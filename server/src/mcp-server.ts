import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { BitrixRequestError } from "./bitrix-client.ts";
import {
  TASK_HISTORY_FIELDS,
  type ListTaskOptions,
  type TaskHistoryOptions,
} from "./tasks.ts";
import type { ApplyUpdateInput } from "./plugin-updater.ts";

export type TaskReaderPort = {
  readonly connectionCheck: () => Promise<unknown>;
  readonly listTasks: (options: ListTaskOptions) => Promise<unknown>;
  readonly getTask: (taskId: number) => Promise<unknown>;
  readonly taskHistory: (options: TaskHistoryOptions) => Promise<unknown>;
  readonly taskFields: () => Promise<unknown>;
};

export type PluginUpdaterPort = {
  readonly check: () => Promise<unknown>;
  readonly apply: (input: ApplyUpdateInput) => Promise<unknown>;
  readonly status: () => Promise<unknown>;
};

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function success(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  const code =
    error instanceof BitrixRequestError
      ? error.code
      : error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)
        ? error.message
        : "INTERNAL_ERROR";
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: code }),
      },
    ],
  };
}

async function safe(run: () => Promise<unknown>) {
  try {
    return success(await run());
  } catch (error) {
    return failure(error);
  }
}

export function registerUpdaterTools(
  server: McpServer,
  updater: PluginUpdaterPort | null,
): void {
  if (!updater) return;
  server.registerTool(
    "iva_bitrix24_update_check",
    {
      description:
        "Check the installed iva-bitrix24 Git source and GitHub Actions for an update. This does not change the server.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => safe(() => updater.check()),
  );
  server.registerTool(
    "iva_bitrix24_update_apply",
    {
      description:
        "Start a previously checked iva-bitrix24 update. Call only when the owner explicitly typed the exact confirmation phrase returned by iva_bitrix24_update_check in the current direct conversation.",
      inputSchema: z
        .object({
          candidateSha: z.string().regex(/^[a-f0-9]{40}$/u),
          confirmation: z.string().min(1).max(64),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) => safe(() => updater.apply(input)),
  );
  server.registerTool(
    "iva_bitrix24_update_status",
    {
      description: "Read the latest background iva-bitrix24 update or rollback status.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => safe(() => updater.status()),
  );
}

export function createMcpServer(
  reader: TaskReaderPort,
  updater: PluginUpdaterPort | null = null,
): McpServer {
  const server = new McpServer({ name: "bitrix24-read", version: "0.2.0" });
  registerUpdaterTools(server, updater);

  server.registerTool(
    "bitrix24_connection_check",
    {
      description:
        "Check the configured Bitrix24 webhook, current user and Tasks scope with read-only methods.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => safe(() => reader.connectionCheck()),
  );

  server.registerTool(
    "bitrix24_list_tasks",
    {
      description:
        "List a bounded page of Bitrix24 tasks. Defaults to tasks assigned to the webhook user.",
      inputSchema: z
        .object({
          scope: z.enum(["mine", "accessible"]).default("mine"),
          responsibleId: z.number().int().positive().optional(),
          status: z.number().int().min(1).max(7).optional(),
          deadlineFrom: z.iso.datetime({ offset: true }).optional(),
          deadlineTo: z.iso.datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(50).default(20),
          start: z.number().int().min(0).max(10_000).default(0),
          sortBy: z
            .enum(["ID", "DEADLINE", "CREATED_DATE", "CHANGED_DATE"])
            .default("DEADLINE"),
          sortDirection: z.enum(["asc", "desc"]).default("asc"),
        })
        .strict()
        .refine(
          (value) =>
            value.scope === "accessible" || value.responsibleId === undefined,
          {
            message: "responsibleId is only valid with scope=accessible",
            path: ["responsibleId"],
          },
        ),
      annotations: readOnly,
    },
    (options) => safe(() => reader.listTasks(options)),
  );

  server.registerTool(
    "bitrix24_get_task",
    {
      description: "Read one Bitrix24 task by its positive numeric identifier.",
      inputSchema: z.object({ taskId: z.number().int().positive() }).strict(),
      annotations: readOnly,
    },
    ({ taskId }) => safe(() => reader.getTask(taskId)),
  );

  server.registerTool(
    "bitrix24_task_history",
    {
      description:
        "Read a bounded page of normalized change-history events for one accessible Bitrix24 task.",
      inputSchema: z
        .object({
          taskId: z.number().int().positive(),
          event: z.enum(TASK_HISTORY_FIELDS).optional(),
          limit: z.number().int().min(1).max(50).default(20),
          start: z.number().int().min(0).max(10_000).default(0),
          sortDirection: z.enum(["asc", "desc"]).default("desc"),
        })
        .strict(),
      annotations: readOnly,
    },
    (options) => safe(() => reader.taskHistory(options)),
  );

  server.registerTool(
    "bitrix24_task_fields",
    {
      description:
        "Read safe metadata for task fields without returning values from any task.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => safe(() => reader.taskFields()),
  );

  return server;
}
