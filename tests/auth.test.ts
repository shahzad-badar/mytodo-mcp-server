import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MCP_PATH } from "../src/server.js";
import { ADMIN } from "../src/auth/roles.js";
import { setupTestAuth, type TestAuth } from "./helpers/testAuthServer.js";
import { callTool, INITIALIZE, startServer, textOf, type RunningServer } from "./helpers/httpServer.js";

// This list is narrower than DEFAULT_TOOL_SCOPES. The tests can then tell the configured list from the default.
const SCOPES_SUPPORTED = "tools.hello tools.ping";

describe("mcp auth", () => {
  let auth: TestAuth;
  let running: RunningServer;

  before(async () => {
    auth = await setupTestAuth({ SCOPES_SUPPORTED });
    running = await startServer({ config: auth.config, getKey: auth.getKey });
  });

  after(() => running.close());

  it("serves protected resource metadata pointing at the authorization server", async () => {
    const res = await fetch(`${running.baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(body.resource, `http://localhost${MCP_PATH}`);
    assert.ok(body.authorization_servers.includes(auth.config.issuer));
  });

  it("advertises exactly the configured scopes", async () => {
    const res = await fetch(`${running.baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}`);
    const body = (await res.json()) as { scopes_supported: string[] };
    assert.deepEqual([...body.scopes_supported].sort(), ["tools.hello", "tools.ping"]);
  });

  it("rejects a request with no token and points at the metadata", async () => {
    const res = await running.post(INITIALIZE);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]*oauth-protected-resource/);
  });

  it("rejects a token with the wrong audience", async () => {
    const res = await running.post(INITIALIZE, await auth.mintToken({ aud: "some-other-api-guid" }));
    assert.equal(res.status, 401);
  });

  it("rejects a token with the wrong issuer", async () => {
    const iss = "https://login.microsoftonline.com/other-tenant/v2.0";
    const res = await running.post(INITIALIZE, await auth.mintToken({ iss }));
    assert.equal(res.status, 401);
  });

  it("rejects an expired token", async () => {
    const res = await running.post(INITIALIZE, await auth.mintToken({ expiresIn: "-10m" }));
    assert.equal(res.status, 401);
  });

  it("rejects a token signed by a key the server does not trust", async () => {
    const stranger = await setupTestAuth();
    const res = await running.post(INITIALIZE, await stranger.mintToken());
    assert.equal(res.status, 401);
  });

  it("does not say which check a rejected token failed", async () => {
    const res = await running.post(INITIALIZE, await auth.mintToken({ aud: "some-other-api-guid" }));
    const body = (await res.json()) as { error_description: string };
    assert.doesNotMatch(body.error_description, /aud|audience/i);
  });

  it("refuses an application token that names no user", async () => {
    const res = await running.post(INITIALIZE, await auth.mintToken({ preferredUsername: "" }));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "access_denied");
  });

  it("refuses to initialize for a role that grants no tool", async () => {
    const res = await running.post(INITIALIZE, await auth.mintToken({ roles: ["Viewer"] }));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "insufficient_role");
    assert.equal(res.headers.get("www-authenticate"), null);
  });

  it("asks for the union of held and missing scopes on step-up", async () => {
    const res = await running.post(callTool("hello"), await auth.mintToken({ scp: "tools.ping" }));
    assert.equal(res.status, 403);
    const header = res.headers.get("www-authenticate") ?? "";
    // A client replaces its scopes when it signs in again. The challenge must name the held scopes too.
    const asked = (header.match(/scope="([^"]*)"/)?.[1] ?? "").split(" ").sort();
    assert.deepEqual(asked, ["tools.hello", "tools.ping"]);
    const body = (await res.json()) as { scope: string };
    assert.deepEqual(body.scope.split(" ").sort(), ["tools.hello", "tools.ping"]);
  });

  it("rejects a malformed tool name without echoing it", async () => {
    const token = await auth.mintToken();
    const res = await running.post(callTool('evil", scope="everything'), token);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.doesNotMatch(await res.text(), /evil/);
  });

  it("fails closed on a body it cannot parse", async () => {
    const token = await auth.mintToken();
    const res = await running.post(JSON.stringify(callTool("hello")), token, { "content-type": "text/plain" });
    assert.equal(res.status, 400);
  });

  it("answers invalid JSON with a JSON 400 and no details", async () => {
    const res = await running.post("{not json", await auth.mintToken());
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { error: string }).error, "invalid_request");
    assert.doesNotMatch(text, /node_modules|at JSON\.parse/);
  });

  it("answers a body over 1 MB with a JSON 413", async () => {
    const res = await running.post({ padding: "a".repeat(1_100_000) });
    assert.equal(res.status, 413);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  it("rejects a JSON-RPC batch", async () => {
    const res = await running.post([callTool("hello"), callTool("ping")], await auth.mintToken());
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  });

  it("admits an admin whose client asked for the scope", async () => {
    const token = await auth.mintToken({ roles: [ADMIN], scp: "tools.hello" });
    const text = await running.withClient(token, async (client) =>
      textOf(await client.callTool({ name: "hello", arguments: { name: "Admin" } })),
    );
    assert.equal(text, "Hello, Admin!");
  });

  it("marks every response nosniff", async () => {
    const res = await fetch(`${running.baseUrl}/healthz`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});
