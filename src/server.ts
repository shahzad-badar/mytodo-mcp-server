import { createServer, type Server } from "node:http";
import { REQUEST_ID_HEADER, emit, emitError, emitWarning, reasonOf, withRequest } from "./observability/log.js";
import { limitDuration } from "./requestTimeout.js";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import type { JWTVerifyGetKey } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpServer } from "./mcp.js";
import { loadAuthConfig, warnIfAudienceLooksLikeUri, type AuthConfig } from "./auth/config.js";
import type { TodoStore } from "./store/store.js";
import { createMemoryStore } from "./store/memoryStore.js";
import { createTokenVerifier, createRemoteJwks } from "./auth/tokenVerifier.js";
import { entraDiscoveryRouter, proxyDiscoveryRouter, resourceMetadataUrl } from "./auth/protectedResource.js";
import { requireToolScope } from "./auth/scopeEnforcement.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { callerEmailOf, requireCallerEmail } from "./auth/callerEmail.js";
import { rolesOf } from "./auth/roles.js";
import { loadProxyConfig, oauthProxyRouter, type ProxyConfig } from "./auth/oauthProxy.js";

const PORT = Number(process.env.PORT ?? 8080);
// An unset HOST binds every interface. HOST=127.0.0.1 keeps a dev server off the network.
const HOST = process.env.HOST?.trim();
export const MCP_PATH = "/mcp";

// TODO: adjust this if your tools accept large payloads (e.g. file uploads).
const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MB default

// TODO: raise this if a tool needs more time. Keep it below the Cloud Run request timeout.
const REQUEST_TIMEOUT_MS = 60_000;

export type ServerDeps = {
  readonly config?: AuthConfig;
  readonly getKey?: JWTVerifyGetKey;
  readonly proxyConfig?: ProxyConfig;
  readonly requestTimeoutMs?: number;
  readonly store?: TodoStore;
};

async function handleMcpRequest(
  req: Request,
  res: Response,
  timeoutMs: number,
  store: TodoStore,
): Promise<void> {
  const auth = (req as Request & { auth?: AuthInfo }).auth;
  const server = createMcpServer({
    scopes: auth?.scopes ?? [],
    roles: rolesOf(auth),
    ownerEmail: callerEmailOf(req),
    store,
  });
  // The transport answers in JSON and sends nothing before the tool returns.
  // A request that times out can then still get a 504.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  limitDuration(res, timeoutMs, () => {
    emitWarning("mcp-request-timeout", { caller: callerEmailOf(req), timeoutMs });
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    emitError("mcp-request-error", {
      caller: callerEmailOf(req),
      reason: reasonOf(error),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

export function createHttpServer(deps: ServerDeps = {}): Server {
  const config = deps.config ?? loadAuthConfig();
  warnIfAudienceLooksLikeUri(config);
  const proxyConfig = deps.proxyConfig ?? loadProxyConfig();
  const getKey = deps.getKey ?? createRemoteJwks(config);
  const store = deps.store ?? createMemoryStore();
  const verifier = createTokenVerifier(config, getKey);
  const rmUrl = resourceMetadataUrl(config, MCP_PATH);

  const app = express();
  app.disable("x-powered-by");
  app.use((req, _res, next) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    withRequest(incoming, next);
  });
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  app.use(proxyConfig.enabled ? proxyDiscoveryRouter(config, MCP_PATH) : entraDiscoveryRouter(config, MCP_PATH));
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  if (proxyConfig.enabled) {
    app.use(oauthProxyRouter(proxyConfig, config));
  }

  app.post(
    MCP_PATH,
    express.json({ limit: MAX_REQUEST_BYTES }),
    requireBearerAuth({ verifier, resourceMetadataUrl: rmUrl }),
    requireCallerEmail(),
    requireToolScope({ audience: config.resourceAudience, resourceMetadataUrl: rmUrl }),
    (req, res) => {
      void handleMcpRequest(req, res, deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, store);
    },
  );

  app.use(jsonErrors);

  return createServer(app);
}

// jsonErrors answers Express errors in JSON without details.
// The default Express page can show a stack trace.
const jsonErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  res.set("Cache-Control", "no-store");
  const type = (error as { type?: unknown }).type;
  if (type === "entity.too.large") {
    res.status(413).json({ error: "invalid_request", error_description: "Request body is too large." });
    return;
  }
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_request", error_description: "Request body is not valid JSON." });
    return;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: "invalid_request", error_description: "The request was refused." });
    return;
  }
  // The shared kind lets the application error alert cover this error too.
  emitError("mcp-request-error", { reason: reasonOf(error) });
  res.status(500).json({ error: "server_error", error_description: "Internal server error." });
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  createHttpServer().listen(HOST ? { port: PORT, host: HOST } : { port: PORT }, () => {
    emit("server-listening", { port: PORT, path: MCP_PATH });
  });
}
