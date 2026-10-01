import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { loadAuthConfig, type AuthConfig } from "../../src/auth/config.js";
import { MEMBER } from "../../src/auth/roles.js";

// This test fixture signs tokens with a local RSA key and serves the key as a JWKS.
export const TEST_ISSUER = "https://login.microsoftonline.com/test-tenant/v2.0";
export const TEST_AUDIENCE = "00000000-0000-0000-0000-resourceguid";
const KID = "test-key";

export type MintOptions = {
  readonly scp?: string;
  readonly aud?: string;
  readonly iss?: string;
  readonly sub?: string;
  readonly azp?: string;
  readonly preferredUsername?: string;
  readonly expiresIn?: string;
  // A token needs a role and a scope. The fixture therefore adds a role by default.
  readonly roles?: readonly string[];
};

export type TestAuth = {
  readonly config: AuthConfig;
  readonly getKey: JWTVerifyGetKey;
  readonly mintToken: (opts?: MintOptions) => Promise<string>;
};

export async function setupTestAuth(extraEnv: Record<string, string> = {}): Promise<TestAuth> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const getKey = createLocalJWKSet({ keys: [publicJwk] });

  const config = loadAuthConfig({
    ENTRA_TENANT_ID: "test-tenant",
    AS_ISSUER: TEST_ISSUER,
    RESOURCE_AUDIENCE: TEST_AUDIENCE,
    RESOURCE_BASE_URL: "http://localhost",
    SCOPES_SUPPORTED: "tools.hello tools.ping tools.test",
    ...extraEnv,
  });

  async function mintToken(opts: MintOptions = {}): Promise<string> {
    return new SignJWT({
      scp: opts.scp ?? "tools.hello tools.ping tools.test",
      azp: opts.azp ?? "test-client-id",
      sub: opts.sub ?? "user@example.com",
      preferred_username: opts.preferredUsername ?? "user@example.com",
      roles: opts.roles ?? [MEMBER],
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(opts.iss ?? TEST_ISSUER)
      .setAudience(opts.aud ?? TEST_AUDIENCE)
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(privateKey);
  }

  return { config, getKey, mintToken };
}
