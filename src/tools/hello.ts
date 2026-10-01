import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// hello shows an input schema, an output schema and annotations.
export function registerHello(server: McpServer): void {
  server.registerTool(
    "hello",
    {
      title: "Hello",
      description: "Return a friendly greeting, optionally addressed to a name.",
      inputSchema: {
        name: z.string().max(100).optional().describe("Who to greet. Defaults to 'world'."),
      },
      outputSchema: {
        greeting: z.string().describe("The greeting."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    ({ name }) => {
      const greeting = `Hello, ${name ?? "world"}!`;
      return {
        content: [{ type: "text", text: greeting }],
        structuredContent: { greeting },
      };
    },
  );
}
