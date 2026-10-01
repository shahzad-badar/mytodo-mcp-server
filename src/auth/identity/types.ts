export type UserIdentity = {
  readonly sub: string;
  readonly email: string;
};

export type AgentIdentity = {
  readonly clientId: string;
};

// A backend call uses a new token scoped to that backend, never the inbound token.
export type AccessIdentity = {
  readonly audience: string;
  readonly token: string;
};
