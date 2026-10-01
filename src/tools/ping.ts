import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ping is a zero-argument liveness probe that returns the server time.
export function registerPing(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Return the current server time as an ISO-8601 timestamp.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  );
}
