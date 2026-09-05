import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const VARIABLE = "BITRIX24_WEBHOOK_BASE_URL";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_INPUT_BYTES = 4096;

export class InstallerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
  }
}

export function parseWebhookBaseUrl(raw: string): URL {
  const value = raw.trim();
  if (!value) {
    throw new InstallerError(
      "EMPTY_WEBHOOK",
      "Webhook не введён, а сохранённой конфигурации нет.",
    );
  }
  if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
    throw new InstallerError("INVALID_WEBHOOK", "Webhook выглядит слишком длинным.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InstallerError("INVALID_WEBHOOK", "Это не похоже на URL webhook Bitrix24.");
  }
  if (url.protocol !== "https:") {
    throw new InstallerError("INVALID_WEBHOOK", "Webhook должен начинаться с https://.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InstallerError(
      "INVALID_WEBHOOK",
      "В webhook не должно быть логина в адресе, параметров после ? или фрагмента после #.",
    );
  }
  if (!/^\/rest\/[1-9][0-9]*\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) {
    throw new InstallerError(
      "INVALID_WEBHOOK",
      "Ожидается полный входящий webhook вида https://портал/rest/ID/СЕКРЕТ.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > MAX_RESPONSE_BYTES) {
    throw new InstallerError("RESPONSE_TOO_LARGE", "Bitrix24 вернул слишком большой ответ.");
  }
  if (!response.body) {
    throw new InstallerError("INVALID_RESPONSE", "Bitrix24 вернул пустой ответ.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new InstallerError("RESPONSE_TOO_LARGE", "Bitrix24 вернул слишком большой ответ.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InstallerError(
      "INVALID_RESPONSE",
      "Сервер ответил не в формате Bitrix24 REST. Проверьте адрес webhook.",
    );
  }
}

function upstreamMessage(code: string, method: string): string {
  if (code === "NO_AUTH_FOUND" || code === "INVALID_CREDENTIALS") {
    return "Bitrix24 не принял webhook. Проверьте адрес или создайте новый входящий webhook.";
  }
  if (code === "ACCESS_DENIED" || code === "INSUFFICIENT_SCOPE") {
    return method === "profile"
      ? "Webhook принят, но у его пользователя недостаточно прав."
      : "Webhook работает, но ему не выдан scope «Задачи» (task). Откройте Приложения → Ресурсы разработчика → Интеграции, отредактируйте webhook и добавьте «Задачи» на шаге «Права доступа».";
  }
  if (code === "QUERY_LIMIT_EXCEEDED" || code === "OPERATION_TIME_LIMIT") {
    return "Bitrix24 временно ограничил запросы. Подождите минуту и повторите установку.";
  }
  return `Bitrix24 отклонил проверку (${code.slice(0, 80)}).`;
}

async function call(
  baseUrl: URL,
  method: "profile" | "tasks.task.getFields",
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname}/${method}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new InstallerError("TIMEOUT", "Bitrix24 не ответил за 10 секунд.");
    }
    throw new InstallerError(
      "NETWORK_ERROR",
      "Не удалось подключиться к Bitrix24. Проверьте сеть, DNS и TLS на сервере Iva.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new InstallerError("REDIRECT_REFUSED", "Webhook перенаправляет запрос на другой адрес.");
  }
  const envelope = await boundedJson(response);
  const rawCode = typeof envelope.error === "string" ? envelope.error : undefined;
  const safeCode =
    rawCode && /^[A-Za-z0-9_.-]{1,80}$/u.test(rawCode) ? rawCode : undefined;
  const code = safeCode?.toUpperCase();
  if (!response.ok || rawCode) {
    throw new InstallerError(
      code ?? (response.ok ? "UPSTREAM_ERROR" : `HTTP_${response.status}`),
      code
        ? upstreamMessage(code, method)
        : response.ok
          ? "Bitrix24 отклонил проверку без безопасного кода ошибки."
          : `Bitrix24 вернул HTTP ${response.status}.`,
    );
  }
  if (!("result" in envelope)) {
    throw new InstallerError("INVALID_RESPONSE", "В ответе Bitrix24 отсутствует result.");
  }
}

export async function probeWebhook(
  raw: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<string> {
  const url = parseWebhookBaseUrl(raw);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  await call(url, "profile", fetchImpl, timeoutMs);
  await call(url, "tasks.task.getFields", fetchImpl, timeoutMs);
  return url.toString();
}

export async function readConfiguredWebhook(envPath: string): Promise<string | null> {
  let source: string;
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const line of source.split("\n")) {
    const match = /^BITRIX24_WEBHOOK_BASE_URL=(.*)$/u.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export async function writeWebhookAtomic(envPath: string, normalized: string): Promise<void> {
  const temporary = join(dirname(envPath), `.bitrix24-read.env-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${VARIABLE}=${normalized}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, envPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
