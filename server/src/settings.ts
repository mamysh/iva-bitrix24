import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { BitrixRequestError } from "./bitrix-client.ts";

export const policySchema = z.object({
  mode: z.enum(["read_only", "confirmed_write"]),
  uploads: z.boolean(),
  deletions: z.boolean(),
  people: z.enum(["ids", "names", "work"]),
  email: z.boolean(),
}).strict().refine(value => !value.email || value.people === "work", "Email requires work profiles");
export type PluginPolicy = z.infer<typeof policySchema>;
export const LEGACY_POLICY: Readonly<PluginPolicy> = Object.freeze({ mode: "confirmed_write", uploads: true, deletions: true, people: "work", email: true });
export const RESTRICTED_POLICY: Readonly<PluginPolicy> = Object.freeze({ mode: "read_only", uploads: false, deletions: false, people: "ids", email: false });
export const panelsReceiptSchema = z.object({ state: z.literal("done"), token: z.string().regex(/^[a-f0-9]{24}$/u), revision: z.number().int().min(1).max(999999999999), message: z.string().min(1).max(1500) }).strict();
const settingsSchema = z.object({ schema: z.literal(1), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), policy: policySchema, panelsReceipts: z.record(z.string().regex(/^[a-f0-9]{24}$/u), panelsReceiptSchema).optional() }).strict();
type SettingsDocument = z.infer<typeof settingsSchema>;
export type Settings = Omit<SettingsDocument, "panelsReceipts">;
export type PolicyReader = () => Promise<Readonly<PluginPolicy>>;
export const legacyPolicy: PolicyReader = async () => LEGACY_POLICY;

export function assertWritePolicy(policy: Readonly<PluginPolicy>, action: { action: string; uploads?: readonly unknown[] | undefined }) {
  if (policy.mode !== "confirmed_write") throw new BitrixRequestError("READ_ONLY_MODE");
  if (!policy.uploads && (action.action === "upload" || Boolean(action.uploads?.length))) throw new BitrixRequestError("UPLOADS_DISABLED");
  if (!policy.deletions && ["delete_file", "delete_message"].includes(action.action)) throw new BitrixRequestError("DELETIONS_DISABLED");
}

// The task writer and settings commits share this lock. A confirmed policy change
// cannot race a batch already writing to Bitrix24; stale locks fail closed.
export async function withPolicyLock<T>(data: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!data || !isAbsolute(data)) throw new BitrixRequestError("WRITES_NOT_CONFIGURED");
  const root = join(data, "task-writes");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new BitrixRequestError("WRITE_BUSY"); }
  try { return await run(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function writePrivateJson(path: string, value: unknown, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    const dir = await open(directory, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export class SettingsStore {
  readonly data: string | undefined;
  readonly identity: string;
  readonly #defaults: Readonly<PluginPolicy>;
  constructor(data: string | undefined, identity: string, defaults: Readonly<PluginPolicy> = LEGACY_POLICY) {
    this.data = data;
    this.identity = identity;
    this.#defaults = defaults;
  }
  path(name: "settings.json" | "settings-offer.json"): string {
    if (!this.data || !isAbsolute(this.data)) throw new BitrixRequestError("SETTINGS_NOT_CONFIGURED");
    return join(this.data, name);
  }
  async #readDocument(): Promise<SettingsDocument> {
    if (!this.data || !isAbsolute(this.data)) return { schema: 1, revision: 0, policy: { ...RESTRICTED_POLICY } };
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(await readFile(this.path("settings.json"), "utf8")));
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, revision: 0, policy: { ...this.#defaults } };
      throw new BitrixRequestError("SETTINGS_INVALID");
    }
  }
  async read(): Promise<Settings> {
    const { schema, revision, policy } = await this.#readDocument();
    return { schema, revision, policy };
  }
  async panelsState(token: string) {
    const current = await this.#readDocument();
    return { settings: { schema: current.schema, revision: current.revision, policy: current.policy }, receipt: current.panelsReceipts?.[token] };
  }
  policy: PolicyReader = async () => (await this.read()).policy;
  async commit(expectedRevision: number, policy: PluginPolicy, receipt?: z.infer<typeof panelsReceiptSchema>): Promise<Settings> {
    // Caller owns withPolicyLock, also used by settings offers and task actions.
    const current = await this.#readDocument();
    if (current.revision !== expectedRevision) throw new BitrixRequestError("SETTINGS_CHANGED");
    const panelsReceipts = { ...current.panelsReceipts };
    if (receipt) {
      panelsReceiptSchema.parse(receipt);
      if (receipt.revision !== current.revision + 1 || panelsReceipts[receipt.token]) throw new BitrixRequestError("SETTINGS_CHANGED");
      panelsReceipts[receipt.token] = receipt;
    }
    const next = settingsSchema.parse({ schema: 1, revision: current.revision + 1, policy, ...(Object.keys(panelsReceipts).length ? { panelsReceipts } : {}) });
    // Invalidate the draft before changing policy; a crash cannot keep a stale preview alive.
    await rm(join(this.data!, "task-writes", "active.json"), { force: true });
    await writePrivateJson(this.path("settings.json"), next, this.data!);
    return { schema: next.schema, revision: next.revision, policy: next.policy };
  }
}

// Only structured employee metadata is projected. Task text, filenames, history
// values and file contents are untrusted free text, not anonymized by this policy.
export function minimizeResult(value: unknown, policy: Readonly<PluginPolicy>, context = ""): unknown {
  if (Array.isArray(value)) return value.map(item => minimizeResult(item, policy, context));
  if (!value || typeof value !== "object") return value;
  const person = ["user", "actor", "author", "people", "members"].includes(context);
  const department = context === "departments";
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if ((["responsibleName", "createdByName"].includes(key) || (person && ["name", "lastName"].includes(key))) && policy.people === "ids") result[key] = null;
    else if ((person && key === "email") && (!policy.email || policy.people !== "work")) result[key] = null;
    else if ((person && ["workPosition", "departmentIds", "admin"].includes(key)) && policy.people !== "work") result[key] = key === "departmentIds" ? [] : null;
    else if (department && key === "name" && policy.people !== "work") result[key] = null;
    else result[key] = minimizeResult(field, policy, key);
  }
  return result;
}
