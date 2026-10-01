import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// TODO: rename these to match the Entra app roles on your resource app.
// A group holds a role, so a role fits group-based access.
export const ADMIN = "Admin";
export const MEMBER = "Member";

// TODO: list the tool names that only ADMIN may call.
const ADMIN_ONLY: readonly string[] = [];

export function rolesOf(auth: AuthInfo | undefined): readonly string[] {
  const roles = (auth?.extra as { readonly roles?: unknown } | undefined)?.roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
}

// roleAllows checks only the role. A tool also needs its scope.
export function roleAllows(roles: readonly string[], toolName: string): boolean {
  if (roles.includes(ADMIN)) return true;
  return roles.includes(MEMBER) && !ADMIN_ONLY.includes(toolName);
}

// grantsAnyTool lets the gate refuse a caller who holds no tool role.
// An empty tool list would answer every call with "Method not found".
export function grantsAnyTool(roles: readonly string[]): boolean {
  return roles.includes(ADMIN) || roles.includes(MEMBER);
}
