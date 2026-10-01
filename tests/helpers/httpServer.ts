import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer, MCP_PATH, type ServerDeps } from "../../src/server.js";

// startServer starts the real server on a free port. It returns helpers that call it.
export type RunningServer = {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly post: (body: unknown, token?: string, headers?: Record<string, string>) => Promise<Response>;
  readonly withClient: <T>(token: string, run: (client: Client) => Promise<T>) => Promise<T>;
};

export const RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
} as const;

export function callTool(name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } };
}

export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const server: Server = createHttpServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    post: (body, token, headers = {}) =>
      fetch(`${baseUrl}${MCP_PATH}`, {
        method: "POST",
        headers: {
          ...RPC_HEADERS,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    withClient: async (token, run) => {
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_PATH, baseUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      try {
        return await run(client);
      } finally {
        await client.close();
      }
    },
  };
}

export function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0] ?? { text: "" }).text;
}
