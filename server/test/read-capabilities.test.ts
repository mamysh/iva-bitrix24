import assert from "node:assert/strict";
import test from "node:test";
import { BitrixClient, BitrixRequestError } from "../src/bitrix-client.ts";
import { loadConfig } from "../src/config.ts";
import { ReadCapabilityReader } from "../src/read-capabilities.ts";

const config = loadConfig({
  BITRIX24_WEBHOOK_BASE_URL: "https://example.test/rest/1/secret",
});

type Handler = (method: string, body: Record<string, unknown>) => unknown;

function reader(handler: Handler) {
  return new ReadCapabilityReader(
    new BitrixClient(config, {
      fetch: async (input, init) => {
        const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1] ?? "";
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(handler(method, body));
      },
    }),
  );
}

test("reports only plugin-relevant webhook scopes and actionable capability blocks", async () => {
  const result = await reader(() => ({
    result: ["task", "im", "user_basic", "crm", "disk"],
  })).capabilities();

  assert.deepEqual(result.grantedScopes, ["disk", "im", "task", "user_basic"]);
  assert.equal(result.blocks.taskDiscussion.available, true);
  assert.equal(result.blocks.taskDiscussion.status, "available");
  assert.equal(result.blocks.people.available, true);
  assert.equal(result.blocks.people.effectiveScope, "user_basic");
  assert.equal(result.blocks.projects.available, false);
  assert.equal(JSON.stringify(result).includes("crm"), false);
  assert.equal(result.permissionGuide.permissions.im.nameRu, "Чат и уведомления");
});

test("reports task-only discussion support as limited instead of unavailable", async () => {
  const result = await reader(() => ({ result: ["task"] })).capabilities();
  assert.equal(result.blocks.taskDiscussion.available, true);
  assert.equal(result.blocks.taskDiscussion.status, "limited");
  assert.equal(result.blocks.taskFiles.available, false);
});

test("reads new-card task chat, bounds it locally and removes contact and download data", async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await reader((method, body) => {
    requests.push({ method, body });
    if (method === "tasks.task.get")
      return { result: { task: { id: "7", chatId: 99 } } };
    return {
      result: {
        messages: [
          {
            id: 12,
            author_id: 42,
            date: "2026-09-06T12:00:00+03:00",
            text: "Synthetic newest",
            params: { FILE_ID: [5] },
          },
          { id: 11, author_id: 0, date: "2026-09-06T11:00:00+03:00", text: "System" },
        ],
        users: [
          {
            id: 42,
            first_name: "Synthetic",
            last_name: "Person",
            email: "hidden@example.test",
            phone: "hidden",
          },
        ],
        files: [
          {
            id: 5,
            name: "brief.pdf",
            size: 123,
            type: "file",
            urlDownload: "https://example.test/secret-download",
          },
        ],
      },
    };
  }).taskComments({ taskId: 7, mode: "auto", limit: 1 });

  assert.deepEqual(requests.map(({ method }) => method), [
    "tasks.task.get",
    "im.dialog.messages.get",
  ]);
  assert.deepEqual(requests[1]?.body, { DIALOG_ID: "chat99", LIMIT: 1 });
  assert.equal(result.source, "task_chat");
  assert.equal(result.messages.length, 1);
  assert.equal(result.nextCursor, "chat:12");
  assert.equal(JSON.stringify(result).includes("hidden@example.test"), false);
  assert.equal(JSON.stringify(result).includes("secret-download"), false);
  assert.deepEqual(result.messages[0]?.attachments, [
    { fileId: "5", name: "brief.pdf", size: 123, type: "file" },
  ]);
});

test("uses legacy comments only when requested and returns a typed continuation cursor", async () => {
  let request: Record<string, unknown> = {};
  const result = await reader((_method, body) => {
    request = body;
    return {
      result: [
        {
          ID: "9",
          AUTHOR_ID: "42",
          AUTHOR_NAME: "Synthetic Person",
          AUTHOR_EMAIL: "hidden@example.test",
          POST_DATE: "2026-09-06T12:00:00+03:00",
          POST_MESSAGE: "Synthetic comment",
          POST_MESSAGE_HTML: "<b>ignored</b>",
        },
      ],
      next: 50,
      total: 51,
    };
  }).taskComments({ taskId: 7, mode: "legacy_comments", limit: 20 });

  assert.equal(request.TASKID, 7);
  assert.equal(result.source, "legacy_comments");
  assert.equal(result.nextCursor, "legacy:50");
  assert.equal(JSON.stringify(result).includes("hidden@example.test"), false);
  assert.equal(JSON.stringify(result).includes("POST_MESSAGE_HTML"), false);
});

test("does not hide a missing chat scope behind legacy fallback", async () => {
  const capabilityReader = new ReadCapabilityReader(
    new BitrixClient(config, {
      fetch: async (input) => {
        const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1];
        if (method === "tasks.task.get")
          return Response.json({ result: { task: { id: "7", chatId: 99 } } });
        return Response.json({ error: "insufficient_scope" }, { status: 403 });
      },
    }),
  );

  await assert.rejects(
    capabilityReader.taskComments({ taskId: 7, mode: "auto", limit: 20 }),
    (error: unknown) =>
      error instanceof BitrixRequestError &&
      error.code === "INSUFFICIENT_SCOPE" &&
      error.requiredScope === "im",
  );
});

test("searches accessible projects and employees with bounded normalized fields", async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const capabilityReader = reader((method, body) => {
    requests.push({ method, body });
    if (method === "sonet_group.get")
      return {
        result: [
          {
            ID: "3",
            NAME: "Synthetic Project",
            PROJECT: "Y",
            OWNER_ID: "42",
            ACTIVE: "Y",
            VISIBLE: "N",
            OPENED: "Y",
            CLOSED: "N",
            DESCRIPTION: "must not appear",
          },
        ],
      };
    return {
      result: [
        {
          ID: "42",
          NAME: "Synthetic",
          LAST_NAME: "Person",
          ACTIVE: true,
          WORK_POSITION: "Manager",
          UF_DEPARTMENT: [4],
          EMAIL: "hidden@example.test",
          PERSONAL_PHONE: "hidden",
        },
      ],
    };
  });

  const projects = await capabilityReader.searchProjects({
    query: "Syn",
    limit: 10,
    start: 0,
  });
  const people = await capabilityReader.searchPeople({
    userId: 42,
    limit: 10,
    start: 0,
  });

  assert.deepEqual((requests[0]?.body.FILTER as Record<string, unknown>)["%NAME"], "Syn");
  assert.deepEqual((requests[1]?.body.filter as Record<string, unknown>).ID, 42);
  assert.equal(projects.projects[0]?.name, "Synthetic Project");
  assert.equal(projects.projects[0]?.project, true);
  assert.deepEqual(people.people[0]?.departmentIds, ["4"]);
  assert.equal(JSON.stringify({ projects, people }).includes("hidden@example.test"), false);
  assert.equal(JSON.stringify({ projects, people }).includes("must not appear"), false);
});

test("advances project pagination by consumed upstream rows when one row is malformed", async () => {
  const result = await reader(() => ({
    result: ["malformed", { ID: "2", NAME: "Valid" }, { ID: "3", NAME: "Later" }],
  })).searchProjects({ query: "Va", limit: 2, start: 0 });

  assert.deepEqual(result.projects.map(({ id }) => id), ["2"]);
  assert.equal(result.partial, true);
  assert.equal(result.skippedMalformed, 1);
  assert.equal(result.nextStart, 2);
});

test("lists only a selected department branch", async () => {
  let request: Record<string, unknown> = {};
  const result = await reader((_method, body) => {
    request = body;
    return {
      result: [{ ID: "4", NAME: "Synthetic Unit", PARENT: "1", UF_HEAD: "42" }],
    };
  }).listDepartments({ parentId: 1, limit: 10, start: 0 });

  assert.equal(request.PARENT, 1);
  assert.deepEqual(result.departments, [
    { id: "4", name: "Synthetic Unit", parentId: "1", headUserId: "42" },
  ]);
});

test("returns task attachment metadata without download URLs and marks inaccessible files", async () => {
  const result = await reader((method, body) => {
    if (method === "tasks.task.get")
      return { result: { task: { id: "7", ufTaskWebdavFiles: [10, 11] } } };
    if (body.id === 10)
      return {
        result: {
          ID: "10",
          OBJECT_ID: "100",
          NAME: "brief.pdf",
          SIZE: "2048",
          CREATE_TIME: "2026-09-06T12:00:00+03:00",
          CREATED_BY: "42",
          MODULE_ID: "tasks",
          ENTITY_TYPE: "tasks_task",
          ENTITY_ID: "7",
          DOWNLOAD_URL: "https://example.test/download?auth=hidden",
        },
      };
    return { error: "ACCESS_DENIED" };
  }).taskFiles({ taskId: 7, limit: 10, start: 0 });

  assert.equal(result.returned, 1);
  assert.equal(result.partial, true);
  assert.equal(result.skippedUnavailable, 1);
  assert.equal(JSON.stringify(result).includes("download"), false);
  assert.equal(JSON.stringify(result).includes("auth=hidden"), false);
});

test("does not turn a task-file network failure into a misleading partial result", async () => {
  const capabilityReader = new ReadCapabilityReader(
    new BitrixClient(
      { ...config, maxAttempts: 1 },
      {
        fetch: async (input) => {
          const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1];
          if (method === "tasks.task.get")
            return Response.json({ result: { task: { id: "7", ufTaskWebdavFiles: [10] } } });
          throw new TypeError("synthetic network failure");
        },
      },
    ),
  );

  await assert.rejects(
    capabilityReader.taskFiles({ taskId: 7, limit: 10, start: 0 }),
    (error: unknown) =>
      error instanceof BitrixRequestError && error.code === "NETWORK_ERROR",
  );
});

test("normalizes checklist data and resolves immediate task relations without recursion", async () => {
  const capabilityReader = reader((method, body) => {
    if (method === "task.checklistitem.getlist")
      return {
        result: [
          {
            ID: "5",
            TASK_ID: "7",
            PARENT_ID: "0",
            CREATED_BY: "42",
            TITLE: "Synthetic checklist item",
            SORT_INDEX: "1",
            IS_COMPLETE: "Y",
            IS_IMPORTANT: "N",
            MEMBERS: [{ ID: "42", TYPE: "U", NAME: "Synthetic Person", IMAGE: "hidden" }],
          },
        ],
      };
    if (method === "tasks.task.get")
      return { result: { task: { id: "7", parentId: "2", dependsOn: [3] } } };
    const filter = body.filter as Record<string, unknown>;
    if (filter.PARENT_ID === 7)
      return {
        result: {
          tasks: [{ id: "8", title: "Subtask", status: "3", deadline: null }],
        },
      };
    return {
      result: {
        tasks: [
          { id: "2", title: "Parent", status: "3", deadline: null },
          { id: "3", title: "Dependency", status: "5", deadline: null },
        ],
      },
    };
  });

  const checklist = await capabilityReader.taskChecklist({
    taskId: 7,
    limit: 20,
    start: 0,
    sortBy: "SORT_INDEX",
    sortDirection: "asc",
  });
  const relations = await capabilityReader.taskRelations({ taskId: 7, subtaskLimit: 10 });

  assert.equal(checklist.items[0]?.completed, true);
  assert.equal(JSON.stringify(checklist).includes("IMAGE"), false);
  assert.equal(relations.parent?.id, "2");
  assert.deepEqual(relations.dependencies.map(({ id }) => id), ["3"]);
  assert.deepEqual(relations.subtasks.map(({ id }) => id), ["8"]);
});
