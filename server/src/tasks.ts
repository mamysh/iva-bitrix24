import { BitrixClient, BitrixRequestError } from "./bitrix-client.ts";

const LIST_FIELDS = [
  "ID",
  "TITLE",
  "STATUS",
  "PRIORITY",
  "DEADLINE",
  "CREATED_DATE",
  "CHANGED_DATE",
  "CLOSED_DATE",
  "RESPONSIBLE_ID",
  "CREATED_BY",
  "GROUP_ID",
  "PARENT_ID",
  "MARK",
] as const;

const GET_FIELDS = [...LIST_FIELDS, "DESCRIPTION"] as const;

type RecordLike = Readonly<Record<string, unknown>>;

export const TASK_HISTORY_FIELDS = [
  "TITLE",
  "DESCRIPTION",
  "REAL_STATUS",
  "STATUS",
  "PRIORITY",
  "MARK",
  "COMMENT",
  "DELETE",
  "NEW",
  "RENEW",
  "MOVE_TO_BACKLOG",
  "MOVE_TO_SPRINT",
  "PARENT_ID",
  "GROUP_ID",
  "STAGE_ID",
  "CREATED_BY",
  "RESPONSIBLE_ID",
  "ACCOMPLICES",
  "AUDITORS",
  "DEADLINE",
  "START_DATE_PLAN",
  "END_DATE_PLAN",
  "DURATION_PLAN",
  "DURATION_PLAN_SECONDS",
  "DURATION_FACT",
  "TIME_ESTIMATE",
  "TIME_SPENT_IN_LOGS",
  "TAGS",
  "DEPENDS_ON",
  "FILES",
  "UF_TASK_WEBDAV_FILES",
  "CHECKLIST_ITEM_CREATE",
  "CHECKLIST_ITEM_RENAME",
  "CHECKLIST_ITEM_REMOVE",
  "CHECKLIST_ITEM_CHECK",
  "CHECKLIST_ITEM_UNCHECK",
  "ADD_IN_REPORT",
  "TASK_CONTROL",
  "ALLOW_TIME_TRACKING",
  "ALLOW_CHANGE_DEADLINE",
  "FLOW_ID",
] as const;

export type TaskHistoryField = (typeof TASK_HISTORY_FIELDS)[number];

function record(value: unknown): RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function pick(source: RecordLike, upper: string, camel: string): unknown {
  return source[camel] ?? source[upper];
}

function scalar(value: unknown, maxLength = 20_000): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, maxLength);
  return null;
}

export type NormalizedTask = {
  readonly id: string | number | null;
  readonly webUrl: string | null;
  readonly title: string | number | null;
  readonly status: string | number | null;
  readonly priority: string | number | null;
  readonly deadline: string | number | null;
  readonly createdDate: string | number | null;
  readonly changedDate: string | number | null;
  readonly closedDate: string | number | null;
  readonly responsibleId: string | number | null;
  readonly createdBy: string | number | null;
  readonly groupId: string | number | null;
  readonly parentId: string | number | null;
  readonly mark: string | number | null;
  readonly description?: string | number | null;
};

function normalizeTask(
  value: unknown,
  taskWebUrl: (taskId: string | number) => string,
  includeDescription = false,
): NormalizedTask {
  const source = record(value);
  const id = scalar(pick(source, "ID", "id"));
  return {
    id,
    webUrl: id === null ? null : taskWebUrl(id),
    title: scalar(pick(source, "TITLE", "title"), 1_000),
    status: scalar(pick(source, "STATUS", "status")),
    priority: scalar(pick(source, "PRIORITY", "priority")),
    deadline: scalar(pick(source, "DEADLINE", "deadline")),
    createdDate: scalar(pick(source, "CREATED_DATE", "createdDate")),
    changedDate: scalar(pick(source, "CHANGED_DATE", "changedDate")),
    closedDate: scalar(pick(source, "CLOSED_DATE", "closedDate")),
    responsibleId: scalar(pick(source, "RESPONSIBLE_ID", "responsibleId")),
    createdBy: scalar(pick(source, "CREATED_BY", "createdBy")),
    groupId: scalar(pick(source, "GROUP_ID", "groupId")),
    parentId: scalar(pick(source, "PARENT_ID", "parentId")),
    mark: scalar(pick(source, "MARK", "mark")),
    ...(includeDescription
      ? {
          description: scalar(
            pick(source, "DESCRIPTION", "description"),
            20_000,
          ),
        }
      : {}),
  };
}

export type ListTaskOptions = {
  readonly scope: "mine" | "accessible";
  readonly responsibleId?: number | undefined;
  readonly status?: number | undefined;
  readonly deadlineFrom?: string | undefined;
  readonly deadlineTo?: string | undefined;
  readonly limit: number;
  readonly start: number;
  readonly sortBy: "ID" | "DEADLINE" | "CREATED_DATE" | "CHANGED_DATE";
  readonly sortDirection: "asc" | "desc";
};

export type TaskHistoryOptions = {
  readonly taskId: number;
  readonly event?: TaskHistoryField | undefined;
  readonly limit: number;
  readonly start: number;
  readonly sortDirection: "asc" | "desc";
};

export class TaskReader {
  readonly #client: BitrixClient;

  constructor(client: BitrixClient) {
    this.#client = client;
  }

  async connectionCheck(): Promise<unknown> {
    const profile = record(await this.#client.call("profile"));
    return {
      connected: true,
      user: {
        id: scalar(pick(profile, "ID", "id")),
        name: scalar(pick(profile, "NAME", "name"), 200),
        lastName: scalar(pick(profile, "LAST_NAME", "lastName"), 200),
        admin: scalar(pick(profile, "ADMIN", "admin")),
      },
    };
  }

  async listTasks(options: ListTaskOptions): Promise<unknown> {
    const filter: Record<string, unknown> = {};
    if (options.scope === "mine") {
      const profile = record(await this.#client.call("profile"));
      const id = pick(profile, "ID", "id");
      if (typeof id !== "string" && typeof id !== "number")
        throw new BitrixRequestError("PROFILE_HAS_NO_ID");
      filter.RESPONSIBLE_ID = id;
    } else if (options.responsibleId !== undefined) {
      filter.RESPONSIBLE_ID = options.responsibleId;
    }
    if (options.status !== undefined) filter.STATUS = options.status;
    if (options.deadlineFrom) filter[">=DEADLINE"] = options.deadlineFrom;
    if (options.deadlineTo) filter["<=DEADLINE"] = options.deadlineTo;

    const page = await this.#client.callPage("tasks.task.list", {
        order: { [options.sortBy]: options.sortDirection },
        filter,
        select: LIST_FIELDS,
        start: options.start,
      });
    const raw = record(page.result);
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const hasMoreInFetchedPage = tasks.length > options.limit;
    const nextStart = hasMoreInFetchedPage
      ? options.start + options.limit
      : page.next;
    return {
      tasks: tasks
        .slice(0, options.limit)
        .map((task) => normalizeTask(task, (id) => this.#client.taskWebUrl(id))),
      returned: Math.min(tasks.length, options.limit),
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async getTask(taskId: number): Promise<unknown> {
    const raw = record(
      await this.#client.call("tasks.task.get", {
        taskId,
        select: GET_FIELDS,
      }),
    );
    return {
      task: normalizeTask(
        raw.task,
        (id) => this.#client.taskWebUrl(id),
        true,
      ),
    };
  }

  async taskHistory(options: TaskHistoryOptions): Promise<unknown> {
    const page = await this.#client.callPage("tasks.task.history.list", {
      taskId: options.taskId,
      ...(options.event ? { filter: { FIELD: options.event } } : {}),
      order: { createdDate: options.sortDirection },
      start: options.start,
    });
    const raw = record(page.result);
    const history = Array.isArray(raw.list) ? raw.list : [];
    const hasMoreInFetchedPage = history.length > options.limit;
    const nextStart = hasMoreInFetchedPage
      ? options.start + options.limit
      : page.next;
    return {
      events: history.slice(0, options.limit).map((value) => {
        const source = record(value);
        const change = record(source.value);
        const user = record(source.user);
        return {
          id: scalar(source.id),
          createdDate: scalar(source.createdDate),
          field: scalar(source.field, 100),
          from: scalar(change.from, 2_000),
          to: scalar(change.to, 2_000),
          actor: {
            id: scalar(user.id),
            name: scalar(user.name, 200),
            lastName: scalar(user.lastName, 200),
            secondName: scalar(user.secondName, 200),
          },
        };
      }),
      returned: Math.min(history.length, options.limit),
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async taskFields(): Promise<unknown> {
    const raw = record(await this.#client.call("tasks.task.getFields"));
    const fields = record(raw.fields);
    const safe = Object.entries(fields).map(([name, value]) => {
      const field = record(value);
      return {
        name: name.slice(0, 200),
        title: scalar(field.title, 500),
        type: scalar(field.type, 100),
        required: field.required === true,
        multiple: field.multiple === true,
        readonly: field.readonly === true,
      };
    });
    return { fields: safe.slice(0, 500), truncated: safe.length > 500 };
  }
}
