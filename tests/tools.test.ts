import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer, MCP_PATH } from "../src/server.js";
import { setupTestAuth, type TestAuth } from "./helpers/testAuthServer.js";
import { DEFAULT_TOOL_SCOPES } from "../src/auth/config.js";
import { ADMIN, MEMBER } from "../src/auth/roles.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Todo } from "../src/store/store.js";

// These tests drive the real server through an MCP client with a test token.
describe("mcp server", () => {
  let server: Server;
  let baseUrl: string;
  let auth: TestAuth;
  let token: string;

  before(async () => {
    auth = await setupTestAuth();
    token = await auth.mintToken({ scp: DEFAULT_TOOL_SCOPES.join(" ") });
    server = createHttpServer({ config: auth.config, getKey: auth.getKey, store: createMemoryStore() });
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
    assert.deepEqual(names, ["add_todo", "complete_todo", "delete_todo", "list_todos", "ping"]);
  });

  it("returns an ISO timestamp from ping", async () => {
    const text = await withClient(async (client) => {
      const result = await client.callTool({ name: "ping", arguments: {} });
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    });
    assert.equal(text, new Date(text).toISOString());
  });

  it("adds a todo and returns it with an id", async () => {
    const result = await withClient((client) =>
      client.callTool({ name: "add_todo", arguments: { title: "Buy milk" } }),
    );
    const todo = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Todo;
    assert.equal(todo.title, "Buy milk");
    assert.equal(todo.completed, false);
    assert.ok(todo.id, "id should be set");
  });

  it("lists todos and includes the one just added", async () => {
    await withClient((client) =>
      client.callTool({ name: "add_todo", arguments: { title: "Write tests" } }),
    );
    const result = await withClient((client) =>
      client.callTool({ name: "list_todos", arguments: {} }),
    );
    const todos = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Todo[];
    assert.ok(todos.some((t) => t.title === "Write tests"));
  });

  it("completes a todo and marks it done", async () => {
    const addResult = await withClient((client) =>
      client.callTool({ name: "add_todo", arguments: { title: "Ship feature" } }),
    );
    const added = JSON.parse((addResult.content as Array<{ text: string }>)[0].text) as Todo;

    const completeResult = await withClient((client) =>
      client.callTool({ name: "complete_todo", arguments: { id: added.id } }),
    );
    const completed = JSON.parse((completeResult.content as Array<{ text: string }>)[0].text) as Todo;
    assert.equal(completed.completed, true);
    assert.equal(completed.id, added.id);
  });

  it("deletes a todo", async () => {
    const addResult = await withClient((client) =>
      client.callTool({ name: "add_todo", arguments: { title: "To be deleted" } }),
    );
    const added = JSON.parse((addResult.content as Array<{ text: string }>)[0].text) as Todo;

    const deleteResult = await withClient((client) =>
      client.callTool({ name: "delete_todo", arguments: { id: added.id } }),
    );
    const body = JSON.parse((deleteResult.content as Array<{ text: string }>)[0].text) as { deleted: string };
    assert.equal(body.deleted, added.id);
  });

  it("returns an error when completing a non-existent todo", async () => {
    const result = await withClient((client) =>
      client.callTool({ name: "complete_todo", arguments: { id: "00000000-0000-0000-0000-000000000000" } }),
    );
    assert.equal(result.isError, true);
  });

  it("returns an error when deleting a non-existent todo", async () => {
    const result = await withClient((client) =>
      client.callTool({ name: "delete_todo", arguments: { id: "00000000-0000-0000-0000-000000000000" } }),
    );
    assert.equal(result.isError, true);
  });

  it("filters todos by completion status", async () => {
    await withClient((client) =>
      client.callTool({ name: "add_todo", arguments: { title: "Incomplete task" } }),
    );
    const addResult = await withClient((client) =>
      client.callTool({ name: "add_todo", arguments: { title: "Task to complete" } }),
    );
    const added = JSON.parse((addResult.content as Array<{ text: string }>)[0].text) as Todo;
    await withClient((client) =>
      client.callTool({ name: "complete_todo", arguments: { id: added.id } }),
    );

    const doneResult = await withClient((client) =>
      client.callTool({ name: "list_todos", arguments: { completed: true } }),
    );
    const doneTodos = JSON.parse((doneResult.content as Array<{ text: string }>)[0].text) as Todo[];
    assert.ok(doneTodos.every((t) => t.completed));
  });

  // A tool needs the role and the scope. A token with only one of them reaches nothing.
  describe("what a role grants", () => {
    async function callListTodos(as: string): Promise<Response> {
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
          params: { name: "list_todos", arguments: {} },
        }),
      });
    }

    it("refuses a token carrying the scopes but no role, with nothing to retry", async () => {
      const res = await callListTodos(await auth.mintToken({ roles: [] }));
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, "insufficient_role");
      assert.equal(res.headers.get("www-authenticate"), null);
    });

    it("refuses a role whose client asked for no scope, and says what to ask for", async () => {
      const res = await callListTodos(await auth.mintToken({ roles: [ADMIN], scp: "" }));
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, "insufficient_scope");
      assert.match(res.headers.get("www-authenticate") ?? "", /insufficient_scope/);
    });

    it("admits a token carrying both halves", async () => {
      const res = await callListTodos(await auth.mintToken({ roles: [MEMBER] }));
      assert.equal(res.status, 200);
    });

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
