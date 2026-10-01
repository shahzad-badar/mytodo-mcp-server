import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createHttpServer } from "../src/server.js";
import type { ProxyConfig } from "../src/auth/oauthProxy.js";
import { setupTestAuth, TEST_AUDIENCE, type TestAuth } from "./helpers/testAuthServer.js";

// These tests cover the OAuth proxy for Claude. They do not contact Entra.
// The routes are public, because a client calls them before it has a token.
const ALLOWED_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CLIENT_SECRET = "super-secret-value-never-leaks";

describe("oauth proxy", () => {
  let server: Server;
  let baseUrl: string;
  let auth: TestAuth;

  const proxyConfig: ProxyConfig = {
    enabled: true,
    clientId: "entra-client-guid-123",
    clientSecret: CLIENT_SECRET,
    allowedRedirectUris: [ALLOWED_REDIRECT],
    allowLoopback: true,
  };
  const LOOPBACK_REDIRECT = "http://127.0.0.1:5473/oauth/callback";

  before(async () => {
    auth = await setupTestAuth();
    server = createHttpServer({
      config: auth.config,
      getKey: auth.getKey,
      proxyConfig,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("registers a client with an allowed redirect_uri: 201 + client_id, no secret", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [ALLOWED_REDIRECT], client_name: "Claude" }),
    });
    assert.equal(res.status, 201);
    const text = await res.text();
    const body = JSON.parse(text) as { client_id: string; token_endpoint_auth_method: string };
    assert.equal(body.client_id, proxyConfig.clientId);
    assert.equal(body.token_endpoint_auth_method, "none");
    assert.ok(!("client_secret" in JSON.parse(text)), "response must not carry a client_secret");
    assert.ok(!text.includes(CLIENT_SECRET), "the secret value must never appear in a response");
  });

  it("rejects registration with a redirect_uri not on the allowlist: 400", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://attacker.example/steal"] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
  });

  it("rejects a register request that is not application/json: 415", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "whatever",
    });
    assert.equal(res.status, 415);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  });

  it("authorizes: 302 to Entra with PKCE and state passed through, secret absent", async () => {
    const url =
      `${baseUrl}/authorize?redirect_uri=${encodeURIComponent(ALLOWED_REDIRECT)}` +
      `&state=xyz&code_challenge=chal123&code_challenge_method=S256&scope=tools.hello`;
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assert.ok(location.startsWith(auth.config.authorizationEndpoint), "must redirect to Entra");
    const redirected = new URL(location);
    assert.equal(redirected.searchParams.get("client_id"), proxyConfig.clientId);
    assert.equal(redirected.searchParams.get("code_challenge"), "chal123");
    assert.equal(redirected.searchParams.get("code_challenge_method"), "S256");
    assert.equal(redirected.searchParams.get("state"), "xyz");
    const scope = redirected.searchParams.get("scope") ?? "";
    assert.ok(scope.includes(`api://${TEST_AUDIENCE}/tools.hello`), `translated scope missing in "${scope}"`);
    assert.ok(scope.includes("openid"), "OIDC scopes must be injected");
    assert.ok(!location.includes(CLIENT_SECRET), "the secret value must never appear in a redirect");
  });

  it("rejects authorize with a redirect_uri not on the allowlist: 400", async () => {
    const url = `${baseUrl}/authorize?redirect_uri=${encodeURIComponent("https://attacker.example/steal")}`;
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
  });

  it("rejects authorize with a scope outside SCOPES_SUPPORTED: 400 invalid_scope", async () => {
    const url =
      `${baseUrl}/authorize?redirect_uri=${encodeURIComponent(ALLOWED_REDIRECT)}` +
      `&code_challenge=chal123&code_challenge_method=S256` +
      `&scope=${encodeURIComponent("tools.delete_everything")}`;
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_scope");
  });

  it("rejects authorize without PKCE S256: 400 invalid_request", async () => {
    const noPkce = `${baseUrl}/authorize?redirect_uri=${encodeURIComponent(ALLOWED_REDIRECT)}`;
    const res1 = await fetch(noPkce, { redirect: "manual" });
    assert.equal(res1.status, 400);
    assert.equal(((await res1.json()) as { error: string }).error, "invalid_request");

    const plain = `${noPkce}&code_challenge=chal123&code_challenge_method=plain`;
    const res2 = await fetch(plain, { redirect: "manual" });
    assert.equal(res2.status, 400);
  });

  it("accepts an RFC 8252 loopback redirect_uri (any port) on register and authorize", async () => {
    const reg = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [LOOPBACK_REDIRECT] }),
    });
    assert.equal(reg.status, 201);

    const url =
      `${baseUrl}/authorize?redirect_uri=${encodeURIComponent(LOOPBACK_REDIRECT)}` +
      `&code_challenge=chal123&code_challenge_method=S256&scope=tools.hello`;
    const auth2 = await fetch(url, { redirect: "manual" });
    assert.equal(auth2.status, 302);
    assert.equal(new URL(auth2.headers.get("location") ?? "").searchParams.get("redirect_uri"), LOOPBACK_REDIRECT);
  });

  it("accepts an IPv6 loopback redirect_uri", async () => {
    const reg = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://[::1]:5473/oauth/callback"] }),
    });
    assert.equal(reg.status, 201);
  });

  it("rejects hosts that only look like loopback (suffix and userinfo spoofs): 400", async () => {
    for (const spoof of ["http://localhost.attacker.example/cb", "http://localhost@evil.com/cb"]) {
      const reg = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [spoof] }),
      });
      assert.equal(reg.status, 400, `must reject ${spoof}`);
      assert.equal(((await reg.json()) as { error: string }).error, "invalid_redirect_uri");
    }
  });

  // This Entra stand-in echoes the form it receives. The proxy must never request
  // more scopes than the request named, because the grant already fixed them.
  describe("token scope relay", () => {
    let entra: Server;
    let tokenServer: Server;
    let tokenBaseUrl: string;

    before(async () => {
      entra = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ echoed: Object.fromEntries(new URLSearchParams(body)) }));
        });
      });
      await new Promise<void>((resolve) => entra.listen(0, "127.0.0.1", resolve));
      const entraPort = (entra.address() as AddressInfo).port;

      tokenServer = createHttpServer({
        config: { ...auth.config, tokenEndpoint: `http://127.0.0.1:${entraPort}/token` },
        getKey: auth.getKey,
        proxyConfig,
      });
      await new Promise<void>((resolve) => tokenServer.listen(0, resolve));
      tokenBaseUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve, reject) => tokenServer.close((e) => (e ? reject(e) : resolve())));
      await new Promise<void>((resolve, reject) => entra.close((e) => (e ? reject(e) : resolve())));
    });

    async function forwardedScope(form: Record<string, string>): Promise<string | undefined> {
      const res = await fetch(`${tokenBaseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      });
      assert.equal(res.status, 200);
      const { echoed } = (await res.json()) as { echoed: Record<string, string> };
      return echoed.scope;
    }

    // The server must not turn an empty tool list into every scope at /token.
    // Entra refuses a request for more scopes than the grant.
    it("does not widen a refresh that named only an OIDC scope", async () => {
      const scope = await forwardedScope({
        grant_type: "refresh_token",
        refresh_token: "rt-123",
        scope: "openid",
      });
      assert.equal(scope, "openid");
    });

    it("translates the tool scopes a request names, and adds none", async () => {
      const scope = await forwardedScope({
        grant_type: "refresh_token",
        refresh_token: "rt-123",
        scope: "openid tools.ping",
      });
      assert.equal(scope, `openid api://${TEST_AUDIENCE}/tools.ping`);
    });

    it("omits scope entirely when the request carried none", async () => {
      const scope = await forwardedScope({ grant_type: "refresh_token", refresh_token: "rt-123" });
      assert.equal(scope, undefined);
    });

    it("still refuses an unknown scope at /token", async () => {
      const res = await fetch(`${tokenBaseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt-123",
          scope: "tools.delete_everything",
        }).toString(),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_scope");
    });
  });
});
