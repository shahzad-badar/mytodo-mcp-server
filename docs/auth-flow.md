# Authentication flow

## Summary

- Every call to `/mcp` needs a valid Entra ID access token.
- Entra issues all tokens. The server never sees a password. The server never stores a token.
- A tool call needs a **role** and a **scope** in the token. An Entra administrator assigns the role. The scope is `tools.<name>`.
- The server runs in one of two modes. `OAUTH_PROXY_ENABLED` sets the mode. The mode changes how a client gets a token. It does not change how the server checks the token.

| Mode | `OAUTH_PROXY_ENABLED` | Used for | Token issuer |
|---|---|---|---|
| 1 | `false` | Local development | `scripts/dev-auth.ts` |
| 2 | `true` | Dev and prod on Cloud Run, with Claude | Entra ID |

## Components

| Component | Description |
|---|---|
| Client | The MCP client. Claude in dev and prod. `mcp-remote` in local development. |
| MCP server | This repository. It checks tokens and runs tools. |
| Entra ID | It signs users in and issues tokens. |
| Resource app | The Entra registration of the server. It defines the scopes and the roles. Its client id is the token audience. |
| Client app | The Entra registration Claude uses to sign in. Mode 2 only. |

[entra-apps.md](entra-apps.md) explains how to create the two registrations.

## Why the server has an OAuth proxy

The MCP specification expects Dynamic Client Registration (DCR, RFC 7591). DCR lets a client register itself with the authorization server. Claude calls `/register`. Claude receives a `client_id`. Claude then signs the user in with this `client_id`.

Entra ID does not support DCR. An administrator registers each application in advance.

The proxy fills this gap. The server exposes three endpoints when the proxy is on.

- `/register` creates nothing. It returns the `client_id` of the client app. Every Claude user receives the same `client_id`.
- `/authorize` redirects the browser to the Entra sign-in page.
- `/token` forwards the request to Entra. It returns the Entra response.

One shared `client_id` is safe. The client app is public. It has no secret. The user's role and scopes decide access. The client does not.

## Mode 1 (local development)

1. The developer runs `npm run dev:auth`. This command starts a local token issuer on `http://127.0.0.1:9001`.
2. The developer runs `npm run dev`. The server trusts the local issuer. `AS_ISSUER` and `AS_JWKS_URI` in `.env` point to it.
3. The developer runs `npm run dev:token`. This command prints a token. The token has the `Member` role and every scope. It is valid for 7 days.
4. The developer adds the token to the `Authorization` header in `mcp-remote`.
5. The server checks each request to `/mcp`. See [Checks on every request](#checks-on-every-request).

Mode 1 needs no Entra tenant. The server refuses to start on Cloud Run when `AS_ISSUER` or `AS_JWKS_URI` is set. A deployment never trusts a local issuer.

## Mode 2 (dev and prod)

### First connection

1. The user adds a custom connector in Claude. The connector URL is `https://<host>/mcp`.
2. Claude calls `/mcp` without a token. The server returns `401`. The `WWW-Authenticate` header gives the address of the server metadata.
3. Claude reads `/.well-known/oauth-protected-resource/mcp`. This document lists the scopes. It names the server as the authorization server.
4. Claude reads `/.well-known/oauth-authorization-server`. This document lists `/register`, `/authorize` and `/token`.
5. Claude calls `POST /register`. The server checks the redirect URI. The only allowed value is `https://claude.ai/api/mcp/auth_callback`. The server returns the `client_id` of the client app.
6. Claude opens `GET /authorize` in the user's browser. The server runs three checks.
   - The redirect URI is allowed.
   - The request uses PKCE with `S256`.
   - The server knows every requested scope.

   The server converts each scope to the Entra format. The Entra format adds the resource app URI. `tools.ping` becomes `api://<resource app id>/tools.ping`. The server then redirects the browser to Entra.
7. The user signs in to Entra. Entra refuses users without an assignment on the resource app.
8. Entra redirects the browser to Claude with an authorization code.
9. Claude calls `POST /token` with the code and the PKCE verifier. The server forwards the request to Entra. The server returns the token to Claude.
10. Claude calls `/mcp` with the token. The server runs the checks below.

The browser calls `/authorize` from the user's IP address. Cloud Armor allows Claude's IP range and the IPs in `allowed_caller_ip_ranges`. Users outside these ranges cannot sign in. This rule applies when `infra/gateway` is deployed.

### Token refresh

The token expires after a period set by Entra. Claude then calls `POST /token` with its refresh token. The server forwards the request to Entra. The server never asks Entra for more scopes than the first sign-in granted.

### Missing scope (step-up)

A token can lack the scope of a tool. The server then returns `403 insufficient_scope`. The `WWW-Authenticate` header names the missing scopes. Claude signs the user in again with these scopes. Claude then retries the call.

## Checks on every request

The server runs these checks on each `POST /mcp`, in this order. The first failure stops the request.

| # | Check | Failure |
|---|---|---|
| 1 | The body is 1 MB or less. | `413 invalid_request` |
| 2 | The body is valid JSON. | `400 invalid_request` |
| 3 | The token signature, issuer, audience and expiry are valid. | `401` |
| 4 | The token belongs to a user. Application tokens fail. | `403` |
| 5 | The body is a single JSON-RPC object. Batches fail. | `400 invalid_request` |
| 6 | The user has a role this server knows. | `403 insufficient_role` |
| 7 | The tool name is valid. | `400 invalid_request` |
| 8 | The user has the role of the called tool. | `403 insufficient_role` |
| 9 | The token has the scope of the called tool. | `403 insufficient_scope` |
| 10 | The tool returns within 60 seconds. | `504` |

Checks 7 to 9 apply to tool calls only. Check 10 applies to every request. Every failure answers in JSON.

The server writes each tool call to the audit log. The entry contains the user, the tool and the result.

`tools/list` returns only the tools the caller can call. This list helps the user. It is not a security control. The checks above apply to every call.

A missing role returns no `WWW-Authenticate` header. A new sign-in cannot grant a role. Only an Entra administrator can assign one.

## Configuration

| Variable | Mode 1 | Mode 2 |
|---|---|---|
| `ENTRA_TENANT_ID` | any GUID | tenant GUID |
| `RESOURCE_AUDIENCE` | any GUID | resource app client id |
| `RESOURCE_BASE_URL` | `http://localhost:8080` | `https://<host>` |
| `OAUTH_PROXY_ENABLED` | `false` | `true` |
| `ENTRA_CLIENT_ID` | not set | client app client id |
| `SCOPES_SUPPORTED` | not set | scopes registered in Entra |
| `AS_ISSUER`, `AS_JWKS_URI` | local issuer | not set |

## Code

| File | Content |
|---|---|
| `src/server.ts` | Order of the checks on `/mcp` |
| `src/auth/tokenVerifier.ts` | Token validation |
| `src/auth/callerEmail.ts` | Rejection of application tokens |
| `src/auth/scopeEnforcement.ts` | Role check, scope check, audit, step-up |
| `src/auth/roles.ts` | Role names and admin-only tools |
| `src/auth/protectedResource.ts` | Discovery metadata for both modes |
| `src/auth/oauthProxy.ts` | `/register`, `/authorize`, `/token` |
| `src/auth/config.ts` | Configuration and startup checks |
| `src/mcp.ts` | Tool list per caller |
| `scripts/dev-auth.ts` | Local token issuer, mode 1 only |
