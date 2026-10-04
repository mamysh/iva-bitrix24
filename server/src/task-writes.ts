import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, realpath, rm } from "node:fs/promises";
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
    .strict(),
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
};
type Offer = {
  schema: 2;
  draftId: string;
  owner: number;
  portal: string;
  createdAt: number;
  input: TaskRequest;
  steps: Prepared[];
  prompt: string;
};

// Escape presentation only: the approved task payload retains its original values.
function previewText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>~=$-]/gu, "\\$&");
}

// One pending preview per webhook owner. State is private plugin data, never inside the bundle.
export class TaskWriter {
  readonly #client: BitrixClient;
  readonly #data: string | undefined;
  readonly #attachments: string | undefined;
  readonly #now: () => number;
  constructor(
    client: BitrixClient,
    data?: string,
    attachments?: string,
    now = Date.now,
  ) {
    this.#client = client;
    this.#data = data;
    this.#attachments = attachments;
    this.#now = now;
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
    const root = this.#root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = join(root, "lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      return fail("WRITE_BUSY");
    }
    try {
      return await run();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  async #person(userId: number) {
    const raw = await this.#client.call("user.get", {
      ID: userId,
      ACTIVE: true,
      select: ["ID", "NAME", "LAST_NAME", "UF_DEPARTMENT", "ACTIVE"],
    });
    const person = (Array.isArray(raw) ? raw : [])
      .map(object)
      .find((p) => positive(p.ID) === userId);
    if (!person || (person.ACTIVE !== true && person.ACTIVE !== "Y"))
      return fail("EMPLOYEE_NOT_FOUND_OR_INACTIVE");
    return {
      person,
      label: `${[person.NAME, person.LAST_NAME]
        .filter((s) => typeof s === "string")
        .join(" ")
        .slice(0, 200)} (ID ${userId})`,
    };
  }
  async #subordinate(owner: number, assignee: number) {
    if (assignee === owner) return fail("ASSIGNEE_NOT_SUBORDINATE");
    const { person } = await this.#person(assignee);
    const departments = Array.isArray(person.UF_DEPARTMENT)
      ? person.UF_DEPARTMENT
      : [person.UF_DEPARTMENT];
    for (const department of departments.slice(0, 20)) {
      let current = positive(department);
      const seen = new Set<number>();
      for (let depth = 0; current !== null && depth < 30; depth++) {
        if (seen.has(current)) return fail("HIERARCHY_INVALID");
        seen.add(current);
        const raw = await this.#client.call("department.get", { ID: current });
        const row = (Array.isArray(raw) ? raw : [])
          .map(object)
          .find((d) => positive(d.ID) === current);
        if (!row) return fail("HIERARCHY_UNAVAILABLE");
        if (positive(row.UF_HEAD) === owner) return;
        current = positive(row.PARENT);
      }
      if (current !== null) return fail("HIERARCHY_LIMIT");
    }
    return fail("ASSIGNEE_NOT_SUBORDINATE");
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
          ],
        }),
      ).task,
    );
    if (positive(task.id) !== input.taskId)
      return fail("TASK_NOT_FOUND_OR_DENIED");
    const status = Number(task.status);
    const rights = object(task.action);
    let method: WriteMethod;
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
      case "update":
        if (rights.edit !== true) return fail("ACTION_NOT_ALLOWED");
        method = "tasks.task.update";
        break;
      case "deadline":
        if (rights.changeDeadline !== true) return fail("ACTION_NOT_ALLOWED");
        method = "tasks.task.update";
        break;
      case "reassign":
        if (rights.edit !== true) return fail("ACTION_NOT_ALLOWED");
        await this.#subordinate(
          owner,
          positive(task.responsibleId) ?? fail("INVALID_RESPONSE"),
        );
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
    if (input.checklist?.length) this.#nextChecklistSort(snapshot);
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
        `Ответственный: ${previewText((await this.#person(input.responsibleId)).label)}`,
        `Срок: ${input.deadline}`,
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
          "Чек-лист:",
          ...input.checklist.map((item, i) => `${i + 1}. ${previewText(item)}`),
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
          `${labels[key]}: ${typeof value === "boolean" ? (value ? "да" : "нет") : previewText(JSON.stringify(value))}`,
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
      };
      lines.push(
        labels[input.action],
        `Задача №${input.taskId}: ${previewText(snapshot.title)}`,
        `Ответственный: ${previewText((await this.#person(snapshot.responsibleId)).label)}`,
        `Текущий срок: ${previewText(snapshot.deadline ?? "не задан")}`,
        `Текущий статус: ${snapshot.status}`,
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
            "Добавить в чек-лист:",
            ...input.checklist.map((v, i) => `${i + 1}. ${previewText(v)}`),
          );
        for (const change of input.checklistUpdates ?? [])
          lines.push(
            `Правка пункта №${change.id}: ${previewText(JSON.stringify(change))}`,
          );
      }
      if (input.action === "comment" || input.action === "upload")
        lines.push(`Текст: ${previewText(input.message ?? "без сообщения")}`);
      if (input.action === "comment")
        lines.push(
          `Куда: ${snapshot.chatId ? "чат задачи" : "комментарии задачи"}`,
        );
      if (input.action === "deadline")
        lines.push(`Новый срок: ${input.deadline}`);
      if (input.action === "reassign")
        lines.push(
          `Новый ответственный: ${previewText((await this.#person(input.responsibleId)).label)}`,
        );
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
      prompt: lines
        .map((line, index) =>
          index === 0
            ? `## ${line}`
            : line.replace(/^([^:\n]+): /u, "**$1:** "),
        )
        .join("\n\n"),
    };
  }
  async prepare(raw: TaskRequest) {
    const input = taskWriteSchema.parse(raw);
    return this.#locked(async () => {
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
          const parts = step.prompt.split("\n\n");
          if (step.input.action !== "create") {
            if (seenTasks.has(step.input.taskId)) {
              parts.splice(1, 4); // Task context already appears in this same approval card.
            } else seenTasks.add(step.input.taskId);
          }
          parts[0] = `### ${index + 1}. ${parts[0]!.slice(3)}`;
          return parts.join("\n\n");
        })
        .join("\n\n");
      const offer: Offer = {
        schema: 2,
        draftId: randomUUID(),
        owner,
        portal: this.#client.taskWebUrl(1),
        createdAt: this.#now(),
        input,
        steps,
        prompt:
          input.action === "batch"
            ? `## Все изменения — одно подтверждение\n\n${batchPrompt}\n\nДействия выполнятся по порядку. При ошибке выполнение остановится; уже выполненное сохранится.`
            : steps[0]!.prompt,
      };
      // Telegram cards are bounded. Refuse rather than hide/truncate any approved field.
      if (offer.prompt.length > 3500) return fail("PREVIEW_TOO_LARGE");
      await this.#atomic(join(this.#root(), "active.json"), offer);
      return {
        draftId: offer.draftId,
        expiresAt: new Date(offer.createdAt + TTL).toISOString(),
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
    const raw = object(
      JSON.parse(await readFile(join(this.#root(), "active.json"), "utf8")),
    );
    if (raw.schema !== 2 || raw.draftId !== draftId)
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
  async apply(draftId: string) {
    return this.#locked(async () => {
      if (!z.uuid().safeParse(draftId).success) return fail("INVALID_DRAFT_ID");
      const receiptPath = join(this.#root(), `${draftId}.json`);
      try {
        return await this.status(draftId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const offer = await this.#offer(draftId);
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
              current.method !== snapshot.method
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
            if (input.action === "deadline")
              params.fields = { DEADLINE: input.deadline };
            if (input.action === "reassign")
              params.fields = { RESPONSIBLE_ID: input.responsibleId };
            if (input.action === "update") params.fields = fields;
            if (input.action !== "update" || Object.keys(fields!).length) {
              const response = await write(snapshot.method, params);
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
            for (const [index, title] of (input.checklist ?? []).entries()) {
              await write("task.checklistitem.add", {
                TASKID: active.taskId,
                FIELDS: {
                  TITLE: title,
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
