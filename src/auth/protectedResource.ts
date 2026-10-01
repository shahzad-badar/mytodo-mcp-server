import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Router } from "express";
import type { AuthConfig } from "./config.js";

// The resource id (RFC 8707, RFC 9728) is the base URL plus the MCP path.
export function resourceServerUrl(config: AuthConfig, mcpPath: string): URL {
  return new URL(mcpPath, config.resourceUrl);
}

export function resourceMetadataUrl(config: AuthConfig, mcpPath: string): string {
  return getOAuthProtectedResourceMetadataUrl(resourceServerUrl(config, mcpPath));
}

function serverBaseUrl(config: AuthConfig): string {
  return config.resourceUrl.href.replace(/\/$/, "");
}

function entraMetadata(config: AuthConfig): OAuthMetadata {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    jwks_uri: config.jwksUri,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...config.scopesSupported],
  };
}

function selfMetadata(config: AuthConfig): OAuthMetadata {
  const base = serverBaseUrl(config);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...config.scopesSupported],
  };
}

// TODO: replace with your server's display name.
const RESOURCE_NAME = "My MCP Server";

// discoveryRouter serves the RFC 9728 PRM and a copy of the AS metadata.
function discoveryRouter(config: AuthConfig, mcpPath: string, oauthMetadata: OAuthMetadata): Router {
  return mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: resourceServerUrl(config, mcpPath),
    scopesSupported: [...config.scopesSupported],
    resourceName: RESOURCE_NAME,
  });
}

// Clients authenticate with Entra directly when the proxy is off.
export function entraDiscoveryRouter(config: AuthConfig, mcpPath: string): Router {
  return discoveryRouter(config, mcpPath, entraMetadata(config));
}

// DCR clients use this server's /authorize, /token and /register when the proxy is on.
export function proxyDiscoveryRouter(config: AuthConfig, mcpPath: string): Router {
  return discoveryRouter(config, mcpPath, selfMetadata(config));
}
