import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { argv, env, exit } from "node:process";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { loadAuthConfig } from "../src/auth/config.js";
import { MEMBER } from "../src/auth/roles.js";

const KID = "dev-local";
const TOKEN_LIFETIME = "7d";
const CLIENT_ID = "dev-local-client";
const KEY_FILE = env.DEV_AUTH_KEY_FILE?.trim() || ".dev-auth/signing-key.json";
const PORT = Number(env.DEV_AUTH_PORT ?? 9001);
const JWKS_PATH = "/jwks";

export type DevKeys = {
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
};

export const devAuthOrigin = (port: number = PORT): string => `http://127.0.0.1:${port}`;
export const devAuthIssuer = (port: number = PORT): string => devAuthOrigin(port);
export const devAuthJwksUri = (port: number = PORT): string => `${devAuthOrigin(port)}${JWKS_PATH}`;

async function readKeys(path: string): Promise<DevKeys | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DevKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function createKeys(path: string): Promise<DevKeys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const keys: DevKeys = {
    privateJwk: { ...(await exportJWK(privateKey)), kid: KID, alg: "RS256" },
    publicJwk: { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

// The key persists on disk. A token in a client config then stays valid after a restart.
export async function loadOrCreateKeys(path: string = KEY_FILE): Promise<DevKeys> {
  return (await readKeys(path)) ?? (await createKeys(path));
}

type MintInput = {
  readonly privateJwk: JWK;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly user: string;
  // Entra puts the app roles of the user's groups in this claim.
  readonly roles?: readonly string[];
  readonly issuer?: string;
};

// The token carries the claims of an Entra v2 token. The server reads it like a real one.
export async function mintToken({
  privateJwk,
  audience,
  scopes,
  user,
  roles,
  issuer = devAuthIssuer(),
}: MintInput): Promise<string> {
  const key = await importJWK(privateJwk, "RS256");
  return new SignJWT({
    scp: scopes.join(" "),
    azp: CLIENT_ID,
    preferred_username: user,
    ...(roles && roles.length > 0 ? { roles } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setSubject(user)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(TOKEN_LIFETIME)
    .sign(key);
}

export function startJwksServer({
  publicJwk,
  port = PORT,
}: {
  readonly publicJwk: JWK;
  readonly port?: number;
}): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url !== JWKS_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function requiredEnv(name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    console.error(`[dev-auth] ${name} is not set. Copy .env.example to .env first.`);
    exit(1);
  }
  return value;
}

async function serve(): Promise<void> {
  const { publicJwk } = await loadOrCreateKeys();
  await startJwksServer({ publicJwk });
  console.log(
    [
      `[dev-auth] JWKS on ${devAuthJwksUri()}`,
      ``,
      `  Point the MCP server at it:`,
      `    AS_ISSUER=${devAuthIssuer()}`,
      `    AS_JWKS_URI=${devAuthJwksUri()}`,
      ``,
      `  Get a token with:  npm run dev:token`,
      ``,
    ].join("\n"),
  );
}

// The token carries MEMBER by default. `npm run dev:token -- OtherRole` mints another role
// so you can test a role that grants nothing.
async function printToken(): Promise<void> {
  const { privateJwk } = await loadOrCreateKeys();
  // The script reads the scopes from the server config, so dev and server agree.
  const { scopesSupported, resourceAudience } = loadAuthConfig(env);
  const named = argv.slice(3).filter((role) => role.trim() !== "");
  const roles = named.length > 0 ? named : [MEMBER];

  console.log(
    await mintToken({
      privateJwk,
      audience: resourceAudience,
      scopes: scopesSupported,
      roles,
      user: requiredEnv("DEV_AUTH_USER"),
    }),
  );
}

const COMMANDS: Record<string, () => Promise<void>> = { serve, token: printToken };

if (argv[1]?.endsWith("dev-auth.ts")) {
  const command = COMMANDS[argv[2] ?? ""];
  if (!command) {
    console.error("[dev-auth] usage: tsx scripts/dev-auth.ts <serve|token>");
    exit(1);
  }
  await command();
}
