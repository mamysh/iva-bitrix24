import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

async function connectedClient() {
  const server = createMcpServer(reader(), {
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

  const invalidLimit = await client.callTool({
    name: "bitrix24_list_tasks",
    arguments: { limit: 51 },
  });
  assert.equal(invalidLimit.isError, true);

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
