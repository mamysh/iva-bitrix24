import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitrixClient } from "./bitrix-client.ts";
import { ConfigurationError, loadConfig } from "./config.ts";
import { TaskFileReader } from "./file-capabilities.ts";
import {
  createMcpServer,
  registerUpdaterTools,
  type PluginUpdaterPort,
} from "./mcp-server.ts";
import { PluginUpdater } from "./plugin-updater.ts";
import { ReadCapabilityReader } from "./read-capabilities.ts";
import { resolveAttachmentsRoot } from "./attachments-root.ts";
import { TaskWriter } from "./task-writes.ts";
import { TaskReader } from "./tasks.ts";

function unavailableServer(
  error: ConfigurationError,
  updater: PluginUpdaterPort | null,
): McpServer {
  const server = new McpServer({ name: "bitrix24-read", version: "0.7.0-rc.2" });
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

export async function serverFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<McpServer> {
  let updater: PluginUpdater | null = null;
  try {
    updater = new PluginUpdater(env);
  } catch {
    // Local development and a not-yet-trusted process do not have Iva plugin paths.
  }
  try {
    const client = new BitrixClient(loadConfig(env));
    const tasks = new TaskReader(client);
    const capabilities = new ReadCapabilityReader(client);
    const attachmentsRoot = await resolveAttachmentsRoot(env);
    const files = new TaskFileReader(client, attachmentsRoot);
    return createMcpServer(
      {
        connectionCheck: () => tasks.connectionCheck(),
        listTasks: (options) => tasks.listTasks(options),
        getTask: (taskId) => tasks.getTask(taskId),
        taskHistory: (options) => tasks.taskHistory(options),
        taskFields: () => tasks.taskFields(),
        capabilities: () => capabilities.capabilities(),
        taskComments: (options) => capabilities.taskComments(options),
        searchProjects: (options) => capabilities.searchProjects(options),
        searchPeople: (options) => capabilities.searchPeople(options),
        listDepartments: (options) => capabilities.listDepartments(options),
        taskFiles: (options) => capabilities.taskFiles(options),
        taskChecklist: (options) => capabilities.taskChecklist(options),
        taskRelations: (options) => capabilities.taskRelations(options),
      },
      updater,
      files,
      new TaskWriter(client, env.PLUGIN_DATA, attachmentsRoot),
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return unavailableServer(error, updater);
    throw error;
  }
}

const server = await serverFromEnvironment();
await server.connect(new StdioServerTransport());
