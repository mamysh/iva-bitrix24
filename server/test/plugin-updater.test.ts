import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PluginUpdater, type UpdaterOperations } from "../src/plugin-updater.ts";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const OLD_VERSION = "0.4.0-rc.3";
const NEW_VERSION = "0.4.0";

type TestCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
};

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
    join(root, "plugin.json"),
    JSON.stringify({ name: "bitrix24-read", version: OLD_VERSION }),
  );
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
  calls: TestCall[],
  remote = NEW,
  fetches: string[] = [],
): Partial<UpdaterOperations> {
  return {
    now: () => new Date("2026-09-05T15:00:00.000Z"),
    token: () => "ABC123ABC123ABC123ABC123",
    exec: async (command, args, environment) => {
      calls.push({ command, args, ...(environment ? { environment } : {}) });
      return command === "git"
        ? { stdout: `${remote}\tHEAD\n`, stderr: "" }
        : { stdout: "Running as unit test.service\n", stderr: "" };
    },
    fetch: async (input) => {
      const url = String(input);
      fetches.push(url);
      return url.startsWith("https://raw.githubusercontent.com/")
        ? new Response(
            JSON.stringify({ name: "bitrix24-read", version: NEW_VERSION }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
    },
  };
}

test("checks the recorded Git source and creates a bounded button-approval offer", async (t) => {
  const paths = await world(t);
  const calls: TestCall[] = [];
  const fetches: string[] = [];
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations(calls, NEW, fetches),
  );
  const result = (await updater.check()) as Record<string, unknown>;
  assert.equal(result.state, "available");
  assert.equal(result.currentSha, OLD);
  assert.equal(result.candidateSha, NEW);
  assert.equal(result.currentVersion, OLD_VERSION);
  assert.equal(result.candidateVersion, NEW_VERSION);
  assert.equal(result.approvalToken, "ABC123ABC123ABC123ABC123");
  assert.deepEqual(result.approvalPrompt, {
    prompt: [
      "⬆️ Доступно обновление плагина Bitrix24",
      "",
      `v${OLD_VERSION} → v${NEW_VERSION}`,
      "Источник: mamysh/iva-bitrix24/plugin @HEAD",
      "CI: success ✅",
      "Настройки и локальные данные будут сохранены.",
    ].join("\n"),
    options: [
      { id: "update", label: "⬆️ Обновить" },
      { id: "later", label: "Позже" },
    ],
    allowFreeform: false,
  });
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
  assert.deepEqual(fetches, [
    `https://raw.githubusercontent.com/mamysh/iva-bitrix24/${NEW}/plugin/plugin.json`,
    `https://api.github.com/repos/mamysh/iva-bitrix24/actions/runs?head_sha=${NEW}&per_page=20`,
  ]);
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

test("refuses missing or invalid semantic versions", async (t) => {
  const paths = await world(t);
  await writeFile(
    join(paths.root, "plugin.json"),
    JSON.stringify({ name: "bitrix24-read", version: "latest" }),
  );
  const invalidCurrent = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );
  await assert.rejects(invalidCurrent.check(), /CURRENT_VERSION_UNAVAILABLE/u);

  await writeFile(
    join(paths.root, "plugin.json"),
    JSON.stringify({ name: "bitrix24-read", version: OLD_VERSION }),
  );
  const base = operations([]);
  const invalidCandidate = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    {
      ...base,
      fetch: async (input, init) =>
        String(input).startsWith("https://raw.githubusercontent.com/")
          ? new Response(JSON.stringify({ name: "bitrix24-read", version: "latest" }))
          : base.fetch!(input, init),
    },
  );
  await assert.rejects(invalidCandidate.check(), /CANDIDATE_VERSION_UNAVAILABLE/u);
});

test("does not expose approval data or retain an offer when CI fails", async (t) => {
  const paths = await world(t);
  const successful = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );
  await successful.check();

  const calls: TestCall[] = [];
  const base = operations(calls);
  const blocked = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    {
      ...base,
      fetch: async (input) =>
        String(input).startsWith("https://raw.githubusercontent.com/")
          ? new Response(
              JSON.stringify({ name: "bitrix24-read", version: NEW_VERSION }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          : new Response(
              JSON.stringify({
                workflow_runs: [{ status: "completed", conclusion: "failure" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
    },
  );
  const result = (await blocked.check()) as Record<string, unknown>;
  assert.equal(result.state, "blocked");
  assert.equal(result.ci, "failure");
  assert.equal("approvalToken" in result, false);
  assert.equal("approvalPrompt" in result, false);
  await assert.rejects(
    blocked.apply({
      candidateSha: NEW,
      approvalToken: "ABC123ABC123ABC123ABC123",
    }),
    /UPDATE_CHECK_REQUIRED/u,
  );
});

test("starts only the exact fresh offer in a transient systemd unit", async (t) => {
  const paths = await world(t);
  const calls: TestCall[] = [];
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations(calls),
  );
  await updater.check();
  await assert.rejects(
    updater.apply({ candidateSha: NEW, approvalToken: "0".repeat(24) }),
    /UPDATE_APPROVAL_MISMATCH/u,
  );
  const started = (await updater.apply({
    candidateSha: NEW,
    approvalToken: "ABC123ABC123ABC123ABC123",
  })) as Record<string, unknown>;
  assert.equal(started.state, "started");
  const launch = calls.find(({ command }) => command === "systemd-run");
  assert.ok(launch);
  assert.ok(launch.args.includes("--user"));
  assert.ok(launch.args.includes("--no-block"));
  assert.match(launch.environment?.XDG_RUNTIME_DIR ?? "", /^\/run\/user\/\d+$/u);
  assert.match(
    launch.environment?.DBUS_SESSION_BUS_ADDRESS ?? "",
    /^unix:path=\/run\/user\/\d+\/bus$/u,
  );
  const jobs = join(paths.pluginData, "update-jobs");
  const jobName = `${started.jobId}.json`;
  const job = JSON.parse(await readFile(join(jobs, jobName), "utf8"));
  assert.equal(job.previousSha, OLD);
  assert.equal(job.expectedSha, NEW);
  assert.equal(job.previousVersion, OLD_VERSION);
  assert.equal(job.expectedVersion, NEW_VERSION);
  assert.equal(started.fromVersion, OLD_VERSION);
  assert.equal(started.toVersion, NEW_VERSION);
  await assert.rejects(
    updater.apply({
      candidateSha: NEW,
      approvalToken: "ABC123ABC123ABC123ABC123",
    }),
    /UPDATE_ALREADY_RUNNING/u,
  );
});

test("rejects a locally corrupted version in a saved offer", async (t) => {
  const paths = await world(t);
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );
  await updater.check();
  const offerPath = join(paths.pluginData, "update-offer.json");
  const offer = JSON.parse(await readFile(offerPath, "utf8"));
  offer.candidateVersion = "latest\nunsafe";
  await writeFile(offerPath, JSON.stringify(offer));

  await assert.rejects(
    updater.apply({
      candidateSha: NEW,
      approvalToken: "ABC123ABC123ABC123ABC123",
    }),
    /UPDATE_OFFER_INVALID/u,
  );
});

test("normalizes a user-systemd launch failure and releases its lock", async (t) => {
  const paths = await world(t);
  const calls: TestCall[] = [];
  const base = operations(calls);
  const baseExec = base.exec!;
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    {
      ...base,
      exec: async (command, args, environment) => {
        if (command === "systemd-run") throw new Error("unsafe bus details");
        return baseExec(command, args, environment);
      },
    },
  );
  await updater.check();
  await assert.rejects(
    updater.apply({
      candidateSha: NEW,
      approvalToken: "ABC123ABC123ABC123ABC123",
    }),
    /UPDATE_WORKER_LAUNCH_FAILED/u,
  );
  await assert.rejects(
    readFile(join(paths.pluginData, "update.lock")),
    /ENOENT/u,
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
  assert.equal(result.currentVersion, OLD_VERSION);
});

test("does not offer a new repository commit with the same semantic version", async (t) => {
  const paths = await world(t);
  const fetches: string[] = [];
  const base = operations([], NEW, fetches);
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    {
      ...base,
      fetch: async (input, init) =>
        String(input).startsWith("https://raw.githubusercontent.com/")
          ? new Response(
              JSON.stringify({ name: "bitrix24-read", version: OLD_VERSION }),
            )
          : base.fetch!(input, init),
    },
  );
  const result = (await updater.check()) as Record<string, unknown>;
  assert.equal(result.state, "current");
  assert.equal(result.currentVersion, OLD_VERSION);
  assert.deepEqual(fetches, []);
  await assert.rejects(
    updater.apply({ candidateSha: NEW, approvalToken: "0".repeat(24) }),
    /UPDATE_CHECK_REQUIRED/u,
  );
});

test("does not offer an older semantic version from a moved ref", async (t) => {
  const paths = await world(t);
  await writeFile(
    join(paths.root, "plugin.json"),
    JSON.stringify({ name: "bitrix24-read", version: NEW_VERSION }),
  );
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );
  const result = (await updater.check()) as Record<string, unknown>;
  assert.equal(result.state, "current");
  assert.equal(result.currentVersion, NEW_VERSION);
});

test("reports a stale terminal job as superseded by current plugin state", async (t) => {
  const paths = await world(t);
  const jobs = join(paths.pluginData, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(
    join(jobs, "100-test.json"),
    JSON.stringify({
      id: "100-test",
      status: "failed",
      installedSha: NEW,
      expectedSha: NEW,
      message: "old result",
    }),
  );
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );

  const result = (await updater.status()) as Record<string, unknown>;
  assert.equal(result.status, "superseded");
  assert.equal(result.previousStatus, "failed");
  assert.equal(result.currentSha, OLD);
  assert.equal(result.currentVersion, OLD_VERSION);
  assert.equal(String(result.message).includes("old result"), false);
});

test("reports a queued job that never started as stalled", async (t) => {
  const paths = await world(t);
  const jobs = join(paths.pluginData, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(
    join(jobs, "100-test.json"),
    JSON.stringify({
      id: "100-test",
      status: "queued",
      createdAt: "2026-09-05T14:57:00.000Z",
      previousSha: OLD,
      expectedSha: NEW,
      message: "queued",
    }),
  );
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );

  const result = (await updater.status()) as Record<string, unknown>;
  assert.equal(result.status, "stalled");
  assert.equal(result.previousStatus, "queued");
  assert.equal(result.currentVersion, OLD_VERSION);
  assert.equal(String(result.message).includes("shell"), true);
});

test("adds the installed semantic version to a legacy completed job", async (t) => {
  const paths = await world(t);
  const jobs = join(paths.pluginData, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(
    join(jobs, "100-test.json"),
    JSON.stringify({
      id: "100-test",
      status: "succeeded",
      installedSha: OLD,
      expectedSha: OLD,
      message: "legacy result",
    }),
  );
  const updater = new PluginUpdater(
    { PLUGIN_ROOT: paths.root, PLUGIN_DATA: paths.pluginData },
    operations([]),
  );

  const result = (await updater.status()) as Record<string, unknown>;
  assert.equal(result.status, "succeeded");
  assert.equal(result.currentVersion, OLD_VERSION);
  assert.equal(result.installedVersion, OLD_VERSION);
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
      approvalToken: "ABC123ABC123ABC123ABC123",
    }),
    /REMOTE_CHANGED_SINCE_CHECK/u,
  );
});
