import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readdir, realpath, rm, lstat, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BitrixClient, BitrixRequestError } from "./bitrix-client.ts";

type Data = Readonly<Record<string, unknown>>;
const object = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const values = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : typeof value === "object" ? Object.values(object(value)) : [value];
const id = (value: unknown): string | null => {
  const candidate = typeof value === "number" ? String(value) : value;
  return typeof candidate === "string" && /^[1-9]\d{0,15}$/u.test(candidate) && Number.isSafeInteger(Number(candidate))
    ? candidate : null;
};
const attachmentId = (value: unknown): string | null => {
  if (typeof value === "string" && /^n[1-9]\d{0,15}$/u.test(value)) return id(value.slice(1));
  return id(value);
};
const str = (value: unknown, max = 500): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;
const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const timestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value.slice(0, 40) : null;
const run = promisify(execFile);

export type FileOrigin = "task" | "chat" | "legacy_comment" | "checklist";
export type TaskFile = {
  readonly key: string;
  readonly source: FileOrigin;
  readonly taskId: string;
  readonly fileId: string | null;
  readonly attachmentId: string | null;
  readonly name: string | null;
  readonly format: string | null;
  readonly size: number | null;
  readonly uploadedAt: string | null;
  readonly uploadedBy: string | null;
  readonly attachedAt: string | null;
  readonly attachedBy: string | null;
  readonly context: string | null;
  readonly contextId: string | null;
};

function format(name: string | null): string | null {
  if (!name) return null;
  const extension = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/u.test(extension) ? extension : null;
}

function makeFile(input: Omit<TaskFile, "format">): TaskFile {
  return { ...input, format: format(input.name) };
}

export class TaskFileReader {
  readonly #client: BitrixClient;
  readonly #attachmentsRoot: string | null;
  #employeeCache: { owner: string; expires: number; ids: string[] } | null = null;

  constructor(client: BitrixClient, attachmentsRoot?: string) {
    this.#client = client;
    this.#attachmentsRoot = attachmentsRoot && isAbsolute(attachmentsRoot) ? resolve(attachmentsRoot) : null;
  }

  async #diskMetadata(fileId: string | null): Promise<Data> {
    if (!fileId) return {};
    try {
      const info = object(await this.#client.call("disk.file.get", { id: Number(fileId) }));
      return id(info.ID) === fileId ? info : {};
    } catch (error) {
      if (error instanceof BitrixRequestError && ["ACCESS_DENIED", "ERROR_NOT_FOUND", "INSUFFICIENT_SCOPE"].includes(error.code)) return {};
      throw error;
    }
  }

  async search(options: { readonly query: string; readonly scope: "mine" | "department"; readonly phase: "open" | "recent_closed"; readonly cursor?: string | undefined; readonly closedSince?: string | undefined; readonly closedBefore?: string | undefined }) {
    const query = options.query.trim().toLocaleLowerCase();
    if (query.length < 2 || query.length > 200) throw new BitrixRequestError("INVALID_QUERY");
    const profile = object(await this.#client.call("profile"));
    const me = id(profile.ID ?? profile.id);
    if (!me) throw new BitrixRequestError("INVALID_PROFILE");
    const assignees = options.scope === "mine" ? [me] : await this.#departmentEmployees(me);
    const match = /^(\d{1,3}):(\d{1,5})$/u.exec(options.cursor ?? "0:0");
    if (!match) throw new BitrixRequestError("INVALID_CURSOR");
    let personIndex = Number(match[1]);
    let offset = Number(match[2]);
    if (personIndex > assignees.length || offset > 10_000) throw new BitrixRequestError("INVALID_CURSOR");
    const matches: Array<{ taskId: string; taskTitle: string | null; file: TaskFile }> = [];
    let scannedTasks = 0;
    let partial = false;
    const closedSince = options.closedSince ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (options.closedBefore && Date.parse(options.closedBefore) < Date.parse(closedSince)) throw new BitrixRequestError("INVALID_DATE_RANGE");
    while (personIndex < assignees.length && scannedTasks < 5) {
      const filter: Record<string, unknown> = {
        RESPONSIBLE_ID: Number(assignees[personIndex]),
        ...(options.phase === "open" ? { "!REAL_STATUS": 5 } : { REAL_STATUS: 5, ">=CLOSED_DATE": closedSince, ...(options.closedBefore ? { "<=CLOSED_DATE": options.closedBefore } : {}) }),
      };
      const response = await this.#client.callPage("tasks.task.list", {
        order: { ID: "DESC" }, filter, select: ["ID", "TITLE"], start: offset,
      });
      const tasks = object(response.result).tasks;
      if (!Array.isArray(tasks)) throw new BitrixRequestError("INVALID_RESPONSE");
      const selected = tasks.slice(0, 5 - scannedTasks);
      for (const rawTask of selected) {
        const task = object(rawTask);
        const taskId = id(task.ID ?? task.id);
        if (!taskId) { partial = true; continue; }
        scannedTasks += 1;
        const inventory = await this.list(Number(taskId));
        partial ||= inventory.partial;
        for (const file of inventory.files) {
          if ((file.name ?? "").toLocaleLowerCase().includes(query) || (file.context ?? "").toLocaleLowerCase().includes(query))
            matches.push({ taskId, taskTitle: str(task.TITLE ?? task.title, 300), file });
        }
      }
      if (selected.length === 0) {
        personIndex += 1;
        offset = 0;
      } else if (selected.length < tasks.length) {
        offset += selected.length;
      } else if (response.next !== null) {
        offset = response.next;
      } else {
        personIndex += 1;
        offset = 0;
      }
    }
    return {
      matches, found: matches.length, scannedTasks, scope: options.scope, phase: options.phase,
      nextCursor: personIndex < assignees.length ? `${personIndex}:${offset}` : null,
      ...(options.phase === "recent_closed" ? { closedSince, closedBefore: options.closedBefore ?? null } : {}),
      partial, untrustedContent: true,
    };
  }

  async #departmentEmployees(me: string): Promise<string[]> {
    if (this.#employeeCache?.owner === me && this.#employeeCache.expires > Date.now()) return this.#employeeCache.ids;
    const selfPage = await this.#client.callPage("user.get", {
      ID: Number(me), select: ["ID", "UF_DEPARTMENT"], start: 0,
    });
    if (!Array.isArray(selfPage.result)) throw new BitrixRequestError("INVALID_RESPONSE");
    const self = selfPage.result.map(object).find((user) => id(user.ID) === me);
    const roots = values(self?.UF_DEPARTMENT).map(id).filter((value): value is string => value !== null);
    if (roots.length === 0) throw new BitrixRequestError("DEPARTMENT_NOT_FOUND");
    const departments = new Set(roots);
    const queue = [...roots];
    while (queue.length && departments.size < 100) {
      const parent = queue.shift()!;
      let start = 0;
      for (;;) {
        const response = await this.#client.callPage("department.get", { PARENT: Number(parent), start });
        if (!Array.isArray(response.result)) throw new BitrixRequestError("INVALID_RESPONSE");
        for (const entry of response.result) {
          const department = object(entry);
          const child = id(department.ID);
          if (child && id(department.PARENT) === parent && !departments.has(child)) {
            departments.add(child);
            queue.push(child);
          }
        }
        if (response.next === null) break;
        start = response.next;
      }
    }
    if (queue.length) throw new BitrixRequestError("DEPARTMENT_SEARCH_LIMIT");
    const employees = new Set<string>();
    for (const department of departments) {
      let start = 0;
      for (;;) {
        const response = await this.#client.callPage("user.get", {
          UF_DEPARTMENT: Number(department), ACTIVE: true,
          select: ["ID", "UF_DEPARTMENT"], start,
        });
        if (!Array.isArray(response.result)) throw new BitrixRequestError("INVALID_RESPONSE");
        for (const entry of response.result) {
          const user = object(entry);
          const userId = id(user.ID);
          if (userId && userId !== me && values(user.UF_DEPARTMENT).some((part) => id(part) === department)) employees.add(userId);
        }
        if (employees.size > 200) throw new BitrixRequestError("EMPLOYEE_SEARCH_LIMIT");
        if (response.next === null) break;
        start = response.next;
      }
    }
    const ids = [...employees].sort((a, b) => Number(a) - Number(b));
    this.#employeeCache = { owner: me, expires: Date.now() + 5 * 60_000, ids };
    return ids;
  }

  async list(taskId: number) {
    const envelope = object(await this.#client.call("tasks.task.get", {
      taskId, select: ["ID", "CHAT_ID", "UF_TASK_WEBDAV_FILES"],
    }));
    const task = object(envelope.task);
    if (id(task.ID ?? task.id) !== String(taskId)) throw new BitrixRequestError("TASK_NOT_FOUND_OR_DENIED");
    const found: TaskFile[] = [];
    let skippedUnavailable = 0;
    const missingScopes = new Set<string>();
    let scannedMessages = 0;
    let scannedChecklist = 0;
    const allTaskAttachmentIds = values(task.UF_TASK_WEBDAV_FILES ?? task.ufTaskWebdavFiles)
      .map(attachmentId).filter((value): value is string => value !== null);
    const directTruncated = allTaskAttachmentIds.length > 100;
    const taskAttachmentIds = allTaskAttachmentIds.slice(0, 100);
    for (const attached of [...new Set(taskAttachmentIds)]) {
      try {
        const info = object(await this.#client.call("disk.attachedObject.get", { id: Number(attached) }));
        if (id(info.ID) !== attached || info.MODULE_ID !== "tasks" || info.ENTITY_TYPE !== "tasks_task" || id(info.ENTITY_ID) !== String(taskId)) {
          skippedUnavailable += 1;
          continue;
        }
        const disk = await this.#diskMetadata(id(info.OBJECT_ID));
        const name = str(info.NAME) ?? str(disk.NAME);
        found.push(makeFile({ key: `task:${attached}`, source: "task", taskId: String(taskId), fileId: id(info.OBJECT_ID), attachmentId: attached, name, size: number(info.SIZE) ?? number(disk.SIZE), uploadedAt: timestamp(disk.CREATE_TIME), uploadedBy: id(disk.CREATED_BY), attachedAt: timestamp(info.CREATE_TIME), attachedBy: id(info.CREATED_BY), context: null, contextId: null }));
      } catch (error) {
        if (error instanceof BitrixRequestError && error.code === "INSUFFICIENT_SCOPE") missingScopes.add("disk");
        else if (error instanceof BitrixRequestError && ["ACCESS_DENIED", "ERROR_NOT_FOUND"].includes(error.code)) skippedUnavailable += 1;
        else throw error;
      }
    }

    const chatId = id(task.CHAT_ID ?? task.chatId);
    let messagesTruncated = false;
    if (chatId) {
      try {
      let before: number | null = null;
      for (let page = 0; page < 4; page += 1) {
        const raw = object(await this.#client.call("im.dialog.messages.get", {
          DIALOG_ID: `chat${chatId}`, LIMIT: 50,
          ...(before === null ? {} : { LAST_ID: before }),
        }));
        if (!Array.isArray(raw.messages)) throw new BitrixRequestError("INVALID_RESPONSE");
        const files = new Map(values(raw.files).map((entry) => [id(object(entry).id), object(entry)]));
        let oldest = Number.MAX_SAFE_INTEGER;
        for (const entry of raw.messages) {
          const message = object(entry);
          const messageId = id(message.id);
          if (!messageId) continue;
          oldest = Math.min(oldest, Number(messageId));
          scannedMessages += 1;
          for (const rawFileId of values(object(message.params).FILE_ID).slice(0, 20)) {
            const fileId = id(rawFileId);
            if (!fileId) continue;
            const file = files.get(fileId) ?? {};
            const name = str(file.name) ?? `file-${fileId}`;
            found.push(makeFile({ key: `chat:${messageId}:${fileId}`, source: "chat", taskId: String(taskId), fileId, attachmentId: null, name, size: number(file.size), uploadedAt: timestamp(file.date), uploadedBy: id(file.authorId), attachedAt: timestamp(message.date), attachedBy: id(message.author_id), context: str(message.text, 1000), contextId: messageId }));
          }
        }
        if (raw.messages.length < 50 || oldest === Number.MAX_SAFE_INTEGER) break;
        if (page === 3) messagesTruncated = true;
        before = oldest;
      }
      } catch (error) {
        if (error instanceof BitrixRequestError && error.code === "INSUFFICIENT_SCOPE") missingScopes.add("im");
        else throw error;
      }
    } else {
      let start = 0;
      for (let page = 0; page < 4; page += 1) {
        const response = await this.#client.callPage("task.commentitem.getlist", { TASKID: taskId, ORDER: { ID: "DESC" }, FILTER: {}, start });
        if (!Array.isArray(response.result)) throw new BitrixRequestError("INVALID_RESPONSE");
        for (const entry of response.result) {
          const comment = object(entry);
          const commentId = id(comment.ID);
          if (!commentId) continue;
          scannedMessages += 1;
          for (const item of values(comment.ATTACHED_OBJECTS).slice(0, 20)) {
            const file = object(item);
            const fileId = id(file.FILE_ID);
            if (!fileId) continue;
            const disk = await this.#diskMetadata(fileId);
            const name = str(file.NAME) ?? str(disk.NAME);
            found.push(makeFile({ key: `legacy:${commentId}:${fileId}`, source: "legacy_comment", taskId: String(taskId), fileId, attachmentId: attachmentId(file.ATTACHMENT_ID), name, size: number(file.SIZE) ?? number(disk.SIZE), uploadedAt: timestamp(disk.CREATE_TIME), uploadedBy: id(disk.CREATED_BY), attachedAt: timestamp(comment.POST_DATE), attachedBy: id(comment.AUTHOR_ID), context: str(comment.POST_MESSAGE, 1000), contextId: commentId }));
          }
        }
        if (response.next === null) break;
        if (page === 3) messagesTruncated = true;
        start = response.next;
      }
    }

    let start = 0;
    let checklistTruncated = false;
    for (let page = 0; page < 4; page += 1) {
      const response = await this.#client.callPage("task.checklistitem.getlist", { TASKID: taskId, ORDER: { ID: "ASC" }, start });
      if (!Array.isArray(response.result)) throw new BitrixRequestError("INVALID_RESPONSE");
      for (const entry of response.result) {
        const item = object(entry);
        const itemId = id(item.ID);
        if (!itemId || id(item.TASK_ID) !== String(taskId)) continue;
        scannedChecklist += 1;
        for (const rawFile of values(item.ATTACHMENTS).slice(0, 20)) {
          const file = object(rawFile);
          const fileId = id(file.FILE_ID);
          if (!fileId) continue;
          const disk = await this.#diskMetadata(fileId);
          const name = str(file.NAME) ?? str(disk.NAME);
          found.push(makeFile({ key: `checklist:${itemId}:${fileId}`, source: "checklist", taskId: String(taskId), fileId, attachmentId: attachmentId(file.ATTACHMENT_ID), name, size: number(file.SIZE) ?? number(disk.SIZE), uploadedAt: timestamp(disk.CREATE_TIME), uploadedBy: id(disk.CREATED_BY), attachedAt: null, attachedBy: null, context: str(item.TITLE, 1000), contextId: itemId }));
        }
      }
      if (response.next === null) break;
      if (page === 3) checklistTruncated = true;
      start = response.next;
    }
    return { files: found, returned: found.length, partial: skippedUnavailable > 0 || directTruncated || messagesTruncated || checklistTruncated || missingScopes.size > 0, skippedUnavailable, missingScopes: [...missingScopes], scannedMessages, scannedChecklist, directTruncated, messagesTruncated, checklistTruncated, untrustedContent: true };
  }

  async download(taskId: number, key: string) {
    if (!this.#attachmentsRoot) throw new BitrixRequestError("ATTACHMENTS_NOT_CONFIGURED");
    const inventory = await this.list(taskId);
    const item = inventory.files.find((file) => file.key === key);
    if (!item?.fileId || !item.name) throw new BitrixRequestError("FILE_NOT_FOUND_OR_DENIED");
    if (item.size !== null && item.size > 50 * 1024 * 1024) throw new BitrixRequestError("FILE_TOO_LARGE");
    let signed: unknown;
    if (item.source === "chat") {
      const task = object(object(await this.#client.call("tasks.task.get", { taskId, select: ["ID", "CHAT_ID"] })).task);
      const chatId = id(task.CHAT_ID ?? task.chatId);
      if (id(task.ID ?? task.id) !== String(taskId) || !chatId) throw new BitrixRequestError("FILE_NOT_FOUND_OR_DENIED");
      signed = object(await this.#client.call("im.v2.File.download", { dialogId: `chat${chatId}`, fileId: Number(item.fileId) })).downloadUrl;
    } else {
      const diskFile = object(await this.#client.call("disk.file.get", { id: Number(item.fileId) }));
      if (id(diskFile.ID) !== item.fileId) throw new BitrixRequestError("FILE_NOT_FOUND_OR_DENIED");
      signed = diskFile.DOWNLOAD_URL;
    }
    if (typeof signed !== "string") throw new BitrixRequestError("INVALID_DOWNLOAD_URL");
    const root = await realpath(this.#attachmentsRoot).catch(() => { throw new BitrixRequestError("ATTACHMENTS_NOT_CONFIGURED"); });
    const directory = join(root, "bitrix24-read");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new BitrixRequestError("INVALID_STAGING_DIRECTORY");
    const artifactId = randomUUID();
    const sanitized = basename(item.name).normalize("NFC").replaceAll(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/u, "") || "document";
    const suffix = extname(sanitized).slice(0, 13);
    const safeName = sanitized.length <= 150 ? sanitized : `${sanitized.slice(0, 150 - suffix.length)}${suffix}`;
    const path = join(directory, `${artifactId}-${safeName}`);
    const file = await open(path, "wx", 0o600);
    let bytes: number;
    try {
      bytes = await this.#client.downloadSignedFile(signed, file, 50 * 1024 * 1024);
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(path, { force: true });
      throw error;
    }
    await file.close();
    return { artifactId, path: `bitrix24-read/${artifactId}-${safeName}`, fileName: safeName, bytes, source: item.source, taskId: String(taskId), key };
  }

  async release(artifactId: string) {
    const path = await this.#artifactPath(artifactId);
    await rm(path);
    return { released: true, artifactId };
  }

  async viewPage(artifactId: string, page: number): Promise<{ data: string; mimeType: "image/jpeg" | "image/png"; page: number }> {
    if (!Number.isInteger(page) || page < 1 || page > 200) throw new BitrixRequestError("INVALID_PAGE");
    const source = await this.#artifactPath(artifactId);
    const extension = extname(source).toLowerCase();
    if (extension === ".jpg" || extension === ".jpeg" || extension === ".png") {
      if (page !== 1) throw new BitrixRequestError("INVALID_PAGE");
      const bytes = await readFile(source);
      if (bytes.length > 10 * 1024 * 1024) throw new BitrixRequestError("IMAGE_TOO_LARGE_FOR_VIEW");
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if ((extension === ".png" && !png) || (extension !== ".png" && !jpeg)) throw new BitrixRequestError("INVALID_IMAGE_FILE");
      return { data: bytes.toString("base64"), mimeType: png ? "image/png" : "image/jpeg", page };
    }
    if (![".pdf", ".ppt", ".pptx", ".docx", ".xlsx"].includes(extension)) throw new BitrixRequestError("UNSUPPORTED_VISUAL_FORMAT");
    const temporary = await mkdtemp(join(tmpdir(), "bitrix-view-"));
    try {
      let pdf = source;
      if (extension !== ".pdf") {
        try {
          await run("libreoffice", [`-env:UserInstallation=file://${temporary}/profile`, "--headless", "--convert-to", "pdf", "--outdir", temporary, source], { timeout: 120_000, maxBuffer: 128_000 });
        } catch { throw new BitrixRequestError("DOCUMENT_RENDERER_UNAVAILABLE"); }
        pdf = join(temporary, `${basename(source, extension)}.pdf`);
        if (!(await lstat(pdf).catch(() => null))?.isFile()) throw new BitrixRequestError("DOCUMENT_RENDER_FAILED");
      }
      const prefix = join(temporary, "page");
      try {
        await run("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "1400", "-jpeg", "-jpegopt", "quality=72", pdf, prefix], { timeout: 120_000, maxBuffer: 128_000 });
      } catch { throw new BitrixRequestError("DOCUMENT_RENDER_FAILED"); }
      const bytes = await readFile(`${prefix}.jpg`).catch(() => { throw new BitrixRequestError("INVALID_PAGE"); });
      if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) throw new BitrixRequestError("IMAGE_TOO_LARGE_FOR_VIEW");
      return { data: bytes.toString("base64"), mimeType: "image/jpeg", page };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async #artifactPath(artifactId: string): Promise<string> {
    if (!this.#attachmentsRoot) throw new BitrixRequestError("ATTACHMENTS_NOT_CONFIGURED");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(artifactId)) throw new BitrixRequestError("INVALID_ARTIFACT_ID");
    const directory = join(await realpath(this.#attachmentsRoot), "bitrix24-read");
    if (await realpath(directory) !== directory) throw new BitrixRequestError("INVALID_STAGING_DIRECTORY");
    const matches = (await readdir(directory)).filter((name) => name.startsWith(`${artifactId}-`));
    if (matches.length !== 1) throw new BitrixRequestError("ARTIFACT_NOT_FOUND");
    const path = join(directory, matches[0]!);
    if (!(await lstat(path)).isFile()) throw new BitrixRequestError("ARTIFACT_NOT_FOUND");
    return path;
  }
}
