import assert from "node:assert/strict";
import test from "node:test";
import { BitrixClient } from "../src/bitrix-client.ts";
import { loadConfig } from "../src/config.ts";
import { TaskReader } from "../src/tasks.ts";

const config = loadConfig({
  BITRIX24_WEBHOOK_BASE_URL: "https://example.test/rest/1/secret",
});

test("connection check verifies both identity and Tasks scope", async () => {
  const methods: string[] = [];
  const client = new BitrixClient(config, {
    fetch: async (input) => {
      const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1] ?? "";
      methods.push(method);
      return method === "profile"
        ? Response.json({ result: { ID: "42", NAME: "Synthetic" } })
        : Response.json({ result: { fields: {} } });
    },
  });

  const result = await new TaskReader(client).connectionCheck();
  assert.deepEqual(methods, ["profile", "tasks.task.getFields"]);
  assert.equal(result.taskScope, true);
  assert.equal(result.contractVersion, "0.3");
  assert.equal(result.apiFamily, "tasks-rest");
});

test("connection check rejects a profile without a bounded positive identifier", async () => {
  const client = new BitrixClient(config, {
    fetch: async () => Response.json({ result: { ID: "0", NAME: "Broken" } }),
  });
  await assert.rejects(
    new TaskReader(client).connectionCheck(),
    (error: unknown) =>
      error instanceof Error && error.message.includes("INVALID_PROFILE"),
  );
});

test("list defaults can be constrained to the webhook user's tasks", async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const client = new BitrixClient(config, {
    fetch: async (input, init) => {
      const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1] ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      if (method === "profile") return Response.json({ result: { ID: "42" } });
      return Response.json({
        result: {
          tasks: [
            {
              id: "7",
              title: "Synthetic task",
              description: "must not appear in list output",
              responsibleId: "42",
            },
          ],
        },
      });
    },
  });

  const result = await new TaskReader(client).listTasks({
    scope: "mine",
    overdueOnly: false,
    limit: 20,
    start: 0,
    sortBy: "DEADLINE",
    sortDirection: "asc",
  });

  assert.equal(JSON.stringify(result).includes("must not appear"), false);
  assert.equal(
    (result as { tasks: ReadonlyArray<{ webUrl: string }> }).tasks[0]?.webUrl,
    "https://example.test/company/personal/user/1/tasks/task/view/7/",
  );
  assert.deepEqual(requests.map(({ method }) => method), [
    "profile",
    "tasks.task.list",
  ]);
  assert.deepEqual(
    (requests[1]?.body.filter as Record<string, unknown>).RESPONSIBLE_ID,
    42,
  );
});

test("normalizes task semantics and embedded display names without extra scopes", async () => {
  let requestBody: Record<string, unknown> = {};
  const client = new BitrixClient(config, {
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        result: {
          tasks: [
            {
              id: 7,
              title: "Synthetic task",
              status: "3",
              priority: "2",
              mark: "P",
              deadline: "2026-09-10T18:30:00+03:00",
              createdDate: "not-a-date",
              responsibleId: "42",
              responsible: {
                id: "42",
                name: "Synthetic Assignee",
                email: "hidden@example.test",
              },
              createdBy: "43",
              creator: { id: "43", name: "Synthetic Creator" },
              groupId: "9",
              group: {
                id: "9",
                name: "Synthetic Project",
                description: "hidden",
              },
            },
          ],
        },
      });
    },
  });

  const result = (await new TaskReader(client).listTasks({
    scope: "accessible",
    overdueOnly: false,
    status: 3,
    limit: 20,
    start: 0,
    sortBy: "DEADLINE",
    sortDirection: "asc",
  })) as { tasks: ReadonlyArray<Record<string, unknown>> };

  assert.deepEqual(requestBody.filter, { REAL_STATUS: 3 });
  assert.ok((requestBody.select as string[]).includes("RESPONSIBLE"));
  assert.ok((requestBody.select as string[]).includes("CREATOR"));
  assert.ok((requestBody.select as string[]).includes("GROUP"));
  assert.deepEqual(result.tasks[0], {
    id: "7",
    webUrl: "https://example.test/company/personal/user/1/tasks/task/view/7/",
    title: "Synthetic task",
    status: 3,
    statusName: "in_progress",
    priority: 2,
    priorityName: "high",
    deadline: "2026-09-10T18:30:00+03:00",
    createdDate: null,
    changedDate: null,
    closedDate: null,
    responsibleId: "42",
    responsibleName: "Synthetic Assignee",
    createdBy: "43",
    createdByName: "Synthetic Creator",
    groupId: "9",
    groupName: "Synthetic Project",
    parentId: null,
    mark: "P",
    markName: "positive",
    dataWarnings: ["invalid_created_date"],
  });
  assert.equal(JSON.stringify(result).includes("hidden@example.test"), false);
  assert.equal(JSON.stringify(result).includes("hidden"), false);
});

test("uses the documented Bitrix24 overdue filter and reports its time boundary", async () => {
  let requestBody: Record<string, unknown> = {};
  const now = new Date("2026-09-06T12:34:56.000Z");
  const client = new BitrixClient(config, {
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ result: { tasks: [] } });
    },
  });

  const result = await new TaskReader(client, () => now).listTasks({
    scope: "accessible",
    overdueOnly: true,
    limit: 20,
    start: 0,
    sortBy: "DEADLINE",
    sortDirection: "asc",
  });

  assert.deepEqual(requestBody.filter, {
    "<DEADLINE": now.toISOString(),
    "!REAL_STATUS": [4, 5],
  });
  assert.equal(result.asOf, now.toISOString());
});

test("get returns only the normalized allowlisted fields", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json({
        result: {
          task: {
            id: "8",
            title: "Synthetic detail",
            description: "Safe synthetic description",
            email: "private@example.test",
          },
        },
      }),
  });
  const result = await new TaskReader(client).getTask(8);
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(JSON.stringify(result).includes("Safe synthetic description"), true);
  assert.equal(
    (result as { task: { webUrl: string } }).task.webUrl,
    "https://example.test/company/personal/user/1/tasks/task/view/8/",
  );
});

test("get rejects a task whose returned identifier differs from the request", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json({ result: { task: { id: "9", title: "Wrong task" } } }),
  });
  await assert.rejects(
    new TaskReader(client).getTask(8),
    (error: unknown) =>
      error instanceof Error && error.message.includes("TASK_ID_MISMATCH"),
  );
});

test("list exposes a cursor without skipping locally trimmed tasks", async () => {
  const client = new BitrixClient(config, {
    fetch: async (input) => {
      const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1];
      if (method === "profile") return Response.json({ result: { ID: "42" } });
      return Response.json({
        result: {
          tasks: Array.from({ length: 10 }, (_, index) => ({
            id: String(index + 1),
            title: `Synthetic ${index + 1}`,
          })),
        },
        next: 50,
        total: 73,
      });
    },
  });

  const result = (await new TaskReader(client).listTasks({
    scope: "mine",
    overdueOnly: false,
    limit: 5,
    start: 0,
    sortBy: "ID",
    sortDirection: "asc",
  })) as {
    tasks: readonly unknown[];
    nextStart: number | null;
    total: number | null;
    truncated: boolean;
  };

  assert.equal(result.tasks.length, 5);
  assert.equal(result.nextStart, 5);
  assert.equal(result.total, 73);
  assert.equal(result.truncated, true);
});

test("marks a list partial instead of treating malformed items as tasks", async () => {
  const client = new BitrixClient(config, {
    fetch: async (input) => {
      const method = /\/([^/]+(?:\.[^/]+)*)\.json$/u.exec(String(input))?.[1];
      if (method === "profile") return Response.json({ result: { ID: "42" } });
      return Response.json({
        result: {
          tasks: [
            { id: "1", title: "Valid" },
            { id: "0", title: "Invalid identifier" },
            "malformed",
          ],
        },
      });
    },
  });

  const result = (await new TaskReader(client).listTasks({
    scope: "mine",
    overdueOnly: false,
    limit: 20,
    start: 0,
    sortBy: "ID",
    sortDirection: "asc",
  })) as {
    tasks: readonly unknown[];
    returned: number;
    partial: boolean;
    skippedMalformed: number;
  };
  assert.equal(result.tasks.length, 1);
  assert.equal(result.returned, 1);
  assert.equal(result.partial, true);
  assert.equal(result.skippedMalformed, 2);
});

test("rejects a malformed single-task envelope", async () => {
  const client = new BitrixClient(config, {
    fetch: async () => Response.json({ result: { task: null } }),
  });
  await assert.rejects(
    new TaskReader(client).getTask(8),
    (error: unknown) =>
      error instanceof Error && error.message.includes("INVALID_RESPONSE"),
  );
});

test("history is bounded, paginated and omits the actor login", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new BitrixClient(config, {
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        result: {
          list: Array.from({ length: 4 }, (_, index) => ({
            id: index + 1,
            createdDate: "2026-09-05T12:00:00+03:00",
            field: "DEADLINE",
            value: { from: "old", to: "new" },
            user: {
              id: 42,
              name: "Synthetic",
              lastName: "Actor",
              login: "private@example.test",
            },
          })),
        },
        next: 50,
        total: 72,
      });
    },
  });

  const result = (await new TaskReader(client).taskHistory({
    taskId: 8,
    event: "DEADLINE",
    limit: 2,
    start: 0,
    sortDirection: "desc",
  })) as {
    events: ReadonlyArray<{ actor: Record<string, unknown> }>;
    nextStart: number | null;
    total: number | null;
    truncated: boolean;
  };

  assert.equal(result.events.length, 2);
  assert.equal(Object.hasOwn(result.events[0]?.actor ?? {}, "login"), false);
  assert.equal(Object.hasOwn(result.events[0]?.actor ?? {}, "secondName"), false);
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(result.nextStart, 2);
  assert.equal(result.total, 72);
  assert.equal(result.truncated, true);
  assert.deepEqual(requests[0], {
    taskId: 8,
    filter: { FIELD: "DEADLINE" },
    order: { createdDate: "desc" },
    start: 0,
  });
});

test("history skips entries without an ID and bounds unknown event types", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json({
        result: {
          list: [
            {
              id: "1",
              createdDate: "2026-09-05T12:00:00+03:00",
              field: "UNEXPECTED_PRIVATE_EVENT",
              value: { from: "old", to: "new" },
              user: { id: "42", name: "Synthetic" },
            },
            { id: "0", field: "TITLE", value: {} },
          ],
        },
      }),
  });

  const result = await new TaskReader(client).taskHistory({
    taskId: 8,
    limit: 20,
    start: 0,
    sortDirection: "desc",
  });
  assert.equal(result.returned, 1);
  assert.equal(result.partial, true);
  assert.equal(result.skippedMalformed, 1);
  assert.equal(result.events[0]?.field, null);
  assert.deepEqual(result.events[0]?.dataWarnings, ["unknown_field"]);
  assert.equal(JSON.stringify(result).includes("UNEXPECTED_PRIVATE_EVENT"), false);
});

test("field metadata is restricted to fields used by the public task contract", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json({
        result: {
          fields: {
            ID: { title: "ID", type: "integer" },
            STATUS: { title: "Status", type: "enum" },
            UF_PRIVATE_PIPELINE: {
              title: "Internal pipeline",
              type: "string",
            },
          },
        },
      }),
  });

  const result = (await new TaskReader(client).taskFields()) as {
    fields: ReadonlyArray<{ name: string }>;
    truncated: boolean;
  };
  assert.deepEqual(result.fields.map(({ name }) => name), ["ID", "STATUS"]);
  assert.equal(result.truncated, false);
});
