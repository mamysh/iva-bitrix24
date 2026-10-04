import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, RESTRICTED_POLICY, LEGACY_POLICY, withPolicyLock, minimizeResult, policySchema } from "../src/settings.ts";
import { SettingsMenu } from "../src/settings-menu.ts";

async function fixture(t: test.TestContext, defaults = RESTRICTED_POLICY) {
  const root = await mkdtemp(join(tmpdir(), "bitrix-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root, "synthetic-owner", defaults);
  let now = 1_000_000;
  const menu = new SettingsMenu(store, { configured: false }, () => now);
  return { root, store, menu, advance: (ms: number) => { now += ms; } };
}
async function change(f: Awaited<ReturnType<typeof fixture>>, choice: string) {
  const offer = await f.menu.run({ reply: `b24s:set:${(await f.store.read()).revision}:${choice}` });
  assert.equal(offer.state, "confirmation_required");
  assert.ok("confirmReply" in offer);
  return offer as typeof offer & { confirmReply: string; cancelReply: string };
}

test("restricted onboarding, legacy upgrade and restart retain explicit policy", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.store.read()).policy, RESTRICTED_POLICY);
  assert.deepEqual((await new SettingsStore(f.root, "synthetic-owner").read()).policy, LEGACY_POLICY);
  const p = await change(f, "names");
  assert.deepEqual((await f.store.read()).policy, RESTRICTED_POLICY); // selection is not a commit
  await f.menu.run({ reply: p.confirmReply });
  const restarted = new SettingsStore(f.root, "synthetic-owner", LEGACY_POLICY);
  assert.equal((await restarted.read()).policy.people, "names");
  assert.equal((await restarted.read()).policy.mode, "read_only");
  assert.equal((await stat(join(f.root, "settings.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "task-writes"))).mode & 0o777, 0o700);
  await assert.rejects(f.menu.run({ reply: p.confirmReply }), /SETTINGS_OFFER_INVALID/u);
});

test("offers are exact, expiring, owner-bound, revision-bound and replaceable", async t => {
  const f = await fixture(t);
  const first = await change(f, "names");
  for (const reply of ["Да", "b24s:confirm:00000000-0000-4000-8000-000000000001", "b24s:set:0:invented", "iva_menu:r:o"]) await assert.rejects(f.menu.run({ reply }));
  const second = await change(f, "work");
  await assert.rejects(f.menu.run({ reply: first.confirmReply }), /SETTINGS_OFFER_INVALID/u);
  const otherOwner = new SettingsMenu(new SettingsStore(f.root, "another-owner"), { configured: false });
  await assert.rejects(otherOwner.run({ reply: second.confirmReply }), /SETTINGS_OFFER_INVALID/u);
  f.advance(11 * 60_000);
  await assert.rejects(f.menu.run({ reply: second.confirmReply }), /SETTINGS_OFFER_INVALID/u);
  const third = await change(f, "names");
  await withPolicyLock(f.root, () => f.store.commit(0, { ...RESTRICTED_POLICY, people: "work" }));
  await assert.rejects(f.menu.run({ reply: third.confirmReply }), /SETTINGS_CHANGED/u);
  await assert.rejects(f.menu.run({ reply: "b24s:set:0:write" }), /SETTINGS_CHANGED/u);
});

test("cancel leaves policy and pending task intact; a commit invalidates its preview", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "task-writes"));
  await writeFile(join(f.root, "task-writes", "active.json"), "synthetic-preview");
  const p = await change(f, "write");
  await f.menu.run({ reply: p.cancelReply });
  assert.equal(await readFile(join(f.root, "task-writes", "active.json"), "utf8"), "synthetic-preview");
  assert.deepEqual((await f.store.read()).policy, RESTRICTED_POLICY);
  const next = await change(f, "write");
  await f.menu.run({ reply: next.confirmReply });
  await assert.rejects(readFile(join(f.root, "task-writes", "active.json")), { code: "ENOENT" });
});

test("settings cannot change while the task writer holds the shared lock", async t => {
  const f = await fixture(t);
  const p = await change(f, "write");
  await withPolicyLock(f.root, async () => {
    await assert.rejects(f.menu.run({ reply: p.confirmReply }), /WRITE_BUSY/u);
    await assert.rejects(f.menu.run({ reply: "b24s:set:0:names" }), /WRITE_BUSY/u);
  });
  assert.equal((await f.store.read()).revision, 0);
  await f.menu.run({ reply: p.confirmReply });
  assert.equal((await f.store.read()).revision, 1);
});

test("corrupt or invalid stored settings fail closed; absent private data restricts writes", async t => {
  const f = await fixture(t);
  for (const value of ["{broken", JSON.stringify({ schema: 2 }), JSON.stringify({ schema: 1, revision: 0, policy: { ...LEGACY_POLICY, people: "ids" } })]) {
    await writeFile(join(f.root, "settings.json"), value);
    await assert.rejects(f.store.read(), /SETTINGS_INVALID/u);
    await assert.rejects(f.menu.run({}), /SETTINGS_INVALID/u);
  }
  const noData = new SettingsStore(undefined, "synthetic-owner");
  assert.deepEqual((await noData.read()).policy, RESTRICTED_POLICY);
  await assert.rejects(new SettingsMenu(noData, { configured: false }).run({ reply: "b24s:set:0:write" }), /WRITES_NOT_CONFIGURED/u);
  assert.equal(policySchema.safeParse({ ...RESTRICTED_POLICY, email: true }).success, false);
});

test("menu buttons navigate all sections, fit Telegram callbacks and diagnose metadata only", async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  const menu = new SettingsMenu(f.store, {
    configured: true,
    connectionCheck: async () => { calls.push("connection"); return { user: { name: "should-not-appear" } }; },
    capabilities: async () => { calls.push("scope"); return { grantedScopes: ["task", "user_brief", "im", "user_basic"] }; },
  });
  const all: string[] = [];
  for (const screen of ["home", "connection", "capabilities", "actions", "privacy"] as const) {
    const response = await menu.run({ reply: `b24s:open:${screen}` });
    all.push(response.markdown);
    assert.equal(response.state, "screen");
    assert.ok(!response.markdown.includes("should-not-appear"));
    assert.ok(!response.markdown.includes("iva_menu"));
    if (screen !== "home") assert.match(response.markdown, /data="b24s:open:home"/u);
  }
  const p = await change(f, "work"); all.push(p.markdown);
  const buttons = all.flatMap(md => [...md.matchAll(/data="([^"]+)"/gu)].map(match => match[1]!));
  assert.ok(buttons.length > 10);
  for (const callback of buttons) assert.ok(Buffer.byteLength(callback, "utf8") <= 64);
  assert.deepEqual(calls, ["connection", "connection", "scope"]);
  assert.match(all[0]!, /Webhook: работает/u);
  assert.match(all[2]!, /Права webhook не доказывают/u);
  assert.match(all[4]!, /не обезличивает/u);
  await assert.rejects(f.menu.run({ screen: "actions", reply: "b24s:open:home" }));
});

test("privacy projection strips structured employee fields without corrupting task text or IDs", () => {
  const input = { task: { responsibleId: "7", responsibleName: "PRIVATE_NAME", createdByName: "PRIVATE_NAME", title: "Free task text", groupName: "Project" }, user: { id: "7", name: "PRIVATE_NAME", lastName: "PRIVATE_NAME", admin: true }, people: [{ id: "7", name: "PRIVATE_NAME", email: "PRIVATE_EMAIL", departmentIds: ["4"], workPosition: "PRIVATE_POSITION" }], messages: [{ author: { id: "7", name: "PRIVATE_NAME" }, text: "Free task text" }], events: [{ actor: { name: "PRIVATE_NAME" }, from: "Free task text" }], items: [{ members: [{ id: "7", name: "PRIVATE_NAME" }], attachments: [{ name: "File name" }] }], departments: [{ id: "4", name: "PRIVATE_DEPARTMENT" }] };
  const minimal = JSON.stringify(minimizeResult(input, RESTRICTED_POLICY));
  for (const marker of ["PRIVATE_NAME", "PRIVATE_EMAIL", "PRIVATE_POSITION", "PRIVATE_DEPARTMENT"]) assert.ok(!minimal.includes(marker));
  for (const preserved of ["Free task text", "File name", "Project", '"id":"7"']) assert.ok(minimal.includes(preserved));
  const names = JSON.stringify(minimizeResult(input, { ...RESTRICTED_POLICY, people: "names" }));
  assert.ok(names.includes("PRIVATE_NAME")); assert.ok(!names.includes("PRIVATE_EMAIL")); assert.ok(!names.includes("PRIVATE_POSITION"));
  const work = JSON.stringify(minimizeResult(input, { ...RESTRICTED_POLICY, people: "work" }));
  assert.ok(work.includes("PRIVATE_POSITION")); assert.ok(!work.includes("PRIVATE_EMAIL"));
  assert.deepEqual(minimizeResult(input, LEGACY_POLICY), input);
});


test("choosing current defaults persists them; a later unchanged selection cancels an older offer", async t => {
  const f = await fixture(t);
  const saveDefaults = await change(f, "read");
  await f.menu.run({ reply: saveDefaults.confirmReply });
  assert.deepEqual((await new SettingsStore(f.root, "synthetic-owner", LEGACY_POLICY).read()).policy, RESTRICTED_POLICY);
  const pending = await change(f, "write");
  const unchanged = await f.menu.run({ reply: "b24s:set:1:read" });
  assert.equal(unchanged.state, "screen");
  await assert.rejects(f.menu.run({ reply: pending.confirmReply }), /SETTINGS_OFFER_INVALID/u);
  assert.equal((await f.store.read()).revision, 1);
});
