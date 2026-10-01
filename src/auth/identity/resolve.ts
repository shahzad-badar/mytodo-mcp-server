import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { UserIdentity, AgentIdentity } from "./types.js";

export type ResolvedIdentities = {
  readonly user: UserIdentity;
  readonly agent: AgentIdentity;
};

export function resolveIdentities(auth: AuthInfo): ResolvedIdentities {
  const sub = typeof auth.extra?.sub === "string" ? auth.extra.sub : "";
  const email = typeof auth.extra?.email === "string" ? auth.extra.email : "";
  return {
    user: { sub, email },
    agent: { clientId: auth.clientId },
  };
}
