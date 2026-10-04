import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, realpath, rm } from "node:fs/promises";
import { SettingsStore, LEGACY_POLICY, assertWritePolicy, withPolicyLock, type PluginPolicy } from "./settings.ts";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import {
  BitrixClient,
  BitrixRequestError,
  type WriteMethod,
} from "./bitrix-client.ts";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(10_000);
const date = z.iso.datetime({ offset: true });
const people = z.array(id).max(50);
const singleWriteSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      title: z.string().trim().min(1).max(250),
      description: text,
      responsibleId: id,
      deadline: date,
      comment: text.optional(),
      uploads: z
        .array(
          z
            .object({
              path: z.string().min(1).max(1000),
              message: text.optional(),
            })
            .strict(),
        )
        .max(10)
        .optional(),
      auditors: people.optional(),
      accomplices: people.optional(),
      projectId: id.optional(),
      checklist: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
      checklistTitle: z.string().trim().min(1).max(250).optional(),
      priority: z.enum(["0", "1", "2"]).optional(),
      parentId: id.optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
      taskControl: z.boolean().optional(),
      allowChangeDeadline: z.boolean().optional(),
      allowTimeTracking: z.boolean().optional(),
      timeEstimate: z.number().int().min(0).max(31_536_000).optional(),
      startDatePlan: date.optional(),
      endDatePlan: date.optional(),
      customFields: z
        .record(
          z.string().regex(/^UF_[A-Z0-9_]{1,80}$/u),
          z.union([
            z.string().max(2000),
            z.number().finite(),
            z.boolean(),
            z
              .array(z.union([z.string().max(500), z.number().finite()]))
              .max(50),
          ]),
        )
        .optional(),
    })
    .strict()
    .refine(v => v.checklistTitle === undefined || Boolean(v.checklist?.length)),
  z
    .object({
      action: z.literal("update"),
      taskId: id,
      title: z.string().trim().min(1).max(250).optional(),
      description: z.string().max(10_000).optional(),
      deadline: date.nullable().optional(),
      auditors: people.optional(),
      addAuditors: people.optional(),
      removeAuditors: people.optional(),
      accomplices: people.optional(),
      projectId: id.nullable().optional(),
      priority: z.enum(["0", "1", "2"]).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
      checklist: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
      checklistTitle: z.string().trim().min(1).max(250).optional(),
      checklistId: id.optional(),
      checklistUpdates: z
        .array(
          z
            .object({
              id,
              title: z.string().trim().min(1).max(500).optional(),
              completed: z.boolean().optional(),
            })
            .strict()
            .refine((v) => v.title !== undefined || v.completed !== undefined),
        )
        .max(50)
        .optional(),
    })
    .strict()
    .refine(v => (v.checklistTitle === undefined && v.checklistId === undefined) || Boolean(v.checklist?.length))
    .refine(v => v.checklistTitle === undefined || v.checklistId === undefined)
    .refine((v) =>
      Object.entries(v).some(
        ([k, value]) =>
          !["action", "taskId"].includes(k) &&
          value !== undefined &&
          (!Array.isArray(value) ||
            value.length > 0 ||
            ["auditors", "accomplices", "tags"].includes(k)),
      ),
    )
    .refine(
      (v) =>
        v.auditors === undefined ||
        (v.addAuditors === undefined && v.removeAuditors === undefined),
    )
    .refine(
      (v) =>
        !(v.addAuditors ?? []).some((n) =>
          (v.removeAuditors ?? []).includes(n),
        ),
    ),
  z
    .object({ action: z.literal("comment"), taskId: id, message: text })
    .strict(),
  z
    .object({
      action: z.literal("upload"),
      taskId: id,
      path: z.string().min(1).max(1000),
      message: text.optional(),
    })
    .strict(),
  z.object({ action: z.literal("stage"), taskId: id, stageId: id }).strict(),
  z.object({ action: z.literal("delete_file"), taskId: id, fileId: id, messageId: id }).strict(),
  z.object({ action: z.literal("delete_message"), taskId: id, messageId: id }).strict(),
  z.object({ action: z.literal("complete"), taskId: id }).strict(),
  z.object({ action: z.literal("rework"), taskId: id }).strict(),
  z
    .object({ action: z.literal("reassign"), taskId: id, responsibleId: id })
    .strict(),
  z
    .object({ action: z.literal("deadline"), taskId: id, deadline: date })
    .strict(),
]);
export type TaskWrite = z.infer<typeof singleWriteSchema>;
export const taskWriteSchema = z.discriminatedUnion("action", [
  ...singleWriteSchema.options,
  z
    .object({
      action: z.literal("batch"),
      actions: z.array(singleWriteSchema).min(1).max(20),
    })
    .strict(),
]);
export type TaskRequest = z.infer<typeof taskWriteSchema>;

// MCP SDK exports JSON Schema only for an object at the tool's root. Preserve
// every action field for discovery, then enforce the same discriminated contract.
const discoveryShape: Record<string, z.ZodType> = {};
for (const option of singleWriteSchema.options)
  for (const [key, field] of Object.entries(option.shape))
    if (key !== "action") discoveryShape[key] = field.optional();
export const taskWriteInputSchema = z.object({
  ...discoveryShape,
  deadline: date.nullable().optional(),
  action: z.enum(["create", "update", "comment", "upload", "complete", "rework", "reassign", "deadline", "stage", "delete_file", "delete_message", "batch"]),
  actions: z.array(singleWriteSchema).min(1).max(20).optional(),
  presentation: z.enum(["native", "rich"]).optional(),
}).strict().refine(({ presentation: _presentation, ...value }) => taskWriteSchema.safeParse(value).success, "Invalid task action");

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const positive = (value: unknown): number | null => {
  const n =
    typeof value === "string" && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const fail = (code: string): never => {
  throw new BitrixRequestError(code);
};
const TTL = 30 * 60_000;
const FILE_LIMIT = 50 * 1024 * 1024;
type Snapshot = {
  id: number;
  title: string;
  responsibleId: number;
  deadline: string | null;
  status: number;
  changedDate: string;
  chatId: number | null;
  method: WriteMethod;
  editState?: Data;
};
type FileStamp = { name: string; bytes: number; sha256: string };
type UploadContent = FileStamp & { data: Buffer };
type Prepared = {
  input: TaskWrite;
  snapshot: Snapshot | null;
  file: FileStamp | null;
  uploads: FileStamp[];
  prompt: string;
  displayLines: string[];
};
type Offer = {
  schema: 5;
  settingsRevision: number;
  presentation: "native" | "rich";
  confirmationReply: string;
  draftId: string;
  owner: number;
  portal: string;
  createdAt: number;
  input: TaskRequest;
  steps: Prepared[];
  prompt: string;
};

// Native ask_question sends literal text, not Markdown or rich HTML. Remove invisible controls only.
function previewText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/gu, "");
}

// Task values never supply markup or buttons. Format only trusted labels/titles.
function richEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~=-])/gu, "\\$1");
}
function richPreview(prompt: string, confirmReply: string, cancelReply: string): string {
  const lines: string[] = [];
  for (const [index, line] of prompt.split("\n").entries()) {
    const colon = line.indexOf(":");
    const item = /^[☐☑]/u.test(line);
    const heading = index === 0 || /^\d+\. (?:Создать|Изменить|Добавить|Переместить|Удалить|Закрыть|Завершить|Вернуть)/u.test(line);
    const field = !item && !line.startsWith("Должность — ") && colon > 0 && colon < 90 && (line[colon + 1] === " " || colon === line.length - 1);
    const explanation = /^(?:Будет |Результат на контроле|Закрытая задача|Файл будет |Сообщение будет |Действия выполнятся)/u.test(line);
    if (line && (heading || field || explanation) && lines.length && lines.at(-1) !== "") lines.push("");
    const formatted = heading ? `**${richEscape(line)}**`
      : field ? `**${richEscape(line.slice(0, colon))}:**${line.slice(colon + 1) ? ` ${richEscape(line.slice(colon + 1).trimStart())}` : ""}`
      : richEscape(line);
    if (formatted || lines.at(-1) !== "") lines.push(formatted);
  }
  return `${lines.map(line => line ? `${line}  ` : "").join("\n")}\n\n<tg-button-row><tg-button type="callback_data" style="success" data="${confirmReply}">✅ Подтвердить</tg-button><tg-button type="callback_data" style="danger" data="${cancelReply}">❌ Отменить</tg-button></tg-button-row>`;
}

// Keep the declared wall-clock time and offset; formatting must not silently shift a deadline.
function previewDate(value: string | null): string {
  if (!value) return "не задан";
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return previewText(value);
  const [, year, month, day, time, seconds, zone] = match;
  return `${day}.${month}.${year}, ${time}${seconds === ":00" ? "" : seconds} (UTC${zone === "Z" ? "+00:00" : zone})`;
}

// One pending preview per webhook owner. State is private plugin data, never inside the bundle.
export class TaskWriter {
  readonly #client: BitrixClient;
  readonly #data: string | undefined;
  readonly #attachments: string | undefined;
  readonly #now: () => number;
  readonly #settings: SettingsStore | undefined;
  #policy: Readonly<PluginPolicy> = LEGACY_POLICY;
  #emailAvailable: boolean | undefined;
  #departmentAvailable = false;
  #departmentNames = new Map<number, string | null>();
  constructor(
    client: BitrixClient,
    data?: string,
    attachments?: string,
    now = Date.now,
    settings?: SettingsStore,
  ) {
    this.#client = client;
    this.#data = data;
    this.#attachments = attachments;
    this.#now = now;
    this.#settings = settings;
  }
  #root(): string {
    if (!this.#data || !isAbsolute(this.#data))
      return fail("WRITES_NOT_CONFIGURED");
    return join(this.#data, "task-writes");
  }
  async #owner(): Promise<number> {
    return (
      positive(object(await this.#client.call("profile")).ID) ??
      fail("INVALID_PROFILE")
    );
  }
  async #atomic(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      const directory = await open(this.#root(), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async #locked<T>(run: () => Promise<T>): Promise<T> {
    this.#root();
    return withPolicyLock(this.#data, run);
  }

  async #person(userId: number, withDetails = false) {
    if (this.#emailAvailable === undefined && this.#policy.people !== "work") {
      this.#emailAvailable = false;
      this.#departmentAvailable = false;
    }
    if (this.#emailAvailable === undefined) {
      const scopes = await this.#client.call("scope");
      this.#departmentAvailable = Array.isArray(scopes) && scopes.some(v => typeof v === "string" && v.toLowerCase() === "department");
      this.#emailAvailable = Array.isArray(scopes) && scopes.some(v => typeof v === "string" && ["user_basic", "user"].includes(v.toLowerCase()));
    }
    const raw = await this.#client.call("user.get", {
      ID: userId,
      ACTIVE: true,
      select: ["ID", "ACTIVE", ...(this.#policy.people !== "ids" ? ["NAME", "LAST_NAME"] : []), ...(withDetails && this.#policy.people === "work" ? ["UF_DEPARTMENT"] : []), ...(withDetails && this.#policy.people === "work" ? ["WORK_POSITION"] : []), ...(this.#emailAvailable && this.#policy.email ? ["EMAIL"] : [])],
    });
    const person = (Array.isArray(raw) ? raw : [])
      .map(object)
      .find((p) => positive(p.ID) === userId);
    if (!person || (person.ACTIVE !== true && person.ACTIVE !== "Y"))
      return fail("EMPLOYEE_NOT_FOUND_OR_INACTIVE");
    const email = this.#policy.email && this.#emailAvailable && typeof person.EMAIL === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(person.EMAIL.trim())
      ? person.EMAIL.trim().slice(0, 320) : null;
    if (this.#policy.people === "ids") return { person, label: `ID ${userId}` };
    const label = `${[person.NAME, person.LAST_NAME]
      .filter((s) => typeof s === "string").join(" ").slice(0, 200)} (${email ?? `ID ${userId}${this.#policy.email ? "; почта недоступна" : ""}`})`;
    if (!withDetails || this.#policy.people !== "work") return { person, label };
    const position = typeof person.WORK_POSITION === "string" && person.WORK_POSITION.trim()
      ? person.WORK_POSITION.trim().replace(/\s+/gu, " ").slice(0, 300) : "не указана";
    const departments = [...new Set((Array.isArray(person.UF_DEPARTMENT) ? person.UF_DEPARTMENT : [])
      .map(positive).filter((value): value is number => value !== null))].slice(0, 20);
    const names: string[] = [];
    for (const departmentId of departments) {
      if (!this.#departmentNames.has(departmentId)) {
        let name: string | null = null;
        if (this.#departmentAvailable) {
          try {
            const raw = await this.#client.call("department.get", { ID: departmentId });
            const row = (Array.isArray(raw) ? raw : []).map(object).find(row => positive(row.ID) === departmentId);
            if (typeof row?.NAME === "string" && row.NAME.trim()) name = row.NAME.trim().replace(/\s+/gu, " ").slice(0, 250);
          } catch { /* Optional display metadata never gates a permitted task action. */ }
        }
        this.#departmentNames.set(departmentId, name);
      }
      names.push(this.#departmentNames.get(departmentId) ?? "недоступно");
    }
    const department = departments.length ? [...new Set(names)].join(", ") : "не указано";
    return { person, label: `${label}\nДолжность — ${position}; подразделение — ${department}` };
  }
  async stages(projectId: number) {
    id.parse(projectId);
    const raw = await this.#client.call("task.stages.get", { entityId: projectId });
    if (!raw || typeof raw !== "object") return fail("INVALID_RESPONSE");
    const stages = Object.values(raw).map(object).map(row => {
      const stageId = positive(row.ID);
      if (!stageId || typeof row.TITLE !== "string" || positive(row.ENTITY_ID) !== projectId || row.ENTITY_TYPE !== "G")
        return fail("INVALID_RESPONSE");
      return { id: stageId, title: row.TITLE.slice(0, 250), sort: Number(row.SORT) || 0 };
    }).sort((a, b) => a.sort - b.sort);
    return { projectId, stages, untrustedContent: true };
  }
  async #chatTarget(chatId: number, input: Extract<TaskWrite, { action: "delete_file" | "delete_message" }>, owner: number): Promise<Data> {
    let before: number | null = null;
    for (let page = 0; page < 4; page++) {
      const raw = object(await this.#client.call("im.dialog.messages.get", {
        DIALOG_ID: `chat${chatId}`, LIMIT: 50, ...(before === null ? {} : { LAST_ID: before }),
      }));
      if (!Array.isArray(raw.messages)) return fail("INVALID_RESPONSE");
      const message = raw.messages.map(object).find(m => positive(m.id) === input.messageId);
      if (message) {
        if (input.action === "delete_file") {
          const ids = object(message.params).FILE_ID;
          const files = Array.isArray(ids) ? ids : (ids !== null && typeof ids === "object" ? Object.values(object(ids)) : [ids]);
          if (!files.some(v => positive(v) === input.fileId)) return fail("FILE_NOT_IN_TASK_CHAT");
          // This API can return true without deleting another sender's file.
          if (positive(message.author_id) !== owner) return fail("FILE_DELETE_NOT_ALLOWED");
          const fileRows = Array.isArray(raw.files) ? raw.files : Object.values(object(raw.files));
          const file = fileRows.map(object).find(f => positive(f.id) === input.fileId);
          if (!file || typeof file.name !== "string") return fail("INVALID_RESPONSE");
          return { messageId: input.messageId, fileId: input.fileId, name: file.name.slice(0, 250), authorId: owner, text: typeof message.text === "string" ? message.text : "" };
        }
        return { messageId: input.messageId, authorId: positive(message.author_id), text: typeof message.text === "string" ? message.text : "" };
      }
      const ids = raw.messages.map(object).map(m => positive(m.id)).filter((v): v is number => v !== null);
      if (ids.length !== raw.messages.length) return fail("INVALID_RESPONSE");
      if (raw.messages.length < 50) break;
      const oldest = Math.min(...ids);
      if (before !== null && oldest >= before) return fail("CHAT_HISTORY_INCOMPLETE");
      if (page === 3) return fail("CHAT_HISTORY_INCOMPLETE");
      before = oldest;
    }
    return fail("MESSAGE_NOT_IN_TASK_CHAT");
  }
  async #snapshot(
    input: Exclude<TaskWrite, { action: "create" }>,
    owner: number,
  ): Promise<Snapshot> {
    const task = object(
      object(
        await this.#client.call("tasks.task.get", {
          taskId: input.taskId,
          select: [
            "ID",
            "TITLE",
            "RESPONSIBLE_ID",
            "DEADLINE",
            "STATUS",
            "CHANGED_DATE",
            "CHAT_ID",
            "ACTION",
            "DESCRIPTION",
            "AUDITORS",
            "ACCOMPLICES",
            "GROUP_ID",
            "PRIORITY",
            "TAGS",
            "STAGE_ID",
          ],
        }),
      ).task,
    );
    if (positive(task.id) !== input.taskId)
      return fail("TASK_NOT_FOUND_OR_DENIED");
    const status = Number(task.status);
    const rights = object(task.action);
    let method: WriteMethod;
    let actionState: Data | undefined;
    switch (input.action) {
      case "comment":
        method = positive(task.chatId)
          ? "im.message.add"
          : "task.commentitem.add";
        break;
      case "upload":
        if (!positive(task.chatId)) return fail("TASK_CHAT_UNAVAILABLE");
        method = "im.v2.File.upload";
        break;
      case "stage": {
        const projectId = positive(task.groupId) ?? fail("TASK_PROJECT_UNAVAILABLE");
        const stage = (await this.stages(projectId)).stages.find(s => s.id === input.stageId);
        if (!stage) return fail("STAGE_NOT_IN_TASK_PROJECT");
        if (await this.#client.call("task.stages.canmovetask", { entityId: projectId, entityType: "G" }) !== true)
          return fail("ACTION_NOT_ALLOWED");
        actionState = { projectId, stageId: task.stageId ?? "0", destination: stage };
        method = "task.stages.movetask";
        break;
      }
      case "delete_file":
      case "delete_message":
        if (!positive(task.chatId)) return fail("TASK_CHAT_UNAVAILABLE");
        actionState = await this.#chatTarget(positive(task.chatId)!, input, owner);
        method = input.action === "delete_file" ? "im.disk.file.delete" : "im.message.delete";
        break;
      case "update":
        if (rights.edit !== true) return fail("ACTION_NOT_ALLOWED");
        method = "tasks.task.update";
        break;
      case "deadline":
        if (rights.changeDeadline !== true) return fail("ACTION_NOT_ALLOWED");
        method = "tasks.task.update";
        break;
      case "reassign":
        await this.#person(input.responsibleId);
        method = "tasks.task.update";
        break;
      case "complete":
        // Closing an awaiting-control task means accepting its result.
        method = status === 4 ? "tasks.task.approve" : "tasks.task.complete";
        if (rights[status === 4 ? "approve" : "complete"] !== true)
          return fail("ACTION_NOT_ALLOWED");
        break;
      case "rework":
        if (status !== 4 && status !== 5)
          return fail("TASK_NOT_READY_FOR_REWORK");
        method = status === 4 ? "tasks.task.disapprove" : "tasks.task.renew";
        if (rights[status === 4 ? "disapprove" : "renew"] !== true)
          return fail("ACTION_NOT_ALLOWED");
        break;
    }
    if (
      typeof task.title !== "string" ||
      typeof task.changedDate !== "string" ||
      !positive(task.responsibleId) ||
      !Number.isInteger(status)
    )
      return fail("INVALID_RESPONSE");
    return {
      id: input.taskId,
      title: task.title.slice(0, 250),
      responsibleId: positive(task.responsibleId)!,
      deadline: typeof task.deadline === "string" ? task.deadline : null,
      status,
      changedDate: task.changedDate,
      chatId: positive(task.chatId),
      method,
      ...(actionState ? { editState: actionState } : {}),
      ...(input.action === "update"
        ? {
            editState: {
              description: task.description ?? null,
              auditors: task.auditors ?? [],
              accomplices: task.accomplices ?? [],
              projectId: task.groupId ?? null,
              priority: task.priority ?? null,
              tags: task.tags ?? [],
              checklist:
                input.checklist?.length || input.checklistUpdates?.length
                  ? await this.#client.call("task.checklistitem.getlist", {
                      TASKID: input.taskId,
                    })
                  : null,
            },
          }
        : {}),
    };
  }
  async #file(path: string) {
    if (!this.#attachments) return fail("ATTACHMENTS_NOT_CONFIGURED");
    if (
      isAbsolute(path) ||
      path.split(/[\\/]/u).some((part) => part === ".." || part === ".") ||
      path.includes("\0")
    )
      return fail("INVALID_UPLOAD_PATH");
    const root = await realpath(this.#attachments);
    const resolved = await realpath(resolve(root, path));
    const rel = relative(root, resolved);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
      return fail("INVALID_UPLOAD_PATH");
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) return fail("INVALID_UPLOAD_PATH");
      if (info.size <= 0 || info.size > FILE_LIMIT)
        return fail("FILE_TOO_LARGE");
      // Fixed allocation also bounds a file growing while it is being read.
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!bytesRead) return fail("UPLOAD_FILE_CHANGED");
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
        return fail("UPLOAD_FILE_CHANGED");
      return {
        data,
        name: basename(path),
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  }
  async #createFields(
    input: Extract<TaskWrite, { action: "create" }>,
    owner: number,
  ) {
    const fields: Data = {
      TITLE: input.title,
      DESCRIPTION: input.description,
      RESPONSIBLE_ID: input.responsibleId,
      DEADLINE: input.deadline,
      CREATED_BY: owner,
    };
    const mapping = {
      auditors: "AUDITORS",
      accomplices: "ACCOMPLICES",
      projectId: "GROUP_ID",
      priority: "PRIORITY",
      parentId: "PARENT_ID",
      tags: "TAGS",
      taskControl: "TASK_CONTROL",
      allowChangeDeadline: "ALLOW_CHANGE_DEADLINE",
      allowTimeTracking: "ALLOW_TIME_TRACKING",
      timeEstimate: "TIME_ESTIMATE",
      startDatePlan: "START_DATE_PLAN",
      endDatePlan: "END_DATE_PLAN",
    } as const;
    for (const [source, target] of Object.entries(mapping)) {
      const value = input[source as keyof typeof mapping];
      if (value !== undefined)
        fields[target] =
          typeof value === "boolean" ? (value ? "Y" : "N") : value;
    }
    if (
      input.startDatePlan &&
      input.endDatePlan &&
      Date.parse(input.startDatePlan) > Date.parse(input.endDatePlan)
    )
      return fail("INVALID_PLANNED_DATES");
    if (input.customFields) {
      if (Object.keys(input.customFields).length > 30)
        return fail("TOO_MANY_CUSTOM_FIELDS");
      const raw = object(await this.#client.call("tasks.task.getFields"));
      const metadata = object(raw.fields ?? raw);
      for (const [key, value] of Object.entries(input.customFields)) {
        if (
          ["UF_TASK_WEBDAV_FILES", "UF_CRM_TASK"].includes(key) ||
          !Object.hasOwn(metadata, key)
        )
          return fail("CUSTOM_FIELD_NOT_SUPPORTED");
        const field = object(metadata[key]);
        if (field.isReadOnly === true || field.isReadOnly === "Y")
          return fail("CUSTOM_FIELD_NOT_SUPPORTED");
        fields[key] = value;
      }
    }
    return fields;
  }
  async #updateFields(
    input: Extract<TaskWrite, { action: "update" }>,
    snapshot: Snapshot,
  ): Promise<Data> {
    const fields: Data = {};
    const mapping = {
      title: "TITLE",
      description: "DESCRIPTION",
      deadline: "DEADLINE",
      auditors: "AUDITORS",
      accomplices: "ACCOMPLICES",
      projectId: "GROUP_ID",
      priority: "PRIORITY",
      tags: "TAGS",
    } as const;
    for (const [key, target] of Object.entries(mapping)) {
      const value = input[key as keyof typeof mapping];
      if (value !== undefined)
        fields[target] = value ?? (key === "projectId" ? 0 : "");
    }
    if (input.addAuditors !== undefined || input.removeAuditors !== undefined) {
      const raw = snapshot.editState?.auditors;
      if (!Array.isArray(raw) || raw.some((v) => positive(v) === null))
        return fail("INVALID_RESPONSE");
      fields.AUDITORS = [
        ...new Set([
          ...raw.map((v) => positive(v)!),
          ...(input.addAuditors ?? []),
        ]),
      ].filter((v) => !(input.removeAuditors ?? []).includes(v));
      if ((fields.AUDITORS as number[]).length > 50)
        return fail("TOO_MANY_AUDITORS");
    }
    for (const person of new Set([
      ...((fields.AUDITORS as number[]) ?? []),
      ...(input.accomplices ?? []),
    ]))
      await this.#person(person);
    if (input.projectId) {
      const raw = await this.#client.call("sonet_group.get", {
        FILTER: { ID: input.projectId },
      });
      if (
        !(Array.isArray(raw) ? raw : []).some(
          (v) => positive(object(v).ID) === input.projectId,
        )
      )
        return fail("PROJECT_NOT_FOUND_OR_DENIED");
    }
    if (input.checklist?.length) { this.#nextChecklistSort(snapshot); this.#checklistTarget(input, snapshot); }
    const checklist = snapshot.editState?.checklist;
    if (input.checklistUpdates?.length) {
      if (!Array.isArray(checklist)) return fail("INVALID_RESPONSE");
      const ids = new Set(
        checklist.map((v) => positive(object(v).ID ?? object(v).id)),
      );
      if (
        new Set(input.checklistUpdates.map((v) => v.id)).size !==
          input.checklistUpdates.length ||
        input.checklistUpdates.some((v) => !ids.has(v.id))
      )
        return fail("CHECKLIST_ITEM_NOT_FOUND");
    }
    return fields;
  }
  #checklistTarget(input: Extract<TaskWrite, { action: "update" }>, snapshot: Snapshot): { id: number | null; title: string } {
    const rows = snapshot.editState?.checklist;
    if (!Array.isArray(rows)) return fail("INVALID_RESPONSE");
    if (input.checklistTitle) return { id: null, title: input.checklistTitle };
    const roots = rows.map(object).filter(row => Number(row.PARENT_ID ?? row.parentId) === 0);
    const root = input.checklistId ? roots.find(row => positive(row.ID ?? row.id) === input.checklistId) : roots[0];
    if (input.checklistId && !root) return fail("CHECKLIST_ITEM_NOT_FOUND");
    if (!input.checklistId && roots.length > 1) return fail("CHECKLIST_SELECTION_REQUIRED");
    if (!root) return { id: null, title: "Чек-лист" };
    const rootId = positive(root.ID ?? root.id);
    if (!rootId || typeof (root.TITLE ?? root.title) !== "string") return fail("INVALID_RESPONSE");
    return { id: rootId, title: String(root.TITLE ?? root.title) };
  }
  #nextChecklistSort(snapshot: Snapshot): number {
    const list = snapshot.editState?.checklist;
    if (!Array.isArray(list)) return fail("INVALID_RESPONSE");
    return list.reduce((max, row) => {
      const n = Number(object(row).SORT_INDEX ?? object(row).sortIndex ?? 0);
      if (!Number.isSafeInteger(n) || n < 0 || n > 2_000_000_000)
        return fail("INVALID_RESPONSE");
      return Math.max(max, n + 1);
    }, 0);
  }
  async #prepareOne(input: TaskWrite, owner: number): Promise<Prepared> {
    let snapshot: Snapshot | null = null;
    let file: Prepared["file"] = null;
    const lines: string[] = [];
    const uploads: FileStamp[] = [];
    if (input.action === "create") {
      await this.#createFields(input, owner);
      lines.push(
        "Создать задачу в Битрикс24",
        `Название: ${previewText(input.title)}`,
        `Описание: ${previewText(input.description)}`,
        `Ответственный: ${previewText((await this.#person(input.responsibleId, true)).label)}`,
        `Срок: ${previewDate(input.deadline)}`,
      );
      for (const [key, label] of [
        ["auditors", "Наблюдатели"],
        ["accomplices", "Соисполнители"],
      ] as const) {
        const labels = [];
        for (const person of input[key] ?? [])
          labels.push(previewText((await this.#person(person)).label));
        if (labels.length) lines.push(`${label}: ${labels.join(", ")}`);
      }
      if (input.projectId) {
        const raw = await this.#client.call("sonet_group.get", {
          FILTER: { ID: input.projectId },
        });
        const project = (Array.isArray(raw) ? raw : [])
          .map(object)
          .find((p) => positive(p.ID) === input.projectId);
        if (!project) return fail("PROJECT_NOT_FOUND_OR_DENIED");
        lines.push(
          `Проект: ${previewText(String(project.NAME).slice(0, 250))} (ID ${input.projectId})`,
        );
      }
      if (input.checklist?.length)
        lines.push(
          `Чек-лист «${previewText(input.checklistTitle ?? "Чек-лист")}»:`,
          ...input.checklist.map(item => `☐ ${previewText(item)}`),
        );
      const extras = Object.fromEntries(
        Object.entries(input).filter(
          ([key]) =>
            ![
              "action",
              "title",
              "description",
              "responsibleId",
              "deadline",
              "auditors",
              "accomplices",
              "projectId",
              "checklist",
              "checklistTitle",
              "comment",
              "uploads",
            ].includes(key),
        ),
      );
      const labels: Record<string, string> = {
        priority: "Приоритет",
        parentId: "Родительская задача",
        tags: "Теги",
        taskControl: "Контроль результата",
        allowChangeDeadline: "Исполнитель может менять срок",
        allowTimeTracking: "Учёт времени",
        timeEstimate: "Оценка времени, секунд",
        startDatePlan: "Начало по плану",
        endDatePlan: "Окончание по плану",
        customFields: "Пользовательские поля",
      };
      for (const [key, value] of Object.entries(extras))
        lines.push(
          `${labels[key]}: ${["startDatePlan", "endDatePlan"].includes(key) ? previewDate(String(value)) : typeof value === "boolean" ? (value ? "да" : "нет") : previewText(JSON.stringify(value))}`,
        );
      if (input.comment)
        lines.push(
          `Комментарий в обсуждение новой задачи: ${previewText(input.comment)}`,
        );
      for (const upload of input.uploads ?? []) {
        const content = await this.#file(upload.path);
        uploads.push({
          name: content.name,
          bytes: content.bytes,
          sha256: content.sha256,
        });
        lines.push(
          `Файл в чат новой задачи: ${previewText(content.name)} (${content.bytes} байт)`,
          `Текст к файлу: ${previewText(upload.message ?? "без сообщения")}`,
        );
      }
    } else {
      snapshot = await this.#snapshot(input, owner);
      const labels = {
        update: "Изменить существующую задачу",
        comment: "Добавить комментарий",
        upload: "Добавить файл в чат задачи",
        complete: "Закрыть задачу",
        rework: "Вернуть на доработку",
        reassign: "Изменить ответственного",
        deadline: "Изменить срок",
        stage: "Переместить в стадию канбана",
        delete_file: "Удалить файл из чата задачи",
        delete_message: "Удалить сообщение из чата задачи",
      };
      lines.push(
        labels[input.action],
        `Задача №${input.taskId}: ${previewText(snapshot.title)}`,
        `Ответственный: ${previewText((await this.#person(snapshot.responsibleId, true)).label)}`,
        `Текущий срок: ${previewDate(snapshot.deadline)}`,
        `Текущий статус: ${{2: "Новая", 3: "В работе", 4: "На контроле", 5: "Завершена", 6: "Отложена"}[snapshot.status] ?? snapshot.status}`,
      );
      if (input.action === "update") {
        const fields = await this.#updateFields(input, snapshot);
        const labels: Record<string, string> = {
          TITLE: "Новое название",
          DESCRIPTION: "Новое описание",
          DEADLINE: "Новый срок",
          AUDITORS: "Наблюдатели после правки",
          ACCOMPLICES: "Соисполнители",
          GROUP_ID: "Проект",
          PRIORITY: "Приоритет",
          TAGS: "Теги",
        };
        for (const [key, value] of Object.entries(fields)) {
          let display =
            typeof value === "string" ? value : JSON.stringify(value);
          if (key === "DEADLINE") display = previewDate(typeof value === "string" ? value : null);
          if (["AUDITORS", "ACCOMPLICES"].includes(key)) {
            const names: string[] = [];
            for (const person of value as number[])
              names.push((await this.#person(person)).label);
            display = names.join(", ") || "нет";
          }
          lines.push(`${labels[key]}: ${previewText(display || "очистить")}`);
        }
        if (input.checklist?.length)
          lines.push(
            `${input.checklistTitle ? "Создать чек-лист" : "Добавить в чек-лист"} «${previewText(this.#checklistTarget(input, snapshot).title)}»:`,
            ...input.checklist.map(v => `☐ ${previewText(v)}`),
          );
        for (const change of input.checklistUpdates ?? []) {
          const rows = snapshot.editState!.checklist as Data[];
          const item = object(rows.find(v => positive(object(v).ID ?? object(v).id) === change.id));
          const title = String(item.TITLE ?? item.title ?? `Пункт №${change.id}`);
          const duplicates = rows.filter(v => (object(v).TITLE ?? object(v).title) === title).length > 1;
          const details = [change.title !== undefined ? `переименовать в «${change.title}»` : "", change.completed !== undefined ? (change.completed ? "выполнен" : "не выполнен") : ""].filter(Boolean).join(", ");
          lines.push(`${change.completed === true ? "☑" : "☐"} ${previewText(title)}${duplicates ? ` (пункт №${change.id})` : ""}: ${previewText(details)}`);
        }
      }
      if (input.action === "comment" || input.action === "upload")
        lines.push(`Текст: ${previewText(input.message ?? "без сообщения")}`);
      if (input.action === "comment")
        lines.push(
          `Куда: ${snapshot.chatId ? "чат задачи" : "комментарии задачи"}`,
        );
      if (input.action === "deadline")
        lines.push(`Новый срок: ${previewDate(input.deadline)}`);
      if (input.action === "reassign")
        lines.push(
          `Новый ответственный: ${previewText((await this.#person(input.responsibleId, true)).label)}`,
        );
      if (input.action === "stage")
        lines.push(`Новая стадия: ${previewText(String(object(snapshot.editState?.destination).title))} (ID ${input.stageId})`);
      if (input.action === "delete_file")
        lines.push(`Файл: ${previewText(String(snapshot.editState?.name))} (ID ${input.fileId})`, "Файл будет удалён из папки чата. Действие необратимо.");
      if (input.action === "delete_message")
        lines.push(`Сообщение №${input.messageId}: ${previewText(String(snapshot.editState?.text))}`, "Сообщение будет удалено из чата задачи.");
      if (input.action === "complete")
        lines.push(
          snapshot.status === 4
            ? "Будет принят результат задачи на контроле."
            : "Будет завершена задача; при включённом контроле она может перейти на проверку постановщику.",
        );
      if (input.action === "rework")
        lines.push(
          snapshot.status === 4
            ? "Результат на контроле будет отклонён."
            : "Закрытая задача будет возобновлена.",
        );
      if (input.action === "upload") {
        const content = await this.#file(input.path);
        file = {
          name: content.name,
          bytes: content.bytes,
          sha256: content.sha256,
        };
        lines.push(`Файл: ${previewText(file.name)} (${file.bytes} байт)`);
      }
    }
    return {
      input,
      snapshot,
      file,
      uploads,
      prompt: [lines[0], lines.slice(1).join("\n")].join("\n\n"),
      displayLines: lines,
    };
  }
  async prepare(raw: TaskRequest, presentation: "native" | "rich" = "native") {
    if (presentation !== "native" && presentation !== "rich") return fail("INVALID_PRESENTATION");
    const input = taskWriteSchema.parse(raw);
    return this.#locked(async () => {
      const settings = this.#settings ? await this.#settings.read() : { revision: 0, policy: LEGACY_POLICY };
      this.#policy = settings.policy;
      for (const action of input.action === "batch" ? input.actions : [input]) assertWritePolicy(this.#policy, action);
      this.#emailAvailable = undefined;
      this.#departmentNames.clear();
      const owner = await this.#owner();
      const actions = input.action === "batch" ? input.actions : [input];
      // Combining two updates for one card would resolve participant deltas against the same old state.
      const updates = actions
        .filter((v) => v.action === "update")
        .map((v) => v.taskId);
      if (new Set(updates).size !== updates.length)
        return fail("DUPLICATE_TASK_UPDATE");
      const steps: Prepared[] = [];
      for (const action of actions)
        steps.push(await this.#prepareOne(action, owner));
      if (
        steps.reduce(
          (total, step) =>
            total +
            (step.file?.bytes ?? 0) +
            step.uploads.reduce((n, v) => n + v.bytes, 0),
          0,
        ) > FILE_LIMIT
      )
        return fail("UPLOAD_BATCH_TOO_LARGE");
      const seenTasks = new Set<number>();
      const batchPrompt = steps
        .map((step, index) => {
          const parts = [...step.displayLines];
          if (step.input.action !== "create") {
            if (seenTasks.has(step.input.taskId)) {
              parts.splice(1, 4); // Task context already appears in this same approval card.
            } else seenTasks.add(step.input.taskId);
          }
          parts[0] = `${index + 1}. ${parts[0]!}`;
          return parts.join("\n");
        })
        .join("\n\n");
      const offer: Offer = {
        schema: 5,
        settingsRevision: settings.revision,
        presentation,
        confirmationReply: `Подтвердить ${randomUUID()}`,
        draftId: randomUUID(),
        owner,
        portal: this.#client.taskWebUrl(1),
        createdAt: this.#now(),
        input,
        steps,
        prompt:
          input.action === "batch"
            ? `Все изменения — одно подтверждение\n\n${batchPrompt}\n\nДействия выполнятся по порядку. При ошибке выполнение остановится; уже выполненное сохранится.`
            : steps[0]!.prompt,
      };
      // Telegram cards are bounded. Refuse rather than hide/truncate any approved field.
      if (offer.prompt.length > 3500) return fail("PREVIEW_TOO_LARGE");
      const cancelReply = `Отменить ${offer.draftId}`;
      const markdown = presentation === "rich"
        ? richPreview(offer.prompt, offer.confirmationReply, cancelReply) : null;
      if (markdown && Buffer.byteLength(markdown, "utf8") > 14_000) return fail("PREVIEW_TOO_LARGE");
      await this.#atomic(join(this.#root(), "active.json"), offer);
      return {
        draftId: offer.draftId,
        expiresAt: new Date(offer.createdAt + TTL).toISOString(),
        presentation,
        richApproval: markdown === null ? null : {
          markdown,
          confirmReply: offer.confirmationReply,
          cancelReply,
        },
        approvalPrompt: {
          prompt: offer.prompt,
          options: [
            { id: "confirm", label: "✅ Подтвердить" },
            { id: "cancel", label: "❌ Отменить" },
          ],
          allowFreeform: true,
        },
        untrustedContent: true,
      };
    });
  }
  async #offer(draftId: string): Promise<Offer> {
    if (!z.uuid().safeParse(draftId).success) return fail("INVALID_DRAFT_ID");
    let raw: Data;
    try { raw = object(JSON.parse(await readFile(join(this.#root(), "active.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail("DRAFT_SUPERSEDED");
      return fail("INVALID_DRAFT_ID");
    }
    if (raw.schema !== 5 || raw.draftId !== draftId)
      return fail("DRAFT_SUPERSEDED");
    const offer = raw as Offer;
    const age = this.#now() - offer.createdAt;
    if (!Number.isFinite(age) || age < 0 || age > TTL)
      return fail("DRAFT_EXPIRED");
    if (
      offer.owner !== (await this.#owner()) ||
      offer.portal !== this.#client.taskWebUrl(1)
    )
      return fail("DRAFT_OWNER_CHANGED");
    const input = taskWriteSchema.parse(offer.input);
    const actions = input.action === "batch" ? input.actions : [input];
    if (
      !Array.isArray(offer.steps) ||
      JSON.stringify(
        offer.steps.map((step) => singleWriteSchema.parse(step.input)),
      ) !== JSON.stringify(actions)
    )
      return fail("INVALID_DRAFT_STATE");
    return offer;
  }
  async status(draftId: string) {
    if (!z.uuid().safeParse(draftId).success) return fail("INVALID_DRAFT_ID");
    const result = object(
      JSON.parse(await readFile(join(this.#root(), `${draftId}.json`), "utf8")),
    );
    if (
      result.owner !== (await this.#owner()) ||
      result.portal !== this.#client.taskWebUrl(1)
    )
      return fail("DRAFT_OWNER_CHANGED");
    const { owner: _owner, portal: _portal, ...receipt } = result;
    return receipt;
  }
  async cancel(draftId: string) {
    return this.#locked(async () => {
      await this.#offer(draftId);
      await rm(join(this.#root(), "active.json"));
      return { state: "cancelled", draftId };
    });
  }
  async apply(draftId: string, confirmationReply?: string) {
    return this.#locked(async () => {
      if (!z.uuid().safeParse(draftId).success) return fail("INVALID_DRAFT_ID");
      const receiptPath = join(this.#root(), `${draftId}.json`);
      try {
        return await this.status(draftId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const offer = await this.#offer(draftId);
      const settings = this.#settings ? await this.#settings.read() : { revision: 0, policy: LEGACY_POLICY };
      if (settings.revision !== offer.settingsRevision) return fail("SETTINGS_CHANGED");
      this.#policy = settings.policy;
      for (const step of offer.steps) assertWritePolicy(this.#policy, step.input);
      if (offer.presentation === "rich" && confirmationReply !== offer.confirmationReply)
        return fail("CONFIRMATION_MISMATCH");
      const prepared: {
        step: Prepared;
        file: UploadContent | null;
        uploads: UploadContent[];
        fields: Data | null;
      }[] = [];
      // Validate the entire request before the first write.
      for (const step of offer.steps) {
        const input = step.input;
        if (input.action !== "create") {
          const current = await this.#snapshot(input, offer.owner);
          if (JSON.stringify(current) !== JSON.stringify(step.snapshot))
            return fail("TASK_CHANGED_SINCE_PREVIEW");
        }
        const file =
          input.action === "upload" ? await this.#file(input.path) : null;
        if (file && file.sha256 !== step.file?.sha256)
          return fail("UPLOAD_FILE_CHANGED");
        const fields =
          input.action === "create"
            ? await this.#createFields(input, offer.owner)
            : input.action === "update"
              ? await this.#updateFields(input, step.snapshot!)
              : null;
        if (input.action === "create")
          for (const userId of new Set([
            input.responsibleId,
            ...(input.auditors ?? []),
            ...(input.accomplices ?? []),
          ]))
            await this.#person(userId);
        const uploads: UploadContent[] = [];
        if (input.action === "create")
          for (const [index, upload] of (input.uploads ?? []).entries()) {
            const content = await this.#file(upload.path);
            if (content.sha256 !== step.uploads[index]?.sha256)
              return fail("UPLOAD_FILE_CHANGED");
            uploads.push(content);
          }
        prepared.push({ step, file, uploads, fields });
      }
      let result: Data = {
        owner: offer.owner,
        portal: offer.portal,
        state: "unknown",
        draftId,
        action: offer.input.action,
        taskId:
          offer.input.action === "batch" || offer.input.action === "create"
            ? null
            : offer.input.taskId,
        completedChecklistItems: 0,
        completedOperations: 0,
        completedWrites: 0,
        operations: [],
      };
      await this.#atomic(receiptPath, result);
      const operations: Data[] = [];
      const touchedTasks = new Set<number>();
      let active: Data | null = null;
      const persist = async () => {
        result.operations = operations;
        await this.#atomic(receiptPath, result);
      };
      const write = async (method: WriteMethod, params: Data) => {
        const current = this.#settings ? await this.#settings.read() : { revision: 0, policy: LEGACY_POLICY };
        if (current.revision !== offer.settingsRevision) return fail("SETTINGS_CHANGED");
        assertWritePolicy(current.policy, { action: method === "im.v2.File.upload" ? "upload" : method === "im.disk.file.delete" ? "delete_file" : method === "im.message.delete" ? "delete_message" : "write" });
        result.currentMethod = method;
        if (active) active.state = "unknown";
        await persist(); // The pending method remains unknown after a crash, never replayed.
        const response = await this.#client.write(method, params);
        result.completedWrites = Number(result.completedWrites) + 1;
        if (active) active.completedWrites = Number(active.completedWrites) + 1;
        await persist();
        return response;
      };
      try {
        for (const { step, file, uploads, fields } of prepared) {
          const input = step.input;
          active = {
            action: input.action,
            taskId: input.action === "create" ? null : input.taskId,
            state: "pending",
            completedWrites: 0,
            completedChecklistItems: 0,
            completedChecklistUpdates: 0,
          };
          operations.push(active);
          result.currentOperation = operations.length - 1;
          if (input.action === "create") {
            const response = object(await write("tasks.task.add", { fields }));
            const taskId =
              positive(object(response.task).id) ??
              fail("WRITE_RESULT_UNKNOWN");
            active.taskId = taskId;
            if (offer.input.action !== "batch") result.taskId = taskId;
            await persist();
          } else {
            const snapshot = step.snapshot!;
            // Recheck permissions and routing after preceding operations, without treating our own writes as stale preview data.
            const current = await this.#snapshot(input, offer.owner);
            if (
              (!touchedTasks.has(input.taskId) &&
                JSON.stringify(current) !== JSON.stringify(snapshot)) ||
              current.chatId !== snapshot.chatId ||
              current.method !== snapshot.method ||
              ((input.action === "delete_file" || input.action === "delete_message") && JSON.stringify(current.editState) !== JSON.stringify(snapshot.editState)) ||
              (input.action === "stage" && (current.editState?.projectId !== snapshot.editState?.projectId || JSON.stringify(current.editState?.destination) !== JSON.stringify(snapshot.editState?.destination)))
            )
              return fail("TASK_CHANGED_SINCE_PREVIEW");
            let params: Data = { taskId: input.taskId };
            if (input.action === "comment")
              params = snapshot.chatId
                ? {
                    DIALOG_ID: `chat${snapshot.chatId}`,
                    MESSAGE: input.message,
                  }
                : { "0": input.taskId, "1": { POST_MESSAGE: input.message } };
            if (input.action === "upload")
              params = {
                dialogId: `chat${snapshot.chatId}`,
                fields: {
                  name: file!.name,
                  content: file!.data.toString("base64"),
                  ...(input.message ? { message: input.message } : {}),
                },
              };
            if (input.action === "stage") params = { id: input.taskId, stageId: input.stageId };
            if (input.action === "delete_file") params = { CHAT_ID: snapshot.chatId, FILE_ID: input.fileId };
            if (input.action === "delete_message") params = { MESSAGE_ID: input.messageId };
            if (input.action === "deadline")
              params.fields = { DEADLINE: input.deadline };
            if (input.action === "reassign")
              params.fields = { RESPONSIBLE_ID: input.responsibleId };
            if (input.action === "update") params.fields = fields;
            if (input.action !== "update" || Object.keys(fields!).length) {
              const response = await write(snapshot.method, params);
              if (input.action === "delete_file") {
                // true may mean a no-op; reconcile against the same task chat.
                try {
                  await this.#chatTarget(snapshot.chatId!, input, offer.owner);
                  return fail("WRITE_RESULT_UNKNOWN");
                } catch (error) {
                  if (!(error instanceof BitrixRequestError) || !["FILE_NOT_IN_TASK_CHAT", "MESSAGE_NOT_IN_TASK_CHAT"].includes(error.code))
                    return fail("WRITE_RESULT_UNKNOWN");
                }
                active.fileId = input.fileId;
                active.messageId = input.messageId;
              }
              if (input.action === "delete_message") active.messageId = input.messageId;
              if (input.action === "stage") active.stageId = input.stageId;
              if (input.action === "upload") {
                const uploaded = object(response);
                const fileId = positive(object(uploaded.file).id),
                  messageId = positive(uploaded.messageId);
                if (!fileId || !messageId) return fail("WRITE_RESULT_UNKNOWN");
                active.fileId = fileId;
                active.messageId = messageId;
                if (offer.input.action !== "batch") {
                  result.fileId = fileId;
                  result.messageId = messageId;
                }
                await persist();
              }
            }
          }
          if (input.action === "create" || input.action === "update") {
            let checklistId: number | null = null;
            if (input.checklist?.length) {
              const target = input.action === "update" ? this.#checklistTarget(input, step.snapshot!) : { id: null, title: input.checklistTitle ?? "Чек-лист" };
              checklistId = target.id;
              if (!checklistId) {
                const response = await write("task.checklistitem.add", {
                  TASKID: active.taskId,
                  FIELDS: { TITLE: target.title, PARENT_ID: 0, SORT_INDEX: input.action === "update" ? this.#nextChecklistSort(step.snapshot!) : 0 },
                });
                checklistId = positive(response);
                if (!checklistId) return fail("WRITE_RESULT_UNKNOWN");
                active.checklistId = checklistId;
                await persist();
              }
            }
            for (const [index, title] of (input.checklist ?? []).entries()) {
              await write("task.checklistitem.add", {
                TASKID: active.taskId,
                FIELDS: {
                  TITLE: title,
                  PARENT_ID: checklistId,
                  SORT_INDEX:
                    index +
                    (input.action === "update"
                      ? this.#nextChecklistSort(step.snapshot!)
                      : 0),
                },
              });
              active.completedChecklistItems = index + 1;
              result.completedChecklistItems =
                Number(result.completedChecklistItems) + 1;
              await persist();
            }
            if (input.action === "update")
              for (const change of input.checklistUpdates ?? []) {
                await write("task.checklistitem.update", {
                  TASKID: input.taskId,
                  ITEMID: change.id,
                  FIELDS: {
                    ...(change.title !== undefined
                      ? { TITLE: change.title }
                      : {}),
                    ...(change.completed !== undefined
                      ? { IS_COMPLETE: change.completed ? "Y" : "N" }
                      : {}),
                  },
                });
                active.completedChecklistUpdates =
                  Number(active.completedChecklistUpdates) + 1;
                await persist();
              }
          }
          if (input.action === "create") {
            const taskId = Number(active.taskId);
            if (input.comment) {
              const route = await this.#snapshot(
                { action: "comment", taskId, message: input.comment },
                offer.owner,
              );
              await write(
                route.method,
                route.chatId
                  ? { DIALOG_ID: `chat${route.chatId}`, MESSAGE: input.comment }
                  : { "0": taskId, "1": { POST_MESSAGE: input.comment } },
              );
              active.commentSent = true;
              await persist();
            }
            active.files = [];
            for (const [index, file] of uploads.entries()) {
              const upload = input.uploads![index]!;
              const route = await this.#snapshot(
                { action: "upload", taskId, path: upload.path },
                offer.owner,
              );
              const response = object(
                await write(route.method, {
                  dialogId: `chat${route.chatId}`,
                  fields: {
                    name: file.name,
                    content: file.data.toString("base64"),
                    ...(upload.message ? { message: upload.message } : {}),
                  },
                }),
              );
              const fileId = positive(object(response.file).id),
                messageId = positive(response.messageId);
              if (!fileId || !messageId) return fail("WRITE_RESULT_UNKNOWN");
              (active.files as Data[]).push({
                fileId,
                messageId,
                name: file.name,
              });
              await persist();
            }
          }
          touchedTasks.add(Number(active.taskId));
          active.state = "applied";
          active.webUrl = this.#client.taskWebUrl(Number(active.taskId));
          result.completedOperations = Number(result.completedOperations) + 1;
          await persist();
        }
        result.state = "applied";
        delete result.currentMethod;
      } catch (error) {
        const code =
          error instanceof BitrixRequestError
            ? error.code
            : "WRITE_RESULT_UNKNOWN";
        const unknown = code === "WRITE_RESULT_UNKNOWN";
        if (active) {
          active.state = unknown
            ? "unknown"
            : Number(active.completedWrites) > 0
              ? "partial"
              : "failed";
          active.error = code;
        }
        result.state =
          unknown &&
          Number(result.completedOperations) === 0 &&
          !positive(active?.taskId)
            ? "unknown"
            : Number(result.completedWrites) > 0
              ? "partial"
              : unknown
                ? "unknown"
                : "failed";
        result.error = code;
        result.doNotRetry = true;
      }
      if (positive(result.taskId))
        result.webUrl = this.#client.taskWebUrl(Number(result.taskId));
      await persist();
      await rm(join(this.#root(), "active.json"), { force: true });
      const { owner: _owner, portal: _portal, ...receipt } = result;
      return receipt;
    });
  }
}
