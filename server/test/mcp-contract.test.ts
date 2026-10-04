import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BitrixRequestError } from "../src/bitrix-client.ts";
import { createMcpServer, type BitrixReaderPort, type FileReaderPort } from "../src/mcp-server.ts";

function files(): FileReaderPort {
  return {
    list: async () => ({ files: [], returned: 0, partial: false, skippedUnavailable: 0, missingScopes: [], scannedMessages: 0, scannedChecklist: 0, directTruncated: false, messagesTruncated: false, checklistTruncated: false, untrustedContent: true }),
    search: async (options) => ({ matches: [], found: 0, scannedTasks: 0, scope: options.scope, phase: options.phase, nextCursor: null, partial: false, untrustedContent: true }),
    download: async (taskId, key) => ({ artifactId: "00000000-0000-4000-8000-000000000001", path: "bitrix24-read/test.pdf", fileName: "test.pdf", bytes: 4, source: "task", taskId: String(taskId), key }),
    release: async () => ({ released: true, artifactId: "00000000-0000-4000-8000-000000000001" }),
    viewPage: async () => ({ data: Buffer.from("image").toString("base64"), mimeType: "image/png", page: 1 }),
  };
}

function reader(): BitrixReaderPort {
  return {
    connectionCheck: async () => ({ connected: true, user: { id: "42" } }),
    listTasks: async (options) => ({ tasks: [], options }),
    getTask: async (taskId) => ({ task: { id: taskId } }),
    taskHistory: async (options) => ({ events: [], options }),
    taskFields: async () => ({ fields: [] }),
    capabilities: async () => ({ blocks: {} }),
    taskComments: async (options) => ({ messages: [], options }),
    searchProjects: async (options) => ({ projects: [], options }),
    searchPeople: async (options) => ({ people: [], options }),
    listDepartments: async (options) => ({ departments: [], options }),
    taskFiles: async (options) => ({ files: [], options }),
    taskChecklist: async (options) => ({ items: [], options }),
    taskRelations: async (options) => ({ subtasks: [], options }),
  };
}

async function connectedClient(taskReader: BitrixReaderPort = reader()) {
  const server = createMcpServer(taskReader, {
    check: async () => ({ state: "current" }),
    apply: async (input) => ({ state: "started", input }),
    status: async () => ({ state: "never_run" }),
  }, files(), {
    stages: async (projectId) => ({ projectId, stages: [{ id: 32, title: "Проверка", sort: 100 }], untrustedContent: true }),
    prepare: async () => ({ draftId: "00000000-0000-4000-8000-000000000001", expiresAt: "2026-10-03T12:30:00Z", approvalPrompt: { prompt: "Превью", options: [{ id: "confirm", label: "Подтвердить" }, { id: "cancel", label: "Отменить" }], allowFreeform: true }, untrustedContent: true }),
    apply: async (draftId) => ({ state: "applied", draftId }),
    cancel: async (draftId) => ({ state: "cancelled", draftId }),
    status: async (draftId) => ({ state: "unknown", draftId }),
  });
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test("publishes bounded task, document and update tools", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "bitrix24_apply_task_action",
      "bitrix24_cancel_task_action",
      "bitrix24_capabilities",
      "bitrix24_connection_check",
      "bitrix24_download_task_document",
      "bitrix24_get_task",
      "bitrix24_list_departments",
      "bitrix24_list_task_documents",
      "bitrix24_list_tasks",
      "bitrix24_prepare_task_action",
      "bitrix24_project_stages",
      "bitrix24_release_task_document",
      "bitrix24_search_people",
      "bitrix24_search_projects",
      "bitrix24_search_task_documents",
      "bitrix24_task_action_status",
      "bitrix24_task_checklist",
      "bitrix24_task_comments",
      "bitrix24_task_fields",
      "bitrix24_task_files",
      "bitrix24_task_history",
      "bitrix24_task_relations",
      "bitrix24_view_task_document_page",
      "iva_bitrix24_update_apply",
      "iva_bitrix24_update_check",
      "iva_bitrix24_update_status",
    ],
  );
  const apply = tools.find(({ name }) => name === "iva_bitrix24_update_apply");
  const comments = tools.find(({ name }) => name === "bitrix24_task_comments");
  assert.match(comments?.description ?? "", /system change events/u);
  assert.match(comments?.description ?? "", /Use it proactively for analytics/u);
  assert.equal(apply?.annotations?.readOnlyHint, false);
  assert.equal(apply?.annotations?.destructiveHint, true);
  for (const tool of tools.filter(({ name }) => !["bitrix24_apply_task_action", "bitrix24_prepare_task_action", "bitrix24_cancel_task_action", "iva_bitrix24_update_apply", "bitrix24_download_task_document", "bitrix24_release_task_document"].includes(name))) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  assert.equal(tools.find(({ name }) => name === "bitrix24_download_task_document")?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(({ name }) => name === "bitrix24_release_task_document")?.annotations?.destructiveHint, true);
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

  const obsoleteTextConfirmation = await client.callTool({
    name: "iva_bitrix24_update_apply",
    arguments: {
      candidateSha: "a".repeat(40),
      confirmation: "ОБНОВИТЬ aaaaaaaaaaaa",
    },
  });
  assert.equal(obsoleteTextConfirmation.isError, true);

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

  const broadProjectSearch = await client.callTool({
    name: "bitrix24_search_projects",
    arguments: {},
  });
  assert.equal(broadProjectSearch.isError, true);

  const ambiguousPeopleSearch = await client.callTool({
    name: "bitrix24_search_people",
    arguments: { userId: 1, query: "Sy" },
  });
  assert.equal(ambiguousPeopleSearch.isError, true);

  const ambiguousDepartmentPeopleSearch = await client.callTool({
    name: "bitrix24_search_people",
    arguments: { query: "Sy", departmentId: 4 },
  });
  assert.equal(ambiguousDepartmentPeopleSearch.isError, true);

  const selectedDepartmentPeopleSearch = await client.callTool({
    name: "bitrix24_search_people",
    arguments: { departmentId: 4 },
  });
  assert.equal(selectedDepartmentPeopleSearch.isError, undefined);

  const broadDepartmentList = await client.callTool({
    name: "bitrix24_list_departments",
    arguments: {},
  });
  assert.equal(broadDepartmentList.isError, true);

  const invalidCommentCursor = await client.callTool({
    name: "bitrix24_task_comments",
    arguments: { taskId: 1, cursor: "../../../secret" },
  });
  assert.equal(invalidCommentCursor.isError, true);

  const excessiveFileLimit = await client.callTool({
    name: "bitrix24_task_files",
    arguments: { taskId: 1, limit: 21 },
  });
  assert.equal(excessiveFileLimit.isError, true);

  const arbitraryDownload = await client.callTool({
    name: "bitrix24_download_task_document",
    arguments: { taskId: 1, key: "../../secret" },
  });
  assert.equal(arbitraryDownload.isError, true);

  const arbitraryRelease = await client.callTool({
    name: "bitrix24_release_task_document",
    arguments: { artifactId: "../../secret" },
  });
  assert.equal(arbitraryRelease.isError, true);

  const unknown = await client.callTool({
    name: "bitrix24_connection_check",
    arguments: { method: "tasks.task.delete" },
  });
  assert.equal(unknown.isError, true);
});

test("returns a visual document page as an MCP image block", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({
    name: "bitrix24_view_task_document_page",
    arguments: { artifactId: "00000000-0000-4000-8000-000000000001", page: 1 },
  });
  assert.equal(result.isError, undefined);
  assert.equal((result.content as Array<{ type: string }>)[0]?.type, "image");
});

test("names the required optional scope without upstream details", async (t) => {
  const bitrixReader = reader();
  const { client, server } = await connectedClient({
    ...bitrixReader,
    taskComments: async () => {
      throw new BitrixRequestError("INSUFFICIENT_SCOPE", false, "im");
    },
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "bitrix24_task_comments",
    arguments: { taskId: 1 },
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.deepEqual(JSON.parse(content[0]?.text ?? "{}"), {
    ok: false,
    error: "INSUFFICIENT_SCOPE",
    category: "permission",
    retryable: false,
    action: "add_required_scope",
    requiredScope: "im",
  });
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


test("task writes expose preview buttons and reject incomplete or modified execution payloads", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const missing = await client.callTool({ name: "bitrix24_prepare_task_action", arguments: { action: "create", title: "Title" } });
  assert.equal(missing.isError, true);
  const result = await client.callTool({ name: "bitrix24_prepare_task_action", arguments: { action: "create", title: "Title", description: "Description", responsibleId: 1, deadline: "2026-10-10T18:00:00+03:00" } });
  const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.deepEqual(payload.approvalPrompt.options.map((o: { id: string }) => o.id), ["confirm", "cancel"]);
  const altered = await client.callTool({ name: "bitrix24_apply_task_action", arguments: { draftId: payload.draftId, responsibleId: 999 } });
  assert.equal(altered.isError, true);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((t) => t.name === "bitrix24_apply_task_action")?.annotations?.readOnlyHint, false);
});

test("MCP accepts one update/comment/upload batch and rejects empty edits and nested batches", async t => {
  const {client, server} = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const valid = await client.callTool({ name: "bitrix24_prepare_task_action", arguments: {
    action: "batch", actions: [
      {action: "update", taskId: 20, addAuditors: [8], checklist: ["Проверить"]},
      {action: "comment", taskId: 20, message: "тест"},
      {action: "upload", taskId: 20, path: "test.txt"},
    ],
  }});
  assert.notEqual(valid.isError, true);
  const clear = await client.callTool({name: "bitrix24_prepare_task_action", arguments: {action: "update", taskId: 20, deadline: null}});
  assert.notEqual(clear.isError, true);
  for (const args of [{action: "update", taskId: 20}, {action: "batch", actions: [{action: "batch", actions: []}]}]) {
    const invalid = await client.callTool({name: "bitrix24_prepare_task_action", arguments: args});
    assert.equal(invalid.isError, true);
  }
});


test("tool discovery publishes task action fields and nested batch schemas", async t => {
 const {client, server} = await connectedClient();
 t.after(async () => {await client.close(); await server.close();});
 const tools = (await client.listTools()).tools;
 const schema = tools.find(t => t.name === "bitrix24_prepare_task_action")!.inputSchema;
 assert.equal(schema.type, "object");
 const props = schema.properties as Record<string, unknown>;
 for (const field of ["action", "title", "description", "taskId", "addAuditors", "checklistUpdates", "uploads", "actions"])
  assert.ok(props[field], field);
 assert.match(JSON.stringify(props.actions), /batch|checklistUpdates/u);
 assert.deepEqual(schema.required, ["action"]);
});

test("MCP discovers and validates project stages and stage/chat-deletion actions", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const stages = await client.callTool({ name: "bitrix24_project_stages", arguments: { projectId: 9 } });
  assert.equal(stages.isError, undefined);
  assert.match(JSON.stringify(stages.content), /Проверка/u);
  for (const arguments_ of [
    { action: "stage", taskId: 20, stageId: 32 },
    { action: "delete_file", taskId: 20, fileId: 55, messageId: 66 },
    { action: "delete_message", taskId: 20, messageId: 66 },
  ]) {
    const result = await client.callTool({ name: "bitrix24_prepare_task_action", arguments: arguments_ });
    assert.notEqual(result.isError, true);
  }
  for (const arguments_ of [
    { action: "stage", taskId: 20, stageId: 0 },
    { action: "delete_file", taskId: 20, fileId: 55 },
    { action: "delete_message", taskId: 20, messageId: 66, chatId: 999 },
  ]) {
    const result = await client.callTool({ name: "bitrix24_prepare_task_action", arguments: arguments_ });
    assert.equal(result.isError, true);
  }
});
