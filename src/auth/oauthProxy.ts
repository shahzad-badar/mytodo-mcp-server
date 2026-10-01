import express, { type Request, type Response, type Router } from "express";
import type { AuthConfig } from "./config.js";

// This proxy fronts Entra for DCR clients such as Claude. Entra still mints the tokens.

const DEFAULT_ALLOWED_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback"];
const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"];

export type ProxyConfig = {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly allowedRedirectUris: readonly string[];
  // RFC 8252 loopback redirects serve local CLI clients. They are off by default.
  readonly allowLoopback: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

type EnvMap = Record<string, string | undefined>;

function parseAllowedRedirectUris(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_ALLOWED_REDIRECT_URIS];
  return value
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter(Boolean);
}

export function loadProxyConfig(env: EnvMap = process.env): ProxyConfig {
  const enabled = env.OAUTH_PROXY_ENABLED === "true";
  const clientId = env.ENTRA_CLIENT_ID?.trim() ?? "";
  if (enabled && !clientId) {
    throw new Error("[auth] OAUTH_PROXY_ENABLED is true but ENTRA_CLIENT_ID is missing. See .env.example.");
  }
  return {
    enabled,
    clientId,
    clientSecret: env.ENTRA_CLIENT_SECRET?.trim() || undefined,
    allowedRedirectUris: parseAllowedRedirectUris(env.OAUTH_PROXY_ALLOWED_REDIRECT_URIS),
    allowLoopback: env.OAUTH_PROXY_ALLOW_LOOPBACK === "true",
  };
}

// A loopback redirect uses http on 127.0.0.1, [::1] or localhost with any port.
function isLoopbackRedirectUri(uri: string): boolean {
  // The check rejects non-ASCII so a homograph host cannot pass as loopback.
  if (/[^\x20-\x7e]/.test(uri)) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

type ScopeResult = { readonly scope: string } | { readonly invalid: readonly string[] };

const entraToolScope = (name: string, authConfig: AuthConfig): string =>
  `api://${authConfig.resourceAudience}/${name}`;

// A requested scope must be an advertised scope or an OIDC scope.
// The proxy refuses any other scope by name.
function readScopeRequest(requested: string | undefined, authConfig: AuthConfig) {
  const tokens = (requested ?? "").split(/\s+/).filter(Boolean);
  const supported = new Set(authConfig.scopesSupported);
  return {
    tokens,
    supported,
    invalid: tokens.filter((s) => !OIDC_SCOPES.includes(s) && !supported.has(s)),
  } as const;
}

// Every /authorize request gets the OIDC scopes. A bare connect also gets every tool
// scope. A client that names tool scopes gets only those tool scopes.
function authorizeScopes(requested: string | undefined, authConfig: AuthConfig): ScopeResult {
  const { tokens, supported, invalid } = readScopeRequest(requested, authConfig);
  if (invalid.length > 0) return { invalid };

  const requestedTools = tokens.filter((s) => supported.has(s));
  const toolNames = requestedTools.length > 0 ? requestedTools : [...authConfig.scopesSupported];
  const toolScopes = toolNames.map((name) => entraToolScope(name, authConfig));
  return { scope: [...OIDC_SCOPES, ...toolScopes].join(" ") };
}

// /token relays only the requested scopes and never widens them.
// The grant already fixed the scopes, and Entra refuses a request for more.
function tokenScopes(requested: string | undefined, authConfig: AuthConfig): ScopeResult {
  const { tokens, supported, invalid } = readScopeRequest(requested, authConfig);
  if (invalid.length > 0) return { invalid };

  return { scope: tokens.map((s) => (supported.has(s) ? entraToolScope(s, authConfig) : s)).join(" ") };
}

function isAllowedRedirectUri(uri: string, proxyConfig: ProxyConfig): boolean {
  if (proxyConfig.allowedRedirectUris.includes(uri)) return true;
  return proxyConfig.allowLoopback && isLoopbackRedirectUri(uri);
}

function badRequest(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

// POST /register (RFC 7591) returns the pre-registered client_id without a secret.
function handleRegister(proxyConfig: ProxyConfig) {
  return (req: Request, res: Response): void => {
    // A non-JSON body is not parsed and would pass as an empty registration.
    if (!req.is("application/json")) {
      badRequest(res, 415, "invalid_request", "Content-Type must be application/json.");
      return;
    }
    const body = (req.body ?? {}) as { redirect_uris?: unknown; grant_types?: unknown; response_types?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];

    const invalid = redirectUris.filter((uri) => !isAllowedRedirectUri(uri, proxyConfig));
    if (invalid.length > 0) {
      badRequest(res, 400, "invalid_redirect_uri", "One or more redirect_uris are not permitted by this server.");
      return;
    }

    res.set("Cache-Control", "no-store").status(201).json({
      client_id: proxyConfig.clientId,
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"],
      response_types: Array.isArray(body.response_types) ? body.response_types : ["code"],
      ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
    });
  };
}

// GET /authorize redirects to Entra with our client_id and the translated scope.
function handleAuthorize(proxyConfig: ProxyConfig, authConfig: AuthConfig) {
  return (req: Request, res: Response): void => {
    const query = req.query as Record<string, string | undefined>;
    const redirectUri = query.redirect_uri;
    if (!redirectUri) {
      badRequest(res, 400, "invalid_request", "redirect_uri is required.");
      return;
    }
    if (!isAllowedRedirectUri(redirectUri, proxyConfig)) {
      badRequest(res, 400, "invalid_redirect_uri", "redirect_uri is not permitted by this server.");
      return;
    }

    if (!query.code_challenge || query.code_challenge_method !== "S256") {
      badRequest(res, 400, "invalid_request", "PKCE with code_challenge_method=S256 is required.");
      return;
    }

    const scopeResult = authorizeScopes(query.scope, authConfig);
    if ("invalid" in scopeResult) {
      badRequest(res, 400, "invalid_scope", `Unknown scope(s): ${scopeResult.invalid.join(", ")}`);
      return;
    }

    const params = new URLSearchParams({
      client_id: proxyConfig.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: redirectUri,
      scope: scopeResult.scope,
    });
    for (const key of ["state", "code_challenge", "code_challenge_method"] as const) {
      const value = query[key];
      if (value) params.set(key, value);
    }
    res.redirect(302, `${authConfig.authorizationEndpoint}?${params.toString()}`);
  };
}

// POST /token relays the grant to Entra and adds the client secret if one is set.
function handleToken(proxyConfig: ProxyConfig, authConfig: AuthConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    const grantType = form.grant_type;

    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      badRequest(res, 400, "unsupported_grant_type", `grant_type '${grantType ?? ""}' is not supported.`);
      return;
    }

    if (grantType === "authorization_code") {
      const redirectUri = form.redirect_uri;
      if (redirectUri && !isAllowedRedirectUri(redirectUri, proxyConfig)) {
        badRequest(res, 400, "invalid_grant", "redirect_uri is not permitted by this server.");
        return;
      }
    }

    const data = new URLSearchParams({
      client_id: proxyConfig.clientId,
      grant_type: grantType,
    });
    // A public PKCE client has no secret.
    if (proxyConfig.clientSecret) data.set("client_secret", proxyConfig.clientSecret);

    if (form.scope) {
      const scopeResult = tokenScopes(form.scope, authConfig);
      if ("invalid" in scopeResult) {
        badRequest(res, 400, "invalid_scope", `Unknown scope(s): ${scopeResult.invalid.join(", ")}`);
        return;
      }
      data.set("scope", scopeResult.scope);
    }

    if (grantType === "authorization_code") {
      data.set("code", form.code ?? "");
      data.set("redirect_uri", form.redirect_uri ?? "");
      if (form.code_verifier) data.set("code_verifier", form.code_verifier);
    } else {
      // The proxy injects no scope on refresh, so Entra reuses the granted scope.
      data.set("refresh_token", form.refresh_token ?? "");
    }

    const entraResponse = await fetch(authConfig.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: data.toString(),
    });
    const payload = await entraResponse.text();
    // RFC 6749 section 5.1 forbids caching a token response.
    res.set("Cache-Control", "no-store").status(entraResponse.status).type("application/json").send(payload);
  };
}

export function oauthProxyRouter(proxyConfig: ProxyConfig, authConfig: AuthConfig): Router {
  const router = express.Router();
  router.post("/register", express.json(), handleRegister(proxyConfig));
  router.get("/authorize", handleAuthorize(proxyConfig, authConfig));
  router.post("/token", express.urlencoded({ extended: false }), handleToken(proxyConfig, authConfig));
  return router;
}
