import { emit } from "../observability/log.js";

export type AuditOutcome = "allow" | "deny";

export type AuditEntry = {
  // The audit records the address for readers and the subject for renames.
  readonly caller: string;
  readonly userId: string;
  readonly agentClientId: string;
  readonly toolName: string;
  readonly scopes: readonly string[];
  readonly audience: string;
  readonly outcome: AuditOutcome;
  readonly durationMs?: number;
};

// The entry is copied field by field so no tool argument reaches the logs.
export function logToolCall(entry: AuditEntry): void {
  emit("tool-audit", {
    caller: entry.caller,
    userId: entry.userId,
    agentClientId: entry.agentClientId,
    toolName: entry.toolName,
    scopes: entry.scopes,
    audience: entry.audience,
    outcome: entry.outcome,
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
  });
}
