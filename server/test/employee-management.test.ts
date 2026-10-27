import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BitrixClient } from "../src/bitrix-client.ts";
import { loadConfig } from "../src/config.ts";
import {
  EmployeeDirectory,
  approximateMatch,
} from "../src/employee-directory.ts";
import {
  EmployeeManager,
  employeeDraftInputSchema,
} from "../src/employee-management.ts";
import {
  SettingsStore,
  LEGACY_POLICY,
  withPolicyLock,
} from "../src/settings.ts";
import { PanelsSettings, PANELS_VERSION } from "../src/panels-api.ts";
import { servePanels } from "../src/panels-main.ts";
import { serverFromEnvironment } from "../src/main.ts";

type Raw = Record<string, unknown>;
const base = {
  schema: "iva-panels/rpc-v1",
  plugin: "bitrix24-read",
  pluginVersion: PANELS_VERSION,
};
const token = (n = 1) => n.toString(16).padStart(24, "0");
const person = {
  ID: "7",
  NAME: "Иван",
  LAST_NAME: "Иванов",
  EMAIL: "ivan@example.test",
  WORK_POSITION: "Дизайнер",
  UF_DEPARTMENT: [2],
  ACTIVE: true,
};
async function fixture(t: test.TestContext) {
  const data = await realpath(await mkdtemp(join(tmpdir(), "emp-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new SettingsStore(data, "https://portal.example.test/123", {
    ...LEGACY_POLICY,
    employees: true,
  });
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({
      schema: 1,
      revision: 0,
      policy: { ...LEGACY_POLICY, employees: true },
    }),
    { mode: 0o600 },
  );
  const people: Raw[] = [structuredClone(person)];
  const departments: Raw[] = [
    { ID: "1", NAME: "Компания", PARENT: "0" },
    { ID: "2", NAME: "Отдел дизайна", PARENT: "1" },
    { ID: "3", NAME: "Сектор дизайна", PARENT: "1" },
  ];
  const calls: Array<{ method: string; params: Raw }> = [];
  let scopes = ["user", "department"];
  let intercept:
    | ((method: string, params: Raw) => Promise<Response | undefined>)
    | undefined;
  const fetcher: typeof globalThis.fetch = async (url, init) => {
    const method = new URL(String(url)).pathname
      .split("/")
      .at(-1)!
      .replace(/\.json$/u, "");
    const params = JSON.parse(String(init?.body)) as Raw;
    calls.push({ method, params });
    const overridden = await intercept?.(method, params);
    if (overridden) return overridden;
    if (method === "scope") return Response.json({ result: scopes });
    if (method === "department.get") {
      const all = params.ID
        ? departments.filter((d) => Number(d.ID) === params.ID)
        : departments.slice(Number(params.start ?? 0));
      return Response.json({ result: all });
    }
    if (method === "user.get") {
      const filter = (params.FILTER ?? {}) as Raw;
      const result = people
        .filter(
          (p) =>
            (!filter.ID || Number(p.ID) === filter.ID) &&
            (!filter.EMAIL ||
              String(p.EMAIL).toLowerCase() ===
                String(filter.EMAIL).toLowerCase()),
        )
        .slice(Number(params.start ?? 0));
      return Response.json({ result });
    }
    if (method === "user.add") {
      const created = { ...structuredClone(person), ...params, ID: "20" };
      people.push(created);
      return Response.json({ result: 20 });
    }
    if (method === "user.update") {
      Object.assign(people.find((p) => Number(p.ID) === params.ID)!, params);
      return Response.json({ result: true });
    }
    throw new Error("Unexpected method");
  };
  const client = new BitrixClient(
    loadConfig({
      BITRIX24_WEBHOOK_BASE_URL:
        "https://portal.example.test/rest/123/synthetic",
    }),
    { fetch: fetcher },
  );
  let now = 1_000_000;
  const directory = new EmployeeDirectory(client, store);
  const manager = new EmployeeManager(directory, store, () => now);
  const panels = new PanelsSettings(store, () => now, manager);
  const rpc = async (input: Raw) =>
    (await panels.request({ ...base, ...input })).result as Raw;
  const collect = () =>
    manager.request({
      op: "collect",
      action: "invite",
      fields: {
        name: "Анна",
        lastName: "Тестова",
        email: "anna@example.test",
        departmentIds: [2],
        position: "Дизайнер",
      },
    });
  const preview = async () => {
    const d = await collect();
    return manager.request({
      op: "preview",
      draftId: d.draftId,
      version: d.version,
    });
  };
  const approve = async (d: Awaited<ReturnType<typeof preview>>, n = 1) => {
    const screen = await manager.screen();
    const offer = await rpc({
      op: "prepare",
      action: `emp-${d.draftId}`,
      revision: screen.revision,
      token: token(n),
    });
    assert.equal(offer.state, "offer");
    assert.equal((await rpc({ op: "confirm", token: token(n) })).state, "done");
  };
  return {
    data,
    store,
    people,
    departments,
    calls,
    directory,
    manager,
    panels,
    rpc,
    collect,
    preview,
    approve,
    fetcher,
    advance: (ms: number) => {
      now += ms;
    },
    intercept: (v: typeof intercept) => {
      intercept = v;
    },
    scopes: (v: string[]) => {
      scopes = v;
    },
    writes: () =>
      calls.filter((c) => ["user.add", "user.update"].includes(c.method)),
  };
}

test("incomplete requests accumulate email/selection in either order; corrections require a new preview and version", async (t) => {
  const f = await fixture(t);
  let d = await f.manager.request({
    op: "collect",
    action: "invite",
    fields: { name: "Иван", lastName: "Иванов" },
  });
  assert.deepEqual(d.missing, ["email", "departmentIds"]);
  const untouched = await f.manager.request({
    op: "preview",
    draftId: d.draftId,
    version: d.version,
  });
  assert.equal(untouched.state, "collecting");
  const old = d;
  d = await f.manager.request({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: { departmentIds: [3] },
  });
  assert.deepEqual(d.missing, ["email"]);
  await assert.rejects(
    f.manager.request({
      op: "collect",
      draftId: old.draftId,
      version: old.version,
      fields: { email: "test@example.test" },
    }),
    /EMPLOYEE_DRAFT_CHANGED/u,
  );
  d = await f.manager.request({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: { email: "new@example.test" },
  });
  assert.equal(d.fields.name, "Иван");
  d = await f.manager.request({
    op: "preview",
    draftId: d.draftId,
    version: d.version,
  });
  assert.equal(d.state, "ready");
  assert.match(d.summary!, /Компания \/ Сектор дизайна/u);
  const screen = await f.manager.screen();
  await f.rpc({
    op: "prepare",
    action: `emp-${d.draftId}`,
    revision: screen.revision,
    token: token(),
  });
  d = await f.manager.request({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: { position: "Арт-директор" },
  });
  assert.equal(d.state, "collecting");
  assert.equal(d.summary, undefined);
  assert.equal(
    (await f.rpc({ op: "confirm", token: token() })).state,
    "cancelled",
  );
  assert.equal(f.writes().length, 0);
});

test("approximate lookup returns actual IDs/paths, two suitable departments, typo matches and incomplete scans", async (t) => {
  const f = await fixture(t);
  assert.equal(approximateMatch("Иванова Ивана", "Иван Иванов"), true);
  const found = await f.directory.lookup({
    kind: "departments",
    query: "дизайн",
  });
  assert.equal(found.items.length, 2);
  assert.equal(found.complete, true);
  assert.ok(
    found.items.every((v) => "path" in v && v.path.startsWith("Компания /")),
  );
  f.people.push({ ...person, ID: "8", EMAIL: "another@example.test" });
  assert.equal(
    (await f.directory.lookup({ kind: "people", query: "Иванов" })).items
      .length,
    2,
  );
  for (let i = 0; i < 11; i++) f.people.push({ ...person, ID: String(30 + i) });
  const partial = await f.directory.lookup({
    kind: "people",
    query: "нетсовпадений",
  });
  assert.equal(partial.items.length, 0);
  assert.equal(partial.complete, false);
  assert.equal(partial.nextStart, 10);
  const later = await f.directory.lookup({
    kind: "people",
    query: "Иванов",
    start: 10,
  });
  assert.equal(later.items.length, 3);
  assert.equal(later.complete, true);
});

test("final Panels approval queues once, worker writes position in invitation and verifies profile; restart/replay never resends", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  assert.equal(f.writes().length, 0);
  assert.doesNotMatch(JSON.stringify(d), /token|fingerprint|portal\.example/u);
  await f.approve(d);
  assert.equal(f.writes().length, 0);
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).state,
    "queued",
  );
  await f.manager.runQueued();
  const status = await f.manager.request({ op: "status", draftId: d.draftId });
  assert.equal(status.state, "applied");
  assert.equal(status.userId, 20);
  assert.equal(f.writes()[0]!.params.WORK_POSITION, "Дизайнер");
  const restarted = new EmployeeManager(f.directory, f.store);
  await restarted.runQueued();
  const panels = new PanelsSettings(f.store, Date.now, restarted);
  for (const op of ["confirm", "cancel", "status"])
    assert.equal(
      ((await panels.request({ ...base, op, token: token() })).result as Raw)
        .state,
      "done",
    );
  assert.equal(f.writes().length, 1);
  assert.equal(
    (await stat(join(f.data, "employees.json"))).mode & 0o777,
    0o600,
  );
});

test("update shows before/after; changing department needs explicit replace/add, and add preserves memberships", async (t) => {
  const f = await fixture(t);
  let d = await f.manager.request({
    op: "collect",
    action: "update",
    fields: { userId: 7, departmentIds: [3], position: "Ведущий дизайнер" },
  });
  assert.deepEqual(d.missing, ["departmentMode"]);
  d = await f.manager.request({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: { departmentMode: "add" },
  });
  d = await f.manager.request({
    op: "preview",
    draftId: d.draftId,
    version: d.version,
  });
  assert.match(d.summary!, /Дизайнер → Ведущий дизайнер/u);
  await f.approve(d);
  await f.manager.runQueued();
  assert.deepEqual(f.writes()[0]!.params.UF_DEPARTMENT, [2, 3]);
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).state,
    "applied",
  );
});

test("same employee update does not invite, name/email/position edits and explicit clearing remain bounded", async (t) => {
  const f = await fixture(t);
  let d = await f.manager.request({
    op: "collect",
    action: "update",
    fields: {
      userId: 7,
      email: "updated@example.test",
      name: "Иван",
      lastName: "Тестов",
      position: null,
    },
  });
  d = await f.manager.request({
    op: "preview",
    draftId: d.draftId,
    version: d.version,
  });
  await f.approve(d);
  await f.manager.runQueued();
  assert.equal(f.writes()[0]!.method, "user.update");
  assert.equal(f.writes()[0]!.params.WORK_POSITION, "");
  assert.equal(f.people[0]!.EMAIL, "updated@example.test");
});

test("duplicate email, missing department, cycle, inactive employee and insufficient scopes prevent writes", async (t) => {
  const f = await fixture(t);
  let d = await f.collect();
  d = await f.manager.request({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: { email: "ivan@example.test" },
  });
  await assert.rejects(
    f.manager.request({
      op: "preview",
      draftId: d.draftId,
      version: d.version,
    }),
    /EMPLOYEE_EMAIL_EXISTS/u,
  );
  d = await f.manager.request({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: { email: "new@example.test", departmentIds: [999] },
  });
  await assert.rejects(
    f.manager.request({
      op: "preview",
      draftId: d.draftId,
      version: d.version,
    }),
    /DEPARTMENT_NOT_FOUND/u,
  );
  f.departments[1]!.PARENT = "2";
  await assert.rejects(f.directory.department(2), /DEPARTMENT_PATH_INVALID/u);
  f.people[0]!.ACTIVE = false;
  let update = await f.manager.request({
    op: "collect",
    action: "update",
    fields: { userId: 7, position: "Тест" },
  });
  await assert.rejects(
    f.manager.request({
      op: "preview",
      draftId: update.draftId,
      version: update.version,
    }),
    /EMPLOYEE_INACTIVE/u,
  );
  f.scopes(["user_basic", "department"]);
  update = await f.manager.request({
    op: "collect",
    action: "update",
    fields: { userId: 7, position: "Тест" },
  });
  await assert.rejects(
    f.manager.request({
      op: "preview",
      draftId: update.draftId,
      version: update.version,
    }),
    (e) => (e as { requiredScope: string }).requiredScope === "user",
  );
  assert.equal(f.writes().length, 0);
});

test("cancellation, stale revision, expiry, unknown field and choice never authorize a write", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  assert.equal(
    (
      await f.rpc({
        op: "prepare",
        action: `emp-${d.draftId}`,
        revision: 999,
        token: token(),
      })
    ).state,
    "rejected",
  );
  const screen = await f.manager.screen();
  await f.rpc({
    op: "prepare",
    action: `emp-${d.draftId}`,
    revision: screen.revision,
    token: token(),
  });
  f.advance(10 * 60_000);
  assert.equal(
    (await f.rpc({ op: "confirm", token: token() })).state,
    "cancelled",
  );
  assert.equal(
    (await f.rpc({ op: "confirm", token: token() })).state,
    "cancelled",
  );
  const cancelled = await f.manager.request({
    op: "cancel",
    draftId: d.draftId,
    version: d.version,
  });
  assert.equal(cancelled.state, "cancelled");
  for (const input of [
    { op: "apply", draftId: d.draftId },
    { op: "collect", action: "dismiss", fields: {} },
    { op: "collect", action: "update", fields: { userId: 7, ACTIVE: false } },
    { op: "collect", action: "invite", fields: { email: "bad" } },
  ])
    assert.equal(employeeDraftInputSchema.safeParse(input).success, false);
  await f.manager.runQueued();
  assert.equal(f.writes().length, 0);
});

test("policy changes invalidate approval and queued job; privacy off hides draft screens and all MCP employee data", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  await f.approve(d);
  await withPolicyLock(f.data, () =>
    f.store.commit(0, {
      ...LEGACY_POLICY,
      employees: false,
      people: "ids",
      email: false,
    }),
  );
  const screen = await f.manager.screen();
  assert.doesNotMatch(screen.body, /Анна|Тестова|anna@example/u);
  await assert.rejects(
    f.manager.request({ op: "status", draftId: d.draftId }),
    /EMPLOYEE_PROFILE_REQUIRED/u,
  );
  await f.manager.runQueued();
  assert.equal(f.writes().length, 0);
});

test("external employee or department edits between preview and execution reject without mutation", async (t) => {
  const f = await fixture(t);
  let d = await f.manager.request({
    op: "collect",
    action: "update",
    fields: { userId: 7, position: "Тест" },
  });
  d = await f.manager.request({
    op: "preview",
    draftId: d.draftId,
    version: d.version,
  });
  await f.approve(d);
  f.people[0]!.WORK_POSITION = "Изменено другим администратором";
  await f.manager.runQueued();
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).code,
    "EMPLOYEE_CHANGED_SINCE_PREVIEW",
  );
  const invite = await f.preview();
  await f.approve(invite, 2);
  f.departments[1]!.NAME = "Другое название";
  await f.manager.runQueued();
  assert.equal(f.writes().length, 0);
});

test("lost write response never retries or allows a conflicting new invitation", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  await f.approve(d);
  f.intercept(async (method) => {
    if (method === "user.add") {
      f.people.push({
        ...person,
        ID: "20",
        NAME: "Анна",
        LAST_NAME: "Тестова",
        EMAIL: "anna@example.test",
      });
      throw new TypeError("synthetic network loss");
    }
    return undefined;
  });
  await f.manager.runQueued();
  await f.manager.runQueued();
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).state,
    "unknown",
  );
  assert.equal(f.writes().length, 1);
  const next = await f.collect();
  await assert.rejects(
    f.manager.request({
      op: "preview",
      draftId: next.draftId,
      version: next.version,
    }),
    /EMPLOYEE_CONFLICTING_DRAFT/u,
  );
});

test("readback mismatch/denial and crash after saved intent preserve uncertainty without replay", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  await f.approve(d);
  f.intercept(async (method) =>
    method === "user.add" ? Response.json({ result: 20 }) : undefined,
  );
  await f.manager.runQueued();
  const unknown = await f.manager.request({ op: "status", draftId: d.draftId });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.userId, 20);
  const doc = JSON.parse(
    await readFile(join(f.data, "employees.json"), "utf8"),
  );
  doc.drafts[d.draftId].state = "running";
  await writeFile(join(f.data, "employees.json"), JSON.stringify(doc));
  await new EmployeeManager(f.directory, f.store).runQueued();
  assert.equal(f.writes().length, 1);
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).state,
    "unknown",
  );
});

test("separate drafts survive restart; one update does not overwrite another and busy/corrupt state fails closed", async (t) => {
  const f = await fixture(t);
  const a = await f.collect();
  const b = await f.manager.request({
    op: "collect",
    action: "update",
    fields: { userId: 7, position: "Тест" },
  });
  const restarted = new EmployeeManager(f.directory, f.store);
  assert.equal(
    (await restarted.request({ op: "status", draftId: a.draftId })).fields
      .email,
    "anna@example.test",
  );
  assert.equal(
    (await restarted.request({ op: "status", draftId: b.draftId })).fields
      .position,
    "Тест",
  );
  await withPolicyLock(f.data, () =>
    assert.rejects(f.collect(), /WRITE_BUSY/u),
  );
  await writeFile(join(f.data, "employees.json"), "invalid");
  await assert.rejects(f.collect(), /EMPLOYEE_STORAGE_INVALID/u);
  assert.equal(f.writes().length, 0);
});

test("actual MCP discovers strict draft schema, collects across calls, rejects apply/hidden fields, and never leaks Panels token", async (t) => {
  const f = await fixture(t);
  const server = await serverFromEnvironment(
    {
      PLUGIN_DATA: f.data,
      BITRIX24_WEBHOOK_BASE_URL:
        "https://portal.example.test/rest/123/synthetic",
    },
    { fetch: f.fetcher },
  );
  const client = new Client({ name: "employee-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((t) => t.name === "bitrix24_employee_draft"));
  const draftSchema=tools.find(t=>t.name==="bitrix24_employee_draft")!.inputSchema as unknown as {properties:{op:{enum:string[]};fields:unknown}};
  assert.deepEqual(draftSchema.properties.op.enum,["collect","preview","present","cancel","status"]);
  assert.ok(draftSchema.properties.fields);
  assert.ok(
    !tools.some((t) => /employee.*apply|apply.*employee/u.test(t.name)),
  );
  const call = (args: Raw) =>
    client.callTool({ name: "bitrix24_employee_draft", arguments: args });
  const first = await call({
    op: "collect",
    action: "invite",
    fields: { name: "Анна" },
  });
  assert.equal(first.isError, undefined);
  const parsed = JSON.parse((first.content as { text: string }[])[0]!.text);
  assert.ok(parsed.missing.includes("email"));
  for (const args of [
    { op: "apply", draftId: parsed.draftId },
    { op: "collect", draftId: parsed.draftId, fields: {} },
    { op: "collect", action: "invite", fields: { password: "test" } },
  ])
    assert.equal((await call(args)).isError, true);
  assert.doesNotMatch(JSON.stringify(first), /token|fingerprint|synthetic/u);
  assert.equal(f.writes().length, 0);
});

test("real socket approval queues a synthetic job, worker executes once, health port never accepts RPC", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  const server = await servePanels(f.panels);
  t.after(() => server.close());
  const rpc = (fields: Raw) =>
    new Promise<Raw>((done, fail) => {
      const req = request(
        {
          socketPath: join(f.data, "panels.sock"),
          method: "POST",
          path: "/panels/v1",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (part) => {
            body += part;
          });
          res.on("end", () => {
            try {
              assert.equal(res.statusCode, 200);
              done(JSON.parse(body).result);
            } catch (e) {
              fail(e);
            }
          });
        },
      );
      req.on("error", fail);
      req.end(JSON.stringify({ ...base, ...fields }));
    });
  const screen = await rpc({ op: "read", page: "employees" });
  assert.equal(
    (
      await rpc({
        op: "prepare",
        action: `emp-${d.draftId}`,
        revision: screen.revision,
        token: token(),
      })
    ).state,
    "offer",
  );
  const approved = await rpc({ op: "confirm", token: token() });
  assert.equal(approved.state, "done");
  assert.match(String(approved.message), /ещё не подтверждение/u);
  await f.manager.runQueued();
  assert.equal((await rpc({ op: "status", token: token() })).state, "done");
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).state,
    "applied",
  );
  assert.equal(f.writes().length, 1);
});

test("expired proposals are cancelled durably for Panels recovery; expired drafts can be cancelled without blocking new work", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  const screen = await f.manager.screen();
  await f.rpc({
    op: "prepare",
    action: `emp-${d.draftId}`,
    revision: screen.revision,
    token: token(),
  });
  f.advance(31 * 60_000);
  await f.manager.expireOffers();
  assert.equal(
    (await f.rpc({ op: "status", token: token() })).state,
    "cancelled",
  );
  assert.equal(
    (
      await f.manager.request({
        op: "cancel",
        draftId: d.draftId,
        version: d.version,
      })
    ).state,
    "cancelled",
  );
  assert.equal((await f.preview()).state, "ready");
  assert.equal(f.writes().length, 0);
});

test("read-only and opt-in gates block even complete requests; restoring work fields does not silently enable employees", async (t) => {
  const f = await fixture(t);
  await withPolicyLock(f.data, () =>
    f.store.commit(0, { ...LEGACY_POLICY, employees: false }),
  );
  await assert.rejects(f.collect(), /EMPLOYEES_DISABLED/u);
  await withPolicyLock(f.data, () =>
    f.store.commit(1, { ...LEGACY_POLICY, employees: true, mode: "read_only" }),
  );
  await assert.rejects(f.collect(), /READ_ONLY_MODE/u);
  const fresh = new SettingsStore(
    join(f.data, "new"),
    "synthetic-owner",
    LEGACY_POLICY,
  );
  assert.notEqual((await fresh.read()).policy.employees, true);
  assert.equal(f.writes().length, 0);
});

test("a portal denial is reported and a malformed invitation success cannot be mistaken for a user ID", async (t) => {
  const f = await fixture(t);
  const denied = await f.preview();
  await f.approve(denied);
  f.intercept(async (method) =>
    method === "user.add"
      ? Response.json({
          error: "ACCESS_DENIED",
          error_description: "private detail",
        })
      : undefined,
  );
  await f.manager.runQueued();
  assert.equal(
    (await f.manager.request({ op: "status", draftId: denied.draftId })).state,
    "rejected",
  );
  const next = await f.preview();
  await f.approve(next, 2);
  f.intercept(async (method) =>
    method === "user.add" ? Response.json({ result: true }) : undefined,
  );
  await f.manager.runQueued();
  const status = await f.manager.request({
    op: "status",
    draftId: next.draftId,
  });
  assert.equal(status.state, "unknown");
  assert.doesNotMatch(JSON.stringify(status), /private detail/u);
});

test("candidate search rechecks privacy after requests and propagates permission errors instead of empty matches", async (t) => {
  const f = await fixture(t);
  let once = false;
  f.intercept(async (method) => {
    if (method === "user.get" && !once) {
      once = true;
      await withPolicyLock(f.data, () =>
        f.store.commit(0, {
          ...LEGACY_POLICY,
          employees: true,
          people: "ids",
          email: false,
        }),
      );
    }
    return undefined;
  });
  await assert.rejects(
    f.directory.lookup({ kind: "people", query: "Иван" }),
    /EMPLOYEE_PROFILE_REQUIRED/u,
  );
  await withPolicyLock(f.data, () =>
    f.store.commit(1, { ...LEGACY_POLICY, employees: true }),
  );
  f.intercept(async (method, params) =>
    method === "department.get" && params.ID
      ? Response.json({ error: "ACCESS_DENIED" })
      : undefined,
  );
  await assert.rejects(
    f.directory.lookup({ kind: "departments", query: "дизайн" }),
    /ACCESS_DENIED/u,
  );
});

test("a successful write followed by readback access denial stays unknown, never 'not performed'", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  await f.approve(d);
  f.intercept(async (method, params) =>
    method === "user.get" && (params.FILTER as Raw)?.ID === 20
      ? Response.json({ error: "ACCESS_DENIED" })
      : undefined,
  );
  await f.manager.runQueued();
  const status = await f.manager.request({ op: "status", draftId: d.draftId });
  assert.equal(status.state, "unknown");
  assert.equal(status.userId, 20);
  assert.equal(f.writes().length, 1);
});

test("a draft expiring during preflight never sends a mutation", async (t) => {
  const f = await fixture(t);
  const d = await f.preview();
  await f.approve(d);
  f.intercept(async (method) => {
    if (method === "scope") f.advance(31 * 60_000);
    return undefined;
  });
  await f.manager.runQueued();
  assert.equal(
    (await f.manager.request({ op: "status", draftId: d.draftId })).code,
    "EMPLOYEE_DRAFT_EXPIRED",
  );
  assert.equal(f.writes().length, 0);
});

test("present validates the saved preview but does not change its revision, queue or portal",async t=>{
 const f=await fixture(t);const collecting=await f.collect();
 await assert.rejects(()=>f.manager.request({op:'present',draftId:collecting.draftId,version:collecting.version}),/EMPLOYEE_DRAFT_CHANGED/);
 const ready=await f.manager.request({op:'preview',draftId:collecting.draftId,version:collecting.version});
 const before=await readFile(f.manager.path(),'utf8');
 const shown=await f.manager.request({op:'present',draftId:ready.draftId,version:ready.version});
 assert.equal(shown.state,'ready');assert.equal(await readFile(f.manager.path(),'utf8'),before);
 assert.equal(f.calls.filter(c=>c.method==='user.add'||c.method==='user.update').length,0);
 await assert.rejects(()=>f.manager.request({op:'present',draftId:ready.draftId,version:ready.version-1}),/EMPLOYEE_DRAFT_CHANGED/);
});
