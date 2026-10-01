import type { Response } from "express";

export const REQUEST_TIMEOUT_CODE = -32001;

// limitDuration answers 504 and calls onTimeout if the response is still open after `ms`.
// The tool keeps running unless it reads its abort signal.
export function limitDuration(res: Response, ms: number, onTimeout: () => void): void {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        jsonrpc: "2.0",
        error: { code: REQUEST_TIMEOUT_CODE, message: "Request timed out" },
        id: null,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
    onTimeout();
  }, ms);
  timer.unref();
  res.on("close", () => clearTimeout(timer));
}
