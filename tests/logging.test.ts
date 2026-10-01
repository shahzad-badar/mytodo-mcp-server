import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REQUEST_ID_HEADER,
  currentRequestId,
  emit,
  emitError,
  emitWarning,
  reasonOf,
  since,
  withRequest,
} from "../src/observability/log.js";
import { createHttpServer } from "../src/server.js";
import { setupTestAuth, type TestAuth } from "./helpers/testAuthServer.js";
import { callTool, startServer, type RunningServer } from "./helpers/httpServer.js";
import { captureLog, entriesOf } from "./helpers/captureLog.js";

const SOURCE = new URL("../src/", import.meta.url).pathname;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return found.flat();
}

// emittedFields balances braces. It reads the fields after an optional `...(x ? {} : { x })` spread.
function emittedFields(text: string): string[] {
  const found: string[] = [];
  for (const call of text.matchAll(/\bemit(?:Error|Warning)?\(\s*"[^"]*"\s*,\s*\{/g)) {
    let depth = 1;
    let index = call.index + call[0].length;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
    found.push(text.slice(call.index + call[0].length, index - 1));
  }
  return found;
}

// "detail" once carried upstream text. The log module sets the other fields itself.
const BANNED_FIELDS = ["detail", "severity", "message", "time", "kind", "requestId"] as const;

async function firstEntry(stream: "log" | "warn" | "error", run: () => unknown): Promise<Record<string, unknown>> {
  const [line] = await captureLog(stream, run);
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("what this server writes", () => {
  let auth: TestAuth;
  let running: RunningServer;

  before(async () => {
    auth = await setupTestAuth();
    running = await startServer({ config: auth.config, getKey: auth.getKey });
  });

  after(() => running.close());

  async function auditedRequestIds(headers: Record<string, string>[]): Promise<unknown[]> {
    const token = await auth.mintToken();
    const lines = await captureLog("log", async () => {
      for (const extra of headers) await (await running.post(callTool("ping"), token, extra)).text();
    });
    return entriesOf(lines, "tool-audit").map((entry) => entry.requestId);
  }

  it("emits one JSON object per event, stamped with the time", async () => {
    const entry = await firstEntry("log", () => emit("something-happened", { caller: "user@example.com" }));
    assert.equal(entry.kind, "something-happened");
    assert.equal(entry.caller, "user@example.com");
    assert.equal(new Date(entry.time as string).toISOString(), entry.time);
  });

  it("writes a failure to the error stream", async () => {
    const entry = await firstEntry("error", () => emitError("it-broke", { reason: "upstream refused" }));
    assert.equal(entry.kind, "it-broke");
  });

  it("stamps INFO on an ordinary event", async () => {
    assert.equal((await firstEntry("log", () => emit("k", {}))).severity, "INFO");
  });

  it("stamps WARNING on a warning", async () => {
    assert.equal((await firstEntry("warn", () => emitWarning("k", {}))).severity, "WARNING");
  });

  it("stamps ERROR on an error", async () => {
    assert.equal((await firstEntry("error", () => emitError("k", {}))).severity, "ERROR");
  });

  it("carries the kind as a readable message", async () => {
    assert.equal((await firstEntry("log", () => emit("server-listening", {}))).message, "server-listening");
  });

  it("stamps every line of one request with the same id", async () => {
    const ids: unknown[] = [];
    await withRequest(undefined, async () => {
      ids.push((await firstEntry("log", () => emit("first", {}))).requestId);
      ids.push((await firstEntry("log", () => emit("second", {}))).requestId);
    });
    assert.ok(ids[0]);
    assert.equal(ids[0], ids[1]);
  });

  it("keeps an id the caller sent", () => {
    withRequest("trace-7", () => assert.equal(currentRequestId(), "trace-7"));
  });

  it("replaces an id that is too long", () => {
    withRequest("x".repeat(200), () => assert.notEqual(currentRequestId(), "x".repeat(200)));
  });

  it("replaces an id with characters outside the allowed set", () => {
    withRequest("has spaces", () => assert.notEqual(currentRequestId(), "has spaces"));
  });

  it("writes no id outside a request", async () => {
    assert.equal(currentRequestId(), undefined);
    assert.ok(!("requestId" in (await firstEntry("log", () => emit("k", {})))));
  });

  it("carries the request id header into the audit line", async () => {
    assert.deepEqual(await auditedRequestIds([{ [REQUEST_ID_HEADER]: "trace-from-caller" }]), ["trace-from-caller"]);
  });

  it("gives each request without an id a fresh one", async () => {
    const [first, second] = await auditedRequestIds([{}, {}]);
    assert.ok(typeof first === "string" && first.length > 0);
    assert.notEqual(first, second);
  });

  it("warns at startup when the audience looks like an App ID URI", async () => {
    const config = { ...auth.config, resourceAudience: "api://my-resource" };
    const warnings = await captureLog("warn", () => createHttpServer({ config, getKey: auth.getKey }));
    const [entry] = entriesOf(warnings, "config-warning");
    assert.equal(entry?.severity, "WARNING");
    assert.equal(entry?.setting, "RESOURCE_AUDIENCE");
  });

  it("does not warn about a GUID audience", async () => {
    const warnings = await captureLog("warn", () => createHttpServer({ config: auth.config, getKey: auth.getKey }));
    assert.deepEqual(warnings, []);
  });

  it("takes the addresses out of an error", () => {
    const reason = reasonOf(new Error("someone@example.com may not read records/other@example.com"));
    assert.doesNotMatch(reason, /@example\.com/);
    assert.match(reason, /may not read/);
  });

  it("bounds how much of an error is kept", () => {
    assert.equal(reasonOf(new Error("x".repeat(5000))).length, 300);
  });

  it("flattens an error that could forge a second line", () => {
    assert.doesNotMatch(reasonOf(new Error('broke\n{"kind":"tool-audit"}')), /\n/);
  });

  it("reads a reason that is not an Error", () => {
    assert.equal(reasonOf("connection refused"), "connection refused");
  });

  it("measures a duration in whole milliseconds", () => {
    const elapsed = since(performance.now() - 1500);
    assert.ok(elapsed >= 1490 && elapsed <= 1600, `got ${elapsed}`);
    assert.equal(elapsed, Math.round(elapsed));
  });

  it("reads a call site's fields past an optional spread", () => {
    const callSite = `emit("k", { a: 1, ...(b === undefined ? {} : { b }), detail: "leak" });`;
    assert.match(emittedFields(callSite)[0] ?? "", /detail/);
  });

  it("leaves the reserved field names to the log module", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SOURCE)) {
      if (file.endsWith("observability/log.ts")) continue;
      for (const fields of emittedFields(await readFile(file, "utf8"))) {
        for (const field of BANNED_FIELDS) {
          if (new RegExp(`(^|[^\\w.])${field}\\s*:`).test(fields)) offenders.push(`${file.replace(SOURCE, "")} (${field})`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("leaves no source file writing to the console itself", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SOURCE)) {
      if (file.endsWith("observability/log.ts")) continue;
      if (/console\s*\./.test(await readFile(file, "utf8"))) offenders.push(file.replace(SOURCE, ""));
    }
    assert.deepEqual(offenders, []);
  });
});
