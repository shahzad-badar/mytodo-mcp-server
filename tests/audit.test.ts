import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setupTestAuth, TEST_AUDIENCE, type TestAuth } from "./helpers/testAuthServer.js";
import { callTool, startServer, type RunningServer } from "./helpers/httpServer.js";
import { captureLog, entriesOf } from "./helpers/captureLog.js";

// The server writes one audit line per tool call. The line never contains tool arguments.
describe("tool audit", () => {
  let auth: TestAuth;
  let running: RunningServer;

  before(async () => {
    auth = await setupTestAuth();
    running = await startServer({ config: auth.config, getKey: auth.getKey });
  });

  after(() => running.close());

  // send reads the whole response. The capture then holds every line of the request.
  async function send(body: unknown, token: string): Promise<string> {
    return (await running.post(body, token)).text();
  }

  async function auditOf(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    return entriesOf(await captureLog("log", run), "tool-audit");
  }

  it("writes only the declared fields", async () => {
    const token = await auth.mintToken();
    const [line] = await auditOf(() => send(callTool("hello"), token));
    assert.deepEqual(Object.keys(line ?? {}).sort(), [
      "agentClientId",
      "audience",
      "caller",
      "kind",
      "message",
      "outcome",
      "requestId",
      "scopes",
      "severity",
      "time",
      "toolName",
      "userId",
    ]);
  });

  it("records an allowed call", async () => {
    const token = await auth.mintToken();
    const res = await auditOf(() => send(callTool("hello"), token));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.outcome, "allow");
    assert.equal(res[0]?.toolName, "hello");
  });

  it("records a call refused for a missing scope", async () => {
    const token = await auth.mintToken({ scp: "tools.ping" });
    const [line] = await auditOf(() => send(callTool("hello"), token));
    assert.equal(line?.outcome, "deny");
    assert.deepEqual(line?.scopes, ["tools.ping"]);
  });

  it("names the caller, subject, client and audience from the token", async () => {
    const token = await auth.mintToken({ sub: "subject-42", preferredUsername: "Someone@Example.com", azp: "agent-7" });
    const [line] = await auditOf(() => send(callTool("ping"), token));
    assert.equal(line?.caller, "someone@example.com");
    assert.equal(line?.userId, "subject-42");
    assert.equal(line?.agentClientId, "agent-7");
    assert.equal(line?.audience, TEST_AUDIENCE);
  });

  it("keeps tool arguments out of the audit line", async () => {
    const token = await auth.mintToken();
    const lines = await captureLog("log", () => send(callTool("hello", { name: "ACME-private" }), token));
    assert.equal(entriesOf(lines, "tool-audit").length, 1);
    assert.doesNotMatch(lines.join("\n"), /ACME-private/);
  });

  it("writes nothing for a request that calls no tool", async () => {
    const token = await auth.mintToken();
    const lines = await auditOf(() => send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, token));
    assert.deepEqual(lines, []);
  });
});
