import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = await realpath(await mkdtemp("/tmp/bp-"));
const plugin = JSON.parse(await readFile("plugin/plugin.json", "utf8"));
const descriptor = JSON.parse(await readFile("plugin/panels.json", "utf8"));
assert.deepEqual(descriptor, { schema: "iva-panels/v2", plugin: plugin.name, pluginVersion: plugin.version, entry: "home", capabilities: ["settings"] });
const reserve = createServer();
await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port;
await new Promise(done => reserve.close(done));
const data = join(root, "plugin-data", plugin.name);
await mkdir(data, { recursive: true, mode: 0o700 });
await mkdir(join(root, "custom", "plugins"), { recursive: true });
await writeFile(join(root, "custom", "plugins", `${plugin.name}.env`), "BITRIX24_SETTINGS_DEFAULTS=restricted\n", { mode: 0o600 });
const env = { PATH: process.env.PATH ?? "", IVA_DATA_DIR: root, PLUGIN_DATA: data, IVA_SERVICE_PORT: String(port) };
const folder = resolve("plugin/sh.iva/services/panels");
const launch = () => process.platform === "linux" ? spawn("bash", ["launch.sh"], { cwd: folder, env, stdio: "pipe" }) : spawn(process.execPath, [join(folder, "server.mjs")], { env, stdio: "pipe" });
let child, exited;
async function start() {
  child = launch(); exited = once(child, "exit");
  child.stdout.resume(); child.stderr.resume();
  for (let i = 0; ; i++) {
    try { assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200); break; }
    catch (error) { if (i > 100 || child.exitCode !== null) throw error; await new Promise(done => setTimeout(done, 25)); }
  }
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } }
const base = { schema: "iva-panels/rpc-v1", plugin: plugin.name, pluginVersion: plugin.version };
const token = n => String(n).padStart(24, "0");
async function rpc(fields) {
  const output = await new Promise((done, fail) => {
    const req = request({ socketPath: join(data, "panels.sock"), method: "POST", path: "/panels/v1", headers: { "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", part => { text += part; }); res.on("end", () => done({ code: res.statusCode, text }));
    });
    req.on("error", fail); req.end(JSON.stringify({ ...base, ...fields }));
  });
  assert.equal(output.code, 200);
  const value = JSON.parse(output.text);
  assert.equal(value.pluginVersion, plugin.version);
  return value.result;
}
try {
  await start();
  assert.equal((await stat(join(data, "panels.sock"))).mode & 0o777, 0o600);
  if (process.platform === "linux") {
    const competitor = launch(); competitor.stdout.resume(); competitor.stderr.resume();
    const [code] = await once(competitor, "exit"); assert.equal(code, 1);
  }
  assert.equal((await rpc({ op: "read", page: "home" })).state, "screen");
  assert.equal((await rpc({ op: "prepare", action: "write", revision: 0, token: token(1) })).state, "offer");
  assert.equal((await rpc({ op: "cancel", token: token(1) })).state, "cancelled");
  assert.equal((await rpc({ op: "prepare", action: "write", revision: 0, token: token(2) })).state, "offer");
  const done = await rpc({ op: "confirm", token: token(2) });
  assert.equal(done.state, "done"); assert.equal(done.revision, 1);
  await stop(); await start();
  for (const op of ["confirm", "cancel", "status"]) assert.deepEqual(await rpc({ op, token: token(2) }), done);
  // Actual built MCP reads the same policy, without exposing socket receipts.
  const client = new Client({ name: "panels-bundle-smoke", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("plugin/server.mjs")], env: { PATH: env.PATH, PLUGIN_DATA: data }, stderr: "pipe" }));
    const result = await client.callTool({ name: "bitrix24_settings", arguments: { screen: "actions" } });
    assert.equal(result.isError, undefined);
    const screen = JSON.parse(result.content[0].text);
    assert.equal(screen.settings.revision, 1);
    assert.equal(screen.settings.policy.mode, "confirmed_write");
    assert.equal("panelsReceipts" in screen.settings, false);
  } finally { await client.close(); }
  // API is never exposed on its health TCP port.
  assert.equal((await fetch(`http://127.0.0.1:${port}/panels/v1`, { method: "POST", body: JSON.stringify(base) })).status, 404);
  console.log("panels bundle ok: descriptor, managed service/socket, cancel/confirm/restart/receipt, shared MCP policy; no portal requests");
} finally { await stop(); await rm(root, { recursive: true, force: true }); }
