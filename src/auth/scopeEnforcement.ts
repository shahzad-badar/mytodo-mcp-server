import type { Request, RequestHandler } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveIdentities } from "./identity/resolve.js";
import { scopeForTool, hasScope, stepUpScope } from "./authorization.js";
import { grantsAnyTool, roleAllows, rolesOf } from "./roles.js";
import { logToolCall } from "./audit.js";

type ScopeEnforcementOptions = {
  readonly audience: string;
  readonly resourceMetadataUrl: string;
};

type JsonRpcRequest = {
  method?: unknown;
  params?: { name?: unknown };
};

// The tool name goes into WWW-Authenticate, so a strict charset blocks header injection.
const SAFE_TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function isJsonRpcObject(body: unknown): body is JsonRpcRequest {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function toolNameFromBody(body: JsonRpcRequest): string | undefined {
  if (body.method !== "tools/call") return undefined;
  const name = body.params?.name;
  return typeof name === "string" ? name : undefined;
}

function authOf(req: Request): AuthInfo | undefined {
  return (req as Request & { auth?: AuthInfo }).auth;
}

// The gate runs before the transport and fails closed. A 403 triggers a client step-up.
export function requireToolScope(options: ScopeEnforcementOptions): RequestHandler {
  return (req, res, next) => {
    const auth = authOf(req);
    if (!auth) {
      res.status(401).json({ error: "invalid_token", error_description: "Missing authentication." });
      return;
    }

    if (!isJsonRpcObject(req.body)) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Request body must be a single JSON-RPC object.",
      });
      return;
    }

    // The transport would answer a caller with no tool role with "Method not found".
    if (!grantsAnyTool(rolesOf(auth))) {
      res.status(403).json({
        error: "insufficient_role",
        error_description: "This role calls no tool on this server.",
      });
      return;
    }

    const toolName = toolNameFromBody(req.body);
    if (!toolName) {
      next();
      return;
    }

    // The gate never echoes an unsafe tool name.
    if (!SAFE_TOOL_NAME.test(toolName)) {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid tool name." });
      return;
    }

    const required = scopeForTool(toolName);
    const { user, agent } = resolveIdentities(auth);
    const auditBase = {
      caller: user.email,
      userId: user.sub,
      agentClientId: agent.clientId,
      toolName,
      scopes: auth.scopes,
      audience: options.audience,
    } as const;

    if (roleAllows(rolesOf(auth), toolName) && hasScope(auth.scopes, required)) {
      logToolCall({ ...auditBase, outcome: "allow" });
      next();
      return;
    }

    logToolCall({ ...auditBase, outcome: "deny" });

    // No client request can obtain a role, because the directory grants roles.
    // The role refusal therefore sends no WWW-Authenticate challenge.
    if (!roleAllows(rolesOf(auth), toolName)) {
      res.status(403).json({
        error: "insufficient_role",
        error_description: `Tool '${toolName}' is not open to this caller.`,
      });
      return;
    }

    // The header and the body both carry the union scope.
    const stepUp = stepUpScope(auth.scopes, required);
    const challenge =
      `Bearer error="insufficient_scope", ` +
      `error_description="Tool '${toolName}' requires scope '${required}'", ` +
      `scope="${stepUp}", ` +
      `resource_metadata="${options.resourceMetadataUrl}"`;
    res.set("WWW-Authenticate", challenge);
    res.status(403).json({
      error: "insufficient_scope",
      error_description: `Tool '${toolName}' requires scope '${required}'`,
      scope: stepUp,
    });
  };
}
