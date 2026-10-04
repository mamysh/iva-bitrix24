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

import { SettingsStore, LEGACY_POLICY, RESTRICTED_POLICY, withPolicyLock } from "../src/settings.ts";
import { SettingsMenu } from "../src/settings-menu.ts";

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
      ) => Response | undefined | Promise<Response | undefined>)
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
        const response = await intercept?.(method, params);
        if (response) return response;
        const result =
          method === "scope"
            ? ["task", "user_brief"]
            : method === "profile"
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
                          : method === "task.checklistitem.add"
                            ? 88
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
      "task.stages.movetask",
      "im.disk.file.delete",
      "im.message.delete",
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
    /Ответственный: Иван Тестов/u,
  );
  assert.match(preview.approvalPrompt.prompt, /Наблюдатели/u);
  assert.deepEqual(
    preview.approvalPrompt.options.map((o) => o.id),
    ["confirm", "cancel"],
  );
  const result = await f.writer.apply(preview.draftId);
  assert.equal(result.state, "applied");
  assert.equal(result.taskId, 21);
  assert.equal(writes(f.calls).length, 4);
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
  assert.equal(writes(f.calls).length, 4);
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

test("reassignment uses portal permissions without department restrictions", async (t) => {
  const f = await fixture(t);
  f.departments.clear();
  f.task.responsibleId = "123";
  f.task.action.edit = false;
  const preview = await f.writer.prepare({ action: "reassign", taskId: 20, responsibleId: 8 });
  assert.equal((await f.writer.apply(preview.draftId)).state, "applied");
  assert.deepEqual(writes(f.calls)[0]?.params, { taskId: 20, fields: { RESPONSIBLE_ID: 8 } });
  assert.equal(f.calls.some(c => c.method === "department.get"), false);
});

test("rechecks rights, task state and chat route after preview", async (t) => {
  const f = await fixture(t);
  const preview = await f.writer.prepare({
    action: "reassign",
    taskId: 20,
    responsibleId: 8,
  });
  f.task.changedDate = "2026-10-02T12:00:00+03:00";
  await assert.rejects(f.writer.apply(preview.draftId), /TASK_CHANGED_SINCE_PREVIEW/u);
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

test("native plain preview preserves literal task values without Markdown escapes", async (t) => {
  const f = await fixture(t);
  const title = 'Тест **важно** | <tg-button data="confirm">Кнопка</tg-button>';
  const description =
    "Строка 1\n## чужой заголовок\n[ссылка](https://example.com)";
  const preview = await f.writer.prepare({ ...create, title, description });
  assert.match(preview.approvalPrompt.prompt, /^Создать задачу/u);
  assert.match(preview.approvalPrompt.prompt, /Название: /u);
  assert.ok(preview.approvalPrompt.prompt.includes(title));
  assert.ok(preview.approvalPrompt.prompt.includes(description));
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
      "task.checklistitem.add",
      "im.message.add",
      "im.v2.File.upload",
    ],
  );
  assert.deepEqual(await f.writer.apply(p.draftId), r);
  assert.equal(writes(f.calls).length, 5);
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
  assert.equal(writes(f.calls).length, 5);
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

test("one approval completes all checklist edits with official null responses then continues the batch", async (t) => {
  const f = await fixture(t);
  f.intercept(method => method === "task.checklistitem.getlist"
    ? Response.json({ result: [101, 102, 103].map(ID => ({ ID, TITLE: `Пункт ${ID}`, IS_COMPLETE: "N" })) })
    : method === "task.checklistitem.update" ? Response.json({ result: null }) : undefined);
  const p = await f.writer.prepare({ action: "batch", actions: [
    { action: "update", taskId: 20, checklistUpdates: [101, 102, 103].map(id => ({ id, completed: true })) },
    { action: "comment", taskId: 20, message: "Готово" },
    { action: "reassign", taskId: 20, responsibleId: 8 },
  ] });
  assert.match(p.approvalPrompt.prompt, /^Все изменения — одно подтверждение/u);
  assert.doesNotMatch(p.approvalPrompt.prompt, /completed|\*\*|###/u);
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  assert.equal(r.completedOperations, 3);
  assert.equal(r.completedWrites, 5);
  assert.deepEqual(writes(f.calls).map(c => c.method), ["task.checklistitem.update", "task.checklistitem.update", "task.checklistitem.update", "im.message.add", "tasks.task.update"]);
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 5);
});

test("project Kanban stage resolves its name, checks portal rights and freezes project membership", async (t) => {
  const f = await fixture(t);
  Object.assign(f.task, { groupId: "9", stageId: "31" });
  let allowed = true;
  f.intercept(method => method === "task.stages.get" ? Response.json({ result: {
    32: { ID: "32", TITLE: "Проверка", ENTITY_ID: "9", ENTITY_TYPE: "G", SORT: "200" },
  } }) : method === "task.stages.canmovetask" ? Response.json({ result: allowed }) : undefined);
  const p = await f.writer.prepare({ action: "stage", taskId: 20, stageId: 32 });
  assert.match(p.approvalPrompt.prompt, /Новая стадия: Проверка/u);
  assert.equal((await f.writer.apply(p.draftId)).state, "applied");
  assert.deepEqual(writes(f.calls)[0], { method: "task.stages.movetask", params: { id: 20, stageId: 32 } });
  await assert.rejects(f.writer.prepare({ action: "stage", taskId: 20, stageId: 99 }), /STAGE_NOT_IN_TASK_PROJECT/u);
  const next = await f.writer.prepare({ action: "stage", taskId: 20, stageId: 32 });
  allowed = false;
  await assert.rejects(f.writer.apply(next.draftId), /ACTION_NOT_ALLOWED/u);
  allowed = true;
  const changed = await f.writer.prepare({ action: "stage", taskId: 20, stageId: 32 });
  Object.assign(f.task, { stageId: "30" });
  await assert.rejects(f.writer.apply(changed.draftId), /TASK_CHANGED_SINCE_PREVIEW/u);
  assert.equal(writes(f.calls).length, 1);
});

test("file deletion is bound to the task chat and sender and verifies a true result", async (t) => {
  const f = await fixture(t);
  let deleted = false, noop = false, author = 123;
  f.intercept(method => method === "im.dialog.messages.get" ? Response.json({ result: {
    messages: deleted ? [] : [{ id: 66, author_id: author, text: "Файл", params: { FILE_ID: [55] } }],
    files: [{ id: 55, name: "report.txt" }],
  } }) : method === "im.disk.file.delete" ? (deleted = !noop, Response.json({ result: true })) : undefined);
  await assert.rejects(f.writer.prepare({ action: "delete_file", taskId: 20, messageId: 66, fileId: 99 }), /FILE_NOT_IN_TASK_CHAT/u);
  author = 8;
  await assert.rejects(f.writer.prepare({ action: "delete_file", taskId: 20, messageId: 66, fileId: 55 }), /FILE_DELETE_NOT_ALLOWED/u);
  author = 123;
  const p = await f.writer.prepare({ action: "delete_file", taskId: 20, messageId: 66, fileId: 55 });
  assert.match(p.approvalPrompt.prompt, /report.txt/u);
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  assert.deepEqual(writes(f.calls)[0], { method: "im.disk.file.delete", params: { CHAT_ID: 44, FILE_ID: 55 } });
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 1);
  deleted = false; noop = true;
  const next = await f.writer.prepare({ action: "delete_file", taskId: 20, messageId: 66, fileId: 55 });
  const unknown = await f.writer.apply(next.draftId);
  assert.equal(unknown.error, "WRITE_RESULT_UNKNOWN");
  assert.notEqual(unknown.state, "applied");
});

test("message deletion cannot address a message outside the current task chat", async (t) => {
  const f = await fixture(t);
  let messageText = "Тест";
  f.intercept(method => method === "im.dialog.messages.get" ? Response.json({ result: {
    messages: [{ id: 66, author_id: 123, text: messageText }], files: [],
  } }) : undefined);
  await assert.rejects(f.writer.prepare({ action: "delete_message", taskId: 20, messageId: 99 }), /MESSAGE_NOT_IN_TASK_CHAT/u);
  const stale = await f.writer.prepare({ action: "delete_message", taskId: 20, messageId: 66 });
  messageText = "Правка";
  await assert.rejects(f.writer.apply(stale.draftId), /TASK_CHANGED_SINCE_PREVIEW/u);
  const p = await f.writer.prepare({ action: "delete_message", taskId: 20, messageId: 66 });
  assert.equal((await f.writer.apply(p.draftId)).state, "applied");
  assert.deepEqual(writes(f.calls)[0], { method: "im.message.delete", params: { MESSAGE_ID: 66 } });
});

test("confirmed reassignment attempts the portal once and reports its actual refusal", async (t) => {
  const f = await fixture(t);
  f.task.action.edit = false;
  f.intercept(method => method === "tasks.task.update" ? Response.json({ error: "ACCESS_DENIED", error_description: "private text" }) : undefined);
  const p = await f.writer.prepare({ action: "reassign", taskId: 20, responsibleId: 8 });
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "failed");
  assert.equal(r.error, "ACCESS_DENIED");
  assert.doesNotMatch(JSON.stringify(r), /private text/u);
  assert.equal(writes(f.calls).length, 1);
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 1);
});

test("an incomplete chat scan cannot prove file removal", async (t) => {
  const f = await fixture(t);
  let deleted = false;
  f.intercept((method, params) => {
    if (method === "im.disk.file.delete") { deleted = true; return Response.json({ result: true }); }
    if (method !== "im.dialog.messages.get") return undefined;
    if (!deleted) return Response.json({ result: {
      messages: [{ id: 66, author_id: 123, text: "Файл", params: { FILE_ID: [55] } }],
      files: [{ id: 55, name: "report.txt" }],
    } });
    const before = Number(params.LAST_ID ?? 1000);
    return Response.json({ result: { messages: Array.from({ length: 50 }, (_, i) => ({ id: before - i - 1, author_id: 123, text: "Другое сообщение" })), files: [] } });
  });
  const p = await f.writer.prepare({ action: "delete_file", taskId: 20, fileId: 55, messageId: 66 });
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.error, "WRITE_RESULT_UNKNOWN");
  assert.notEqual(r.state, "applied");
  assert.equal(writes(f.calls).length, 1);
});


test("compact approval uses account email and readable dates without changing the frozen payload", async t => {
  const f = await fixture(t);
  f.intercept((method, params) => method === "scope" ? Response.json({result: ["task", "user_basic"]}) : method === "user.get" ? Response.json({result: [{ID: params.ID, NAME: "Иван", LAST_NAME: "Тестов", ACTIVE: true, EMAIL: "ivan@example.invalid"}]}) : undefined);
  const preview = await f.writer.prepare({action: "batch", actions: [{action: "update", taskId: 20, deadline: "2026-10-06T14:35:00+03:00", addAuditors: [8]}, {action: "comment", taskId: 20, message: "Готово"}]});
  const prompt = preview.approvalPrompt.prompt;
  assert.match(prompt, /Иван Тестов \(ivan@example.invalid\)/u);
  assert.doesNotMatch(prompt, /ID 7|ID 8|T14:35|\n\nОтветственный/u);
  assert.match(prompt, /Новый срок: 06\.10\.2026, 14:35 \(UTC\+03:00\)/u);
  assert.equal(prompt.match(/Задача №20/gu)?.length, 1);
  await f.writer.apply(preview.draftId);
  assert.equal((writes(f.calls)[0]!.params.fields as Record<string, unknown>).DEADLINE, "2026-10-06T14:35:00+03:00");
});

test("checklist approval shows original item titles, including renames, and resolves identical names", async t => {
  const f = await fixture(t);
  f.intercept(method => method === "task.checklistitem.getlist" ? Response.json({result: [{ID: 10, TITLE: "Проверка", PARENT_ID: 0}, {ID: 101, TITLE: "Проверить макет", PARENT_ID: 10}, {ID: 102, TITLE: "Отправить", PARENT_ID: 10}, {ID: 103, TITLE: "Отправить", PARENT_ID: 10}]}) : undefined);
  const p = await f.writer.prepare({action: "update", taskId: 20, checklistUpdates: [{id: 101, completed: true, title: "Макет проверен"}, {id: 102, completed: false}]});
  assert.match(p.approvalPrompt.prompt, /☑ Проверить макет: переименовать в «Макет проверен», выполнен/u);
  assert.doesNotMatch(p.approvalPrompt.prompt, /№101/u);
  assert.match(p.approvalPrompt.prompt, /☐ Отправить \(пункт №102\): не выполнен/u);
});

test("named checklist creates an explicit root and binds every child to its returned ID; replay never creates another root", async t => {
  const f = await fixture(t);
  const p = await f.writer.prepare({...create, checklistTitle: "Проверка отчёта", checklist: ["Собрать", "Отправить"]});
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "applied");
  const calls = writes(f.calls).filter(c => c.method === "task.checklistitem.add");
  assert.deepEqual(calls[0]!.params, {TASKID: 21, FIELDS: {TITLE: "Проверка отчёта", PARENT_ID: 0, SORT_INDEX: 0}});
  for (const child of calls.slice(1)) assert.equal((child.params.FIELDS as Record<string, unknown>).PARENT_ID, 88);
  assert.equal(r.completedChecklistItems, 2);
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 4);
});

test("append keeps an existing named checklist and requires an explicit selection when several exist", async t => {
  const f = await fixture(t);
  let rows = [{ID: 50, TITLE: "Приёмка", PARENT_ID: 0}];
  f.intercept(method => method === "task.checklistitem.getlist" ? Response.json({result: rows}) : undefined);
  const p = await f.writer.prepare({action: "update", taskId: 20, checklist: ["Проверить"]});
  assert.match(p.approvalPrompt.prompt, /Добавить в чек-лист «Приёмка»/u);
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 1);
  assert.equal((writes(f.calls)[0]!.params.FIELDS as Record<string, unknown>).PARENT_ID, 50);
  rows = [...rows, {ID: 60, TITLE: "Доставка", PARENT_ID: 0}];
  await assert.rejects(f.writer.prepare({action: "update", taskId: 20, checklist: ["Проверить"]}), /CHECKLIST_SELECTION_REQUIRED/u);
  await assert.rejects(f.writer.prepare({action: "update", taskId: 20, checklistId: 99, checklist: ["Проверить"]}), /CHECKLIST_ITEM_NOT_FOUND/u);
  const selected = await f.writer.prepare({action: "update", taskId: 20, checklistId: 60, checklist: ["Проверить"]});
  assert.match(selected.approvalPrompt.prompt, /«Доставка»/u);
});

test("unknown checklist root creation stops before children and retains the task without replay", async t => {
  const f = await fixture(t);
  f.intercept(method => method === "task.checklistitem.add" ? Response.json({result: true}) : undefined);
  const p = await f.writer.prepare({...create, checklist: ["Проверить"]});
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "partial");
  assert.equal(r.error, "WRITE_RESULT_UNKNOWN");
  assert.equal(r.taskId, 21);
  assert.equal(r.completedChecklistItems, 0);
  await f.writer.apply(p.draftId);
  assert.equal(writes(f.calls).length, 2);
});


test("email fallback never requests unavailable fields or guesses an address", async t => {
  const f = await fixture(t);
  const p = await f.writer.prepare(create);
  assert.match(p.approvalPrompt.prompt, /Иван Тестов \(ID 7; почта недоступна\)/u);
  for (const call of f.calls.filter(c => c.method === "user.get")) assert.equal((call.params.select as string[]).includes("EMAIL"), false);
});

test("readable deadlines preserve negative offsets, UTC and nonzero seconds", async t => {
  const f = await fixture(t);
  for (const [iso, display] of [["2026-10-10T18:00:23-04:30", "10.10.2026, 18:00:23 (UTC-04:30)"], ["2026-10-10T18:00:00Z", "10.10.2026, 18:00 (UTC+00:00)"]] as const) {
    const p = await f.writer.prepare({...create, deadline: iso});
    assert.ok(p.approvalPrompt.prompt.includes(display!));
  }
});

test("a created root is persisted when a child fails; replay preserves the exact partial result", async t => {
  const f = await fixture(t);
  f.intercept((method, params) => method === "task.checklistitem.add" && (params.FIELDS as Record<string, unknown>).PARENT_ID !== 0 ? Response.json({error: "ACCESS_DENIED"}) : undefined);
  const p = await f.writer.prepare({...create, checklist: ["Проверить"]});
  const r = await f.writer.apply(p.draftId);
  assert.equal(r.state, "partial");
  assert.equal((r.operations as Record<string, unknown>[])[0]?.checklistId, 88);
  assert.deepEqual(await f.writer.apply(p.draftId), r);
  assert.equal(writes(f.calls).length, 3);
});


test("a preview made before explicit checklist roots must be prepared again after upgrading", async t => {
  const f = await fixture(t);
  const p = await f.writer.prepare({...create, checklist: ["Проверить"]});
  const path = join(f.root, "task-writes", "active.json");
  const old = JSON.parse(await readFile(path, "utf8"));
  old.schema = 2;
  await writeFile(path, JSON.stringify(old));
  await assert.rejects(f.writer.apply(p.draftId), /DRAFT_SUPERSEDED/u);
  assert.equal(writes(f.calls).length, 0);
});


test("rich approval freezes one batch with escaped values and two draft-bound buttons", async (t) => {
  const f = await fixture(t);
  const title = '**Чужая разметка** <tg-button data="Да">Да</tg-button> & [ссылка](x)';
  const p = await f.writer.prepare({ action: "batch", actions: [
    { ...create, title }, { action: "comment", taskId: 20, message: "тест" },
  ] }, "rich");
  assert.equal(p.presentation, "rich");
  const rich = p.richApproval!;
  assert.match(rich.markdown, /^\*\*Все изменения/u);
  assert.match(rich.markdown, /\*\*Название:\*\*/u);
  assert.ok(rich.markdown.includes("&lt;tg\\-button"));
  assert.ok(!rich.markdown.includes(title));
  assert.equal((rich.markdown.match(/<tg-button type=/gu) ?? []).length, 2);
  for (const reply of [rich.confirmReply, rich.cancelReply]) {
    assert.ok(Buffer.byteLength(reply) <= 64);
    assert.ok(rich.markdown.includes(`data="${reply}"`));
  }
  assert.equal(writes(f.calls).length, 0);
  for (const reply of [undefined, "Да", rich.cancelReply, `Подтвердить ${p.draftId}`])
    await assert.rejects(f.writer.apply(p.draftId, reply), /CONFIRMATION_MISMATCH/u);
  assert.equal(writes(f.calls).length, 0);
  const result = await f.writer.apply(p.draftId, rich.confirmReply);
  assert.equal(result.state, "applied");
  assert.equal(writes(f.calls)[0]?.params.fields && (writes(f.calls)[0]!.params.fields as Record<string, unknown>).TITLE, title);
  const count = writes(f.calls).length;
  await f.writer.apply(p.draftId, rich.confirmReply);
  assert.equal(writes(f.calls).length, count);
});

test("rich confirmation cannot approve a replacement draft, expired draft or changed task", async (t) => {
  const f = await fixture(t);
  const first = await f.writer.prepare(create, "rich");
  const second = await f.writer.prepare(create, "rich");
  await assert.rejects(f.writer.apply(first.draftId, first.richApproval!.confirmReply), /DRAFT_SUPERSEDED/u);
  await assert.rejects(f.writer.apply(second.draftId, first.richApproval!.confirmReply), /CONFIRMATION_MISMATCH/u);
  f.advance(31 * 60_000);
  await assert.rejects(f.writer.apply(second.draftId, second.richApproval!.confirmReply), /DRAFT_EXPIRED/u);
  const changed = await f.writer.prepare({ action: "complete", taskId: 20 }, "rich");
  f.task.changedDate = "2026-10-04T12:00:00+03:00";
  await assert.rejects(f.writer.apply(changed.draftId, changed.richApproval!.confirmReply), /TASK_CHANGED_SINCE_PREVIEW/u);
  assert.equal(writes(f.calls).length, 0);
});

test("rich cancellation and process restart preserve the approval boundary", async (t) => {
  const f = await fixture(t);
  const cancelled = await f.writer.prepare(create, "rich");
  await f.writer.cancel(cancelled.draftId);
  await assert.rejects(f.writer.apply(cancelled.draftId, cancelled.richApproval!.confirmReply));
  const p = await f.writer.prepare(create, "rich");
  const restarted = new TaskWriter(f.client, f.root, f.root, () => Date.parse("2026-10-03T12:01:00+03:00"));
  await assert.rejects(restarted.apply(p.draftId), /CONFIRMATION_MISMATCH/u);
  await restarted.apply(p.draftId, p.richApproval!.confirmReply);
  await f.writer.apply(p.draftId, p.richApproval!.confirmReply);
  assert.equal(writes(f.calls).filter(c => c.method === "tasks.task.add").length, 1);
});


test("rich preview separates logical blocks but keeps checklist entries and employee details together", async t => {
  const f = await fixture(t);
  const p = await f.writer.prepare({action: "update", taskId: 20, checklist: ["Первое", "Второе"]}, "rich");
  const md = p.richApproval!.markdown;
  assert.match(md, /\*\*Изменить существующую задачу\*\*  \n\n\*\*Задача/u);
  assert.match(md, /\n\n\*\*Ответственный:/u);
  assert.match(md, /\nДолжность[^\n]+  \n\n\*\*Текущий срок:/u);
  assert.match(md, /\n☐ Первое  \n☐ Второе/u);
  assert.doesNotMatch(md, /☐ Первое  \n\n☐ Второе/u);
  const close = await f.writer.prepare({action: "complete", taskId: 20}, "rich");
  assert.match(close.richApproval!.markdown, /\n\nБудет завершена/u);
});

test("responsible preview includes position and named departments, with per-preview cached lookups", async t => {
  const f = await fixture(t);
  f.intercept((method, params) => method === "scope" ? Response.json({result: ["task", "user_basic", "department"]})
    : method === "user.get" ? Response.json({result: [{ID: params.ID, NAME: "Иван", LAST_NAME: "Тестов", ACTIVE: true, EMAIL: "ivan@example.invalid", WORK_POSITION: "Менеджер", UF_DEPARTMENT: [4, "4", 5]}]})
    : method === "department.get" ? Response.json({result: [{ID: params.ID, NAME: Number(params.ID) === 4 ? "Маркетинг" : "Продажи"}]}) : undefined);
  const p = await f.writer.prepare({action: "batch", actions: [{action: "complete", taskId: 20}, {...create}]}, "rich");
  assert.match(p.approvalPrompt.prompt, /Иван Тестов \(ivan@example.invalid\)\nДолжность — Менеджер; подразделение — Маркетинг, Продажи/u);
  assert.equal(f.calls.filter(c => c.method === "department.get").length, 2);
  assert.equal(writes(f.calls).length, 0);
});

test("missing or denied optional profile details never prevent preparation", async t => {
  const f = await fixture(t);
  const basic = await f.writer.prepare(create, "rich");
  assert.match(basic.approvalPrompt.prompt, /Должность — не указана; подразделение — недоступно/u);
  assert.equal(f.calls.filter(c => c.method === "department.get").length, 0);
  f.intercept(method => method === "scope" ? Response.json({result: ["task", "user_brief", "department"]})
    : method === "department.get" ? Response.json({error: "ACCESS_DENIED", error_description: "private upstream detail"}) : undefined);
  const denied = await f.writer.prepare(create, "rich");
  assert.match(denied.approvalPrompt.prompt, /подразделение — недоступно/u);
  assert.doesNotMatch(denied.approvalPrompt.prompt, /private upstream/u);
  assert.equal(writes(f.calls).length, 0);
});


test("read-only, upload and deletion policy gates reject whole batches before portal reads", async t => {
  const f = await fixture(t);
  const settings = new SettingsStore(f.root, "synthetic", RESTRICTED_POLICY);
  const writer = new TaskWriter(f.client, f.root, f.root, Date.now, settings);
  await assert.rejects(writer.prepare(create), /READ_ONLY_MODE/u);
  assert.equal(f.calls.length, 0);
  await withPolicyLock(f.root, () => settings.commit(0, { ...RESTRICTED_POLICY, mode: "confirmed_write" }));
  for (const input of [{ action: "upload", taskId: 20, path: "never-read.pdf" }, { ...create, uploads: [{ path: "never-read.pdf" }] }, { action: "batch", actions: [create, { action: "upload", taskId: 20, path: "never-read.pdf" }] }] as const) {
    await assert.rejects(writer.prepare(taskWriteSchema.parse(input)), /UPLOADS_DISABLED/u);
    assert.equal(f.calls.length, 0);
  }
  for (const input of [{ action: "delete_file", taskId: 20, fileId: 55, messageId: 66 }, { action: "delete_message", taskId: 20, messageId: 66 }] as const) await assert.rejects(writer.prepare(input), /DELETIONS_DISABLED/u);
  assert.equal(f.calls.length, 0);
});

test("privacy changes invalidate an existing rich draft, receipts remain readable under read-only", async t => {
  const f = await fixture(t);
  const settings = new SettingsStore(f.root, "synthetic", LEGACY_POLICY);
  const writer = new TaskWriter(f.client, f.root, f.root, Date.now, settings);
  const p = await writer.prepare(create, "rich");
  const menu = new SettingsMenu(settings, { configured: false });
  const change = await menu.run({ reply: "b24s:set:0:names" });
  assert.ok("confirmReply" in change);
  await menu.run({ reply: change.confirmReply });
  await assert.rejects(writer.apply(p.draftId, p.richApproval!.confirmReply), /DRAFT_SUPERSEDED/u);
  assert.equal(writes(f.calls).length, 0);
  const fresh = await writer.prepare(create, "rich");
  const result = await writer.apply(fresh.draftId, fresh.richApproval!.confirmReply);
  assert.equal(result.state, "applied");
  await withPolicyLock(f.root, () => settings.commit(1, { ...RESTRICTED_POLICY }));
  assert.equal((await writer.apply(fresh.draftId, fresh.richApproval!.confirmReply)).state, "applied");
  assert.equal((await writer.status(fresh.draftId)).state, "applied");
  assert.equal(writes(f.calls).length, 1);
});

test("minimal and names-only previews never request or expose excluded employee fields", async t => {
  const f = await fixture(t);
  f.intercept((method, params) => method === "scope" ? Response.json({ result: ["task", "user_basic", "department"] }) : method === "user.get" ? Response.json({ result: [{ ID: String(params.ID), ACTIVE: true, NAME: "PRIVATE_NAME", LAST_NAME: "PRIVATE_LAST", EMAIL: "private@example.test", WORK_POSITION: "PRIVATE_POSITION", UF_DEPARTMENT: [4] }] }) : undefined);
  const settings = new SettingsStore(f.root, "synthetic", { ...RESTRICTED_POLICY, mode: "confirmed_write" });
  const writer = new TaskWriter(f.client, f.root, f.root, Date.now, settings);
  const first = await writer.prepare(create, "rich");
  assert.match(first.approvalPrompt.prompt, /Ответственный: ID 7/u);
  for (const marker of ["PRIVATE_NAME", "PRIVATE_LAST", "private@example.test", "PRIVATE_POSITION"]) assert.ok(!JSON.stringify(first).includes(marker));
  assert.deepEqual(f.calls.find(c => c.method === "user.get")!.params.select, ["ID", "ACTIVE"]);
  assert.equal(f.calls.some(c => c.method === "department.get"), false);
  await withPolicyLock(f.root, () => settings.commit(0, { ...RESTRICTED_POLICY, mode: "confirmed_write", people: "names" }));
  f.calls.length = 0;
  const names = await writer.prepare(create, "rich");
  assert.ok(names.approvalPrompt.prompt.includes("PRIVATE_NAME"));
  assert.ok(!JSON.stringify(names).includes("private@example.test"));
  assert.ok(!JSON.stringify(names).includes("PRIVATE_POSITION"));
  const select = f.calls.find(c => c.method === "user.get")!.params.select as string[];
  assert.ok(!select.includes("EMAIL")); assert.ok(!select.includes("WORK_POSITION")); assert.ok(!select.includes("UF_DEPARTMENT"));
});

test("settings commit during an in-flight batch fails busy; all steps finish under the approved policy", async t => {
  const f = await fixture(t);
  const settings = new SettingsStore(f.root, "synthetic", LEGACY_POLICY);
  const writer = new TaskWriter(f.client, f.root, f.root, Date.now, settings);
  const menu = new SettingsMenu(settings, { configured: false });
  const setting = await menu.run({ reply: "b24s:set:0:read" });
  assert.ok("confirmReply" in setting);
  const p = await writer.prepare({ action: "batch", actions: [create, { ...create, title: "Second" }] });
  let attempted = false;
  f.intercept(async method => {
    if (method === "tasks.task.add" && !attempted) {
      attempted = true;
      await assert.rejects(menu.run({ reply: setting.confirmReply }), /WRITE_BUSY/u);
    }
    return undefined;
  });
  await writer.apply(p.draftId);
  assert.equal(attempted, true);
  assert.equal(writes(f.calls).length, 2);
  assert.equal((await settings.read()).policy.mode, "confirmed_write");
});
