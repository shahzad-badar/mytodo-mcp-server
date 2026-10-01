import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey, type JWTPayload } from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthConfig } from "./config.js";

// Entra v2 names the client in azp or appid and the user in preferred_username or upn.
type EntraClaims = JWTPayload & {
  scp?: string;
  azp?: string;
  appid?: string;
  tid?: string;
  preferred_username?: string;
  upn?: string;
};

function rolesFrom(roles: unknown): readonly string[] {
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
}

function scopesFromScp(scp: string | undefined): string[] {
  return (scp ?? "").split(" ").filter(Boolean);
}

// jose caches and rotates Entra's remote JWKS.
export function createRemoteJwks(config: AuthConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(config.jwksUri));
}

// The verifier checks the signature, issuer, audience, exp and nbf.
// Production uses the remote JWKS and tests inject a local one.
export function createTokenVerifier(config: AuthConfig, getKey: JWTVerifyGetKey): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let claims: EntraClaims;
      try {
        const { payload } = await jwtVerify<EntraClaims>(token, getKey, {
          issuer: config.issuer,
          audience: config.resourceAudience,
          algorithms: ["RS256"],
          requiredClaims: ["exp"],
        });
        claims = payload;
      } catch {
        // The generic message hides which check failed.
        throw new InvalidTokenError("The access token is invalid.");
      }

      return {
        token,
        clientId: claims.azp ?? claims.appid ?? "",
        scopes: scopesFromScp(claims.scp),
        expiresAt: claims.exp,
        extra: {
          sub: claims.sub,
          tenantId: claims.tid,
          email: (claims.preferred_username ?? claims.upn ?? "").toLowerCase(),
          roles: rolesFrom(claims.roles),
        },
      };
    },
  };
}
