import type { Request, RequestHandler } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveIdentities } from "./identity/resolve.js";

export function callerEmailOf(req: Request): string {
  const auth = (req as Request & { auth?: AuthInfo }).auth;
  return auth ? resolveIdentities(auth).user.email : "";
}

export function requireCallerEmail(): RequestHandler {
  return (req, res, next) => {
    if (callerEmailOf(req)) {
      next();
      return;
    }
    res.status(403).json({
      error: "access_denied",
      error_description: "This server requires a user token; application-only tokens are not accepted.",
    });
  };
}
