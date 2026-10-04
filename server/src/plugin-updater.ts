import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname, homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PLUGIN_NAME = "bitrix24-read";
const SHA = /^[a-f0-9]{40}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MANIFEST_LIMIT_BYTES = 64 * 1024;
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
  readonly pluginPath: string;
};

type Offer = {
  readonly schema: "iva-bitrix24-update-offer/v3";
  readonly createdAt: string;
  readonly currentSha: string;
  readonly candidateSha: string;
  readonly currentVersion: string;
  readonly candidateVersion: string;
  readonly approvalToken: string;
  readonly source: string;
  readonly sourceBase: string;
  readonly ref: string;
  readonly confirmationReply?: string | undefined;
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
  readonly hasLibreOffice: () => Promise<boolean>;
  readonly officeHost: (dataDir: string) => Promise<{ hostname: string; user: string; osId: string; aptGet: boolean; ivaPath: string | null }>;
};

async function executableOnPath(name: string): Promise<boolean> {
  const searchPath = process.env.PATH || ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
  for (const directory of searchPath.split(delimiter).filter(Boolean).slice(0, 64)) {
    try {
      const candidate = join(directory, name);
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue to the next PATH directory.
    }
  }
  return false;
}

function wrapperPath(source: string, name: "IVA_ROOT" | "IVA_DATA"): string | null {
  const raw = new RegExp(`^${name}="((?:\\\\.|[^"\\\\])*)"$`, "mu").exec(source)?.[1];
  if (!raw) return null;
  const path = raw.replace(/\\(["\\$`])/gu, "$1");
  return isAbsolute(path) && !/[\0\r\n]/u.test(path) ? path : null;
}

export async function verifiedIvaPath(dataDir: string, wrapper = join(homedir(), ".local", "bin", "iva")): Promise<string | null> {
  try {
    const source = await readFile(wrapper, "utf8");
    const root = wrapperPath(source, "IVA_ROOT");
    const data = wrapperPath(source, "IVA_DATA");
    if (!root || !data || await realpath(data) !== await realpath(dataDir)) return null;
    if (!(await stat(join(root, "current"))).isDirectory()) return null;
    return await realpath(root);
  } catch { return null; }
}

async function officeHost(dataDir: string) {
  let release = "";
  try { release = await readFile("/etc/os-release", "utf8"); } catch { /* Non-Linux host. */ }
  const osId = /^ID=["']?([a-z0-9_-]+)["']?$/mu.exec(release)?.[1] || "unknown";
  const aptTools = await Promise.all([executableOnPath("apt-get"), executableOnPath("apt-cache")]);
  const aptPackages = aptTools.every(Boolean) && (await Promise.all(
    ["libreoffice-impress-nogui", "libreoffice-writer-nogui", "libreoffice-calc-nogui"].map(async (name) => {
      try {
        await execFile("apt-cache", ["show", name], { timeout: 5_000, maxBuffer: 64_000 });
        return true;
      } catch { return false; }
    }),
  )).every(Boolean);
  return {
    hostname: hostname(),
    user: userInfo().username,
    osId,
    aptGet: aptPackages,
    ivaPath: await verifiedIvaPath(dataDir),
  };
}

function officeRenderer(available: boolean, root: string, host: Awaited<ReturnType<typeof officeHost>>) {
  const command = !available && host.ivaPath && host.aptGet && ["ubuntu", "debian"].includes(host.osId)
    ? "sudo apt-get update && sudo apt-get install -y --no-install-recommends libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui"
    : undefined;
  return {
    available,
    neededFor: ["ppt", "pptx", "office_visual_analysis"],
    ...(!available ? {
      installAction: command ? "run_command_on_iva_server" : "ask_server_administrator",
      server: { hostname: host.hostname, user: host.user, ivaPath: host.ivaPath, pluginPath: root, osId: host.osId },
      ...(command ? { command } : {}),
    } : {}),
  };
}

const escapeRich = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/([\\`*_{}\[\]()#+.!|~=-])/gu, "\\$1");
const richLines = (values: string[]) => values.map(escapeRich).join("  \n");

function updateMarkdown(current: string, candidate: string, source: string, ref: string, renderer: ReturnType<typeof officeRenderer>, reply: string): string {
  const blocks = [
    "**⬆️ Доступно обновление плагина Bitrix24**",
    "**Версия и источник**  \n" + richLines([`v${current} → v${candidate}`, `Источник: ${source} @${ref}`, "CI: success ✅"]),
  ];
  if (!renderer.available) {
    const host = renderer.server!;
    blocks.push("**Для работы с документами**  \n" + richLines([
      `LibreOffice отсутствует на ${host.hostname} (${host.osId}).`,
      `Ива работает от пользователя ${host.user}.`,
      ...(host.ivaPath ? [`Путь установки Ивы: ${host.ivaPath}`, `Плагин: ${host.pluginPath}`] : ["Путь установки Ивы не удалось подтвердить."]),
    ]));
    blocks.push(renderer.command
      ? "**Команда для VPS**  \nПодключитесь к указанному серверу по SSH и выполните:\n\n```bash\n" + renderer.command + "\n```"
      : "**Установка LibreOffice**  \nКоманда для этой системы не проверена; обратитесь к администратору сервера.");
  }
  blocks.push("**Что сохранится**  \nНастройки и локальные данные будут сохранены. Обновление плагина не устанавливает системные пакеты.");
  blocks.push(`<tg-button-row><tg-button type="callback_data" style="success" data="${reply}">⬆️ Обновить</tg-button><tg-button type="callback_data" data="${reply.replace("b24u:update:", "b24u:later:")}">Позже</tg-button></tg-button-row>`);
  return blocks.join("\n\n");
}

export type ApplyUpdateInput = {
  readonly candidateSha: string;
  readonly approvalToken: string;
  readonly confirmationReply?: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSha(value: unknown): string {
  return typeof value === "string" && SHA.test(value) ? value : "";
}

function safeVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || !SEMVER.test(value))
    return "";
  const coreAndPrerelease = value.split("+", 1)[0]!;
  const separator = coreAndPrerelease.indexOf("-");
  if (
    separator !== -1 &&
    coreAndPrerelease.slice(separator + 1).split(".")
      .some((part) => /^0[0-9]+$/u.test(part))
  ) return "";
  return value;
}

function compareVersions(left: string, right: string): number {
  const parts = (version: string) => {
    const withoutBuild = version.split("+", 1)[0]!;
    const separator = withoutBuild.indexOf("-");
    const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
    return {
      core: core.split(".").map((part) => BigInt(part)),
      prerelease: prerelease?.split(".") ?? null,
    };
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! > b.core[index]!) return 1;
    if (a.core[index]! < b.core[index]!) return -1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric)
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
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
  const parts = base.split("/");
  const pathParts = parts.slice(2);
  if (pathParts.some((part) => part === "." || part === "..")) return null;
  return {
    label: base,
    url: `https://github.com/${owner}/${repo}.git`,
    base,
    ref: sourceRef || stateRef,
    owner,
    repo,
    pluginPath: pathParts.join("/"),
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
  readonly #dataDir: string;
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
    this.#dataDir = dataDir;
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
      token: () => randomBytes(12).toString("hex").toUpperCase(),
      hasLibreOffice: () => executableOnPath("libreoffice"),
      officeHost,
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

  async #installedVersion(): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.#root, "plugin.json"), "utf8"));
    } catch {
      throw new Error("CURRENT_VERSION_UNAVAILABLE");
    }
    if (!isRecord(parsed) || parsed.name !== PLUGIN_NAME) {
      throw new Error("CURRENT_VERSION_UNAVAILABLE");
    }
    const version = safeVersion(parsed.version);
    if (!version) throw new Error("CURRENT_VERSION_UNAVAILABLE");
    return version;
  }

  async #candidateVersion(source: GitSource, sha: string): Promise<string> {
    const manifestPath = [...(source.pluginPath ? source.pluginPath.split("/") : []), "plugin.json"]
      .map(encodeURIComponent)
      .join("/");
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${sha}/${manifestPath}`;
    const response = await this.#operations.fetch(url, {
      headers: { accept: "application/json", "user-agent": "iva-bitrix24-updater" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("CANDIDATE_VERSION_UNAVAILABLE");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MANIFEST_LIMIT_BYTES)
      throw new Error("CANDIDATE_VERSION_UNAVAILABLE");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MANIFEST_LIMIT_BYTES)
      throw new Error("CANDIDATE_VERSION_UNAVAILABLE");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("CANDIDATE_VERSION_UNAVAILABLE");
    }
    if (!isRecord(parsed) || parsed.name !== PLUGIN_NAME)
      throw new Error("CANDIDATE_VERSION_UNAVAILABLE");
    const version = safeVersion(parsed.version);
    if (!version) throw new Error("CANDIDATE_VERSION_UNAVAILABLE");
    return version;
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

  async check(input: { presentation?: "native" | "rich" | undefined } = {}): Promise<unknown> {
    const renderer = officeRenderer(await this.#operations.hasLibreOffice(), this.#root, await this.#operations.officeHost(this.#dataDir));
    const entry = await this.#entry();
    const source = sourceFromEntry(entry);
    if (!source) {
      await rm(this.#offer, { force: true });
      return {
        ok: false,
        state: "local_source",
        officeRenderer: renderer,
        message:
          "Этот экземпляр установлен из локальной папки и не может проверять GitHub. Один раз переустановите его из mamysh/iva-bitrix24/plugin.",
      };
    }
    const currentSha = safeSha(entry.sha);
    if (!currentSha) throw new Error("CURRENT_SHA_UNAVAILABLE");
    const currentVersion = await this.#installedVersion();
    const candidateSha = await this.#remoteSha(source);
    if (candidateSha === currentSha) {
      await rm(this.#offer, { force: true });
      return {
        ok: true,
        state: "current",
        source: source.label,
        ref: source.ref,
        currentSha,
        currentVersion,
        officeRenderer: renderer,
        enabled: entry.enabled === true,
        trusted: entry.trusted === true,
      };
    }
    const candidateVersion = await this.#candidateVersion(source, candidateSha);
    if (compareVersions(candidateVersion, currentVersion) <= 0) {
      await rm(this.#offer, { force: true });
      return {
        ok: true,
        state: "current",
        source: source.label,
        ref: source.ref,
        currentSha,
        currentVersion,
        officeRenderer: renderer,
        enabled: entry.enabled === true,
        trusted: entry.trusted === true,
      };
    }
    const ci = await this.#ci(source, candidateSha);
    const approvalToken = this.#operations.token();
    if (!/^[A-F0-9]{24}$/u.test(approvalToken))
      throw new Error("UPDATE_APPROVAL_TOKEN_INVALID");
    const confirmationReply = input.presentation === "rich" ? `b24u:update:${randomBytes(12).toString("hex")}` : undefined;
    const offer: Offer = {
      schema: "iva-bitrix24-update-offer/v3",
      createdAt: this.#operations.now().toISOString(),
      currentSha,
      candidateSha,
      currentVersion,
      candidateVersion,
      approvalToken,
      source: entry.source as string,
      sourceBase: source.base,
      ref: source.ref,
      ...(confirmationReply ? { confirmationReply } : {}),
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
      currentVersion,
      candidateVersion,
      ci,
      officeRenderer: renderer,
      ...(ci === "success"
        ? {
            approvalToken,
            ...(confirmationReply ? { richApproval: { markdown: updateMarkdown(currentVersion, candidateVersion, source.label, source.ref, renderer, confirmationReply), confirmationReply, laterReply: confirmationReply.replace("b24u:update:", "b24u:later:") } } : {}),
            approvalPrompt: {
              prompt: [
                "⬆️ Доступно обновление плагина Bitrix24",
                "",
                `v${currentVersion} → v${candidateVersion}`,
                `Источник: ${source.label} @${source.ref}`,
                "CI: success ✅",
                "",
                ...(!renderer.available
                  ? [
                    `LibreOffice отсутствует на ${renderer.server!.hostname} (${renderer.server!.osId}); Iva работает от ${renderer.server!.user}.`,
                    ...(renderer.server!.ivaPath ? [`Проверенный путь установки Iva: ${renderer.server!.ivaPath}. Плагин: ${renderer.server!.pluginPath}.`] : ["Путь установки Iva не удалось подтвердить."]),
                    ...(renderer.command ? ["", "Подключитесь к этому серверу по SSH и выполните:", renderer.command, ""] : ["Команда установки для этой системы не проверена; обратитесь к администратору сервера."]),
                    "Обновление плагина системные пакеты не устанавливает.",
                  ]
                  : []),
                "",
                "Настройки и локальные данные будут сохранены.",
              ].join("\n"),
              options: [
                { id: "update", label: "⬆️ Обновить" },
                { id: "later", label: "Позже" },
              ],
              allowFreeform: false,
            },
          }
        : {}),
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
    if (!isRecord(parsed) || parsed.schema !== "iva-bitrix24-update-offer/v3")
      throw new Error("UPDATE_OFFER_INVALID");
    const offer = parsed as Offer;
    if (
      safeVersion(offer.currentVersion) !== offer.currentVersion ||
      safeVersion(offer.candidateVersion) !== offer.candidateVersion
    )
      throw new Error("UPDATE_OFFER_INVALID");
    const age = this.#operations.now().getTime() - Date.parse(offer.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > OFFER_TTL_MS)
      throw new Error("UPDATE_OFFER_EXPIRED");
    if (
      input.candidateSha !== offer.candidateSha ||
      input.approvalToken !== offer.approvalToken ||
      (offer.confirmationReply !== undefined && (typeof offer.confirmationReply !== "string" || !/^b24u:update:[a-f0-9]{24}$/u.test(offer.confirmationReply) || input.confirmationReply !== offer.confirmationReply)) ||
      (offer.confirmationReply === undefined && input.confirmationReply !== undefined)
    )
      throw new Error("UPDATE_APPROVAL_MISMATCH");
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
      previousVersion: offer.currentVersion,
      expectedVersion: offer.candidateVersion,
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
      fromVersion: offer.currentVersion,
      toVersion: offer.candidateVersion,
      message: "Обновление запущено отдельно и переживёт перезапуск MCP. Спросите Иву о статусе через минуту.",
    };
  }

  async status(): Promise<unknown> {
    const renderer = officeRenderer(await this.#operations.hasLibreOffice(), this.#root, await this.#operations.officeHost(this.#dataDir));
    let names: string[];
    try {
      names = await readdir(this.#jobs);
    } catch {
      return { ok: true, state: "never_run", officeRenderer: renderer };
    }
    const latest = names.filter((name) => name.endsWith(".json")).sort().at(-1);
    if (!latest) return { ok: true, state: "never_run", officeRenderer: renderer };
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
    for (const key of ["previousVersion", "expectedVersion", "installedVersion"] as const) {
      const version = safeVersion(parsed[key]);
      if (version) safe[key] = version;
    }
    const currentSha = safeSha((await this.#entry()).sha);
    const currentVersion = await this.#installedVersion();
    const recordedSha = safeSha(parsed.installedSha);
    const withCurrentVersion = {
      ...safe,
      currentVersion,
      officeRenderer: renderer,
      ...("installedVersion" in safe || !recordedSha || recordedSha !== currentSha
        ? {}
        : { installedVersion: currentVersion }),
    };
    if (currentSha && recordedSha && currentSha !== recordedSha) {
      return {
        ...withCurrentVersion,
        status: "superseded",
        previousStatus: parsed.status,
        currentSha,
        currentVersion,
        message:
          "Состояние плагина изменилось после этой job; показана текущая установленная версия.",
      };
    }
    if (parsed.status === "queued" && typeof parsed.createdAt === "string") {
      const queuedFor = this.#operations.now().getTime() - Date.parse(parsed.createdAt);
      if (Number.isFinite(queuedFor) && queuedFor > JOB_START_TIMEOUT_MS) {
        return {
          ...withCurrentVersion,
          status: "stalled",
          previousStatus: "queued",
          message:
            "Фоновый worker не начал работу вовремя; повторный запуск через shell запрещён.",
        };
      }
    }
    return withCurrentVersion;
  }
}
