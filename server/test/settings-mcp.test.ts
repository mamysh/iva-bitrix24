import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverFromEnvironment } from "../src/main.ts";
import { SettingsStore, RESTRICTED_POLICY, withPolicyLock } from "../src/settings.ts";

type Call = { method: string; params: Record<string, unknown> };
async function fixture(t: test.TestContext, configured = true) {
  const root = await mkdtemp(join(tmpdir(), "bitrix-settings-mcp-"));
  const calls: Call[] = [];
  let intercept: ((method: string) => Promise<void>) | undefined;
  const server = await serverFromEnvironment({ PLUGIN_DATA: root, BITRIX24_SETTINGS_DEFAULTS: "restricted", ...(configured ? { BITRIX24_WEBHOOK_BASE_URL: "https://example.test/rest/123/secret" } : {}) }, {
    fetch: async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1)!.replace(/\.json$/u, "");
      const params = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, params });
      await intercept?.(method);
      let result: unknown = true;
      if (method === "profile") result = { ID: "123", NAME: "PRIVATE_NAME", LAST_NAME: "PRIVATE_LAST", ADMIN: true };
      if (method === "scope") result = ["task", "im", "user_basic", "department"];
      if (method === "user.get") result = [{ ID: "7", ACTIVE: true, NAME: "PRIVATE_NAME", LAST_NAME: "PRIVATE_LAST", EMAIL: "private@example.test", WORK_POSITION: "PRIVATE_POSITION", UF_DEPARTMENT: [4] }];
      if (method === "tasks.task.getFields") result = { fields: {} };
      const task = { id: "20", title: "Free text", responsibleId: "7", createdBy: "7", responsible: { id: "7", name: "PRIVATE_NAME" }, creator: { id: "7", name: "PRIVATE_NAME" } };
      if (method === "tasks.task.list") result = { tasks: [task] };
      if (method === "tasks.task.get") result = { task };
      if (method === "tasks.task.history.list") result = { list: [{ id: "1", field: "TITLE", user: { id: "7", name: "PRIVATE_NAME", lastName: "PRIVATE_LAST" }, value: { from: "Free text" } }] };
      if (method === "task.commentitem.getlist") result = [{ ID: "1", AUTHOR_ID: "7", AUTHOR_NAME: "PRIVATE_NAME", POST_MESSAGE: "Free text" }];
      if (method === "task.checklistitem.getlist") result = [{ ID: "1", TASK_ID: "20", TITLE: "Free text", MEMBERS: [{ ID: "7", NAME: "PRIVATE_NAME" }] }];
      if (method === "department.get") result = [{ ID: "4", NAME: "PRIVATE_DEPARTMENT" }];
      return Response.json({ result });
    },
  });
  const client = new Client({ name: "settings-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, calls, client, intercept: (hook: typeof intercept) => { intercept = hook; }, store: new SettingsStore(root, "https://example.test/123", RESTRICTED_POLICY) };
}
function parsed(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return JSON.parse((result.content as { type: string; text: string }[])[0]!.text);
}

test("production MCP exposes settings schema and safe home before configuration", async t => {
  const f = await fixture(t, false);
  const { tools } = await f.client.listTools();
  const tool = tools.find(tool => tool.name === "bitrix24_settings")!;
  assert.equal(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties?.screen);
  assert.ok(tool.inputSchema.properties?.reply);
  const result = parsed(await f.client.callTool({ name: "bitrix24_settings", arguments: {} }));
  assert.match(String(result.markdown), /не настроен/u);
  assert.equal(f.calls.length, 0);
});

test("actual MCP minimizes connection, people, task, history, comments and checklist members", async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ["bitrix24_connection_check", {}],
    ["bitrix24_search_people", { userId: 7 }],
    ["bitrix24_list_tasks", {}],
    ["bitrix24_get_task", { taskId: 20 }],
    ["bitrix24_task_history", { taskId: 20 }],
    ["bitrix24_task_comments", { taskId: 20, mode: "legacy_comments" }],
    ["bitrix24_task_checklist", { taskId: 20 }],
    ["bitrix24_list_departments", { departmentId: 4 }],
  ] as const) {
    const response = await f.client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, name);
    for (const marker of ["PRIVATE_NAME", "PRIVATE_LAST", "private@example.test", "PRIVATE_POSITION", "PRIVATE_DEPARTMENT"]) assert.ok(!JSON.stringify(response).includes(marker), `${name}: ${marker}`);
  }
  assert.deepEqual(f.calls.find(c => c.method === "user.get")!.params.select, ["ID", "ACTIVE"]);
  assert.ok(!(f.calls.find(c => c.method === "tasks.task.list")!.params.select as string[]).includes("RESPONSIBLE"));
  const before = f.calls.length;
  const rejected = parsed(await f.client.callTool({ name: "bitrix24_search_people", arguments: { query: "PRIVATE_NAME" } }));
  assert.equal(rejected.error, "PERSON_NAME_SEARCH_DISABLED");
  assert.equal(f.calls.length, before);
  const readonly = parsed(await f.client.callTool({ name: "bitrix24_prepare_task_action", arguments: { action: "complete", taskId: 20 } }));
  assert.equal(readonly.error, "READ_ONLY_MODE");
  assert.equal(f.calls.length, before);
});

test("MCP forwards actual confirmation, persists revision and blocks replay", async t => {
  const f = await fixture(t);
  const home = parsed(await f.client.callTool({ name: "bitrix24_settings", arguments: {} }));
  assert.match(String(home.markdown), /Webhook: работает/u);
  assert.deepEqual(f.calls.map(c => c.method), ["profile", "tasks.task.getFields"]);
  const offer = parsed(await f.client.callTool({ name: "bitrix24_settings", arguments: { reply: "b24s:set:0:names" } }));
  assert.equal((await f.store.read()).revision, 0);
  const reply = String(offer.confirmReply);
  const applied = parsed(await f.client.callTool({ name: "bitrix24_settings", arguments: { reply } }));
  assert.match(String(applied.markdown), /Настройки сохранены/u);
  const people = parsed(await f.client.callTool({ name: "bitrix24_search_people", arguments: { userId: 7 } }));
  assert.ok(JSON.stringify(people).includes("PRIVATE_NAME"));
  assert.ok(!JSON.stringify(people).includes("private@example.test"));
  assert.ok(!JSON.stringify(people).includes("PRIVATE_POSITION"));
  assert.equal(parsed(await f.client.callTool({ name: "bitrix24_settings", arguments: { reply } })).error, "SETTINGS_OFFER_INVALID");
});

test("the final MCP projection rechecks a policy changed during an upstream read", async t => {
  const f = await fixture(t);
  await withPolicyLock(f.root, () => f.store.commit(0, { ...RESTRICTED_POLICY, people: "work", email: true }));
  f.intercept(async method => {
    if (method === "user.get") {
      await withPolicyLock(f.root, () => f.store.commit(1, RESTRICTED_POLICY));
      f.intercept(undefined);
    }
  });
  const result = await f.client.callTool({ name: "bitrix24_search_people", arguments: { userId: 7 } });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_NAME"));
  assert.ok((f.calls.find(c => c.method === "user.get")!.params.select as string[]).includes("EMAIL"));
  await writeFile(join(f.root, "settings.json"), "{broken");
  const before = f.calls.length;
  const invalid = parsed(await f.client.callTool({ name: "bitrix24_get_task", arguments: { taskId: 20 } }));
  assert.equal(invalid.error, "SETTINGS_INVALID");
  assert.equal(f.calls.length, before);
});

test("Bridge screen schema returns structured navigation and preserves confirmation guards", async t => {
  const f = await fixture(t, false);
  const tools = await f.client.listTools();
  assert.ok(tools.tools.find(tool => tool.name === "bitrix24_screen")?.inputSchema.properties?.event);
  const call = async (event: Record<string, unknown>) => parsed(await f.client.callTool({ name: "bitrix24_screen", arguments: { event } }));
  const home = await call({ type: "open", eventId: "open" });
  assert.equal(home.type, "show");
  const view = home.view as { markdown: string; rows: { id: string; label: string }[][] };
  assert.doesNotMatch(view.markdown, /<tg-button/u);
  assert.ok(view.rows.flat().some(button => button.id === "b24s:open:privacy"));
  const context = { type: "action", screen: "a".repeat(32), revision: 0, eventId: "select" };
  const confirmation = await call({ ...context, actionId: "b24s:set:0:names" });
  const confirmView = confirmation.view as typeof view;
  const confirm = confirmView.rows.flat().find(button => button.id.startsWith("b24s:confirm:"))!;
  assert.ok(confirm);
  assert.equal((await f.store.read()).policy.people, "ids");
  const applied = await call({ ...context, revision: 1, eventId: "apply", actionId: confirm.id });
  assert.equal(applied.type, "show");
  assert.equal((await f.store.read()).policy.people, "names");
  const repeated = await f.client.callTool({ name: "bitrix24_screen", arguments: { event: { ...context, actionId: confirm.id } } });
  assert.equal(repeated.isError, true);
  assert.equal((await call({ ...context, actionId: "close" })).type, "close");
  // The conversational fallback stays usable on unpatched Iva.
  assert.equal((await f.client.callTool({ name: "bitrix24_settings", arguments: {} })).isError, undefined);
});
