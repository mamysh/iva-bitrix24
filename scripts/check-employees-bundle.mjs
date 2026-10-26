import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serverFromEnvironment } from "../plugin/server.mjs";
import {
  createPanelsApi,
  servePanels,
} from "../plugin/sh.iva/services/panels/server.mjs";

const data = await realpath(await mkdtemp("/tmp/be-"));
const env = {
  PLUGIN_DATA: data,
  BITRIX24_WEBHOOK_BASE_URL: "https://portal.example.test/rest/123/synthetic",
  BITRIX24_SETTINGS_DEFAULTS: "restricted",
};
const version = JSON.parse(
  await readFile("plugin/plugin.json", "utf8"),
).version;
const envelope = {
  schema: "iva-panels/rpc-v1",
  plugin: "bitrix24-read",
  pluginVersion: version,
};
const people = [];
let writes = 0;
const fetcher = async (url, init) => {
  const method = new URL(String(url)).pathname
    .split("/")
    .at(-1)
    .replace(/\.json$/u, "");
  const params = JSON.parse(String(init.body));
  if (method === "scope")
    return Response.json({ result: ["user", "department"] });
  if (method === "department.get")
    return Response.json({
      result: [{ ID: "1", NAME: "Synthetic design", PARENT: "0" }],
    });
  if (method === "user.get")
    return Response.json({
      result: people.filter(
        (p) =>
          (!params.FILTER?.ID || Number(p.ID) === params.FILTER.ID) &&
          (!params.FILTER?.EMAIL || p.EMAIL === params.FILTER.EMAIL),
      ),
    });
  if (method === "user.add") {
    writes++;
    people.push({ ID: "20", ...params, ACTIVE: true });
    return Response.json({ result: 20 });
  }
  throw new Error("UNEXPECTED_SYNTHETIC_METHOD");
};
const api = createPanelsApi(env, { fetch: fetcher });
let socket, server, client;
const rpc = (fields) =>
  new Promise((done, fail) => {
    const req = request(
      {
        socketPath: join(data, "panels.sock"),
        method: "POST",
        path: "/panels/v1",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
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
    req.end(JSON.stringify({ ...envelope, ...fields }));
  });
try {
  // Synthetic setup is explicit; normal upgrades never enable employee management.
  await mkdir(data, { recursive: true });
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({
      schema: 1,
      revision: 0,
      policy: {
        mode: "confirmed_write",
        uploads: false,
        deletions: false,
        people: "work",
        email: true,
        employees: true,
      },
    }),
    { mode: 0o600 },
  );
  socket = await servePanels(api);
  server = await serverFromEnvironment(env, { fetch: fetcher });
  client = new Client({ name: "employee-bundle-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((t) => t.name === "bitrix24_employee_draft"));
  assert.ok(
    !tools.some((t) => /employee.*apply|apply.*employee/u.test(t.name)),
  );
  const draftCall = async (fields) => {
    const response = await client.callTool({
      name: "bitrix24_employee_draft",
      arguments: fields,
    });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  let d = await draftCall({
    op: "collect",
    action: "invite",
    fields: { name: "Synthetic", lastName: "Example" },
  });
  assert.deepEqual(d.missing, ["email", "departmentIds"]);
  d = await draftCall({
    op: "collect",
    draftId: d.draftId,
    version: d.version,
    fields: {
      email: "synthetic@example.test",
      departmentIds: [1],
      position: "Designer",
    },
  });
  d = await draftCall({
    op: "preview",
    draftId: d.draftId,
    version: d.version,
  });
  assert.equal(writes, 0);
  const screen = await rpc({ op: "read", page: "employees" });
  const token = "01".repeat(12);
  const offer = await rpc({
    op: "prepare",
    action: `emp-${d.draftId}`,
    revision: screen.revision,
    token,
  });
  assert.equal(offer.state, "offer");
  assert.match(offer.summary, /Designer/u);
  const accepted = await rpc({ op: "confirm", token });
  assert.equal(accepted.state, "done");
  assert.match(accepted.message, /ещё не подтверждение/u);
  await api.employees.runQueued();
  assert.equal(
    (await draftCall({ op: "status", draftId: d.draftId })).state,
    "applied",
  );
  assert.equal(people[0].WORK_POSITION, "Designer");
  for (const op of ["confirm", "cancel", "status"])
    assert.deepEqual(await rpc({ op, token }), accepted);
  await api.employees.runQueued();
  assert.equal(writes, 1);
  console.log(
    "employee bundles ok: actual built MCP + private socket, incomplete draft, final approval, queue/readback/replay; fake Bitrix only",
  );
} finally {
  if (socket) await new Promise((done) => socket.close(done));
  await client?.close();
  await server?.close();
  await rm(data, { recursive: true, force: true });
}
