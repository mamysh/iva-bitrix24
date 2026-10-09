import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { SettingsStore, minimizeResult } from "./settings.ts";
import { settingsFromEnvironment } from "./settings-environment.ts";
import { SettingsMenu } from "./settings-menu.ts";
import { registerSettingsTool } from "./mcp-server.ts";
import { TaskReader } from "./tasks.ts";

function unavailableServer(
  error: ConfigurationError,
  updater: PluginUpdaterPort | null,
  settings: SettingsStore,
): McpServer {
  const server = new McpServer({ name: "bitrix24-read", version: "0.9.0-rc.2" });
  registerUpdaterTools(server, updater);
  registerSettingsTool(server, new SettingsMenu(settings, { configured: false }));
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
  dependencies: ConstructorParameters<typeof BitrixClient>[1] = {},
): Promise<McpServer> {
  let updater: PluginUpdater | null = null;
  try {
    updater = new PluginUpdater(env);
  } catch {
    // Local development and a not-yet-trusted process do not have Iva plugin paths.
  }
  const defaultsMarker = env.BITRIX24_SETTINGS_DEFAULTS;
  const settings = settingsFromEnvironment(env);
  const protect = async <T>(read: () => Promise<T>): Promise<T> => {
    await settings.read(); // Invalid policy fails closed before requesting any content.
    const result = await read();
    return minimizeResult(result, await settings.policy()) as T;
  };
  try {
    if (defaultsMarker !== undefined && !["restricted", "legacy"].includes(defaultsMarker))
      throw new ConfigurationError("BITRIX24_SETTINGS_DEFAULTS must be restricted or legacy");
    const client = new BitrixClient(loadConfig(env), dependencies);
    const tasks = new TaskReader(client, undefined, settings.policy);
    const capabilities = new ReadCapabilityReader(client, settings.policy);
    const attachmentsRoot = await resolveAttachmentsRoot(env);
    const files = new TaskFileReader(client, attachmentsRoot);
    const writer = new TaskWriter(client, env.PLUGIN_DATA, attachmentsRoot, Date.now, settings);
    const server = createMcpServer(
      {
        connectionCheck: () => protect(() => tasks.connectionCheck()),
        listTasks: (options) => protect(() => tasks.listTasks(options)),
        getTask: (taskId) => protect(() => tasks.getTask(taskId)),
        taskHistory: (options) => protect(() => tasks.taskHistory(options)),
        taskFields: () => protect(() => tasks.taskFields()),
        capabilities: () => protect(() => capabilities.capabilities()),
        taskComments: (options) => protect(() => capabilities.taskComments(options)),
        searchProjects: (options) => protect(() => capabilities.searchProjects(options)),
        searchPeople: (options) => protect(() => capabilities.searchPeople(options)),
        listDepartments: (options) => protect(() => capabilities.listDepartments(options)),
        taskFiles: (options) => protect(() => capabilities.taskFiles(options)),
        taskChecklist: (options) => protect(() => capabilities.taskChecklist(options)),
        taskRelations: (options) => protect(() => capabilities.taskRelations(options)),
      },
      updater,
      {
        list: taskId => protect(() => files.list(taskId)),
        search: options => protect(() => files.search(options)),
        download: (taskId, key) => protect(() => files.download(taskId, key)),
        viewPage: (artifactId, page) => protect(() => files.viewPage(artifactId, page)),
        release: artifactId => files.release(artifactId),
      },
      {
        stages: projectId => protect(() => writer.stages(projectId)),
        prepare: (input, presentation) => writer.prepare(input, presentation),
        apply: (draftId, reply) => writer.apply(draftId, reply),
        cancel: draftId => writer.cancel(draftId),
        status: draftId => writer.status(draftId),
      },
    );
    registerSettingsTool(server, new SettingsMenu(settings, { configured: true, connectionCheck: () => tasks.connectionCheck(), capabilities: () => capabilities.capabilities() }));
    return server;
  } catch (error) {
    if (error instanceof ConfigurationError) return unavailableServer(error, updater, settings);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = await serverFromEnvironment();
  await server.connect(new StdioServerTransport());
}
