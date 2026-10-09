import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { PanelsSettings, PANELS_VERSION } from "../src/panels-api.ts";
import { servePanels } from "../src/panels-main.ts";
import { SettingsMenu } from "../src/settings-menu.ts";
import { SettingsStore, RESTRICTED_POLICY, withPolicyLock } from "../src/settings.ts";
import { settingsFromEnvironment } from "../src/settings-environment.ts";
const base = { schema: "iva-panels/rpc-v1", plugin: "bitrix24-read", pluginVersion: PANELS_VERSION };
const token = (n: number) => n.toString(16).padStart(24, "0");
async function fixture(t: test.TestContext) {
  const data = await realpath(await mkdtemp(join(tmpdir(), "bitrix-panels-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new SettingsStore(data, "synthetic-owner", RESTRICTED_POLICY);
  let now = 1_000_000;
  const api = new PanelsSettings(store, () => now);
  const call = async (fields: object) => (await api.request({ ...base, ...fields })).result as Record<string, unknown>;
  return { data, store, api, call, advance: (ms: number) => { now += ms; } };
}

test("Panels prepares without effect, cancels, persists settings and receipt atomically, replays after restart", async t => {
  const f = await fixture(t);
  await mkdir(join(f.data, "task-writes"));
  await writeFile(join(f.data, "task-writes", "active.json"), "synthetic-draft");
  const offer = await f.call({ op: "prepare", action: "write", revision: 0, token: token(1) });
  assert.equal(offer.state, "offer");
  assert.equal((await f.store.read()).policy.mode, "read_only");
  assert.match(String(offer.summary), /Сейчас:[\s\S]*После подтверждения:/u);
  assert.equal((await f.call({ op: "cancel", token: token(1) })).state, "cancelled");
  assert.equal(await readFile(join(f.data, "task-writes", "active.json"), "utf8"), "synthetic-draft");
  assert.equal((await f.call({ op: "confirm", token: token(1) })).state, "cancelled");
  await f.call({ op: "prepare", action: "write", revision: 0, token: token(2) });
  const done = await f.call({ op: "confirm", token: token(2) });
  assert.equal(done.state, "done"); assert.equal(done.revision, 1);
  await assert.rejects(readFile(join(f.data, "task-writes", "active.json")), { code: "ENOENT" });
  assert.equal((await stat(join(f.data, "settings.json"))).mode & 0o777, 0o600);
  const document = JSON.parse(await readFile(join(f.data, "settings.json"), "utf8"));
  assert.deepEqual(document.panelsReceipts[token(2)], done);
  assert.equal(document.policy.mode, "confirmed_write");
  assert.equal("panelsReceipts" in await f.store.read(), false); // No recovery tokens enter MCP results.
  const restarted = new PanelsSettings(new SettingsStore(f.data, "synthetic-owner"));
  for (const op of ["confirm", "cancel", "status"]) assert.deepEqual((await restarted.request({ ...base, op, token: token(2) })).result, done);
  assert.equal((await f.store.read()).revision, 1);
});

test("same authoritative store, legacy edits invalidate offers and retain every terminal receipt", async t => {
  const f = await fixture(t);
  await f.call({ op: "prepare", action: "write", revision: 0, token: token(1) });
  const done = await f.call({ op: "confirm", token: token(1) });
  const menu = new SettingsMenu(f.store, { configured: false });
  const legacy = await menu.run({ reply: "b24s:set:1:names" });
  assert.ok("confirmReply" in legacy);
  await f.call({ op: "prepare", action: "upload-on", revision: 1, token: token(2) });
  await menu.run({ reply: legacy.confirmReply });
  assert.equal((await f.call({ op: "status", token: token(2) })).state, "cancelled");
  assert.equal((await f.call({ op: "confirm", token: token(2) })).state, "cancelled");
  assert.deepEqual(await f.call({ op: "status", token: token(1) }), done);
  assert.equal((await f.store.read()).policy.people, "names");
  const pending = await menu.run({ reply: "b24s:set:2:work" });
  assert.ok("confirmReply" in pending);
  await f.call({ op: "prepare", action: "read", revision: 2, token: token(3) });
  await f.call({ op: "confirm", token: token(3) });
  await assert.rejects(menu.run({ reply: pending.confirmReply }), /SETTINGS_CHANGED/u);
});

test("validation, competing proposals, CAS, expiry, owner change and shared writer lock fail closed", async t => {
  const f = await fixture(t);
  for (const fields of [{ op: "read", page: "home", extra: true }, { op: "prepare", action: "shell", token: token(1), revision: 0 }, { op: "confirm", token: "../settings" }, { op: "read", page: "home", pluginVersion: "0.9.0-rc.1" }]) await assert.rejects(f.call(fields));
  assert.equal((await f.call({ op: "prepare", action: "email-on", token: token(1), revision: 0 })).state, "rejected");
  assert.equal((await f.call({ op: "prepare", action: "write", token: token(1), revision: 99 })).state, "rejected");
  const offer = await f.call({ op: "prepare", action: "write", token: token(1), revision: 0 });
  assert.deepEqual(await f.call({ op: "prepare", action: "write", token: token(1), revision: 0 }), offer);
  assert.equal((await f.call({ op: "prepare", action: "names", token: token(2), revision: 0 })).state, "rejected");
  await assert.rejects(f.call({ op: "prepare", action: "read", token: token(1), revision: 0 }));
  await withPolicyLock(f.data, async () => { await assert.rejects(f.call({ op: "confirm", token: token(1) }), /WRITE_BUSY/u); });
  const other = new PanelsSettings(new SettingsStore(f.data, "other-owner"));
  assert.equal(((await other.request({ ...base, op: "confirm", token: token(1) })).result as { state: string }).state, "cancelled");
  f.advance(10 * 60_000);
  await f.api.expireOffers();
  assert.equal((await f.call({ op: "status", token: token(1) })).state, "cancelled");
  assert.equal((await f.call({ op: "confirm", token: token(1) })).state, "cancelled");
  assert.equal((await f.store.read()).revision, 0);
  await f.call({ op: "prepare", action: "names", token: token(2), revision: 0 });
  assert.equal((await f.call({ op: "confirm", token: token(2) })).state, "done");
});

test("status does not modify evidence; invalid storage and max revision cannot authorize changes", async t => {
  const f = await fixture(t);
  await f.call({ op: "prepare", action: "ids", token: token(1), revision: 0 });
  const path = join(f.data, "panels-offers", `${token(1)}.json`);
  const before = await readFile(path, "utf8");
  f.advance(11 * 60_000);
  assert.equal((await f.call({ op: "status", token: token(1) })).state, "offer");
  assert.equal(await readFile(path, "utf8"), before);
  await f.api.expireOffers();
  assert.equal((await f.call({ op: "status", token: token(1) })).state, "cancelled");
  f.advance(-11 * 60_000);
  assert.equal((await f.call({ op: "confirm", token: token(1) })).state, "cancelled");
  await writeFile(join(f.data, "settings.json"), JSON.stringify({ schema: 1, revision: 999999999999, policy: RESTRICTED_POLICY }));
  assert.equal((await f.call({ op: "prepare", action: "write", token: token(2), revision: 999999999999 })).state, "rejected");
  await writeFile(join(f.data, "settings.json"), "invalid");
  await assert.rejects(f.call({ op: "confirm", token: token(1) }), /SETTINGS_INVALID/u);
});

test("pages expose bounded global actions and no diagnostics, secret or portal calls", async t => {
  const f = await fixture(t);
  for (const page of ["home", "actions", "privacy"]) {
    const screen = await f.call({ op: "read", page });
    assert.equal(screen.state, "screen");
    assert.ok(String(screen.body).length <= 1500);
    const rows = screen.rows as Record<string, string>[][];
    assert.ok(rows.length <= 5);
    for (const row of rows) { assert.ok(row.length >= 1 && row.length <= 2); for (const button of row) assert.ok(button.label!.length <= 48); }
    assert.doesNotMatch(JSON.stringify(screen), /synthetic-owner|webhookBaseUrl|approvalToken|b24s:/u);
  }
  const legacy = settingsFromEnvironment({ PLUGIN_DATA: f.data, BITRIX24_WEBHOOK_BASE_URL: "https://portal.example.invalid/rest/123/synthetic" });
  const restricted = settingsFromEnvironment({ PLUGIN_DATA: f.data, BITRIX24_SETTINGS_DEFAULTS: "restricted", BITRIX24_WEBHOOK_BASE_URL: "https://portal.example.invalid/rest/123/synthetic" });
  assert.equal((await legacy.read()).policy.mode, "confirmed_write");
  assert.equal((await restricted.read()).policy.mode, "read_only");
  assert.equal(legacy.identity, restricted.identity);
});

function rpc(path: string, payload: unknown, route = "/panels/v1") {
  return new Promise<{ status: number; text: string }>((done, fail) => {
    const req = request({ socketPath: path, method: "POST", path: route, headers: { "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", part => { text += part; }); res.on("end", () => done({ status: res.statusCode!, text }));
    });
    req.on("error", fail); req.end(JSON.stringify(payload));
  });
}
test("real Unix socket serves strict RPC, permissions, lost response recovery and restart", async t => {
  const f = await fixture(t);
  let server = await servePanels(f.api);
  t.after(() => server.close());
  const path = join(f.data, "panels.sock");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await rpc(path, { ...base, op: "read", page: "home" })).status, 200);
  assert.equal((await rpc(path, { ...base, op: "read", page: "home", shell: "no" })).status, 400);
  assert.equal((await rpc(path, {}, "/arbitrary")).status, 404);
  await rpc(path, { ...base, op: "prepare", action: "write", revision: 0, token: token(1) });
  // Caller loses/ignores the confirm response; no replay needed to recover its receipt.
  await rpc(path, { ...base, op: "confirm", token: token(1) });
  await new Promise<void>(resolve => server.close(() => resolve()));
  server = await servePanels(new PanelsSettings(new SettingsStore(f.data, "synthetic-owner")));
  const status = JSON.parse((await rpc(path, { ...base, op: "status", token: token(1) })).text);
  assert.equal(status.result.state, "done"); assert.equal(status.result.revision, 1);
  assert.equal((await f.store.read()).revision, 1);
});

test("socket startup refuses unexpected files and symlinked private data", async t => {
  const f = await fixture(t);
  await writeFile(join(f.data, "panels.sock"), "preserve");
  await assert.rejects(servePanels(f.api), /UNSAFE_SOCKET/u);
  assert.equal(await readFile(join(f.data, "panels.sock"), "utf8"), "preserve");
  const link = `${f.data}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(f.data, link);
  await assert.rejects(servePanels(new PanelsSettings(new SettingsStore(link, "synthetic-owner"))), /CANONICAL/u);
});

test("managed service reads only its own private env, preserves Iva paths and matches MCP defaults", async t => {
  const f = await fixture(t);
  const { panelsEnvironment } = await import("../src/panels-main.ts");
  await mkdir(join(f.data, "custom", "plugins"), { recursive: true });
  const path = join(f.data, "custom", "plugins", "bitrix24-read.env");
  await writeFile(path, 'BITRIX24_WEBHOOK_BASE_URL="https://portal.example.invalid/rest/123/synthetic"\nBITRIX24_SETTINGS_DEFAULTS=legacy\nPLUGIN_DATA=/arbitrary\nNODE_OPTIONS=--arbitrary\n', { mode: 0o600 });
  const env = await panelsEnvironment({ IVA_DATA_DIR: f.data, PLUGIN_DATA: f.data });
  assert.equal(env.PLUGIN_DATA, f.data);
  assert.equal("NODE_OPTIONS" in env, false);
  const serviceStore = settingsFromEnvironment(env);
  assert.equal((await serviceStore.read()).policy.mode, "confirmed_write");
  assert.equal(serviceStore.identity, settingsFromEnvironment({ ...env }).identity);
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o644);
  await assert.rejects(panelsEnvironment({ IVA_DATA_DIR: f.data, PLUGIN_DATA: f.data }), /PLUGIN_ENV_UNAVAILABLE/u);
  await rm(path);
  assert.equal((await settingsFromEnvironment(await panelsEnvironment({ IVA_DATA_DIR: f.data, PLUGIN_DATA: f.data })).read()).policy.mode, "read_only");
});
