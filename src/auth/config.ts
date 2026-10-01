// loadAuthConfig reads the auth settings from the environment and fails fast.

import { emitWarning } from "../observability/log.js";

export type AuthConfig = {
  readonly tenantId: string;
  // The token `iss` must equal this URL.
  readonly issuer: string;
  readonly jwksUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  // The token `aud` must equal the resource app client_id GUID, not the App ID URI.
  readonly resourceAudience: string;
  // This public URL anchors the PRM path and the WWW-Authenticate header.
  readonly resourceUrl: URL;
  readonly scopesSupported: readonly string[];
};

type EnvMap = Record<string, string | undefined>;

function parseList(raw: string | undefined, lower = false): string[] {
  const value = raw?.trim();
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

// TODO: add one entry per tool you register in src/mcp.ts
export const DEFAULT_TOOL_SCOPES = [
  "tools.hello",
  "tools.ping",
  "tools.test",
] as const;

function parseScopes(raw: string | undefined): string[] {
  const scopes = parseList(raw);
  return scopes.length > 0 ? scopes : [...DEFAULT_TOOL_SCOPES];
}

export function warnIfAudienceLooksLikeUri(config: AuthConfig): void {
  const aud = config.resourceAudience;
  if (aud.includes("://") || aud.startsWith("api:")) {
    emitWarning("config-warning", {
      setting: "RESOURCE_AUDIENCE",
      value: aud,
      reason:
        `Looks like an App ID URI, not a GUID. An Entra v2 access token carries the ` +
        `resource app's client_id GUID in "aud", so every real token will be rejected.`,
    });
  }
}

function assertNoIssuerOverrideInDeployment(env: EnvMap): void {
  if (!env.K_SERVICE) return;
  const overrides = ["AS_ISSUER", "AS_JWKS_URI"].filter((name) => env[name]?.trim());
  if (overrides.length > 0) {
    throw new Error(
      `[auth] ${overrides.join(" and ")} must not be set in a deployment ` +
        `(K_SERVICE="${env.K_SERVICE}"): they replace the Entra issuer this server trusts.`,
    );
  }
}

export function loadAuthConfig(env: EnvMap = process.env): AuthConfig {
  assertNoIssuerOverrideInDeployment(env);

  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };

  const tenantId = required("ENTRA_TENANT_ID");
  const resourceAudience = required("RESOURCE_AUDIENCE");
  const resourceBaseUrl = required("RESOURCE_BASE_URL");

  if (missing.length > 0) {
    throw new Error(`[auth] Missing required env var(s): ${missing.join(", ")}. See .env.example.`);
  }

  // The tenant id goes into the issuer and JWKS URLs.
  // This check rejects any value that could repoint them.
  if (/[\s/\\]/.test(tenantId) || tenantId.includes(":")) {
    throw new Error(`[auth] ENTRA_TENANT_ID has an invalid format: "${tenantId}".`);
  }

  const base = `https://login.microsoftonline.com/${tenantId}`;
  return {
    tenantId,
    issuer: env.AS_ISSUER?.trim() || `${base}/v2.0`,
    jwksUri: env.AS_JWKS_URI?.trim() || `${base}/discovery/v2.0/keys`,
    authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    resourceAudience,
    resourceUrl: new URL(resourceBaseUrl),
    scopesSupported: parseScopes(env.SCOPES_SUPPORTED),
  };
}
