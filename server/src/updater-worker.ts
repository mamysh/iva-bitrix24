import { execFileSync } from "node:child_process";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { updateStartDelay } from "./updater-policy.ts";

const IVA_CLI = join(homedir(), ".local", "bin", "iva");

type Job = Record<string, unknown> & {
  schema: "iva-bitrix24-update-job/v1";
  pluginName: string;
  statePath: string;
  previousSha: string;
  expectedSha: string;
  sourceBase: string;
  lockPath?: string;
};

function run(args: string[]): void {
  try {
    execFileSync(IVA_CLI, args, {
      stdio: "pipe",
      timeout: 20 * 60 * 1000,
      maxBuffer: 2_000_000,
      env: process.env,
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { signal?: NodeJS.Signals };
    if (failure.code === "ENOENT") throw new Error("IVA_CLI_NOT_FOUND");
    if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM")
      throw new Error("IVA_CLI_TIMEOUT");
    throw new Error("IVA_CLI_FAILED");
  }
}

async function save(path: string, job: Job): Promise<void> {
  const temporary = `${path}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function installedSha(job: Job): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(job.statePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { plugins?: unknown }).plugins))
    return "";
  const entry = (parsed as { plugins: Record<string, unknown>[] }).plugins.find(
    (item) => item?.name === job.pluginName,
  );
  return typeof entry?.sha === "string" ? entry.sha : "";
}

async function rollback(job: Job): Promise<"succeeded" | "failed"> {
  if (!/^[a-f0-9]{40}$/u.test(job.previousSha)) return "failed";
  try {
    run(["plugin", "remove", job.pluginName]);
    run(["plugin", "add", `${job.sourceBase}@${job.previousSha}`, "--trust"]);
    run(["doctor"]);
    return (await installedSha(job)) === job.previousSha ? "succeeded" : "failed";
  } catch {
    return "failed";
  }
}

const jobPath = process.argv[2];
if (!jobPath) process.exit(2);
const job = JSON.parse(await readFile(jobPath, "utf8")) as Job;
try {
  // The MCP tool must return its accepted job before this worker restarts the
  // plugin proxy or rebuilds Iva. A detached unit survives that restart.
  await delay(updateStartDelay());
  job.status = "running";
  job.startedAt = new Date().toISOString();
  await save(jobPath, job);
  let stage = "plugin_update";
  try {
    run(["plugin", "update", job.pluginName]);
    stage = "sha_verification";
    const sha = await installedSha(job);
    if (sha !== job.expectedSha) throw new Error("SHA_MISMATCH");
    stage = "iva_doctor";
    run(["doctor"]);
    job.status = "succeeded";
    job.installedSha = sha;
    job.message = "Плагин обновлён, штатная диагностика Iva прошла.";
  } catch (error) {
    job.status = "failed";
    job.failureStage = stage;
    job.failureCode =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)
        ? error.message
        : "UPDATE_STEP_FAILED";
    const current = await installedSha(job);
    job.installedSha = current;
    if (current === job.expectedSha) {
      job.message = "Новая версия установилась, но не прошла диагностику; выполняется возврат предыдущей версии.";
      job.rollbackStatus = await rollback(job);
      if (job.rollbackStatus === "succeeded") {
        job.status = "rolled_back";
        job.installedSha = job.previousSha;
        job.message = "Новая версия не прошла проверку; предыдущий SHA восстановлен и проверен.";
      }
    } else if (current === job.previousSha) {
      job.rollbackStatus = "not_needed";
      job.message = "Обновление не применилось; предыдущая рабочая версия осталась на месте.";
    } else {
      job.rollbackStatus = "unsafe_state";
      job.message = "Обновление завершилось в неизвестном состоянии; автоматический remove/add не выполнялся.";
    }
  }
  job.finishedAt = new Date().toISOString();
  await save(jobPath, job);
} finally {
  if (typeof job.lockPath === "string") await rm(job.lockPath, { force: true });
}
