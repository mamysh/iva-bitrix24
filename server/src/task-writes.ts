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
export const taskWriteSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      title: z.string().trim().min(1).max(250),
      description: text,
      responsibleId: id,
      deadline: date,
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
export type TaskWrite = z.infer<typeof taskWriteSchema>;
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
};
type Offer = {
  schema: 1;
  draftId: string;
  owner: number;
  portal: string;
  createdAt: number;
  input: TaskWrite;
  snapshot: Snapshot | null;
  file: { name: string; bytes: number; sha256: string } | null;
  prompt: string;
};

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
  async prepare(raw: TaskWrite) {
    const input = taskWriteSchema.parse(raw);
    return this.#locked(async () => {
      const owner = await this.#owner();
      let snapshot: Snapshot | null = null;
      let file: Offer["file"] = null;
      const lines: string[] = [];
      if (input.action === "create") {
        await this.#createFields(input, owner);
        lines.push(
          "Создать задачу в Битрикс24",
          `Название: ${input.title}`,
          `Описание: ${input.description}`,
          `Ответственный: ${(await this.#person(input.responsibleId)).label}`,
          `Срок: ${input.deadline}`,
        );
        for (const [key, label] of [
          ["auditors", "Наблюдатели"],
          ["accomplices", "Соисполнители"],
        ] as const) {
          const labels = [];
          for (const person of input[key] ?? [])
            labels.push((await this.#person(person)).label);
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
            `Проект: ${String(project.NAME).slice(0, 250)} (ID ${input.projectId})`,
          );
        }
        if (input.checklist?.length)
          lines.push(
            "Чек-лист:",
            ...input.checklist.map((item, i) => `${i + 1}. ${item}`),
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
            `${labels[key]}: ${typeof value === "boolean" ? (value ? "да" : "нет") : JSON.stringify(value)}`,
          );
      } else {
        snapshot = await this.#snapshot(input, owner);
        const labels = {
          comment: "Добавить комментарий",
          upload: "Добавить файл в чат задачи",
          complete: "Закрыть задачу",
          rework: "Вернуть на доработку",
          reassign: "Изменить ответственного",
          deadline: "Изменить срок",
        };
        lines.push(
          labels[input.action],
          `Задача №${input.taskId}: ${snapshot.title}`,
          `Ответственный: ${(await this.#person(snapshot.responsibleId)).label}`,
          `Текущий срок: ${snapshot.deadline ?? "не задан"}`,
          `Текущий статус: ${snapshot.status}`,
        );
        if (input.action === "comment" || input.action === "upload")
          lines.push(`Текст: ${input.message ?? "без сообщения"}`);
        if (input.action === "comment")
          lines.push(
            `Куда: ${snapshot.chatId ? "чат задачи" : "комментарии задачи"}`,
          );
        if (input.action === "deadline")
          lines.push(`Новый срок: ${input.deadline}`);
        if (input.action === "reassign")
          lines.push(
            `Новый ответственный: ${(await this.#person(input.responsibleId)).label}`,
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
          lines.push(`Файл: ${file.name} (${file.bytes} байт)`);
        }
      }
      const offer: Offer = {
        schema: 1,
        draftId: randomUUID(),
        owner,
        portal: this.#client.taskWebUrl(1),
        createdAt: this.#now(),
        input,
        snapshot,
        file,
        prompt: lines.join("\n\n"),
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
    if (raw.schema !== 1 || raw.draftId !== draftId)
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
    taskWriteSchema.parse(offer.input);
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
      const input = offer.input;
      if (input.action !== "create") {
        const current = await this.#snapshot(input, offer.owner);
        if (JSON.stringify(current) !== JSON.stringify(offer.snapshot))
          return fail("TASK_CHANGED_SINCE_PREVIEW");
      }
      const file =
        input.action === "upload" ? await this.#file(input.path) : null;
      if (file && file.sha256 !== offer.file?.sha256)
        return fail("UPLOAD_FILE_CHANGED");
      const fields =
        input.action === "create"
          ? await this.#createFields(input, offer.owner)
          : null;
      if (input.action === "create") {
        for (const userId of new Set([
          input.responsibleId,
          ...(input.auditors ?? []),
          ...(input.accomplices ?? []),
        ]))
          await this.#person(userId);
      }
      // Persist BEFORE any side effect. Even a crash cannot replay this write.
      let result: Data = {
        owner: offer.owner,
        portal: offer.portal,
        state: "unknown",
        draftId,
        action: input.action,
        taskId: input.action === "create" ? null : input.taskId,
        completedChecklistItems: 0,
      };
      await this.#atomic(receiptPath, result);
      try {
        if (input.action === "create") {
          const response = object(
            await this.#client.write("tasks.task.add", { fields }),
          );
          const taskId =
            positive(object(response.task).id) ?? fail("WRITE_RESULT_UNKNOWN");
          result.taskId = taskId;
          await this.#atomic(receiptPath, result);
          for (const [index, title] of (input.checklist ?? []).entries()) {
            await this.#client.write("task.checklistitem.add", {
              TASKID: taskId,
              FIELDS: { TITLE: title, SORT_INDEX: index },
            });
            result.completedChecklistItems = index + 1;
            await this.#atomic(receiptPath, result);
          }
        } else {
          const snapshot = offer.snapshot!;
          let params: Data = { taskId: input.taskId };
          if (input.action === "comment")
            params = snapshot.chatId
              ? { DIALOG_ID: `chat${snapshot.chatId}`, MESSAGE: input.message }
              : {
                  // Legacy comment API uses positional REST parameters.
                  "0": input.taskId,
                  "1": { POST_MESSAGE: input.message },
                };
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
          await this.#client.write(snapshot.method, params);
        }
        result.state = "applied";
      } catch (error) {
        result.state =
          result.taskId && input.action === "create"
            ? "partial"
            : error instanceof BitrixRequestError &&
                error.code !== "WRITE_RESULT_UNKNOWN"
              ? "failed"
              : "unknown";
        result.error =
          error instanceof BitrixRequestError
            ? error.code
            : "WRITE_RESULT_UNKNOWN";
        result.doNotRetry = true;
      }
      if (positive(result.taskId))
        result.webUrl = this.#client.taskWebUrl(Number(result.taskId));
      await this.#atomic(receiptPath, result);
      await rm(join(this.#root(), "active.json"), { force: true });
      const { owner: _owner, portal: _portal, ...receipt } = result;
      return receipt;
    });
  }
}
