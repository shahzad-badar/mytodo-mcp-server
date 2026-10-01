// captureLog records the lines that src/observability/log.ts writes while `run` runs.
export type Stream = "log" | "warn" | "error";

export async function captureLog(stream: Stream, run: () => unknown): Promise<string[]> {
  const written: string[] = [];
  const original = console[stream];
  console[stream] = (line: unknown) => void written.push(String(line));
  try {
    await run();
  } finally {
    console[stream] = original;
  }
  return written;
}

export function entriesOf(lines: readonly string[], kind: string): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.kind === kind);
}
