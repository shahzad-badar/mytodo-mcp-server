import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer, MCP_PATH } from "../src/server.js";
import { setupTestAuth, type TestAuth } from "./helpers/testAuthServer.js";
import { TEST_MESSAGE } from "../src/tools/test.js";
import { DEFAULT_TOOL_SCOPES } from "../src/auth/config.js";
import { ADMIN, MEMBER } from "../src/auth/roles.js";

// These tests drive the real server through an MCP client with a test token.
describe("mcp server", () => {
  let server: Server;
  let baseUrl: string;
  let auth: TestAuth;
  let token: string;

  before(async () => {
    auth = await setupTestAuth();
    token = await auth.mintToken({ scp: DEFAULT_TOOL_SCOPES.join(" ") });
    server = createHttpServer({ config: auth.config, getKey: auth.getKey });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function withClient<T>(run: (client: Client) => Promise<T>, as: string = token): Promise<T> {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_PATH, baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${as}` } },
    });
    await client.connect(transport);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  it("responds ok on /healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("has a default scope for every registered tool", async () => {
    const names = await withClient(async (client) => {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    });
    const missing = names.filter((name) => !DEFAULT_TOOL_SCOPES.includes(`tools.${name}` as never));
    assert.deepEqual(missing, [], `tools with no default scope: ${missing.join(", ")}`);
  });

  it("lists every registered tool", async () => {
    const names = await withClient(async (client) => {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).sort();
    });
    // TODO: update this list whenever you add or remove a tool.
    assert.deepEqual(names, ["hello", "ping", "test"]);
  });

  it("greets with a provided name", async () => {
    const text = await withClient(async (client) => {
      const result = await client.callTool({ name: "hello", arguments: { name: "World" } });
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    });
    assert.equal(text, "Hello, World!");
  });

  it("greets the world by default", async () => {
    const text = await withClient(async (client) => {
      const result = await client.callTool({ name: "hello", arguments: {} });
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    });
    assert.equal(text, "Hello, world!");
  });

  it("rejects a name longer than 100 characters", async () => {
    const result = await withClient((client) =>
      client.callTool({ name: "hello", arguments: { name: "x".repeat(101) } }),
    );
    assert.equal(result.isError, true);
  });

  it("returns the greeting as structured content", async () => {
    const result = await withClient((client) => client.callTool({ name: "hello", arguments: { name: "World" } }));
    assert.deepEqual(result.structuredContent, { greeting: "Hello, World!" });
  });

  it("marks every example tool as read-only", async () => {
    const tools = await withClient(async (client) => (await client.listTools()).tools);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not marked read-only`);
    }
  });

  it("returns an ISO timestamp from ping", async () => {
    const text = await withClient(async (client) => {
      const result = await client.callTool({ name: "ping", arguments: {} });
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    });
    assert.equal(text, new Date(text).toISOString());
  });

  it("returns the marker string from test", async () => {
    const text = await withClient(async (client) => {
      const result = await client.callTool({ name: "test", arguments: {} });
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    });
    assert.equal(text, TEST_MESSAGE);
  });
  // A tool needs the role and the scope. A token with only one of them reaches nothing.
  describe("what a role grants", () => {
    async function callHello(as: string): Promise<Response> {
      return fetch(`${baseUrl}${MCP_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${as}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "hello", arguments: {} },
        }),
      });
    }

    it("refuses a token carrying the scopes but no role, with nothing to retry", async () => {
      const res = await callHello(await auth.mintToken({ roles: [] }));
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, "insufficient_role");
      // Only the directory grants a role. The response therefore carries no challenge.
      assert.equal(res.headers.get("www-authenticate"), null);
    });

    it("refuses a role whose client asked for no scope, and says what to ask for", async () => {
      const res = await callHello(await auth.mintToken({ roles: [ADMIN], scp: "" }));
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, "insufficient_scope");
      assert.match(res.headers.get("www-authenticate") ?? "", /insufficient_scope/);
    });

    it("admits a token carrying both halves", async () => {
      const res = await callHello(await auth.mintToken({ roles: [MEMBER] }));
      assert.equal(res.status, 200);
    });

    // The server builds the tool list from each caller's token. A role alone must not list every tool.
    it("lists only the tools whose scope the caller actually holds", async () => {
      const narrow = await auth.mintToken({ roles: [MEMBER], scp: "tools.ping" });
      const names = await withClient(async (client) => {
        const { tools } = await client.listTools();
        return tools.map((t) => t.name);
      }, narrow);
      assert.deepEqual(names, ["ping"]);
    });
  });
});
