import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitrixClient } from "./bitrix-client.ts";
import { ConfigurationError, loadConfig } from "./config.ts";
import { createMcpServer } from "./mcp-server.ts";
import { TaskReader } from "./tasks.ts";

function unavailableServer(error: ConfigurationError): McpServer {
  const server = new McpServer({ name: "bitrix24-read", version: "0.1.0" });
  server.registerTool(
    "bitrix24_connection_check",
    {
      description: "Report whether the Bitrix24 plugin is configured.",
    },
    () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: "NOT_CONFIGURED" }),
        },
      ],
    }),
  );
  console.error(`[bitrix24-read] configuration unavailable: ${error.message}`);
  return server;
}

export function serverFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpServer {
  try {
    const client = new BitrixClient(loadConfig(env));
    return createMcpServer(new TaskReader(client));
  } catch (error) {
    if (error instanceof ConfigurationError) return unavailableServer(error);
    throw error;
  }
}

const server = serverFromEnvironment();
await server.connect(new StdioServerTransport());
