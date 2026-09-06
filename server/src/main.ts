import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitrixClient } from "./bitrix-client.ts";
import { ConfigurationError, loadConfig } from "./config.ts";
import {
  createMcpServer,
  registerUpdaterTools,
  type PluginUpdaterPort,
} from "./mcp-server.ts";
import { PluginUpdater } from "./plugin-updater.ts";
import { TaskReader } from "./tasks.ts";

function unavailableServer(
  error: ConfigurationError,
  updater: PluginUpdaterPort | null,
): McpServer {
  const server = new McpServer({ name: "bitrix24-read", version: "0.3.0" });
  registerUpdaterTools(server, updater);
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
  let updater: PluginUpdater | null = null;
  try {
    updater = new PluginUpdater(env);
  } catch {
    // Local development and a not-yet-trusted process do not have Iva plugin paths.
  }
  try {
    const client = new BitrixClient(loadConfig(env));
    return createMcpServer(new TaskReader(client), updater);
  } catch (error) {
    if (error instanceof ConfigurationError) return unavailableServer(error, updater);
    throw error;
  }
}

const server = serverFromEnvironment();
await server.connect(new StdioServerTransport());
