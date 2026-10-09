import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { BitrixRequestError } from "./bitrix-client.ts";
import { changePolicy, policySummary, settingsChoices, type Choice } from "./settings-menu.ts";
import { SettingsStore, panelsReceiptSchema, policySchema, withPolicyLock, writePrivateJson } from "./settings.ts";

export const PANELS_VERSION = "0.9.0";
const tokenSchema = z.string().regex(/^[a-f0-9]{24}$/u);
const revisionSchema = z.number().int().min(0).max(999999999999);
const envelope = { schema: z.literal("iva-panels/rpc-v1"), plugin: z.literal("bitrix24-read"), pluginVersion: z.literal(PANELS_VERSION) };
export const panelsRequestSchema = z.discriminatedUnion("op", [
  z.object({ ...envelope, op: z.literal("read"), page: z.enum(["home", "actions", "privacy"]) }).strict(),
  z.object({ ...envelope, op: z.literal("prepare"), action: z.enum(settingsChoices.map(value => value.replaceAll("_", "-")) as [string, ...string[]]), revision: revisionSchema, token: tokenSchema }).strict(),
  ...(["confirm", "cancel", "status"] as const).map(op => z.object({ ...envelope, op: z.literal(op), token: tokenSchema }).strict()),
]);
const offerSchema = z.object({ token: tokenSchema, revision: revisionSchema, action: z.string(), identity: z.string(), createdAt: z.number().finite(), expiresAt: z.number().finite(), policy: policySchema, summary: z.string().min(1).max(1500), cancelled: z.boolean().optional() }).strict();
type Offer = z.infer<typeof offerSchema>;
const TTL = 10 * 60_000;
const MAX_OFFERS = 1000; // Retain receipts; refuse further proposals rather than evict recovery evidence.
const doneMessage = "Настройки сохранены. Предыдущее превью задачи отменено.";
const cancelled = (o: Offer) => ({ state: "cancelled" as const, token: o.token, revision: o.revision, message: "Изменение отменено или предложение устарело. Откройте настройки заново." });
const proposal = (o: Offer) => ({ state: "offer" as const, token: o.token, revision: o.revision, expiresAt: o.expiresAt, summary: o.summary });

/** Plugin-owned local settings only; no portal calls, MCP sessions or Telegram credentials. */
export class PanelsSettings {
  readonly store: SettingsStore;
  readonly now: () => number;
  constructor(store: SettingsStore, now = Date.now) { this.store = store; this.now = now; }
  directory() {
    if (!this.store.data) throw new BitrixRequestError("SETTINGS_NOT_CONFIGURED");
    this.store.path("settings.json");
    return join(this.store.data, "panels-offers");
  }
  async load(token: string): Promise<Offer | undefined> {
    try { return offerSchema.parse(JSON.parse(await readFile(join(this.directory(), `${tokenSchema.parse(token)}.json`), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new BitrixRequestError("SETTINGS_OFFER_INVALID"); }
  }
  async receipt(o: Offer) {
    const { settings: current, receipt: done } = await this.store.panelsState(o.token);
    if (done) return panelsReceiptSchema.parse(done);
    if (o.cancelled || current.revision !== o.revision) return cancelled(o);
    return proposal(o);
  }
  invalid(o: Offer) {
    return o.identity !== this.store.identity || this.now() < o.createdAt || this.now() >= o.expiresAt;
  }
  async cancelOffer(o: Offer) {
    await writePrivateJson(join(this.directory(), `${o.token}.json`), { ...o, cancelled: true }, this.directory());
    return cancelled(o);
  }
  async expireOffers() {
    return withPolicyLock(this.store.data, async () => {
      let files: string[];
      try { files = await readdir(this.directory()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const current = await this.store.read();
      for (const name of files) {
        if (!/^[a-f0-9]{24}\.json$/u.test(name)) throw new BitrixRequestError("SETTINGS_OFFER_INVALID");
        const o = await this.load(name.slice(0, -5));
        if (o && !o.cancelled && o.revision === current.revision && this.invalid(o)) await this.cancelOffer(o);
      }
    });
  }
  async request(raw: unknown) {
    const input = panelsRequestSchema.parse(raw);
    let result: unknown;
    if (input.op === "read") result = await this.screen(input.page);
    else if (input.op === "status") {
      const o = await this.load(input.token);
      if (!o) throw new BitrixRequestError("SETTINGS_OFFER_INVALID");
      result = await this.receipt(o); // Pure read, including recovery after atomic commit.
    } else result = await withPolicyLock(this.store.data, async () => {
      if (input.op === "prepare") {
        const existing = await this.load(input.token);
        if (existing) {
          if (existing.action !== input.action || existing.revision !== input.revision) throw new BitrixRequestError("SETTINGS_OFFER_INVALID");
          return this.receipt(existing);
        }
        const reject = (message: string) => ({ state: "rejected", token: input.token, message });
        const current = await this.store.read();
        if (current.revision !== input.revision || current.revision >= 999999999999) return reject("Настройки изменились. Откройте их заново.");
        await mkdir(this.directory(), { recursive: true, mode: 0o700 });
        const files = await readdir(this.directory());
        if (files.length >= MAX_OFFERS) return reject("Журнал подтверждений заполнен. Нужна проверка оператора без удаления незавершённых предложений.");
        for (const name of files) {
          if (!/^[a-f0-9]{24}\.json$/u.test(name)) throw new BitrixRequestError("SETTINGS_OFFER_INVALID");
          const previous = await this.load(name.slice(0, -5));
          if (previous && !previous.cancelled && previous.revision === current.revision && this.invalid(previous)) await this.cancelOffer(previous);
          if (previous && !previous.cancelled && previous.revision === current.revision && !this.invalid(previous)) return reject("Уже есть предложение Panels. Подтвердите или отмените его в предыдущем экране, либо дождитесь окончания десятиминутного срока.");
        }
        let policy;
        try { policy = changePolicy(current.policy, input.action.replaceAll("-", "_") as Choice); }
        catch (error) { if (error instanceof BitrixRequestError && error.code === "EMAIL_REQUIRES_WORK_PROFILE") return reject("Для email сначала выберите рабочий профиль."); throw error; }
        const createdAt = this.now();
        const o = offerSchema.parse({ token: input.token, revision: input.revision, action: input.action, identity: this.store.identity, createdAt, expiresAt: createdAt + TTL, policy,
          summary: `Изменить настройки Bitrix24?\n\nСейчас:\n${policySummary(current.policy)}\n\nПосле подтверждения:\n${policySummary(policy)}\n\nПредыдущее превью задачи станет недействительным. Права webhook остаются прежними. Настройка не очищает уже полученные данные и память Ивы.` });
        await writePrivateJson(join(this.directory(), `${o.token}.json`), o, this.directory());
        return proposal(o);
      }
      const o = await this.load(input.token);
      if (!o) throw new BitrixRequestError("SETTINGS_OFFER_INVALID");
      const saved = await this.receipt(o);
      if (saved.state !== "offer") return saved;
      if (input.op === "cancel" || this.invalid(o)) return this.cancelOffer(o);
      const receipt = panelsReceiptSchema.parse({ state: "done", token: o.token, revision: o.revision + 1, message: doneMessage });
      // Settings, revision and receipt share one atomic rename/fsync. All other
      // SettingsStore commits preserve receipts, including the existing MCP menu.
      await this.store.commit(o.revision, o.policy, receipt);
      return receipt;
    });
    return { ...envelopeValues(), result };
  }
  async screen(page: "home" | "actions" | "privacy") {
    const settings = await this.store.read();
    revisionSchema.parse(settings.revision);
    const p = settings.policy;
    const action = (label: string, choice: Choice) => ({ label, action: choice.replaceAll("_", "-") });
    const home = [{ label: "‹ Настройки Bitrix24", target: "home" }];
    if (page === "home") return { state: "screen", revision: settings.revision, title: "Настройки Bitrix24", body: `${policySummary(p)}\n\nИзменения сохраняются после превью и подтверждения. Они не меняют права webhook. Проверка подключения и прав доступна в обычном меню Bitrix24.`, rows: [[{ label: "Действия", target: "actions" }, { label: "Данные сотрудников", target: "privacy" }]] };
    if (page === "actions") return { state: "screen", revision: settings.revision, title: "Действия Bitrix24", body: `${policySummary(p)}\n\nЧтение: без изменений на портале. Запись: каждое действие через превью и подтверждение. Загрузка и удаление доступны только в режиме записи. Скачивание относится к чтению.`, rows: [[action("Только чтение", "read"), action("Запись с подтверждением", "write")], [action(p.uploads ? "Выключить загрузку" : "Разрешить загрузку", p.uploads ? "upload_off" : "upload_on"), action(p.deletions ? "Выключить удаление" : "Разрешить удаление", p.deletions ? "delete_off" : "delete_on")], home] };
    return { state: "screen", revision: settings.revision, title: "Данные сотрудников", body: `${policySummary(p)}\n\nID: без имён. Имена: ID и имя. Рабочий профиль: имя, должность и подразделения. Email требует рабочего профиля и прав webhook. Настройка ограничивает структурированные поля, но не обезличивает тексты задач, обсуждений и документов. Уже полученные сообщения и память Ивы не очищаются.`, rows: [[action("Только ID", "ids"), action("ID и имена", "names")], [action("Рабочий профиль", "work")], ...(p.people === "work" ? [[action(p.email ? "Скрыть email" : "Разрешить email", p.email ? "email_off" : "email_on")]] : []), home] };
  }
}
function envelopeValues() { return { schema: "iva-panels/rpc-v1", plugin: "bitrix24-read", pluginVersion: PANELS_VERSION }; }
