import { createServer, type IncomingMessage } from "node:http";
import { chmod, lstat, mkdir, realpath, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { parseEnv } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PanelsSettings } from "./panels-api.ts";
import { settingsFromEnvironment } from "./settings-environment.ts";

export async function panelsEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const data = env.IVA_DATA_DIR;
  if (!data || !isAbsolute(data)) throw new Error("IVA_DATA_DIR_REQUIRED");
  const path = join(data, "custom", "plugins", "bitrix24-read.env");
  let values: Record<string, string | undefined> = {};
  try {
    if (await realpath(path) !== resolve(path)) throw new Error("UNSAFE_PLUGIN_ENV");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 65536) throw new Error("UNSAFE_PLUGIN_ENV");
      values = parseEnv(await handle.readFile("utf8"));
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("PLUGIN_ENV_UNAVAILABLE"); }
  // Paths, service port and process controls belong to Iva, never to the env file.
  return { PLUGIN_DATA: env.PLUGIN_DATA, BITRIX24_WEBHOOK_BASE_URL: values.BITRIX24_WEBHOOK_BASE_URL, BITRIX24_SETTINGS_DEFAULTS: values.BITRIX24_SETTINGS_DEFAULTS };
}

async function body(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    const buffer = Buffer.from(part);
    bytes += buffer.length;
    if (bytes > 4096) throw new Error("REQUEST_TOO_LARGE");
    parts.push(buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
export async function servePanels(api: PanelsSettings) {
  const data = api.store.data;
  if (!data || !isAbsolute(data)) throw new Error("PLUGIN_DATA_REQUIRED");
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (await realpath(data) !== resolve(data)) throw new Error("PLUGIN_DATA_MUST_BE_CANONICAL");
  await api.expireOffers();
  const path = join(data, "panels.sock");
  try {
    const info = await lstat(path);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error("UNSAFE_SOCKET");
    // Caller holds the dedicated service flock; never unlink a peer's live socket.
    await rm(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/panels/v1") { res.writeHead(404).end(); return; }
    if (req.headers["content-type"] !== "application/json") { res.writeHead(415).end(); return; }
    try {
      const output = JSON.stringify(await api.request(await body(req)));
      if (Buffer.byteLength(output) > 32 * 1024) throw new Error("RESPONSE_TOO_LARGE");
      res.writeHead(200, { "content-type": "application/json" }).end(output);
    } catch {
      // No webhook, portal identity, policy payload or stack trace in errors.
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"PANELS_REQUEST_FAILED"}');
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 16;
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(path, () => { server.removeListener("error", fail); done(); }); });
  try { await chmod(path, 0o600); }
  catch (error) { server.close(); throw error; }
  const expiry = setInterval(() => { void api.expireOffers().catch(() => { /* Busy/corrupt storage never applies a policy; retry cancellation on the next tick. */ }); }, 15_000);
  expiry.unref();
  server.once("close", () => clearInterval(expiry));
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.umask(0o077);
  const env = await panelsEnvironment(process.env);
  if (env.BITRIX24_SETTINGS_DEFAULTS !== undefined && !["restricted", "legacy"].includes(env.BITRIX24_SETTINGS_DEFAULTS)) throw new Error("INVALID_SETTINGS_DEFAULTS");
  const api = new PanelsSettings(settingsFromEnvironment(env));
  const socket = await servePanels(api);
  const health = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"service":"bitrix24-panels"}');
    else res.writeHead(404).end();
  });
  const port = Number(process.env.IVA_SERVICE_PORT ?? 8736);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_SERVICE_PORT");
  health.listen(port, "127.0.0.1"); // Service discovery/health only; settings API is socket-only.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    socket.close(); health.close();
  });
}
