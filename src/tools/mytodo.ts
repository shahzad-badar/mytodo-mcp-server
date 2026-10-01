import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TodoStore } from "../store/store.js";
import { jsonResult, errorResult } from "./results.js";
import { emitError, reasonOf } from "../observability/log.js";

type Context = { ownerEmail: string; store: TodoStore };

export function registerAddTodo(server: McpServer, ctx: Context): void {
  server.registerTool(
    "add_todo",
    {
      title: "Add todo",
      description: "Add a new todo item to the caller's todo list.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("The title of the todo item."),
        description: z.string().max(1000).optional().describe("Optional description or notes."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, description }) => {
      try {
        const todo = {
          id: randomUUID(),
          title,
          description,
          completed: false,
          createdAt: new Date().toISOString(),
        };
        await ctx.store.add(ctx.ownerEmail, todo);
        return jsonResult(todo);
      } catch (error) {
        emitError("add-todo-error", { reason: reasonOf(error) });
        return errorResult("Could not add the todo. Try again later.");
      }
    },
  );
}

export function registerListTodos(server: McpServer, ctx: Context): void {
  server.registerTool(
    "list_todos",
    {
      title: "List todos",
      description: "List all todo items in the caller's todo list.",
      inputSchema: {
        completed: z
          .boolean()
          .optional()
          .describe("Filter by completion status. Omit to return all items."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ completed }) => {
      try {
        const todos = await ctx.store.list(ctx.ownerEmail);
        const filtered =
          completed === undefined ? todos : todos.filter((t) => t.completed === completed);
        return jsonResult(filtered);
      } catch (error) {
        emitError("list-todos-error", { reason: reasonOf(error) });
        return errorResult("Could not list todos. Try again later.");
      }
    },
  );
}

export function registerCompleteTodo(server: McpServer, ctx: Context): void {
  server.registerTool(
    "complete_todo",
    {
      title: "Complete todo",
      description: "Mark a todo item as completed.",
      inputSchema: {
        id: z.string().uuid().describe("The id of the todo item to mark as completed."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const updated = await ctx.store.complete(ctx.ownerEmail, id);
        if (!updated) return errorResult(`Todo not found: ${id}`);
        return jsonResult(updated);
      } catch (error) {
        emitError("complete-todo-error", { reason: reasonOf(error) });
        return errorResult("Could not complete the todo. Try again later.");
      }
    },
  );
}

export function registerDeleteTodo(server: McpServer, ctx: Context): void {
  server.registerTool(
    "delete_todo",
    {
      title: "Delete todo",
      description: "Permanently delete a todo item.",
      inputSchema: {
        id: z.string().uuid().describe("The id of the todo item to delete."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const deleted = await ctx.store.remove(ctx.ownerEmail, id);
        if (!deleted) return errorResult(`Todo not found: ${id}`);
        return jsonResult({ deleted: id });
      } catch (error) {
        emitError("delete-todo-error", { reason: reasonOf(error) });
        return errorResult("Could not delete the todo. Try again later.");
      }
    },
  );
}
