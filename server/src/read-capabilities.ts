import { BitrixClient, BitrixRequestError } from "./bitrix-client.ts";

type RecordLike = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): RecordLike {
  return isRecord(value) ? value : {};
}

function pick(source: RecordLike, ...names: readonly string[]): unknown {
  for (const name of names) if (source[name] !== undefined) return source[name];
  return undefined;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? value : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function date(value: unknown): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function yes(value: unknown): boolean | null {
  if (value === "Y" || value === true) return true;
  if (value === "N" || value === false) return false;
  return null;
}

function positiveIds(value: unknown, max = 100): string[] {
  const input = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const result: string[] = [];
  for (const item of input) {
    const id = identifier(
      isRecord(item)
        ? pick(item, "ATTACHMENT_ID", "attachmentId", "ID", "id")
        : item,
    );
    if (id !== null && !result.includes(id)) result.push(id);
    if (result.length >= max) break;
  }
  return result;
}

function collection(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : Object.values(record(value));
}

function pageCursor(start: number, selected: number, upstream: number | null, hadMore: boolean) {
  return hadMore ? start + selected : upstream;
}

const PERMISSIONS = {
  task: { nameRu: "Задачи", purpose: "задачи, legacy-комментарии, чек-листы и связи" },
  im: { nameRu: "Чат и уведомления", purpose: "обсуждение в новой карточке задачи" },
  sonet_group: {
    nameRu: "Рабочие группы социальной сети",
    purpose: "поиск доступных проектов и рабочих групп",
  },
  user_brief: {
    nameRu: "Пользователи (минимальные)",
    purpose: "имена сотрудников без контактных данных",
  },
  department: { nameRu: "Структура компании", purpose: "названия подразделений" },
  disk: { nameRu: "Диск", purpose: "метаданные доступных вложений" },
} as const;

export type CommentOptions = {
  readonly taskId: number;
  readonly mode: "auto" | "task_chat" | "legacy_comments";
  readonly limit: number;
  readonly cursor?: string | undefined;
};

export type ProjectSearchOptions = {
  readonly projectId?: number | undefined;
  readonly query?: string | undefined;
  readonly limit: number;
  readonly start: number;
};

export type PeopleSearchOptions = {
  readonly userId?: number | undefined;
  readonly query?: string | undefined;
  readonly limit: number;
  readonly start: number;
};

export type DepartmentOptions = {
  readonly departmentId?: number | undefined;
  readonly parentId?: number | undefined;
  readonly limit: number;
  readonly start: number;
};

export type TaskFilesOptions = {
  readonly taskId: number;
  readonly limit: number;
  readonly start: number;
};

export type ChecklistOptions = {
  readonly taskId: number;
  readonly limit: number;
  readonly start: number;
  readonly sortBy: "ID" | "SORT_INDEX" | "IS_COMPLETE" | "IS_IMPORTANT";
  readonly sortDirection: "asc" | "desc";
};

export type RelationsOptions = {
  readonly taskId: number;
  readonly subtaskLimit: number;
};

export class ReadCapabilityReader {
  readonly #client: BitrixClient;

  constructor(client: BitrixClient) {
    this.#client = client;
  }

  async capabilities() {
    const raw = await this.#client.call("scope");
    if (!Array.isArray(raw)) throw new BitrixRequestError("INVALID_RESPONSE");
    const granted = new Set(
      raw.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase()),
    );
    const effectiveUserScope = ["user_brief", "user_basic", "user"].find((scope) =>
      granted.has(scope),
    );
    const hasUsers = effectiveUserScope !== undefined;
    const recognized = new Set([
      "task",
      "im",
      "sonet_group",
      "user_brief",
      "user_basic",
      "user",
      "department",
      "disk",
    ]);
    const knownGranted = [...granted].filter((scope) => recognized.has(scope)).sort();
    const block = (requiredScopes: readonly string[], available: boolean, note?: string) => ({
      available,
      status: available ? ("available" as const) : ("unavailable" as const),
      requiredScopes,
      ...(note ? { note } : {}),
    });
    return {
      contractVersion: "0.4",
      grantedScopes: knownGranted,
      blocks: {
        taskDiscussion: granted.has("task")
          ? {
              available: true,
              status: granted.has("im") ? ("available" as const) : ("limited" as const),
              requiredScopes: ["task", "im"],
              note: granted.has("im")
                ? "New task chat and legacy comments are available."
                : "Legacy comments may work; new task cards require im.",
            }
          : block(["task", "im"], false),
        projects: block(["sonet_group"], granted.has("sonet_group")),
        people: {
          ...block(["user_brief"], hasUsers),
          effectiveScope: effectiveUserScope ?? null,
        },
        departments: block(["department"], granted.has("department")),
        taskFiles: block(["task", "disk"], granted.has("task") && granted.has("disk")),
        checklistAndRelations: block(["task"], granted.has("task")),
      },
      permissionGuide: {
        path: ["Приложения", "Ресурсы для разработчиков", "Интеграции", "Настройка прав"],
        permissions: PERMISSIONS,
        warning:
          "Scope webhook and the employee's access are independent. Save the webhook and rerun the installer if its secret changes; never paste it into chat.",
      },
    };
  }

  async taskComments(options: CommentOptions) {
    const parsedCursor = this.#commentCursor(options.cursor);
    let mode = options.mode;
    let chatId: string | null = null;
    if (mode !== "legacy_comments") {
      const task = record(
        await this.#client.call("tasks.task.get", {
          taskId: options.taskId,
          select: ["ID", "CHAT_ID"],
        }),
      );
      const taskRecord = record(task.task);
      if (identifier(pick(taskRecord, "ID", "id")) !== String(options.taskId))
        throw new BitrixRequestError("TASK_NOT_FOUND_OR_DENIED");
      chatId = identifier(pick(taskRecord, "CHAT_ID", "chatId"));
      if (mode === "task_chat" && chatId === null)
        throw new BitrixRequestError("TASK_CHAT_UNAVAILABLE");
      if (mode === "auto") mode = chatId === null ? "legacy_comments" : "task_chat";
    }
    if (parsedCursor && parsedCursor.mode !== mode)
      throw new BitrixRequestError("INVALID_CURSOR");
    return mode === "task_chat"
      ? this.#taskChat(options, chatId, parsedCursor?.value)
      : this.#legacyComments(options, parsedCursor?.value);
  }

  async #taskChat(options: CommentOptions, chatId: string | null, before?: number) {
    if (chatId === null) throw new BitrixRequestError("TASK_CHAT_UNAVAILABLE");
    const raw = record(
      await this.#client.call("im.dialog.messages.get", {
        DIALOG_ID: `chat${chatId}`,
        ...(before === undefined ? {} : { LAST_ID: before }),
        LIMIT: options.limit,
      }),
    );
    if (!Array.isArray(raw.messages)) throw new BitrixRequestError("INVALID_RESPONSE");
    const users = new Map<string, RecordLike>();
    if (Array.isArray(raw.users)) {
      for (const value of raw.users) {
        const user = record(value);
        const id = identifier(user.id);
        if (id !== null) users.set(id, user);
      }
    }
    const files = new Map<string, RecordLike>();
    if (Array.isArray(raw.files)) {
      for (const value of raw.files) {
        const file = record(value);
        const id = identifier(file.id);
        if (id !== null) files.set(id, file);
      }
    }
    const normalized = raw.messages
      .filter(isRecord)
      .map((message) => {
        const id = identifier(message.id);
        const authorId = identifier(message.author_id);
        const author = authorId === null ? {} : record(users.get(authorId));
        const params = record(message.params);
        return {
          id,
          author: {
            id: authorId,
            name: text(author.first_name, 200) ?? text(author.name, 300),
            lastName: text(author.last_name, 200),
          },
          createdDate: date(message.date),
          text: text(message.text, 8_000),
          kind: authorId === null ? "system" : "message",
          attachments: positiveIds(params.FILE_ID, 20).map((fileId) => {
            const file = record(files.get(fileId));
            return {
              fileId,
              name: text(file.name, 500),
              size: integer(file.size),
              type: text(file.type, 100),
            };
          }),
          untrustedContent: true,
        };
      })
      .filter((message) => message.id !== null)
      .sort((left, right) => Number(right.id) - Number(left.id));
    const selected = normalized.slice(0, options.limit);
    const nextId = selected.length === 0 ? null : Math.min(...selected.map(({ id }) => Number(id)));
    return {
      source: "task_chat" as const,
      messages: selected,
      returned: selected.length,
      partial: normalized.length !== raw.messages.length,
      skippedMalformed: raw.messages.length - normalized.length,
      nextCursor:
        nextId !== null && raw.messages.length >= options.limit ? `chat:${nextId}` : null,
      truncated: nextId !== null && raw.messages.length >= options.limit,
    };
  }

  async #legacyComments(options: CommentOptions, start = 0) {
    const page = await this.#client.callPage("task.commentitem.getlist", {
      TASKID: options.taskId,
      ORDER: { ID: "DESC" },
      FILTER: {},
      start,
    });
    if (!Array.isArray(page.result)) throw new BitrixRequestError("INVALID_RESPONSE");
    const hasMoreInFetchedPage = page.result.length > options.limit;
    const selectedRaw = page.result.slice(0, options.limit);
    const normalized = selectedRaw
      .filter(isRecord)
      .map((comment) => ({
        id: identifier(comment.ID),
        author: {
          id: identifier(comment.AUTHOR_ID),
          name: text(comment.AUTHOR_NAME, 300),
          lastName: null,
        },
        createdDate: date(comment.POST_DATE),
        text: text(comment.POST_MESSAGE, 8_000),
        kind: "message" as const,
        attachments: collection(comment.ATTACHED_OBJECTS)
          .slice(0, 20)
          .map((value) => {
            const file = record(value);
            return {
              attachmentId: identifier(file.ATTACHMENT_ID),
              fileId: identifier(file.FILE_ID),
              name: text(file.NAME, 500),
              size: integer(file.SIZE),
            };
          }),
        untrustedContent: true,
      }))
      .filter((comment) => comment.id !== null);
    const next = pageCursor(start, selectedRaw.length, page.next, hasMoreInFetchedPage);
    return {
      source: "legacy_comments" as const,
      messages: normalized,
      returned: normalized.length,
      partial: normalized.length !== selectedRaw.length,
      skippedMalformed: selectedRaw.length - normalized.length,
      nextCursor: next === null ? null : `legacy:${next}`,
      truncated: next !== null,
    };
  }

  #commentCursor(cursor?: string) {
    if (cursor === undefined) return null;
    const match = /^(chat|legacy):([1-9]\d{0,15})$/u.exec(cursor);
    if (!match) throw new BitrixRequestError("INVALID_CURSOR");
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) throw new BitrixRequestError("INVALID_CURSOR");
    return {
      mode: match[1] === "chat" ? ("task_chat" as const) : ("legacy_comments" as const),
      value,
    };
  }

  async searchProjects(options: ProjectSearchOptions) {
    const page = await this.#client.callPage("sonet_group.get", {
      ORDER: { NAME: "ASC" },
      FILTER: options.query === undefined ? {} : { "%NAME": options.query },
      ...(options.projectId === undefined ? {} : { GROUP_ID: options.projectId }),
      start: options.start,
    });
    if (!Array.isArray(page.result)) throw new BitrixRequestError("INVALID_RESPONSE");
    const hasMoreInFetchedPage = page.result.length > options.limit;
    const selectedRaw = page.result.slice(0, options.limit);
    const normalized = selectedRaw
      .filter(isRecord)
      .map((group) => ({
        id: identifier(group.ID),
        name: text(group.NAME, 500),
        project: yes(group.PROJECT),
        ownerId: identifier(group.OWNER_ID),
        active: yes(group.ACTIVE),
        visible: yes(group.VISIBLE),
        opened: yes(group.OPENED),
        archived: yes(group.CLOSED),
      }))
      .filter((group) => group.id !== null);
    const nextStart = pageCursor(
      options.start,
      selectedRaw.length,
      page.next,
      hasMoreInFetchedPage,
    );
    return {
      projects: normalized,
      returned: normalized.length,
      partial: normalized.length !== selectedRaw.length,
      skippedMalformed: selectedRaw.length - normalized.length,
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async searchPeople(options: PeopleSearchOptions) {
    const page = await this.#client.callPage("user.get", {
      filter:
        options.userId === undefined
          ? { NAME_SEARCH: options.query }
          : { ID: options.userId },
      sort: "ID",
      order: "ASC",
      select: ["ID", "NAME", "LAST_NAME", "ACTIVE", "WORK_POSITION", "UF_DEPARTMENT"],
      start: options.start,
    });
    if (!Array.isArray(page.result)) throw new BitrixRequestError("INVALID_RESPONSE");
    const hasMoreInFetchedPage = page.result.length > options.limit;
    const selectedRaw = page.result.slice(0, options.limit);
    const normalized = selectedRaw
      .filter(isRecord)
      .map((user) => ({
        id: identifier(user.ID),
        name: text(user.NAME, 200),
        lastName: text(user.LAST_NAME, 200),
        active: yes(user.ACTIVE),
        workPosition: text(user.WORK_POSITION, 300),
        departmentIds: positiveIds(user.UF_DEPARTMENT, 20),
      }))
      .filter((user) => user.id !== null);
    const nextStart = pageCursor(
      options.start,
      selectedRaw.length,
      page.next,
      hasMoreInFetchedPage,
    );
    return {
      people: normalized,
      returned: normalized.length,
      partial: normalized.length !== selectedRaw.length,
      skippedMalformed: selectedRaw.length - normalized.length,
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async listDepartments(options: DepartmentOptions) {
    const page = await this.#client.callPage("department.get", {
      sort: "NAME",
      order: "ASC",
      ...(options.departmentId === undefined ? {} : { ID: options.departmentId }),
      ...(options.parentId === undefined ? {} : { PARENT: options.parentId }),
      start: options.start,
    });
    if (!Array.isArray(page.result)) throw new BitrixRequestError("INVALID_RESPONSE");
    const hasMoreInFetchedPage = page.result.length > options.limit;
    const selectedRaw = page.result.slice(0, options.limit);
    const normalized = selectedRaw
      .filter(isRecord)
      .map((department) => ({
        id: identifier(department.ID),
        name: text(department.NAME, 500),
        parentId: identifier(department.PARENT),
        headUserId: identifier(department.UF_HEAD),
      }))
      .filter((department) => department.id !== null);
    const nextStart = pageCursor(
      options.start,
      selectedRaw.length,
      page.next,
      hasMoreInFetchedPage,
    );
    return {
      departments: normalized,
      returned: normalized.length,
      partial: normalized.length !== selectedRaw.length,
      skippedMalformed: selectedRaw.length - normalized.length,
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async taskFiles(options: TaskFilesOptions) {
    const raw = record(
      await this.#client.call("tasks.task.get", {
        taskId: options.taskId,
        select: ["ID", "UF_TASK_WEBDAV_FILES"],
      }),
    );
    const task = record(raw.task);
    if (identifier(pick(task, "ID", "id")) !== String(options.taskId))
      throw new BitrixRequestError("TASK_NOT_FOUND_OR_DENIED");
    const attachmentIds = positiveIds(
      pick(task, "UF_TASK_WEBDAV_FILES", "ufTaskWebdavFiles"),
      1_000,
    );
    const selectedIds = attachmentIds.slice(options.start, options.start + options.limit);
    const files: Array<Record<string, unknown>> = [];
    let skippedUnavailable = 0;
    for (const attachmentId of selectedIds) {
      try {
        const file = record(
          await this.#client.call("disk.attachedObject.get", { id: Number(attachmentId) }),
        );
        if (
          identifier(file.ID) !== attachmentId ||
          file.MODULE_ID !== "tasks" ||
          file.ENTITY_TYPE !== "tasks_task" ||
          identifier(file.ENTITY_ID) !== String(options.taskId)
        ) {
          skippedUnavailable += 1;
          continue;
        }
        files.push({
          attachmentId,
          fileId: identifier(file.OBJECT_ID),
          name: text(file.NAME, 500),
          size: integer(file.SIZE),
          createdDate: date(file.CREATE_TIME),
          createdBy: identifier(file.CREATED_BY),
          entityType: text(file.ENTITY_TYPE, 100),
          entityId: identifier(file.ENTITY_ID),
        });
      } catch (error) {
        if (
          error instanceof BitrixRequestError &&
          ["ACCESS_DENIED", "ERROR_NOT_FOUND"].includes(error.code)
        ) {
          skippedUnavailable += 1;
          continue;
        }
        throw error;
      }
    }
    const nextStart =
      options.start + selectedIds.length < attachmentIds.length
        ? options.start + selectedIds.length
        : null;
    return {
      files,
      returned: files.length,
      partial: skippedUnavailable > 0,
      skippedUnavailable,
      start: options.start,
      nextStart,
      total: attachmentIds.length,
      truncated: nextStart !== null,
    };
  }

  async taskChecklist(options: ChecklistOptions) {
    const page = await this.#client.callPage("task.checklistitem.getlist", {
      TASKID: options.taskId,
      ORDER: { [options.sortBy]: options.sortDirection.toUpperCase() },
      start: options.start,
    });
    if (!Array.isArray(page.result)) throw new BitrixRequestError("INVALID_RESPONSE");
    const hasMoreInFetchedPage = page.result.length > options.limit;
    const selectedRaw = page.result.slice(0, options.limit);
    const normalized = selectedRaw
      .filter(isRecord)
      .map((item) => ({
        id: identifier(item.ID),
        taskId: identifier(item.TASK_ID),
        parentId: identifier(item.PARENT_ID),
        createdBy: identifier(item.CREATED_BY),
        title: text(item.TITLE, 2_000),
        sortIndex: integer(item.SORT_INDEX),
        completed: yes(item.IS_COMPLETE),
        important: yes(item.IS_IMPORTANT),
        toggledBy: identifier(item.TOGGLED_BY),
        toggledDate: date(item.TOGGLED_DATE),
        members: Array.isArray(item.MEMBERS)
          ? item.MEMBERS.slice(0, 20).map((value) => {
              const member = record(value);
              return {
                id: identifier(member.ID),
                type: text(member.TYPE, 30),
                name: text(member.NAME, 300),
              };
            })
          : [],
        attachments: collection(item.ATTACHMENTS)
          .slice(0, 20)
          .map((value) => {
            const file = record(value);
            return {
              attachmentId: identifier(file.ATTACHMENT_ID),
              fileId: identifier(file.FILE_ID),
              name: text(file.NAME, 500),
              size: integer(file.SIZE),
            };
          }),
        untrustedContent: true,
      }))
      .filter((item) => item.id !== null && item.taskId === String(options.taskId));
    const nextStart = pageCursor(
      options.start,
      selectedRaw.length,
      page.next,
      hasMoreInFetchedPage,
    );
    return {
      items: normalized,
      returned: normalized.length,
      partial: normalized.length !== selectedRaw.length,
      skippedMalformed: selectedRaw.length - normalized.length,
      start: options.start,
      nextStart,
      total: page.total,
      truncated: nextStart !== null,
    };
  }

  async taskRelations(options: RelationsOptions) {
    const raw = record(
      await this.#client.call("tasks.task.get", {
        taskId: options.taskId,
        select: ["ID", "PARENT_ID", "DEPENDS_ON"],
      }),
    );
    const task = record(raw.task);
    if (identifier(pick(task, "ID", "id")) !== String(options.taskId))
      throw new BitrixRequestError("TASK_NOT_FOUND_OR_DENIED");
    const parentId = identifier(pick(task, "PARENT_ID", "parentId"));
    const dependencyIds = positiveIds(pick(task, "DEPENDS_ON", "dependsOn"), 20);
    const relatedIds = [...new Set([parentId, ...dependencyIds].filter((id): id is string => id !== null))];
    const relatedResult =
      relatedIds.length === 0
        ? { tasks: [], truncated: false }
        : await this.#taskSummaries({ ID: relatedIds }, 20);
    const subtaskResult = await this.#taskSummaries(
      { PARENT_ID: options.taskId },
      options.subtaskLimit,
    );
    const byId = new Map(relatedResult.tasks.map((entry) => [entry.id, entry]));
    return {
      taskId: String(options.taskId),
      parent: parentId === null ? null : (byId.get(parentId) ?? { id: parentId, unavailable: true }),
      dependencies: dependencyIds.map((id) => byId.get(id) ?? { id, unavailable: true }),
      subtasks: subtaskResult.tasks,
      subtaskLimit: options.subtaskLimit,
      subtasksTruncated: subtaskResult.truncated,
    };
  }

  async #taskSummaries(filter: Record<string, unknown>, limit: number) {
    const page = await this.#client.callPage("tasks.task.list", {
      order: { ID: "ASC" },
      filter,
      select: ["ID", "TITLE", "STATUS", "DEADLINE"],
      start: 0,
    });
    const raw = record(page.result);
    if (!Array.isArray(raw.tasks)) throw new BitrixRequestError("INVALID_RESPONSE");
    const tasks = raw.tasks
      .filter(isRecord)
      .map((task) => ({
        id: identifier(pick(task, "ID", "id")),
        title: text(pick(task, "TITLE", "title"), 1_000),
        status: integer(pick(task, "STATUS", "status")),
        deadline: date(pick(task, "DEADLINE", "deadline")),
        untrustedContent: true,
      }))
      .filter((task): task is typeof task & { id: string } => task.id !== null)
      .slice(0, limit);
    return {
      tasks,
      truncated: raw.tasks.length > limit || page.next !== null,
    };
  }
}
