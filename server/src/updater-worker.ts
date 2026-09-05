import { execFileSync } from "node:child_process";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

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
  execFileSync("iva", args, {
    stdio: "pipe",
    timeout: 20 * 60 * 1000,
    maxBuffer: 2_000_000,
    env: process.env,
  });
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
  job.status = "running";
  job.startedAt = new Date().toISOString();
  await save(jobPath, job);
  try {
    run(["plugin", "update", job.pluginName]);
    const sha = await installedSha(job);
    if (sha !== job.expectedSha) throw new Error("installed SHA does not match the checked candidate");
    run(["doctor"]);
    job.status = "succeeded";
    job.installedSha = sha;
    job.message = "Плагин обновлён, штатная диагностика Iva прошла.";
  } catch {
    job.status = "failed";
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
