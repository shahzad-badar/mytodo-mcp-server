import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { limitDuration, REQUEST_TIMEOUT_CODE } from "../src/requestTimeout.js";
import { setupTestAuth, type TestAuth } from "./helpers/testAuthServer.js";
import { callTool, startServer, type RunningServer } from "./helpers/httpServer.js";
import { captureLog, entriesOf } from "./helpers/captureLog.js";

describe("request timeout", () => {
  let helperServer: Server;
  let helperUrl: string;
  let helperTimeouts = 0;
  let auth: TestAuth;
  let running: RunningServer;

  before(async () => {
    const app = express();
    app.get("/slow", (_req, res) => {
      limitDuration(res, 50, () => {
        helperTimeouts += 1;
      });
    });
    app.get("/fast", (_req, res) => {
      limitDuration(res, 50, () => {
        helperTimeouts += 1;
      });
      res.json({ ok: true });
    });
    helperServer = createServer(app);
    await new Promise<void>((resolve) => helperServer.listen(0, "127.0.0.1", resolve));
    helperUrl = `http://127.0.0.1:${(helperServer.address() as AddressInfo).port}`;

    auth = await setupTestAuth();
    running = await startServer({ config: auth.config, getKey: auth.getKey, requestTimeoutMs: 50 });
  });

  after(async () => {
    await new Promise<void>((resolve) => helperServer.close(() => resolve()));
    await running.close();
  });

  it("answers 504 with a JSON-RPC error when the handler does not finish", async () => {
    const res = await fetch(`${helperUrl}/slow`);
    assert.equal(res.status, 504);
    assert.equal(((await res.json()) as { error: { code: number } }).error.code, REQUEST_TIMEOUT_CODE);
    assert.equal(helperTimeouts, 1);
  });

  it("does not fire after the handler has answered", async () => {
    const res = await fetch(`${helperUrl}/fast`);
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(helperTimeouts, 1);
  });

  it("stops a tool call that runs too long and logs a warning", async () => {
    // This mock gives ping a handler that never returns. The transport and the server stay real.
    const register = McpServer.prototype.registerTool;
    const stuck = mock.method(McpServer.prototype, "registerTool", function (this: McpServer, ...args: unknown[]) {
      const [name, config] = args as [string, unknown];
      const handler = name === "ping" ? () => new Promise(() => {}) : args[2];
      return (register as (...a: unknown[]) => unknown).call(this, name, config, handler);
    });
    try {
      const token = await auth.mintToken();
      let status = 0;
      let body: { error?: { code?: number } } = {};
      const warnings = await captureLog("warn", async () => {
        const res = await running.post(callTool("ping"), token);
        status = res.status;
        body = (await res.json()) as typeof body;
      });
      assert.equal(status, 504);
      assert.equal(body.error?.code, REQUEST_TIMEOUT_CODE);
      assert.equal(entriesOf(warnings, "mcp-request-timeout").length, 1);
    } finally {
      stuck.mock.restore();
    }
  });

  it("lets a normal tool call finish", async () => {
    const res = await running.post(callTool("ping"), await auth.mintToken());
    assert.equal(res.status, 200);
  });
});
