import type { UserIdentity, AgentIdentity, AccessIdentity } from "./identity/types.js";

// Backend access never receives the inbound token, so it cannot pass it through.
// Implement it with OBO or client credentials. README.md describes the pattern.
export type BackendAccessRequest = {
  readonly user: UserIdentity;
  readonly agent: AgentIdentity;
  readonly backendId: string;
};

export interface BackendAccess {
  acquire(request: BackendAccessRequest): Promise<AccessIdentity>;
}

export const backendAccess: BackendAccess = {
  async acquire(): Promise<AccessIdentity> {
    throw new Error("backendAccess is not implemented yet.");
  },
};
