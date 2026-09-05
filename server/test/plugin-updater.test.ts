import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PluginUpdater, type UpdaterOperations } from "../src/plugin-updater.ts";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

async function world(
  t: TestContext,
  source = "mamysh/iva-bitrix24/plugin",
) {
  const home = await mkdtemp(join(tmpdir(), "iva-bitrix24-updater-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const data = join(home, "data");
  const root = join(data, "custom", "plugins", "bitrix24-read");
  const pluginData = join(data, "plugin-data", "bitrix24-read");
  await mkdir(root, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  await writeFile(join(root, "update-worker.mjs"), "// worker\n");
  await writeFile(
    join(data, "custom", "plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "bitrix24-read",
          source,
          ref: source.startsWith("/") ? "" : "HEAD",
          sha: source.startsWith("/") ? "" : OLD,
          enabled: true,
          trusted: true,
        },
      ],
    }),
  );
  return { data, root, pluginData };
}

function operations(
  calls: { command: string; args: readonly string[] }[],
  remote = NEW,
): Partial<UpdaterOperations> {
  return {
    now: () => new Date("2026-09-05T15:00:00.000Z"),
    token: () => "ABC123",
    exec: async (command, args) => {
      calls.push({ command, args });
      return command === "git"
        ? { stdout: `${remote}\tHEAD\n`, stderr: "" }
        : { stdout: "Running as unit test.service\n", stderr: "" };
    },
    fetch: async () =>
      new Response(
        JSON.stringify({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

test("checks the recorded Git source and creates a bounded confirmed offer", async (t) => {
  const paths = await world(t);
  const calls: { command: string; args: readonly string[] }[] = [];
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations(calls),
  );
  const result = (await updater.check()) as Record<string, unknown>;
  assert.equal(result.state, "available");
  assert.equal(result.currentSha, OLD);
  assert.equal(result.candidateSha, NEW);
  assert.equal(result.confirmation, `ОБНОВИТЬ ${NEW.slice(0, 12)}`);
  assert.deepEqual(calls[0], {
    command: "git",
    args: [
      "ls-remote",
      "--",
      "https://github.com/mamysh/iva-bitrix24.git",
      "HEAD",
      "HEAD^{}",
    ],
  });
});

test("refuses chat updates for a local folder source", async (t) => {
  const paths = await world(t, "./local-plugin");
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );
  const result = (await updater.check()) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.state, "local_source");
});

test("starts only the exact fresh offer in a transient systemd unit", async (t) => {
  const paths = await world(t);
  const calls: { command: string; args: readonly string[] }[] = [];
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations(calls),
  );
  await updater.check();
  await assert.rejects(
    updater.apply({ candidateSha: NEW, confirmation: "да" }),
    /UPDATE_CONFIRMATION_MISMATCH/u,
  );
  const started = (await updater.apply({
    candidateSha: NEW,
    confirmation: `ОБНОВИТЬ ${NEW.slice(0, 12)}`,
  })) as Record<string, unknown>;
  assert.equal(started.state, "started");
  const launch = calls.find(({ command }) => command === "systemd-run");
  assert.ok(launch);
  assert.ok(launch.args.includes("--user"));
  const jobs = join(paths.pluginData, "update-jobs");
  const jobName = `${started.jobId}.json`;
  const job = JSON.parse(await readFile(join(jobs, jobName), "utf8"));
  assert.equal(job.previousSha, OLD);
  assert.equal(job.expectedSha, NEW);
  await assert.rejects(
    updater.apply({
      candidateSha: NEW,
      confirmation: `ОБНОВИТЬ ${NEW.slice(0, 12)}`,
    }),
    /UPDATE_ALREADY_RUNNING/u,
  );
});

test("reports current without creating an update offer", async (t) => {
  const paths = await world(t);
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([], OLD),
  );
  const result = (await updater.check()) as Record<string, unknown>;
  assert.equal(result.state, "current");
});

test("rechecks a moving remote ref immediately before apply", async (t) => {
  const paths = await world(t);
  let remote = NEW;
  const ops: Partial<UpdaterOperations> = {
    ...operations([]),
    exec: async (command: string) =>
      command === "git"
        ? { stdout: `${remote}\tHEAD\n`, stderr: "" }
        : { stdout: "", stderr: "" },
  };
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    ops,
  );
  await updater.check();
  remote = "3".repeat(40);
  await assert.rejects(
    updater.apply({
      candidateSha: NEW,
      confirmation: `ОБНОВИТЬ ${NEW.slice(0, 12)}`,
    }),
    /REMOTE_CHANGED_SINCE_CHECK/u,
  );
});
