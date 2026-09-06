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
  const details = errorDetails(
    code,
    error instanceof BitrixRequestError && error.retryable,
  );
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: code, ...details }),
      },
    ],
  };
}

function errorDetails(code: string, retryable: boolean) {
  if (["NO_AUTH_FOUND", "INVALID_CREDENTIALS", "WRONG_AUTH_TYPE"].includes(code))
    return {
      category: "authentication",
      retryable: false,
      action: "rotate_webhook",
    };
  if (code === "INSUFFICIENT_SCOPE")
    return {
      category: "permission",
      retryable: false,
      action: "add_required_scope",
    };
  if (["ACCESS_DENIED", "ERROR_CORE"].includes(code))
    return {
      category: "access",
      retryable: false,
      action: "check_user_access",
    };
  if (code === "TASK_NOT_FOUND_OR_DENIED")
    return {
      category: "access",
      retryable: false,
      action: "check_task_id_or_access",
    };
  if (["INVALID_PROFILE", "TASK_ID_MISMATCH"].includes(code))
    return {
      category: "upstream",
      retryable: false,
      action: "inspect_integration",
    };
  if (
    [
      "QUERY_LIMIT_EXCEEDED",
      "OPERATION_TIME_LIMIT",
      "OVERLOAD_LIMIT",
      "HTTP_429",
      "HTTP_503",
    ].includes(code)
  )
    return { category: "temporary", retryable: true, action: "retry_later" };
  if (["TIMEOUT", "NETWORK_ERROR"].includes(code))
    return { category: "network", retryable: true, action: "check_network" };
  if (
    [
      "INVALID_RESPONSE",
      "RESPONSE_TOO_LARGE",
      "REDIRECT_REFUSED",
      "UPSTREAM_ERROR",
    ].includes(code)
  )
    return {
      category: "upstream",
      retryable: false,
      action: "inspect_integration",
    };
  return { category: "internal", retryable, action: "inspect_plugin" };
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
        "Start the fresh iva-bitrix24 update only after the owner chose the Update option in Iva's structured ask_question prompt in this private conversation.",
      inputSchema: z
        .object({
          candidateSha: z.string().regex(/^[a-f0-9]{40}$/u),
          approvalToken: z.string().regex(/^[A-F0-9]{24}$/u),
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
  const server = new McpServer({ name: "bitrix24-read", version: "0.3.0-rc.7" });
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
        "List a bounded normalized page of Bitrix24 tasks. Defaults to tasks assigned to the webhook user and filters by real status.",
      inputSchema: z
        .object({
          scope: z.enum(["mine", "accessible"]).default("mine"),
          responsibleId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
          status: z
            .number()
            .int()
            .min(2)
            .max(6)
            .describe(
              "Real task status: 2 pending, 3 in progress, 4 awaiting control, 5 completed, 6 deferred.",
            )
            .optional(),
          overdueOnly: z
            .boolean()
            .default(false)
            .describe(
              "Return overdue tasks using Bitrix24's documented filter: deadline before server time and real status not 4 or 5.",
            ),
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
        )
        .refine(
          (value) =>
            !value.overdueOnly ||
            (value.status === undefined &&
              value.deadlineFrom === undefined &&
              value.deadlineTo === undefined),
          {
            message:
              "overdueOnly cannot be combined with status or explicit deadline bounds",
            path: ["overdueOnly"],
          },
        )
        .refine(
          (value) =>
            value.deadlineFrom === undefined ||
            value.deadlineTo === undefined ||
            Date.parse(value.deadlineFrom) <= Date.parse(value.deadlineTo),
          {
            message: "deadlineFrom must not be later than deadlineTo",
            path: ["deadlineTo"],
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
      inputSchema: z
        .object({
          taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
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
          taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
        "Read safe metadata only for fields exposed by the public task contract, without returning values from any task.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => safe(() => reader.taskFields()),
  );

  return server;
}
