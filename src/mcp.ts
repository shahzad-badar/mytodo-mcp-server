import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPing } from "./tools/ping.js";
import {
  registerAddTodo,
  registerListTodos,
  registerCompleteTodo,
  registerDeleteTodo,
} from "./tools/mytodo.js";
import { hasScope, scopeForTool } from "./auth/authorization.js";
import { roleAllows } from "./auth/roles.js";
import type { TodoStore } from "./store/store.js";

export type ToolContext = {
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  readonly ownerEmail: string;
  readonly store: TodoStore;
};

export const SERVER_NAME = "mytodo-mcp-server";
export const SERVER_VERSION = "0.1.0";

// Hiding a tool is not a security control. The scope gate still answers 403.
export function createMcpServer({ scopes, roles, ownerEmail, store }: ToolContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // A tool needs the role and the scope.
  // scopeEnforcement.ts enforces the same rule on every call.
  const granted = (tool: string, register: () => void): void => {
    if (roleAllows(roles, tool) && hasScope(scopes, scopeForTool(tool))) register();
  };

  granted("ping", () => registerPing(server));
  granted("add_todo", () => registerAddTodo(server, { ownerEmail, store }));
  granted("list_todos", () => registerListTodos(server, { ownerEmail, store }));
  granted("complete_todo", () => registerCompleteTodo(server, { ownerEmail, store }));
  granted("delete_todo", () => registerDeleteTodo(server, { ownerEmail, store }));

  return server;
}
