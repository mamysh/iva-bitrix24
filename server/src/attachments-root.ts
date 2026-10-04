import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { verifiedIvaPath } from "./plugin-updater.ts";

// Old installs may have only the webhook in their env. Recover the vault from the
// verified CLI installation, never from a task path or from the MCP process cwd.
export async function resolveAttachmentsRoot(
  env: Readonly<Record<string, string | undefined>>,
  wrapper = join(env.HOME || homedir(), ".local", "bin", "iva"),
): Promise<string | undefined> {
  const explicit = env.BITRIX24_ATTACHMENTS_ROOT;
  if (explicit !== undefined)
    return isAbsolute(explicit) && !/[\0\r\n]/u.test(explicit)
      ? resolve(explicit)
      : undefined;
  const data = env.PLUGIN_DATA;
  if (
    !data ||
    !isAbsolute(data) ||
    basename(data) !== "bitrix24-read" ||
    basename(dirname(data)) !== "plugin-data"
  )
    return undefined;
  const root = await verifiedIvaPath(dirname(dirname(data)), wrapper);
  if (!root) return undefined;
  try {
    const source = await readFile(join(root, ".env"), "utf8");
    if (source.length > 256_000) return undefined;
    const settings = parseEnv(source);
    const configured = settings.ASSISTANT_VAULT_DIR ?? "vault";
    if (!configured || /[\0\r\n]/u.test(configured)) return undefined;
    return join(
      isAbsolute(configured) ? configured : resolve(root, configured),
      "attachments",
    );
  } catch {
    return undefined;
  }
}
