import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// Each event is one JSON line that Cloud Logging indexes.
// Nothing else calls console.
export type LogFields = Readonly<Record<string, unknown>>;

// AsyncLocalStorage carries the request id so no call site can forget to pass it.
const REQUEST = new AsyncLocalStorage<string>();

export const REQUEST_ID_HEADER = "x-request-id";

// A valid incoming id is kept so all services share one id per request.
export function withRequest<T>(incoming: string | undefined, run: () => T): T {
  return REQUEST.run(usableId(incoming) ?? randomUUID(), run);
}

export function currentRequestId(): string | undefined {
  return REQUEST.getStore();
}

// The id comes from the caller and reaches the logs, so its length and charset are restricted.
const ID = /^[A-Za-z0-9._-]{1,128}$/;

function usableId(incoming: string | undefined): string | undefined {
  return incoming !== undefined && ID.test(incoming) ? incoming : undefined;
}

// Each line sets its severity because Cloud Run sets no default.
// A line without severity never matches a `severity>=ERROR` alert.
type Severity = "INFO" | "WARNING" | "ERROR";

// Cloud Logging reads the entry time from `time`.
// It ignores an ISO string in `timestamp` and uses the receive time instead.
function line(kind: string, severity: Severity, fields: LogFields): string {
  const requestId = REQUEST.getStore();
  return JSON.stringify({
    severity,
    message: kind,
    kind,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
    time: new Date().toISOString(),
  });
}

// Call sites write their fields out so no argument reaches the logs by accident.
// Each severity has its own function so no call site passes the wrong one.
export function emit(kind: string, fields: LogFields): void {
  console.log(line(kind, "INFO", fields));
}

export function emitWarning(kind: string, fields: LogFields): void {
  console.warn(line(kind, "WARNING", fields));
}

export function emitError(kind: string, fields: LogFields): void {
  console.error(line(kind, "ERROR", fields));
}

// Error text can quote refused data. reasonOf removes addresses and control characters
// and bounds the length. It does not remove other upstream text.
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@,;)]+/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const REASON_LENGTH = 300;

export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(EMAIL, "[address]").replace(CONTROL, " ").slice(0, REASON_LENGTH);
}

// The duration tells a slow call from a broken one.
export function since(start: number): number {
  return Math.round(performance.now() - start);
}
