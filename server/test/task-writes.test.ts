import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitrixClient } from "../src/bitrix-client.ts";
import { loadConfig } from "../src/config.ts";
import {
  TaskWriter,
  taskWriteSchema,
  type TaskWrite,
} from "../src/task-writes.ts";

const create: TaskWrite = {
  action: "create",
  title: "Подготовить отчёт",
  description: "Собрать результаты",
  responsibleId: 7,
  deadline: "2026-10-10T18:00:00+03:00",
};
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "bitrix-writes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const task = {
    id: "20",
    title: "Отчёт",
    responsibleId: "7",
    deadline: "2026-10-10T18:00:00+03:00",
    status: "3",
    changedDate: "2026-10-01T12:00:00+03:00",
    chatId: "44",
    action: {
      edit: true,
      complete: true,
      approve: true,
      disapprove: true,
      renew: true,
      changeDeadline: true,
    },
  };
  const departments = new Map<number, Record<string, unknown>>([
    [4, { ID: "4", PARENT: "1", UF_HEAD: "99" }],
    [1, { ID: "1", PARENT: "0", UF_HEAD: "123" }],
  ]);
  let intercept:
    | ((
        method: string,
        params: Record<string, unknown>,
      ) => Response | undefined)
    | undefined;
  const client = new BitrixClient(
    loadConfig({
      BITRIX24_WEBHOOK_BASE_URL: "https://portal.example.invalid/rest/123/test",
    }),
    {
      fetch: async (url, init) => {
        const method = new URL(String(url)).pathname
          .split("/")
          .at(-1)!
          .replace(/\.json$/u, "");
        const params = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        calls.push({ method, params });
        const response = intercept?.(method, params);
        if (response) return response;
        const result =
          method === "profile"
            ? { ID: "123" }
            : method === "user.get"
              ? [
                  {
                    ID: String(params.ID),
                    NAME: "Иван",
                    LAST_NAME: "Тестов",
                    ACTIVE: true,
                    UF_DEPARTMENT: [4],
                  },
                ]
              : method === "department.get"
                ? [departments.get(Number(params.ID))]
                : method === "tasks.task.get"
                  ? { task }
                  : method === "tasks.task.add"
                    ? { task: { id: "21" } }
                    : method === "tasks.task.getFields"
                      ? { fields: { UF_TEST: { isReadOnly: false } } }
                      : method === "sonet_group.get"
                        ? [{ ID: "9", NAME: "Проект" }]
                        : method === "task.checklistitem.getlist"
                          ? []
                          : method === "im.v2.File.upload"
                            ? { file: { id: "55" }, messageId: "66" }
                            : true;
        return Response.json({ result });
      },
      sleep: async () => {},
    },
  );
  let now = Date.parse("2026-10-03T12:00:00+03:00");
  const writer = new TaskWriter(client, root, root, () => now);
  return {
    root,
    client,
    writer,
    task,
    calls,
    departments,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const writes = <T extends { method: string }>(calls: T[]) =>
  calls.filter((c) =>
    [
      "tasks.task.add",
      "tasks.task.update",
      "tasks.task.complete",
      "tasks.task.approve",
      "tasks.task.disapprove",
      "tasks.task.renew",
      "task.checklistitem.add",
      "task.checklistitem.update",
      "task.commentitem.add",
      "im.message.add",
      "im.v2.File.upload",
    ].includes(c.method),
  );

test("creation requires all four base fields and rejects arbitrary REST payloads", () => {
  for (const key of ["title", "description", "responsibleId", "deadline"]) {
    const raw = { ...create } as Record<string, unknown>;
    delete raw[key];
    assert.equal(taskWriteSchema.safeParse(raw).success, false);
  }
  assert.equal(
    taskWriteSchema.safeParse({ ...create, fields: { STATUS: 5 } }).success,
    false,
  );
  assert.equal(
    taskWriteSchema.safeParse({ ...create, deadline: "2026-10-10T18:00:00" })
      .success,
    false,
  );
});

test("preview creates no portal writes; application freezes fields and replay uses the receipt", async (t) => {
  const f = await fixture(t);
  const preview = await f.writer.prepare({
    ...create,
    auditors: [8],
    accomplices: [9],
    projectId: 9,
    checklist: ["Собрать", "Проверить"],
    taskControl: true,
    customFields: { UF_TEST: "текст" },
  });
  assert.equal(writes(f.calls).length, 0);
  assert.match(
    preview.approvalPrompt.prompt,
    /Ответственный:\*\* Иван Тестов/u,
  );
  assert.match(preview.approvalPrompt.prompt, /Наблюдатели/u);
  assert.deepEqual(
    preview.approvalPrompt.options.map((o) => o.id),
    ["confirm", "cancel"],
  );
  const result = await f.writer.apply(preview.draftId);
  assert.equal(result.state, "applied");
  assert.equal(result.taskId, 21);
  assert.equal(writes(f.calls).length, 3);
  assert.deepEqual(writes(f.calls)[0]?.params.fields, {
    TITLE: create.title,
    DESCRIPTION: create.description,
    RESPONSIBLE_ID: 7,
    DEADLINE: create.deadline,
    CREATED_BY: 123,
    AUDITORS: [8],
    ACCOMPLICES: [9],
    GROUP_ID: 9,
    TASK_CONTROL: "Y",
    UF_TEST: "текст",
  });
  assert.deepEqual(await f.writer.apply(preview.draftId), result);
  assert.equal(writes(f.calls).length, 3);
});

test("cancellation, correction and expiration prevent using an old preview", async (t) => {
  const f = await fixture(t);
  const first = await f.writer.prepare(create);
  const next = await f.writer.prepare({ ...create, title: "Исправлено" });
  await assert.rejects(f.writer.apply(first.draftId), /DRAFT_SUPERSEDED/u);
  await f.writer.cancel(next.draftId);
  await assert.rejects(f.writer.apply(next.draftId));
  const last = await f.writer.prepare(create);
  f.advance(31 * 60_000);
  await assert.rejects(f.writer.apply(last.draftId), /DRAFT_EXPIRED/u);
  assert.equal(writes(f.calls).length, 0);
});

test("reassignment allows indirect subordinates but rejects peers and cycles", async (t) => {
  const f = await fixture(t);
  const preview = await f.writer.prepare({
    action: "reassign",
    taskId: 20,
    responsibleId: 8,
  });
  assert.equal((await f.writer.apply(preview.draftId)).state, "applied");
  assert.deepEqual(writes(f.calls)[0]?.params, {
    taskId: 20,
    fields: { RESPONSIBLE_ID: 8 },
  });
  f.departments.set(1, { ID: "1", PARENT: "0", UF_HEAD: "999" });
  await assert.rejects(
    f.writer.prepare({ action: "reassign", taskId: 20, responsibleId: 8 }),
    /ASSIGNEE_NOT_SUBORDINATE/u,
  );
  f.departments.set(1, { ID: "1", PARENT: "4", UF_HEAD: "999" });
  await assert.rejects(
    f.writer.prepare({ action: "reassign", taskId: 20, responsibleId: 8 }),
    /HIERARCHY_INVALID/u,
  );
});

test("rechecks hierarchy, rights, task state and chat route after preview", async (t) => {
  const f = await fixture(t);
  const preview = await f.writer.prepare({
    action: "reassign",
    taskId: 20,
    responsibleId: 8,
  });
  f.departments.set(1, { ID: "1", PARENT: "0", UF_HEAD: "999" });
  await assert.rejects(
    f.writer.apply(preview.draftId),
    /ASSIGNEE_NOT_SUBORDINATE/u,
  );
  const deadline = await f.writer.prepare({
    action: "deadline",
    taskId: 20,
    deadline: "2026-10-11T18:00:00+03:00",
  });
  f.task.deadline = "2026-10-12T18:00:00+03:00";
  await assert.rejects(
    f.writer.apply(deadline.draftId),
    /TASK_CHANGED_SINCE_PREVIEW/u,
  );
  const comment = await f.writer.prepare({
    action: "comment",
    taskId: 20,
    message: "Текст",
  });
  f.task.chatId = "45";
  await assert.rejects(
    f.writer.apply(comment.draftId),
    /TASK_CHANGED_SINCE_PREVIEW/u,
  );
  const close = await f.writer.prepare({ action: "complete", taskId: 20 });
  f.task.action.complete = false;
  await assert.rejects(f.writer.apply(close.draftId), /ACTION_NOT_ALLOWED/u);
  assert.equal(writes(f.calls).length, 0);
});

test("maps close and rework to the correct status operation", async (t) => {
  const f = await fixture(t);
  for (const [action, status, method] of [
    ["complete", "3", "tasks.task.complete"],
    ["complete", "4", "tasks.task.approve"],
    ["rework", "4", "tasks.task.disapprove"],
    ["rework", "5", "tasks.task.renew"],
  ] as const) {
    f.task.status = status;
    const preview = await f.writer.prepare({ action, taskId: 20 });
    assert.equal((await f.writer.apply(preview.draftId)).state, "applied");
    assert.equal(writes(f.calls).at(-1)?.method, method);
  }
  f.task.status = "3";
  await assert.rejects(
    f.writer.prepare({ action: "rework", taskId: 20 }),
    /TASK_NOT_READY_FOR_REWORK/u,
  );
});

test("comment routes to task chat, legacy only when no chat exists", async (t) => {
  const f = await fixture(t);
  let preview = await f.writer.prepare({
    action: "comment",
    taskId: 20,
    message: "Готово",
  });
  await f.writer.apply(preview.draftId);
  assert.deepEqual(writes(f.calls).at(-1), {
    method: "im.message.add",
    params: { DIALOG_ID: "chat44", MESSAGE: "Готово" },
  });
  f.task.chatId = "0";
  preview = await f.writer.prepare({
    action: "comment",
    taskId: 20,
    message: "Правки",
  });
  await f.writer.apply(preview.draftId);
  assert.equal(writes(f.calls).at(-1)?.method, "task.commentitem.add");
  assert.deepEqual(writes(f.calls).at(-1)?.params, {
    "0": 20,
    "1": { POST_MESSAGE: "Правки" },
  });
  await assert.rejects(
    f.writer.prepare({ action: "upload", taskId: 20, path: "report.txt" }),
    /TASK_CHAT_UNAVAILABLE/u,
  );
});

test("upload is bound to vault bytes and task chat; rejects traversal and escaped symlinks", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.txt"), "Отчёт");
  const input: TaskWrite = {
    action: "upload",
    taskId: 20,
    path: "report.txt",
    message: "Для проверки",
  };
  let preview = await f.writer.prepare(input);
  await writeFile(join(f.root, "report.txt"), "Изменён");
  await assert.rejects(f.writer.apply(preview.draftId), /UPLOAD_FILE_CHANGED/u);
  assert.equal(writes(f.calls).length, 0);
  preview = await f.writer.prepare(input);
  await f.writer.apply(preview.draftId);
  const uploaded = writes(f.calls).at(-1)!;
  assert.equal(uploaded.method, "im.v2.File.upload");
  assert.equal(uploaded.params.dialogId, "chat44");
  assert.deepEqual(uploaded.params.fields, {
    name: "report.txt",
    content: Buffer.from("Изменён").toString("base64"),
    message: "Для проверки",
  });
  await assert.rejects(
    f.writer.prepare({ ...input, path: "../secret" }),
    /INVALID_UPLOAD_PATH/u,
  );
  await assert.rejects(
    f.writer.prepare({ ...input, path: "/etc/hosts" }),
    /INVALID_UPLOAD_PATH/u,
  );
  await symlink("/etc/hosts", join(f.root, "escape"));
  await assert.rejects(
    f.writer.prepare({ ...input, path: "escape" }),
    /INVALID_UPLOAD_PATH/u,
  );
});

test("a lost mutation response never retries; partial creation retains task and checklist progress", async (t) => {
  const f = await fixture(t);
  f.intercept((method) => {
    if (method === "tasks.task.add") throw new TypeError("network lost");
    return undefined;
  });
  let preview = await f.writer.prepare(create);
  let result = await f.writer.apply(preview.draftId);
  assert.equal(result.state, "unknown");
  assert.equal(result.error, "WRITE_RESULT_UNKNOWN");
  await f.writer.apply(preview.draftId);
  assert.equal(writes(f.calls).length, 1);
  const restarted = new TaskWriter(f.client, f.root, f.root);
  assert.equal((await restarted.status(preview.draftId)).state, "unknown");
  f.intercept((method) =>
    method === "task.checklistitem.add"
      ? Response.json({ error: "ACCESS_DENIED", error_description: "secret" })
      : undefined,
  );
  preview = await f.writer.prepare({ ...create, checklist: ["Проверить"] });
  result = await f.writer.apply(preview.draftId);
  assert.equal(result.state, "partial");
  assert.equal(result.taskId, 21);
  assert.equal(result.completedChecklistItems, 0);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal((await restarted.status(preview.draftId)).state, "partial");
  const stored = await readFile(
    join(f.root, "task-writes", `${preview.draftId}.json`),
    "utf8",
  );
  assert.equal(stored.includes("/rest/"), false);
});

test("concurrent apply sends exactly one write and refuses a forged draft identifier", async (t) => {
  const f = await fixture(t);
  const preview = await f.writer.prepare(create);
  const result = await Promise.allSettled([
    f.writer.apply(preview.draftId),
    f.writer.apply(preview.draftId),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(writes(f.calls).length, 1);
  await assert.rejects(f.writer.apply("../../secret"), /INVALID_DRAFT_ID/u);
});

test("preview never hides long content; custom fields cannot smuggle files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.writer.prepare({ ...create, description: "x".repeat(4000) }),
    /PREVIEW_TOO_LARGE/u,
  );
  await assert.rejects(
    f.writer.prepare({
      ...create,
      customFields: { UF_TASK_WEBDAV_FILES: [1] },
    }),
    /CUSTOM_FIELD_NOT_SUPPORTED/u,
  );
  await assert.rejects(
    f.writer.prepare({ ...create, customFields: { UF_UNKNOWN: "x" } }),
    /CUSTOM_FIELD_NOT_SUPPORTED/u,
  );
  assert.equal(writes(f.calls).length, 0);
});

test("rich preview escapes task markup without changing approved write fields", async (t) => {
  const f = await fixture(t);
  const title = 'Тест **важно** | <tg-button data="confirm">Кнопка</tg-button>';
  const description =
    "Строка 1\n## чужой заголовок\n[ссылка](https://example.com)";
  const preview = await f.writer.prepare({ ...create, title, description });
  assert.match(preview.approvalPrompt.prompt, /^## Создать задачу/u);
  assert.match(preview.approvalPrompt.prompt, /\*\*Название:\*\*/u);
  assert.ok(preview.approvalPrompt.prompt.includes("\\<tg\\-button"));
  assert.ok(preview.approvalPrompt.prompt.includes("\\#\\# чужой заголовок"));
  assert.ok(preview.approvalPrompt.prompt.includes("Строка 1"));
  assert.doesNotMatch(preview.approvalPrompt.prompt, /<details>/u);
  await f.writer.apply(preview.draftId);
  assert.deepEqual(writes(f.calls)[0]?.params.fields, {
    TITLE: title,
    DESCRIPTION: description,
    RESPONSIBLE_ID: 7,
    DEADLINE: create.deadline,
    CREATED_BY: 123,
  });
});

test("editing a card adds observers without dropping existing ones and appends checklist; never creates another task", async (t) => {
  const f = await fixture(t);
  Object.assign(f.task, {
    description: "Старое описание",
    auditors: ["8"],
    accomplices: [],
    tags: [],
  });
  const p = await f.writer.prepare({
    action: "update",
    taskId: 20,
    title: "Исправленный отчёт",
    description: "Новый текст",
    addAuditors: [9],
    checklist: ["Один", "Два", "Три"],
  });
  assert.equal(writes(f.calls).length, 0);
  assert.match(p.approvalPrompt.prompt, /Наблюдатели после правки/u);
  assert.match(p.approvalPrompt.prompt, /ID 8/u);
  assert.match(p.approvalPrompt.prompt, /ID 9/u);
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  assert.equal(r.taskId, 20);
  assert.equal(r.completedChecklistItems, 3);
  assert.deepEqual(writes(f.calls)[0], {
    method: "tasks.task.update",
    params: {
      taskId: 20,
      fields: {
        TITLE: "Исправленный отчёт",
        DESCRIPTION: "Новый текст",
        AUDITORS: [8, 9],
      },
    },
  });
  assert.equal(
    writes(f.calls).filter((v) => v.method === "tasks.task.add").length,
    0,
  );
});

test("one preview approves card changes, a comment and a file, and replay never repeats them", async (t) => {
  const f = await fixture(t);
  Object.assign(f.task, { auditors: ["8"] });
  await writeFile(join(f.root, "test.txt"), "Файл");
  const p = await f.writer.prepare({
    action: "batch",
    actions: [
      {
        action: "update",
        taskId: 20,
        addAuditors: [9],
        checklist: ["Проверить"],
      },
      { action: "comment", taskId: 20, message: "тест" },
      { action: "upload", taskId: 20, path: "test.txt", message: "Документ" },
    ],
  });
  assert.equal(writes(f.calls).length, 0);
  for (const v of ["одно подтверждение", "ID 9", "Проверить", "тест", "test"])
    assert.ok(p.approvalPrompt.prompt.includes(v));
  assert.equal(p.approvalPrompt.options.length, 2);
  assert.equal(p.approvalPrompt.prompt.match(/Задача №20/gu)?.length, 1);
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  assert.equal(r.completedOperations, 3);
  const ops = r.operations as Record<string, unknown>[];
  assert.deepEqual(
    ops.map((v) => v.taskId),
    [20, 20, 20],
  );
  assert.equal(ops[2]?.fileId, 55);
  assert.equal(ops[2]?.messageId, 66);
  assert.deepEqual(
    writes(f.calls).map((v) => v.method),
    [
      "tasks.task.update",
      "task.checklistitem.add",
      "im.message.add",
      "im.v2.File.upload",
    ],
  );
  assert.deepEqual(await f.writer.apply(p.draftId), r);
  assert.equal(writes(f.calls).length, 4);
});

test("batch validates every file and snapshot before any write; cancel cancels the whole request", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "test.txt"), "Файл");
  const input = {
    action: "batch",
    actions: [
      { action: "comment", taskId: 20, message: "тест" },
      { action: "upload", taskId: 20, path: "test.txt" },
    ],
  } as const;
  const p = await f.writer.prepare({ ...input, actions: [...input.actions] });
  await writeFile(join(f.root, "test.txt"), "Изменён");
  await assert.rejects(f.writer.apply(p.draftId), /UPLOAD_FILE_CHANGED/u);
  assert.equal(writes(f.calls).length, 0);
  await f.writer.cancel(p.draftId);
  await assert.rejects(f.writer.apply(p.draftId));
  assert.equal(writes(f.calls).length, 0);
});

test("failed or lost batch operation stops the remainder and retains exact progress across restart", async (t) => {
  for (const lost of [false, true]) {
    const f = await fixture(t);
    f.intercept((method) => {
      if (method === "im.message.add") {
        if (lost) throw new TypeError("lost");
        return Response.json({ error: "ACCESS_DENIED" });
      }
      return undefined;
    });
    const p = await f.writer.prepare({
      action: "batch",
      actions: [
        { action: "update", taskId: 20, description: "Правка" },
        { action: "comment", taskId: 20, message: "тест" },
        { action: "complete", taskId: 20 },
      ],
    });
    const r = await f.writer.apply(p.draftId);
    assert.equal(r.state, "partial");
    assert.equal(r.completedOperations, 1);
    assert.equal(r.doNotRetry, true);
    const ops = r.operations as Record<string, unknown>[];
    assert.equal(ops[0]?.state, "applied");
    assert.equal(ops[1]?.state, lost ? "unknown" : "failed");
    assert.equal(writes(f.calls).length, 2);
    const restarted = new TaskWriter(f.client, f.root, f.root);
    assert.deepEqual(await restarted.apply(p.draftId), r);
    assert.equal(writes(f.calls).length, 2);
  }
});

test("edit clears requested fields, preserves others, checks rights, and refuses stale observer lists", async (t) => {
  const f = await fixture(t);
  Object.assign(f.task, { auditors: ["8"] });
  const p = await f.writer.prepare({
    action: "update",
    taskId: 20,
    removeAuditors: [8],
    deadline: null,
    projectId: null,
    description: "",
    tags: [],
  });
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  assert.deepEqual(writes(f.calls)[0]?.params.fields, {
    DESCRIPTION: "",
    DEADLINE: "",
    AUDITORS: [],
    GROUP_ID: 0,
    TAGS: [],
  });
  const next = await f.writer.prepare({
    action: "update",
    taskId: 20,
    addAuditors: [9],
  });
  Object.assign(f.task, { auditors: ["8", "10"] });
  await assert.rejects(
    f.writer.apply(next.draftId),
    /TASK_CHANGED_SINCE_PREVIEW/u,
  );
  f.task.action.edit = false;
  await assert.rejects(
    f.writer.prepare({ action: "update", taskId: 20, description: "Правка" }),
    /ACTION_NOT_ALLOWED/u,
  );
  assert.equal(writes(f.calls).length, 1);
});

test("existing checklist entries can be renamed and completed without replacing the checklist", async (t) => {
  const f = await fixture(t);
  f.intercept((method) =>
    method === "task.checklistitem.getlist"
      ? Response.json({
          result: [
            {
              ID: "101",
              TITLE: "Проверить",
              IS_COMPLETE: "N",
              SORT_INDEX: "10",
            },
          ],
        })
      : undefined,
  );
  const p = await f.writer.prepare({
    action: "update",
    taskId: 20,
    checklistUpdates: [{ id: 101, title: "Проверено", completed: true }],
  });
  assert.equal((await f.writer.apply(p.draftId)).state, "applied");
  assert.deepEqual(writes(f.calls), [
    {
      method: "task.checklistitem.update",
      params: {
        TASKID: 20,
        ITEMID: 101,
        FIELDS: { TITLE: "Проверено", IS_COMPLETE: "Y" },
      },
    },
  ]);
  await assert.rejects(
    f.writer.prepare({
      action: "update",
      taskId: 20,
      checklistUpdates: [{ id: 102, completed: true }],
    }),
    /CHECKLIST_ITEM_NOT_FOUND/u,
  );
});

test("unknown upload response is never advertised as sent or retried", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "test.txt"), "test");
  f.intercept((method) =>
    method === "im.v2.File.upload"
      ? Response.json({ result: true })
      : undefined,
  );
  const p = await f.writer.prepare({
    action: "upload",
    taskId: 20,
    path: "test.txt",
  });
  const r = await f.writer.apply(p.draftId);
  assert.notEqual(r.state, "applied");
  assert.equal(r.error, "WRITE_RESULT_UNKNOWN");
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 1);
});

test("rejects empty edits, mixed observer modes and nested or duplicate update batches", async (t) => {
  for (const raw of [
    { action: "update", taskId: 20 },
    { action: "update", taskId: 20, auditors: [8], addAuditors: [9] },
    { action: "update", taskId: 20, addAuditors: [8], removeAuditors: [8] },
    { action: "batch", actions: [] },
    { action: "batch", actions: [{ action: "batch", actions: [] }] },
  ])
    assert.equal(taskWriteSchema.safeParse(raw).success, false);
  const f = await fixture(t);
  await assert.rejects(
    f.writer.prepare({
      action: "batch",
      actions: [
        { action: "update", taskId: 20, title: "a" },
        { action: "update", taskId: 20, addAuditors: [8] },
      ],
    }),
    /DUPLICATE_TASK_UPDATE/u,
  );
});

test("creation with checklist, comment and file uses one preview and only the returned new task ID", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.txt"), "Report");
  f.intercept((method, params) =>
    method === "tasks.task.get" && params.taskId === 21
      ? Response.json({
          result: { task: { ...f.task, id: "21", chatId: "99" } },
        })
      : undefined,
  );
  const p = await f.writer.prepare({
    ...create,
    checklist: ["Проверить"],
    comment: "тест",
    uploads: [{ path: "report.txt", message: "Файл к задаче" }],
  });
  assert.equal(writes(f.calls).length, 0);
  assert.match(
    p.approvalPrompt.prompt,
    /Комментарий в обсуждение новой задачи/u,
  );
  assert.equal(p.approvalPrompt.prompt.includes("undefined:"), false);
  assert.equal(p.approvalPrompt.prompt.includes('"path"'), false);
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  assert.equal(r.taskId, 21);
  assert.deepEqual(
    writes(f.calls).map((v) => v.method),
    [
      "tasks.task.add",
      "task.checklistitem.add",
      "im.message.add",
      "im.v2.File.upload",
    ],
  );
  assert.equal(writes(f.calls).at(-1)?.params.dialogId, "chat99");
  assert.equal(
    (r.operations as Record<string, unknown>[])[0]?.commentSent,
    true,
  );
  assert.deepEqual((r.operations as Record<string, unknown>[])[0]?.files, [
    { fileId: 55, messageId: 66, name: "report.txt" },
  ]);
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 4);
});

test("creation checks every attached file before creating and preserves the new task if its chat fails", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.txt"), "Report");
  const input = { ...create, uploads: [{ path: "report.txt" }] };
  const p = await f.writer.prepare(input);
  await writeFile(join(f.root, "report.txt"), "Changed");
  await assert.rejects(f.writer.apply(p.draftId), /UPLOAD_FILE_CHANGED/u);
  assert.equal(writes(f.calls).length, 0);
  f.intercept((method, params) =>
    method === "tasks.task.get" && params.taskId === 21
      ? Response.json({
          result: { task: { ...f.task, id: "21", chatId: "0" } },
        })
      : undefined,
  );
  const next = await f.writer.prepare(input);
  const r = await f.writer.apply(next.draftId);
  assert.equal(r.state, "partial");
  assert.equal(r.taskId, 21);
  assert.equal(r.error, "TASK_CHAT_UNAVAILABLE");
  await f.writer.apply(next.draftId);
  assert.equal(writes(f.calls).length, 1);
});


test("batch refuses a task changed after preflight but before its first write", async t => {
  const f = await fixture(t);
  f.intercept((method, params) => method === "tasks.task.get" && params.taskId === 22
    ? Response.json({result: {task: {...f.task, id: "22"}}}) : undefined);
  const preview = await f.writer.prepare({action: "batch", actions: [
    {action: "comment", taskId: 20, message: "first"},
    {action: "deadline", taskId: 22, deadline: "2026-10-12T18:00:00+03:00"},
  ]});
  f.intercept((method, params) => {
    if (method === "tasks.task.get" && params.taskId === 22)
      return Response.json({result: {task: {...f.task, id: "22", changedDate: writes(f.calls).length > 0 ? "2026-10-04T12:00:00+03:00" : f.task.changedDate}}});
    return undefined;
  });
  const receipt = await f.writer.apply(preview.draftId);
  assert.equal(receipt.state, "partial");
  assert.equal(receipt.error, "TASK_CHANGED_SINCE_PREVIEW");
  assert.equal(receipt.completedOperations, 1);
  assert.deepEqual(writes(f.calls).map(v => v.method), ["im.message.add"]);
  await f.writer.apply(preview.draftId);
  assert.equal(writes(f.calls).length, 1);
});
