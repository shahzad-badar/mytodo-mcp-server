import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Edit this message and call the tool again to prove a client sees code changes.
export const TEST_MESSAGE = "test tool is live";

export function registerTest(server: McpServer): void {
  server.registerTool(
    "test",
    {
      title: "Test",
      description: "Return a marker string, to confirm a running client sees server code changes.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    () => ({
      content: [{ type: "text", text: TEST_MESSAGE }],
    }),
  );
}
