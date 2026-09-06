import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BitrixRequestError } from "../src/bitrix-client.ts";
import { createMcpServer, type TaskReaderPort } from "../src/mcp-server.ts";

function reader(): TaskReaderPort {
  return {
    connectionCheck: async () => ({ connected: true, user: { id: "42" } }),
    listTasks: async (options) => ({ tasks: [], options }),
    getTask: async (taskId) => ({ task: { id: taskId } }),
    taskHistory: async (options) => ({ events: [], options }),
    taskFields: async () => ({ fields: [] }),
  };
}

async function connectedClient(taskReader: TaskReaderPort = reader()) {
  const server = createMcpServer(taskReader, {
    check: async () => ({ state: "current" }),
    apply: async (input) => ({ state: "started", input }),
    status: async () => ({ state: "never_run" }),
  });
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test("publishes five Bitrix read tools and three guarded update tools", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "bitrix24_connection_check",
      "bitrix24_get_task",
      "bitrix24_list_tasks",
      "bitrix24_task_fields",
      "bitrix24_task_history",
      "iva_bitrix24_update_apply",
      "iva_bitrix24_update_check",
      "iva_bitrix24_update_status",
    ],
  );
  const apply = tools.find(({ name }) => name === "iva_bitrix24_update_apply");
  assert.equal(apply?.annotations?.readOnlyHint, false);
  assert.equal(apply?.annotations?.destructiveHint, true);
  for (const tool of tools.filter(({ name }) => name !== "iva_bitrix24_update_apply")) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
});

test("validates task identifiers and list limits at the MCP boundary", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const invalidId = await client.callTool({
    name: "bitrix24_get_task",
    arguments: { taskId: -1 },
  });
  assert.equal(invalidId.isError, true);

  const unsafeId = await client.callTool({
    name: "bitrix24_get_task",
    arguments: { taskId: Number.MAX_SAFE_INTEGER + 1 },
  });
  assert.equal(unsafeId.isError, true);

  const invalidLimit = await client.callTool({
    name: "bitrix24_list_tasks",
    arguments: { limit: 51 },
  });
  assert.equal(invalidLimit.isError, true);

  const invalidLegacyStatus = await client.callTool({
    name: "bitrix24_list_tasks",
    arguments: { status: 1 },
  });
  assert.equal(invalidLegacyStatus.isError, true);

  const invalidDeadlineRange = await client.callTool({
    name: "bitrix24_list_tasks",
    arguments: {
      deadlineFrom: "2026-09-07T00:00:00+03:00",
      deadlineTo: "2026-09-06T00:00:00+03:00",
    },
  });
  assert.equal(invalidDeadlineRange.isError, true);

  const ambiguousOverdue = await client.callTool({
    name: "bitrix24_list_tasks",
    arguments: {
      overdueOnly: true,
      status: 3,
    },
  });
  assert.equal(ambiguousOverdue.isError, true);

  const invalidHistoryLimit = await client.callTool({
    name: "bitrix24_task_history",
    arguments: { taskId: 1, limit: 51 },
  });
  assert.equal(invalidHistoryLimit.isError, true);

  const unknown = await client.callTool({
    name: "bitrix24_connection_check",
    arguments: { method: "tasks.task.delete" },
  });
  assert.equal(unknown.isError, true);
});

test("returns bounded actionable error metadata without upstream details", async (t) => {
  const taskReader = reader();
  const { client, server } = await connectedClient({
    ...taskReader,
    getTask: async () => {
      throw new BitrixRequestError("INSUFFICIENT_SCOPE");
    },
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "bitrix24_get_task",
    arguments: { taskId: 1 },
  });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.type === "text" ? (content[0].text ?? "") : "";
  assert.deepEqual(JSON.parse(text), {
    ok: false,
    error: "INSUFFICIENT_SCOPE",
    category: "permission",
    retryable: false,
    action: "add_required_scope",
  });
});

test("keeps an ambiguous task error actionable without guessing its cause", async (t) => {
  const taskReader = reader();
  const { client, server } = await connectedClient({
    ...taskReader,
    getTask: async () => {
      throw new BitrixRequestError("TASK_NOT_FOUND_OR_DENIED");
    },
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "bitrix24_get_task",
    arguments: { taskId: 1 },
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  const payload = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
  assert.deepEqual(payload, {
    ok: false,
    error: "TASK_NOT_FOUND_OR_DENIED",
    category: "access",
    retryable: false,
    action: "check_task_id_or_access",
  });
});
