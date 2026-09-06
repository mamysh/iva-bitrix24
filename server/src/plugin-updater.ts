import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PLUGIN_NAME = "bitrix24-read";
const SHA = /^[a-f0-9]{40}$/u;
const OFFER_TTL_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const JOB_START_TIMEOUT_MS = 2 * 60 * 1000;

type PluginEntry = {
  readonly name?: unknown;
  readonly source?: unknown;
  readonly ref?: unknown;
  readonly sha?: unknown;
  readonly enabled?: unknown;
  readonly trusted?: unknown;
};

type GitSource = {
  readonly label: string;
  readonly url: string;
  readonly base: string;
  readonly ref: string;
  readonly owner: string;
  readonly repo: string;
};

type Offer = {
  readonly schema: "iva-bitrix24-update-offer/v1";
  readonly createdAt: string;
  readonly currentSha: string;
  readonly candidateSha: string;
  readonly confirmation: string;
  readonly source: string;
  readonly sourceBase: string;
  readonly ref: string;
};

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
};

export type UpdaterOperations = {
  readonly exec: (
    command: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => Promise<CommandResult>;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly token: () => string;
};

export type ApplyUpdateInput = {
  readonly candidateSha: string;
  readonly confirmation: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSha(value: unknown): string {
  return typeof value === "string" && SHA.test(value) ? value : "";
}

function sourceFromEntry(entry: PluginEntry): GitSource | null {
  if (typeof entry.source !== "string" || !entry.source) return null;
  const raw = entry.source;
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../"))
    return null;
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)*(?:@([A-Za-z0-9._/-]+))?$/u.exec(
    raw,
  );
  if (!shorthand) return null;
  const owner = shorthand[1]!;
  const repo = shorthand[2]!;
  const sourceRef = shorthand[3];
  const stateRef = typeof entry.ref === "string" && entry.ref ? entry.ref : "HEAD";
  const at = raw.indexOf("@");
  const base = at === -1 ? raw : raw.slice(0, at);
  return {
    label: base,
    url: `https://github.com/${owner}/${repo}.git`,
    base,
    ref: sourceRef || stateRef,
    owner,
    repo,
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export class PluginUpdater {
  readonly #root: string;
  readonly #data: string;
  readonly #state: string;
  readonly #jobs: string;
  readonly #offer: string;
  readonly #operations: UpdaterOperations;

  constructor(
    env: Readonly<Record<string, string | undefined>> = process.env,
    operations: Partial<UpdaterOperations> = {},
  ) {
    this.#root = resolve(env.PLUGIN_ROOT || "");
    this.#data = resolve(env.PLUGIN_DATA || "");
    const plugins = dirname(this.#root);
    const custom = dirname(plugins);
    const dataDir = dirname(custom);
    if (
      !env.PLUGIN_ROOT ||
      !env.PLUGIN_DATA ||
      basename(this.#root) !== PLUGIN_NAME ||
      basename(plugins) !== "plugins" ||
      basename(custom) !== "custom"
    ) {
      throw new Error("UPDATE_ENVIRONMENT_UNAVAILABLE");
    }
    this.#state = join(dataDir, "custom", "plugins.json");
    this.#jobs = join(this.#data, "update-jobs");
    this.#offer = join(this.#data, "update-offer.json");
    this.#operations = {
      exec: async (command, args, environment) => {
        const result = await execFile(command, [...args], {
          timeout: 20_000,
          maxBuffer: 256_000,
          env: { ...process.env, ...environment },
        });
        return { stdout: result.stdout, stderr: result.stderr };
      },
      fetch: globalThis.fetch,
      now: () => new Date(),
      token: () => randomBytes(3).toString("hex").toUpperCase(),
      ...operations,
    };
  }

  async #entry(): Promise<PluginEntry> {
    const parsed: unknown = JSON.parse(await readFile(this.#state, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins))
      throw new Error("PLUGIN_STATE_INVALID");
    const entry = parsed.plugins.find(
      (item) => isRecord(item) && item.name === PLUGIN_NAME,
    );
    if (!isRecord(entry)) throw new Error("PLUGIN_NOT_INSTALLED");
    return entry;
  }

  async #acquireLock(path: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await open(path, "wx", 0o600);
        await lock.writeFile(`${this.#operations.now().toISOString()}\n`, "utf8");
        await lock.close();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = this.#operations.now().getTime() - (await stat(path)).mtimeMs;
        if (attempt === 0 && age > LOCK_STALE_MS) {
          await rm(path, { force: true });
          continue;
        }
        throw new Error("UPDATE_ALREADY_RUNNING");
      }
    }
  }

  async #remoteSha(source: GitSource): Promise<string> {
    const { stdout } = await this.#operations.exec("git", [
      "ls-remote",
      "--",
      source.url,
      source.ref,
      `${source.ref}^{}`,
    ]);
    const candidates = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter(([sha]) => SHA.test(sha || ""));
    const peeled = candidates.find(([, name]) => name?.endsWith("^{}"));
    const candidate = (peeled ?? candidates[0])?.[0] ?? "";
    if (!SHA.test(candidate)) throw new Error("REMOTE_REF_NOT_FOUND");
    return candidate;
  }

  async #ci(source: GitSource, sha: string): Promise<"success" | "pending" | "failure"> {
    const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/actions/runs?head_sha=${sha}&per_page=20`;
    const response = await this.#operations.fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "iva-bitrix24-updater" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("CI_STATUS_UNAVAILABLE");
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.workflow_runs))
      throw new Error("CI_STATUS_INVALID");
    const runs = body.workflow_runs.filter(isRecord);
    if (runs.some((run) => run.status !== "completed")) return "pending";
    return runs.length > 0 && runs.every((run) => run.conclusion === "success")
      ? "success"
      : "failure";
  }

  async check(): Promise<unknown> {
    const entry = await this.#entry();
    const source = sourceFromEntry(entry);
    if (!source) {
      await rm(this.#offer, { force: true });
      return {
        ok: false,
        state: "local_source",
        message:
          "Этот экземпляр установлен из локальной папки и не может проверять GitHub. Один раз переустановите его из mamysh/iva-bitrix24/plugin.",
      };
    }
    const currentSha = safeSha(entry.sha);
    if (!currentSha) throw new Error("CURRENT_SHA_UNAVAILABLE");
    const candidateSha = await this.#remoteSha(source);
    if (candidateSha === currentSha) {
      await rm(this.#offer, { force: true });
      return {
        ok: true,
        state: "current",
        source: source.label,
        ref: source.ref,
        currentSha,
        enabled: entry.enabled === true,
        trusted: entry.trusted === true,
      };
    }
    const ci = await this.#ci(source, candidateSha);
    const confirmation = `ОБНОВИТЬ ${candidateSha.slice(0, 12)}`;
    const offer: Offer = {
      schema: "iva-bitrix24-update-offer/v1",
      createdAt: this.#operations.now().toISOString(),
      currentSha,
      candidateSha,
      confirmation,
      source: entry.source as string,
      sourceBase: source.base,
      ref: source.ref,
    };
    await mkdir(this.#data, { recursive: true, mode: 0o700 });
    if (ci === "success") await atomicJson(this.#offer, offer);
    else await rm(this.#offer, { force: true });
    return {
      ok: true,
      state: ci === "success" ? "available" : "blocked",
      source: source.label,
      ref: source.ref,
      currentSha,
      candidateSha,
      ci,
      ...(ci === "success" ? { confirmation } : {}),
    };
  }

  async apply(input: ApplyUpdateInput): Promise<unknown> {
    const lockPath = join(this.#data, "update.lock");
    try {
      const lockInfo = await stat(lockPath);
      const age = this.#operations.now().getTime() - lockInfo.mtimeMs;
      if (age <= LOCK_STALE_MS) throw new Error("UPDATE_ALREADY_RUNNING");
      await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#offer, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("UPDATE_CHECK_REQUIRED");
      throw new Error("UPDATE_OFFER_INVALID");
    }
    if (!isRecord(parsed) || parsed.schema !== "iva-bitrix24-update-offer/v1")
      throw new Error("UPDATE_OFFER_INVALID");
    const offer = parsed as Offer;
    const age = this.#operations.now().getTime() - Date.parse(offer.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > OFFER_TTL_MS)
      throw new Error("UPDATE_OFFER_EXPIRED");
    if (input.candidateSha !== offer.candidateSha || input.confirmation !== offer.confirmation)
      throw new Error("UPDATE_CONFIRMATION_MISMATCH");
    const entry = await this.#entry();
    if (safeSha(entry.sha) !== offer.currentSha)
      throw new Error("PLUGIN_CHANGED_SINCE_CHECK");
    const source = sourceFromEntry(entry);
    if (!source || (await this.#remoteSha(source)) !== offer.candidateSha)
      throw new Error("REMOTE_CHANGED_SINCE_CHECK");
    if ((await this.#ci(source, offer.candidateSha)) !== "success")
      throw new Error("CI_NOT_SUCCESSFUL");
    const jobId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    await mkdir(this.#jobs, { recursive: true, mode: 0o700 });
    const jobPath = join(this.#jobs, `${jobId}.json`);
    await this.#acquireLock(lockPath);
    await atomicJson(jobPath, {
      schema: "iva-bitrix24-update-job/v1",
      id: jobId,
      status: "queued",
      action: "update",
      createdAt: this.#operations.now().toISOString(),
      pluginName: PLUGIN_NAME,
      pluginData: this.#data,
      statePath: this.#state,
      previousSha: offer.currentSha,
      expectedSha: offer.candidateSha,
      source: offer.source,
      sourceBase: offer.sourceBase,
      ref: offer.ref,
      lockPath,
    });
    const worker = join(this.#root, "update-worker.mjs");
    const unit = `iva-bitrix24-update-${jobId}`;
    const uid = process.getuid?.();
    if (uid === undefined) {
      await rm(lockPath, { force: true });
      throw new Error("USER_SYSTEMD_UNAVAILABLE");
    }
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    const busAddress =
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDirectory}/bus`;
    try {
      await this.#operations.exec(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--no-block",
          `--unit=${unit}`,
          process.execPath,
          worker,
          jobPath,
        ],
        {
          XDG_RUNTIME_DIR: runtimeDirectory,
          DBUS_SESSION_BUS_ADDRESS: busAddress,
        },
      );
      await rm(this.#offer, { force: true });
    } catch {
      await rm(lockPath, { force: true });
      throw new Error("UPDATE_WORKER_LAUNCH_FAILED");
    }
    return {
      ok: true,
      state: "started",
      jobId,
      from: offer.currentSha,
      to: offer.candidateSha,
      message: "Обновление запущено отдельно и переживёт перезапуск MCP. Спросите Иву о статусе через минуту.",
    };
  }

  async status(): Promise<unknown> {
    let names: string[];
    try {
      names = await readdir(this.#jobs);
    } catch {
      return { ok: true, state: "never_run" };
    }
    const latest = names.filter((name) => name.endsWith(".json")).sort().at(-1);
    if (!latest) return { ok: true, state: "never_run" };
    const parsed: unknown = JSON.parse(await readFile(join(this.#jobs, latest), "utf8"));
    if (!isRecord(parsed)) throw new Error("UPDATE_JOB_INVALID");
    const allowed = [
      "id",
      "status",
      "action",
      "createdAt",
      "startedAt",
      "finishedAt",
      "previousSha",
      "expectedSha",
      "installedSha",
      "message",
      "rollbackStatus",
      "failureStage",
      "failureCode",
    ];
    const safe = Object.fromEntries(
      allowed.flatMap((key) => (key in parsed ? [[key, parsed[key]]] : [])),
    );
    const currentSha = safeSha((await this.#entry()).sha);
    const recordedSha = safeSha(parsed.installedSha);
    if (currentSha && recordedSha && currentSha !== recordedSha) {
      return {
        ...safe,
        status: "superseded",
        previousStatus: parsed.status,
        currentSha,
        message:
          "Состояние плагина изменилось после этой job; показан текущий установленный SHA.",
      };
    }
    if (parsed.status === "queued" && typeof parsed.createdAt === "string") {
      const queuedFor = this.#operations.now().getTime() - Date.parse(parsed.createdAt);
      if (Number.isFinite(queuedFor) && queuedFor > JOB_START_TIMEOUT_MS) {
        return {
          ...safe,
          status: "stalled",
          previousStatus: "queued",
          message:
            "Фоновый worker не начал работу вовремя; повторный запуск через shell запрещён.",
        };
      }
    }
    return safe;
  }
}
