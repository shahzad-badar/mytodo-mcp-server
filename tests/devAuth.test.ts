import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MEMBER } from "../src/auth/roles.js";
import { loadAuthConfig } from "../src/auth/config.js";
import { createRemoteJwks } from "../src/auth/tokenVerifier.js";
// scripts/dev-auth.ts is a developer script. The image does not contain it.
import { loadOrCreateKeys, mintToken, startJwksServer, type DevKeys } from "../scripts/dev-auth.js";
import { callTool, INITIALIZE, startServer, textOf, type RunningServer } from "./helpers/httpServer.js";

const AUDIENCE = "00000000-0000-0000-0000-devresource";
const USER = "dev@example.com";
const SCOPES = ["tools.hello", "tools.ping"];

// Cloud Run always sets K_SERVICE. This environment imitates a deployment.
const DEPLOYED = {
  K_SERVICE: "my-mcp-server",
  ENTRA_TENANT_ID: "tenant",
  RESOURCE_AUDIENCE: AUDIENCE,
  RESOURCE_BASE_URL: "https://mcp.example.com",
};

describe("dev authorization server", () => {
  let jwks: Server;
  let running: RunningServer;
  let keyFile: string;
  let keys: DevKeys;
  let issuer: string;

  function mint(overrides: Partial<Parameters<typeof mintToken>[0]> = {}): Promise<string> {
    return mintToken({
      privateJwk: keys.privateJwk,
      audience: AUDIENCE,
      scopes: SCOPES,
      roles: [MEMBER],
      user: USER,
      issuer,
      ...overrides,
    });
  }

  before(async () => {
    keyFile = join(await mkdtemp(join(tmpdir(), "dev-auth-")), "signing-key.json");
    keys = await loadOrCreateKeys(keyFile);
    jwks = await startJwksServer({ publicJwk: keys.publicJwk, port: 0 });
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;

    const config = loadAuthConfig({
      ENTRA_TENANT_ID: "dev-tenant",
      RESOURCE_AUDIENCE: AUDIENCE,
      RESOURCE_BASE_URL: "http://localhost:8080",
      SCOPES_SUPPORTED: SCOPES.join(" "),
      AS_ISSUER: issuer,
      AS_JWKS_URI: `${issuer}/jwks`,
    });
    running = await startServer({ config, getKey: createRemoteJwks(config) });
  });

  after(async () => {
    await running.close();
    await new Promise<void>((resolve, reject) => jwks.close((err) => (err ? reject(err) : resolve())));
  });

  it("boots a deployment with no issuer override", () => {
    assert.equal(loadAuthConfig(DEPLOYED).resourceAudience, AUDIENCE);
  });

  it("refuses AS_ISSUER in a deployment", () => {
    assert.throws(() => loadAuthConfig({ ...DEPLOYED, AS_ISSUER: "http://127.0.0.1:9001" }), /AS_ISSUER/);
  });

  it("refuses AS_JWKS_URI in a deployment", () => {
    assert.throws(() => loadAuthConfig({ ...DEPLOYED, AS_JWKS_URI: "http://127.0.0.1:9001/jwks" }), /AS_JWKS_URI/);
  });

  it("allows the override off a deployment", () => {
    const { K_SERVICE: _deployed, ...local } = DEPLOYED;
    assert.equal(loadAuthConfig({ ...local, AS_ISSUER: "http://127.0.0.1:9001" }).issuer, "http://127.0.0.1:9001");
  });

  it("reuses the signing key it saved", async () => {
    assert.deepEqual(await loadOrCreateKeys(keyFile), keys);
  });

  it("saves the signing key readable only by its owner", async () => {
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  });

  it("serves only the public key", async () => {
    const res = await fetch(`${issuer}/jwks`);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    assert.equal(body.keys.length, 1);
    assert.ok(!("d" in (body.keys[0] ?? {})), "the private exponent must not be served");
  });

  it("still rejects a request with no token", async () => {
    const res = await running.post(INITIALIZE);
    assert.equal(res.status, 401);
  });

  it("accepts a token the dev script minted", async () => {
    const text = await running.withClient(await mint(), async (client) =>
      textOf(await client.callTool({ name: "hello", arguments: { name: "Dev" } })),
    );
    assert.equal(text, "Hello, Dev!");
  });

  it("still enforces per-tool scopes on a dev token", async () => {
    const res = await running.post(callTool("hello"), await mint({ scopes: ["tools.ping"] }));
    assert.equal(res.status, 403);
    assert.match(res.headers.get("www-authenticate") ?? "", /insufficient_scope/);
  });

  it("still requires a role on a dev token", async () => {
    const res = await running.post(callTool("hello"), await mint({ roles: [] }));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "insufficient_role");
  });

  it("rejects a dev token minted for another audience", async () => {
    const res = await running.post(INITIALIZE, await mint({ audience: "some-other-api-guid" }));
    assert.equal(res.status, 401);
  });
});
