import type { BitrixConfig } from "./config.ts";

export const ALLOWED_METHODS = [
  "profile",
  "scope",
  "department.get",
  "disk.attachedObject.get",
  "disk.file.get",
  "im.dialog.messages.get",
  "im.v2.File.download",
  "sonet_group.get",
  "task.checklistitem.getlist",
  "task.commentitem.getlist",
  "tasks.task.get",
  "tasks.task.list",
  "tasks.task.getFields",
  "tasks.task.history.list",
  "user.get",
] as const;

export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

const allowed = new Set<string>(ALLOWED_METHODS);
const REQUIRED_SCOPES: Partial<Record<AllowedMethod, string>> = {
  "department.get": "department",
  "disk.attachedObject.get": "disk",
  "disk.file.get": "disk",
  "im.dialog.messages.get": "im",
  "im.v2.File.download": "im",
  "sonet_group.get": "sonet_group",
  "task.checklistitem.getlist": "task",
  "task.commentitem.getlist": "task",
  "tasks.task.get": "task",
  "tasks.task.list": "task",
  "tasks.task.getFields": "task",
  "tasks.task.history.list": "task",
  "user.get": "user_brief",
};
const RETRYABLE_CODES = new Set([
  "QUERY_LIMIT_EXCEEDED",
  "OPERATION_TIME_LIMIT",
  "OVERLOAD_LIMIT",
]);
const MAX_RESPONSE_BYTES = 1_000_000;

export class BitrixRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requiredScope: string | null;

  constructor(code: string, retryable = false, requiredScope: string | null = null) {
    super(`Bitrix24 request failed (${code})`);
    this.name = "BitrixRequestError";
    this.code = code;
    this.retryable = retryable;
    this.requiredScope = requiredScope;
  }
}

type Dependencies = {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly random: () => number;
};

const defaults: Dependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
};

type BitrixEnvelope = {
  readonly result?: unknown;
  readonly error?: unknown;
  readonly next?: unknown;
  readonly total?: unknown;
};

export type BitrixPage = {
  readonly result: unknown;
  readonly next: number | null;
  readonly total: number | null;
};

function safeUpstreamCode(
  value: unknown,
  status: number,
  method: AllowedMethod,
): string {
  if (
    value === "0" &&
    (method === "tasks.task.get" || method === "tasks.task.history.list")
  )
    return "TASK_NOT_FOUND_OR_DENIED";
  if (typeof value !== "string") return `HTTP_${status}`;
  const normalized = value.trim().toUpperCase();
  if (normalized === "") return `HTTP_${status}`;
  return /^[A-Z][A-Z0-9_]{1,79}$/u.test(normalized)
    ? normalized
    : "UPSTREAM_ERROR";
}

async function boundedText(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > MAX_RESPONSE_BYTES)
    throw new BitrixRequestError("RESPONSE_TOO_LARGE");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new BitrixRequestError("RESPONSE_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function retryDelay(attempt: number, random: () => number): number {
  const base = 250 * 2 ** attempt;
  return Math.round(base + base * 0.25 * random());
}

export class BitrixClient {
  readonly #config: BitrixConfig;
  readonly #dependencies: Dependencies;

  constructor(config: BitrixConfig, dependencies: Partial<Dependencies> = {}) {
    this.#config = config;
    this.#dependencies = { ...defaults, ...dependencies };
  }

  taskWebUrl(taskId: string | number): string {
    const path = `/company/personal/user/${this.#config.webhookUserId}/tasks/task/view/${taskId}/`;
    return new URL(path, this.#config.portalOrigin).toString();
  }

  async downloadSignedFile(urlValue: string, destination: import("node:fs/promises").FileHandle, maxBytes: number): Promise<number> {
    const resolveSigned = (value: string, base: string): URL => {
      let candidate: URL;
      try { candidate = new URL(value, base); }
      catch { throw new BitrixRequestError("INVALID_DOWNLOAD_URL"); }
      if (candidate.protocol !== "https:" || candidate.origin !== this.#config.portalOrigin || candidate.username || candidate.password)
        throw new BitrixRequestError("INVALID_DOWNLOAD_URL");
      return candidate;
    };
    let url = resolveSigned(urlValue, this.#config.portalOrigin);
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      try {
        response = await this.#dependencies.fetch(url, {
          method: "GET",
          headers: { accept: "*/*", "user-agent": "iva-bitrix24/1.0", referer: `${this.#config.portalOrigin}/` },
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new BitrixRequestError("DOWNLOAD_NETWORK_ERROR");
      }
      if (response.status < 300 || response.status >= 400) break;
      if (hop >= 2) throw new BitrixRequestError("DOWNLOAD_REDIRECT_REFUSED");
      const location = response.headers.get("location");
      if (!location) throw new BitrixRequestError("DOWNLOAD_REDIRECT_REFUSED");
      url = resolveSigned(location, url.toString());
    }
    if (!response.ok || !response.body) throw new BitrixRequestError("DOWNLOAD_FAILED");
    const announced = Number(response.headers.get("content-length") ?? "0");
    if (announced > maxBytes) throw new BitrixRequestError("FILE_TOO_LARGE");
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (type.includes("text/html") || type.includes("application/json"))
      throw new BitrixRequestError("INVALID_FILE_RESPONSE");
    const reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BitrixRequestError("FILE_TOO_LARGE");
      }
      let written = 0;
      while (written < value.byteLength) {
        const part = await destination.write(value, written, value.byteLength - written);
        if (part.bytesWritten <= 0) throw new BitrixRequestError("DOWNLOAD_WRITE_FAILED");
        written += part.bytesWritten;
      }
    }
    if (total === 0) throw new BitrixRequestError("EMPTY_FILE");
    return total;
  }

  async call(method: AllowedMethod, params: unknown = {}): Promise<unknown> {
    return (await this.#callEnvelope(method, params)).result;
  }

  async callPage(
    method: AllowedMethod,
    params: unknown = {},
  ): Promise<BitrixPage> {
    const envelope = await this.#callEnvelope(method, params);
    return {
      result: envelope.result,
      next:
        typeof envelope.next === "number" &&
        Number.isInteger(envelope.next) &&
        envelope.next >= 0
          ? envelope.next
          : null,
      total:
        typeof envelope.total === "number" &&
        Number.isInteger(envelope.total) &&
        envelope.total >= 0
          ? envelope.total
          : null,
    };
  }

  async #callEnvelope(
    method: AllowedMethod,
    params: unknown,
  ): Promise<BitrixEnvelope> {
    if (!allowed.has(method)) throw new BitrixRequestError("METHOD_NOT_ALLOWED");

    for (let attempt = 0; attempt < this.#config.maxAttempts; attempt += 1) {
      try {
        return await this.#attempt(method, params);
      } catch (error) {
        const retryable =
          error instanceof BitrixRequestError
            ? error.retryable
            : error instanceof TypeError ||
              (error instanceof DOMException && error.name === "AbortError");
        if (!retryable || attempt + 1 >= this.#config.maxAttempts) {
          if (error instanceof BitrixRequestError) throw error;
          throw new BitrixRequestError(
            error instanceof DOMException && error.name === "AbortError"
              ? "TIMEOUT"
              : "NETWORK_ERROR",
          );
        }
        await this.#dependencies.sleep(
          retryDelay(attempt, this.#dependencies.random),
        );
      }
    }
    throw new BitrixRequestError("RETRY_EXHAUSTED");
  }

  async #attempt(
    method: AllowedMethod,
    params: unknown,
  ): Promise<BitrixEnvelope> {
    const url = new URL(this.#config.webhookBaseUrl);
    url.pathname = `${url.pathname}/${method}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);

    let response: Response;
    try {
      response = await this.#dependencies.fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400)
      throw new BitrixRequestError("REDIRECT_REFUSED");

    const retryableStatus = response.status === 429 || response.status === 503;
    const raw = await boundedText(response);
    let envelope: BitrixEnvelope;
    try {
      envelope = JSON.parse(raw) as BitrixEnvelope;
    } catch {
      throw new BitrixRequestError(
        retryableStatus ? `HTTP_${response.status}` : "INVALID_RESPONSE",
        retryableStatus,
      );
    }

    const hasUpstreamError =
      typeof envelope.error === "string"
        ? envelope.error.trim() !== ""
        : envelope.error !== undefined && envelope.error !== null;
    if (!response.ok || hasUpstreamError) {
      const code = safeUpstreamCode(envelope.error, response.status, method);
      throw new BitrixRequestError(
        code,
        retryableStatus || RETRYABLE_CODES.has(code),
        code === "INSUFFICIENT_SCOPE" ? (REQUIRED_SCOPES[method] ?? null) : null,
      );
    }
    return envelope;
  }
}
