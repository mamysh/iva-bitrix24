import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

async function fixture(
  t: import("node:test").TestContext,
  mode: "success" | "doctor-failure" | "update-failure",
) {
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix24-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, ".local", "bin");
  const statePath = join(root, "plugins.json");
  const counter = join(root, "doctor-count");
  const lockPath = join(root, "update.lock");
  const jobPath = join(root, "job.json");
  await mkdir(bin, { recursive: true });
  await writeFile(lockPath, "locked\n", { mode: 0o600 });
  await writeFile(
    statePath,
    JSON.stringify({ plugins: [{ name: "bitrix24-read", sha: OLD }] }),
  );
  const fake = `#!${process.execPath}
const fs = require("node:fs");
const [a,b,c] = process.argv.slice(2);
const statePath = process.env.TEST_STATE;
const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
if (a === "plugin" && b === "update") {
  if (process.env.TEST_MODE === "update-failure") process.exit(1);
  const s=state(); s.plugins[0].sha=process.env.TEST_NEW; save(s); process.exit(0);
}
if (a === "doctor") {
  const n=Number(fs.existsSync(process.env.TEST_COUNTER) ? fs.readFileSync(process.env.TEST_COUNTER,"utf8") : "0")+1;
  fs.writeFileSync(process.env.TEST_COUNTER,String(n));
  process.exit(process.env.TEST_MODE === "doctor-failure" && n === 1 ? 1 : 0);
}
if (a === "plugin" && b === "remove") { save({plugins:[]}); process.exit(0); }
if (a === "plugin" && b === "add") { const sha=c.slice(c.lastIndexOf("@")+1); save({plugins:[{name:"bitrix24-read",sha}]}); process.exit(0); }
process.exit(2);
`;
  const iva = join(bin, "iva");
  await writeFile(iva, fake);
  await chmod(iva, 0o755);
  await writeFile(
    jobPath,
    JSON.stringify({
      schema: "iva-bitrix24-update-job/v1",
      id: "test",
      status: "queued",
      action: "update",
      pluginName: "bitrix24-read",
      statePath,
      previousSha: OLD,
      expectedSha: NEW,
      sourceBase: "mamysh/iva-bitrix24/plugin",
      lockPath,
    }),
  );
  const result = spawnSync(process.execPath, ["server/src/updater-worker.ts", jobPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      PATH: process.env.PATH || "/usr/bin:/bin",
      IVA_BITRIX24_WORKER_DELAY_MS: "0",
      TEST_STATE: statePath,
      TEST_NEW: NEW,
      TEST_COUNTER: counter,
      TEST_MODE: mode,
    },
  });
  return { result, job: JSON.parse(await readFile(jobPath, "utf8")), lockPath };
}

test("worker verifies the installed SHA and doctor", async (t) => {
  const done = await fixture(t, "success");
  assert.equal(done.result.status, 0, done.result.stderr);
  assert.equal(done.job.status, "succeeded");
  assert.equal(done.job.installedSha, NEW);
  await assert.rejects(readFile(done.lockPath), /ENOENT/u);
});

test("worker restores the previous SHA when doctor fails", async (t) => {
  const done = await fixture(t, "doctor-failure");
  assert.equal(done.result.status, 0, done.result.stderr);
  assert.equal(done.job.status, "rolled_back");
  assert.equal(done.job.rollbackStatus, "succeeded");
  assert.equal(done.job.installedSha, OLD);
  assert.equal(done.job.failureStage, "iva_doctor");
  assert.equal(done.job.failureCode, "IVA_CLI_FAILED");
  await assert.rejects(readFile(done.lockPath), /ENOENT/u);
});

test("worker leaves the previous version installed when update fails before moving", async (t) => {
  const done = await fixture(t, "update-failure");
  assert.equal(done.result.status, 0, done.result.stderr);
  assert.equal(done.job.status, "failed");
  assert.equal(done.job.rollbackStatus, "not_needed");
  assert.equal(done.job.installedSha, OLD);
  assert.equal(done.job.failureStage, "plugin_update");
  assert.equal(done.job.failureCode, "IVA_CLI_FAILED");
  await assert.rejects(readFile(done.lockPath), /ENOENT/u);
});
