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
  "CREATOR",
  "RESPONSIBLE",
  "GROUP",
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

function isRecordLike(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): RecordLike {
  return isRecordLike(value) ? value : {};
}

function pick(source: RecordLike, upper: string, camel: string): unknown {
  return source[camel] ?? source[upper];
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value === "string") return value.slice(0, maxLength);
  return null;
}

function historyValue(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? value : null;
}

function requestIdentifier(value: unknown): number | null {
  const normalized = identifier(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function isoDate(value: unknown, field: string, warnings: string[]): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return value;
  warnings.push(`invalid_${field}`);
  return null;
}

const STATUS_NAMES: Readonly<Record<number, string>> = {
  2: "pending",
  3: "in_progress",
  4: "awaiting_control",
  5: "completed",
  6: "deferred",
};

const PRIORITY_NAMES: Readonly<Record<number, string>> = {
  0: "low",
  1: "medium",
  2: "high",
};

function entityName(
  value: unknown,
  expectedId: string | null,
  field: string,
  warnings: string[],
): string | null {
  if (expectedId === null) return null;
  const source = record(value);
  const embeddedId = identifier(pick(source, "ID", "id"));
  if (embeddedId !== null && embeddedId !== expectedId) {
    warnings.push(`${field}_id_mismatch`);
    return null;
  }
  return text(pick(source, "NAME", "name"), 300);
}

export type NormalizedTask = {
  readonly id: string | null;
  readonly webUrl: string | null;
  readonly title: string | null;
  readonly status: number | null;
  readonly statusName: string;
  readonly priority: number | null;
  readonly priorityName: string;
  readonly deadline: string | null;
  readonly createdDate: string | null;
  readonly changedDate: string | null;
  readonly closedDate: string | null;
  readonly responsibleId: string | null;
  readonly responsibleName: string | null;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly parentId: string | null;
  readonly mark: "N" | "P" | null;
  readonly markName: "negative" | "positive" | "unrated" | "unknown";
  readonly dataWarnings?: readonly string[];
  readonly description?: string | null;
};

function normalizeTask(
  value: unknown,
  taskWebUrl: (taskId: string | number) => string,
  includeDescription = false,
): NormalizedTask {
  const source = record(value);
  const warnings: string[] = [];
  const rawId = pick(source, "ID", "id");
  const rawStatus = pick(source, "STATUS", "status");
  const rawPriority = pick(source, "PRIORITY", "priority");
  const rawResponsibleId = pick(source, "RESPONSIBLE_ID", "responsibleId");
  const rawCreatedBy = pick(source, "CREATED_BY", "createdBy");
  const rawGroupId = pick(source, "GROUP_ID", "groupId");
  const rawParentId = pick(source, "PARENT_ID", "parentId");
  const id = identifier(rawId);
  const status = integer(rawStatus);
  const priority = integer(rawPriority);
  const rawMark = pick(source, "MARK", "mark");
  const mark = rawMark === "N" || rawMark === "P" ? rawMark : null;
  const responsibleId = identifier(rawResponsibleId);
  const createdBy = identifier(rawCreatedBy);
  const groupId = identifier(rawGroupId);
  const parentId = identifier(rawParentId);
  if (hasValue(rawId) && id === null) warnings.push("invalid_id");
  if (hasValue(rawStatus) && (status === null || STATUS_NAMES[status] === undefined))
    warnings.push("unknown_status");
  if (
    hasValue(rawPriority) &&
    (priority === null || PRIORITY_NAMES[priority] === undefined)
  )
    warnings.push("unknown_priority");
  if (hasValue(rawMark) && mark === null) warnings.push("unknown_mark");
  if (hasValue(rawResponsibleId) && responsibleId === null)
    warnings.push("invalid_responsible_id");
  if (hasValue(rawCreatedBy) && createdBy === null)
    warnings.push("invalid_created_by");
  if (hasValue(rawGroupId) && groupId === null) warnings.push("invalid_group_id");
  if (hasValue(rawParentId) && parentId === null) warnings.push("invalid_parent_id");
  return {
    id,
    webUrl: id === null ? null : taskWebUrl(id),
    title: text(pick(source, "TITLE", "title"), 1_000),
    status,
    statusName: status === null ? "unknown" : (STATUS_NAMES[status] ?? "unknown"),
    priority,
    priorityName:
      priority === null ? "unknown" : (PRIORITY_NAMES[priority] ?? "unknown"),
    deadline: isoDate(pick(source, "DEADLINE", "deadline"), "deadline", warnings),
    createdDate: isoDate(
      pick(source, "CREATED_DATE", "createdDate"),
      "created_date",
      warnings,
    ),
    changedDate: isoDate(
      pick(source, "CHANGED_DATE", "changedDate"),
      "changed_date",
      warnings,
    ),
    closedDate: isoDate(
      pick(source, "CLOSED_DATE", "closedDate"),
      "closed_date",
      warnings,
    ),
    responsibleId,
    responsibleName: entityName(
      source.responsible,
      responsibleId,
      "responsible",
      warnings,
    ),
    createdBy,
    createdByName: entityName(source.creator, createdBy, "creator", warnings),
    groupId,
    groupName: entityName(source.group, groupId, "group", warnings),
    parentId,
    mark,
    markName:
      rawMark === null || rawMark === undefined || rawMark === ""
        ? "unrated"
        : rawMark === "N"
          ? "negative"
          : rawMark === "P"
            ? "positive"
            : "unknown",
    ...(warnings.length > 0 ? { dataWarnings: warnings } : {}),
    ...(includeDescription
      ? {
          description: text(pick(source, "DESCRIPTION", "description"), 20_000),
        }
      : {}),
  };
}

export type ListTaskOptions = {
  readonly scope: "mine" | "accessible";
  readonly responsibleId?: number | undefined;
  readonly status?: number | undefined;
  readonly overdueOnly: boolean;
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

export type ConnectionResult = {
  readonly connected: true;
  readonly taskScope: true;
  readonly taskContentChecked: false;
  readonly contractVersion: "0.4";
  readonly apiFamily: "tasks-rest";
  readonly user: {
    readonly id: string | null;
    readonly name: string | null;
    readonly lastName: string | null;
    readonly admin: boolean;
  };
};

export type TaskListResult = {
  readonly tasks: readonly NormalizedTask[];
  readonly returned: number;
  readonly partial: boolean;
  readonly skippedMalformed: number;
  readonly start: number;
  readonly nextStart: number | null;
  readonly total: number | null;
  readonly truncated: boolean;
  readonly asOf: string | null;
};

export type TaskHistoryEvent = {
  readonly id: string | null;
  readonly createdDate: string | null;
  readonly field: TaskHistoryField | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly dataWarnings?: readonly string[];
  readonly actor: {
    readonly id: string | null;
    readonly name: string | null;
    readonly lastName: string | null;
  };
};

export type TaskHistoryResult = {
  readonly events: readonly TaskHistoryEvent[];
  readonly returned: number;
  readonly partial: boolean;
  readonly skippedMalformed: number;
  readonly start: number;
  readonly nextStart: number | null;
  readonly total: number | null;
  readonly truncated: boolean;
};

export type TaskFieldMetadata = {
  readonly name: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly readonly: boolean;
};

export type TaskFieldsResult = {
  readonly fields: readonly TaskFieldMetadata[];
  readonly truncated: false;
};

export class TaskReader {
  readonly #client: BitrixClient;
  readonly #now: () => Date;

  constructor(client: BitrixClient, now: () => Date = () => new Date()) {
    this.#client = client;
    this.#now = now;
  }

  async connectionCheck(): Promise<ConnectionResult> {
    const profile = record(await this.#client.call("profile"));
    const profileId = identifier(pick(profile, "ID", "id"));
    if (profileId === null) throw new BitrixRequestError("INVALID_PROFILE");
    await this.#client.call("tasks.task.getFields");
    return {
      connected: true,
      taskScope: true,
      taskContentChecked: false,
      contractVersion: "0.4",
      apiFamily: "tasks-rest",
      user: {
        id: profileId,
        name: text(pick(profile, "NAME", "name"), 200),
        lastName: text(pick(profile, "LAST_NAME", "lastName"), 200),
        admin:
          pick(profile, "ADMIN", "admin") === true ||
          pick(profile, "ADMIN", "admin") === "Y",
      },
    };
  }

  async listTasks(options: ListTaskOptions): Promise<TaskListResult> {
    const filter: Record<string, unknown> = {};
    if (options.scope === "mine") {
      const profile = record(await this.#client.call("profile"));
      const id = requestIdentifier(pick(profile, "ID", "id"));
      if (id === null) throw new BitrixRequestError("INVALID_PROFILE");
      filter.RESPONSIBLE_ID = id;
    } else if (options.responsibleId !== undefined) {
      filter.RESPONSIBLE_ID = options.responsibleId;
    }
    let asOf: string | null = null;
    if (options.overdueOnly) {
      asOf = this.#now().toISOString();
      filter["<DEADLINE"] = asOf;
      filter["!REAL_STATUS"] = [4, 5];
    } else {
      if (options.status !== undefined) filter.REAL_STATUS = options.status;
      if (options.deadlineFrom) filter[">=DEADLINE"] = options.deadlineFrom;
      if (options.deadlineTo) filter["<=DEADLINE"] = options.deadlineTo;
    }

    const page = await this.#client.callPage("tasks.task.list", {
      order: { [options.sortBy]: options.sortDirection },
      filter,
      select: LIST_FIELDS,
      start: options.start,
    });
    const raw = record(page.result);
    if (!Array.isArray(raw.tasks)) throw new BitrixRequestError("INVALID_RESPONSE");
    const tasks = raw.tasks;
    const hasMoreInFetchedPage = tasks.length > options.limit;
    const nextStart = hasMoreInFetchedPage
      ? options.start + options.limit
      : page.next;
    const selected = tasks.slice(0, options.limit);
    const normalized = selected
      .filter(isRecordLike)
      .map((task) => normalizeTask(task, (id) => this.#client.taskWebUrl(id)))
      .filter((task) => task.id !== null);
    const skippedMalformed = selected.length - normalized.length;
    return {
      tasks: normalized,
      returned: normalized.length,
      partial: skippedMalformed > 0,
      skippedMalformed,
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
      asOf,
    };
  }

  async getTask(taskId: number): Promise<{ readonly task: NormalizedTask }> {
    const raw = record(
      await this.#client.call("tasks.task.get", {
        taskId,
        select: GET_FIELDS,
      }),
    );
    if (!isRecordLike(raw.task)) throw new BitrixRequestError("INVALID_RESPONSE");
    const task = normalizeTask(
      raw.task,
      (id) => this.#client.taskWebUrl(id),
      true,
    );
    if (task.id !== String(taskId)) throw new BitrixRequestError("TASK_ID_MISMATCH");
    return { task };
  }

  async taskHistory(options: TaskHistoryOptions): Promise<TaskHistoryResult> {
    const page = await this.#client.callPage("tasks.task.history.list", {
      taskId: options.taskId,
      ...(options.event ? { filter: { FIELD: options.event } } : {}),
      order: { createdDate: options.sortDirection },
      start: options.start,
    });
    const raw = record(page.result);
    if (!Array.isArray(raw.list)) throw new BitrixRequestError("INVALID_RESPONSE");
    const history = raw.list;
    const hasMoreInFetchedPage = history.length > options.limit;
    const nextStart = hasMoreInFetchedPage
      ? options.start + options.limit
      : page.next;
    const selected = history.slice(0, options.limit);
    const normalized = selected
      .filter(isRecordLike)
      .map((value) => {
        const source = record(value);
        const change = record(source.value);
        const user = record(source.user);
        const warnings: string[] = [];
        const id = identifier(source.id);
        const field =
          typeof source.field === "string" &&
          TASK_HISTORY_FIELDS.includes(source.field as TaskHistoryField)
            ? (source.field as TaskHistoryField)
            : null;
        if (hasValue(source.field) && field === null) warnings.push("unknown_field");
        return {
          id,
          createdDate: isoDate(source.createdDate, "created_date", warnings),
          field,
          from: historyValue(change.from),
          to: historyValue(change.to),
          actor: {
            id: identifier(user.id),
            name: text(user.name, 200),
            lastName: text(user.lastName, 200),
          },
          ...(warnings.length > 0 ? { dataWarnings: warnings } : {}),
        };
      })
      .filter((event) => event.id !== null);
    const skippedMalformed = selected.length - normalized.length;
    return {
      events: normalized,
      returned: normalized.length,
      partial: skippedMalformed > 0,
      skippedMalformed,
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async taskFields(): Promise<TaskFieldsResult> {
    const raw = record(await this.#client.call("tasks.task.getFields"));
    if (!isRecordLike(raw.fields)) throw new BitrixRequestError("INVALID_RESPONSE");
    const fields = raw.fields;
    const selectedFields = new Set<string>(GET_FIELDS);
    const safe = Object.entries(fields)
      .filter(([name]) => selectedFields.has(name))
      .map(([name, value]) => {
        const field = record(value);
        return {
          name: name.slice(0, 200),
          title: text(field.title, 500),
          type: text(field.type, 100),
          required: field.required === true,
          multiple: field.multiple === true,
          readonly: field.readonly === true,
        };
      });
    safe.sort((left, right) => left.name.localeCompare(right.name));
    return { fields: safe, truncated: false };
  }
}
