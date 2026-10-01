import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHello } from "./tools/hello.js";
import { registerPing } from "./tools/ping.js";
import { registerTest } from "./tools/test.js";
// TODO: import your own tools here, e.g.:
// import { registerMyTool } from "./tools/myTool.js";
import { hasScope, scopeForTool } from "./auth/authorization.js";
import { roleAllows } from "./auth/roles.js";

export type ToolContext = {
  // The server is built per request, so it lists only the caller's tools.
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  // TODO: add domain-specific context your tools need (e.g. a store, the caller's email).
};

export const SERVER_NAME = "my-mcp-server"; // TODO: rename to match your server
export const SERVER_VERSION = "0.1.0";

// Hiding a tool is not a security control. The scope gate still answers 403.
export function createMcpServer({ scopes, roles }: ToolContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // A tool needs the role and the scope.
  // scopeEnforcement.ts enforces the same rule on every call.
  const granted = (tool: string, register: () => void): void => {
    if (roleAllows(roles, tool) && hasScope(scopes, scopeForTool(tool))) register();
  };

  granted("hello", () => registerHello(server));
  granted("ping", () => registerPing(server));
  granted("test", () => registerTest(server));
  // TODO: register your tools here, e.g.:
  // granted("my_tool", () => registerMyTool(server, context));

  return server;
}
