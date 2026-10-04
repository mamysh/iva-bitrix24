import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod/v4";
import { BitrixRequestError } from "./bitrix-client.ts";
import { SettingsStore, policySchema, withPolicyLock, writePrivateJson, type PluginPolicy } from "./settings.ts";

const screens = ["home", "connection", "capabilities", "actions", "privacy"] as const;
export const settingsInputSchema = z.object({ screen: z.enum(screens).optional(), reply: z.string().min(1).max(64).optional() }).strict().refine(input => !(input.screen && input.reply));
export type SettingsInput = z.infer<typeof settingsInputSchema>;
type Screen = typeof screens[number];
type Diagnostics = { configured: boolean; connectionCheck?: () => Promise<unknown>; capabilities?: () => Promise<unknown> };
const offerSchema = z.object({ schema: z.literal(1), identity: z.string(), revision: z.number().int().min(0), policy: policySchema, screen: z.enum(screens), createdAt: z.number().finite(), token: z.uuid() }).strict();
const TTL = 10 * 60_000;
const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/([\\`*_{}\[\]()#+.!|~=-])/gu, "\\$1");
const richText = (value: string) => escape(value).split("\n").map(line => line ? `${line}  ` : "").join("\n");
const button = (label: string, reply: string, style?: "success" | "danger") => `<tg-button-row><tg-button type="callback_data"${style ? ` style="${style}"` : ""} data="${reply}">${label}</tg-button></tg-button-row>`;
const nav = (label: string, screen: Screen) => button(label, `b24s:open:${screen}`);
const modeLabel = (p: PluginPolicy) => p.mode === "read_only" ? "Только чтение" : "Запись с подтверждением";
const peopleLabel = (p: PluginPolicy) => ({ ids: "Только ID", names: "ID и имена", work: "Рабочий профиль" })[p.people];
const on = (value: boolean) => value ? "разрешено" : "выключено";
const summary = (p: PluginPolicy) => `Действия: ${modeLabel(p)}\nЗагрузка в Bitrix: ${on(p.uploads)}\nУдаление сообщений и файлов: ${on(p.deletions)}\nДанные сотрудников: ${peopleLabel(p)}\nEmail: ${on(p.email)}`;
const choices = ["read", "write", "upload_on", "upload_off", "delete_on", "delete_off", "ids", "names", "work", "email_on", "email_off"] as const;
type Choice = typeof choices[number];
function change(current: PluginPolicy, choice: Choice): PluginPolicy {
  const next = { ...current };
  switch (choice) {
    case "read": next.mode = "read_only"; break;
    case "write": next.mode = "confirmed_write"; break;
    case "upload_on": next.uploads = true; break;
    case "upload_off": next.uploads = false; break;
    case "delete_on": next.deletions = true; break;
    case "delete_off": next.deletions = false; break;
    case "ids": next.people = "ids"; next.email = false; break;
    case "names": next.people = "names"; next.email = false; break;
    case "work": next.people = "work"; break;
    case "email_on": if (next.people !== "work") throw new BitrixRequestError("EMAIL_REQUIRES_WORK_PROFILE"); next.email = true; break;
    case "email_off": next.email = false; break;
  }
  return policySchema.parse(next);
}

export class SettingsMenu {
  readonly #store: SettingsStore;
  readonly #diagnostics: Diagnostics;
  readonly #now: () => number;
  constructor(store: SettingsStore, diagnostics: Diagnostics, now = Date.now) { this.#store = store; this.#diagnostics = diagnostics; this.#now = now; }
  async run(raw: SettingsInput) {
    const input = settingsInputSchema.parse(raw);
    if (input.reply) {
      const open = /^b24s:open:(home|connection|capabilities|actions|privacy)$/u.exec(input.reply);
      if (open) return this.#render(open[1] as Screen);
      const set = /^b24s:set:(0|[1-9]\d{0,15}):([a-z_]+)$/u.exec(input.reply);
      if (set && choices.includes(set[2] as Choice)) return this.#prepare(Number(set[1]), set[2] as Choice);
      const confirm = /^b24s:(confirm|cancel):([0-9a-f-]{36})$/u.exec(input.reply);
      if (confirm && z.uuid().safeParse(confirm[2]).success) return this.#resolve(confirm[1] === "confirm", confirm[2]!);
      throw new BitrixRequestError("INVALID_SETTINGS_REPLY");
    }
    return this.#render(input.screen ?? "home");
  }
  async #prepare(revision: number, choice: Choice) {
    return withPolicyLock(this.#store.data, async () => {
      const current = await this.#store.read();
      if (current.revision !== revision) throw new BitrixRequestError("SETTINGS_CHANGED");
      const policy = change(current.policy, choice);
      const screen = ["ids", "names", "work", "email_on", "email_off"].includes(choice) ? "privacy" : "actions";
      if (current.revision > 0 && JSON.stringify(current.policy) === JSON.stringify(policy)) {
        await rm(this.#store.path("settings-offer.json"), { force: true });
        return this.#render(screen, "Эта настройка уже выбрана. Предыдущее предложение настроек отменено.");
      }
      const offer = { schema: 1, identity: this.#store.identity, revision, policy, screen, createdAt: this.#now(), token: randomUUID() };
      await writePrivateJson(this.#store.path("settings-offer.json"), offer, this.#store.data!);
      const confirmReply = `b24s:confirm:${offer.token}`;
      const cancelReply = `b24s:cancel:${offer.token}`;
      const prompt = `Изменить настройки Bitrix24?\n\nСейчас:\n${summary(current.policy)}\n\nПосле подтверждения:\n${summary(policy)}\n\nПредыдущее превью задачи станет недействительным. Настройки не меняют права webhook в Bitrix24.`;
      return { state: "confirmation_required", settings: current, expiresAt: new Date(offer.createdAt + TTL).toISOString(), confirmReply, cancelReply, approvalPrompt: prompt, markdown: `**Настройки Bitrix24**\n\n${richText(prompt)}\n\n${button("Подтвердить", confirmReply, "success")}\n\n${button("Отменить", cancelReply, "danger")}` };
    });
  }
  async #resolve(confirm: boolean, token: string) {
    return withPolicyLock(this.#store.data, async () => {
      let offer: z.infer<typeof offerSchema>;
      try { offer = offerSchema.parse(JSON.parse(await readFile(this.#store.path("settings-offer.json"), "utf8"))); }
      catch { throw new BitrixRequestError("SETTINGS_OFFER_INVALID"); }
      const age = this.#now() - offer.createdAt;
      if (offer.token !== token || offer.identity !== this.#store.identity || age < 0 || age > TTL) throw new BitrixRequestError("SETTINGS_OFFER_INVALID");
      if ((await this.#store.read()).revision !== offer.revision) throw new BitrixRequestError("SETTINGS_CHANGED");
      if (confirm) await this.#store.commit(offer.revision, offer.policy);
      await rm(this.#store.path("settings-offer.json"), { force: true });
      return this.#render(offer.screen, confirm ? "Настройки сохранены. Предыдущее превью задачи отменено." : "Изменение отменено.");
    });
  }
  async #render(screen: Screen, notice?: string) {
    const settings = await this.#store.read();
    const p = settings.policy;
    const lines = ["**Bitrix24 · Настройки**"];
    if (notice) lines.push(escape(notice));
    const select = (label: string, choice: Choice) => button(label, `b24s:set:${settings.revision}:${choice}`);
    if (screen === "home") {
      let connection = "не настроен";
      if (this.#diagnostics.configured) {
        try { await this.#diagnostics.connectionCheck!(); connection = "работает; доступ к методам задач проверен"; }
        catch (error) { connection = `проверка не прошла (${error instanceof BitrixRequestError ? error.code : "CHECK_FAILED"}); откройте раздел подключения`; }
      }
      lines.push(escape(`Webhook: ${connection}`), richText(summary(p)), nav("Подключение", "connection"), nav("Возможности", "capabilities"), nav("Действия", "actions"), nav("Персональные данные", "privacy"));
      if (!this.#store.data) lines.push("Приватные данные плагина недоступны: изменения настроек и запись закрыты. Проверьте установку Ивы.");
      if (settings.revision === 0) lines.push("Первый запуск меню: показаны исходные настройки установки. Сохраните нужный режим в разделах ниже.");
    } else if (screen === "connection" || screen === "capabilities") {
      lines.push(screen === "connection" ? "**Подключение**" : "**Возможности**");
      if (!this.#diagnostics.configured) lines.push("Webhook не настроен. Запустите установщик в терминале сервера Ивы; секрет в чат не отправляйте.");
      else {
        try {
          if (screen === "connection") {
            await this.#diagnostics.connectionCheck!();
            lines.push("Соединение работает. Доступ к методам задач проверен; задачи и документы не читались.");
          } else {
            const result = await this.#diagnostics.capabilities!() as { grantedScopes?: string[] };
            const scopes = new Set(result.grantedScopes ?? []);
            const hasPeople = ["user_brief", "user_basic", "user"].some(value => scopes.has(value));
            for (const [label, available] of [["Задачи и чек-листы", scopes.has("task")], ["Обсуждения нового чата", scopes.has("task") && scopes.has("im")], ["Проекты", scopes.has("sonet_group")], ["Сотрудники", hasPeople], ["Подразделения", scopes.has("department")], ["Вложения задач", scopes.has("task") && scopes.has("disk")], ["Методы действий", scopes.has("task") && hasPeople]] as const) lines.push(`${label}: ${available ? "права webhook есть" : "нужных прав webhook нет"}`);
            lines.push(`Email: ${scopes.has("user_basic") || scopes.has("user") ? "права webhook есть" : "нужен user_basic"}; ${p.email ? "разрешён настройкой" : "скрыт настройкой"}.`, `Действия в плагине: ${modeLabel(p)}.`, "Это проверка scopes, а не доказательство доступа ко всем объектам или возможности записи. Права сотрудника проверяются для конкретного действия.", "Изменить права: Bitrix24 → Приложения → Ресурсы разработчика → webhook → Права доступа.");
          }
          lines.push(`Проверено: ${escape(new Date(this.#now()).toISOString())}`);
        } catch (error) {
          const code = error instanceof BitrixRequestError ? error.code : "CHECK_FAILED";
          const hint = ["NO_AUTH_FOUND", "INVALID_CREDENTIALS"].includes(code) ? "Проверьте или замените webhook через установщик."
            : ["ACCESS_DENIED", "INSUFFICIENT_SCOPE"].includes(code) ? "Проверьте права webhook и его пользователя в Bitrix24."
            : "Повторите проверку; при повторной ошибке проверьте сеть и настройку webhook.";
          lines.push(`Проверка не завершена: ${escape(code)}. ${hint}`);
        }
      }
      lines.push(nav("Проверить снова", screen));
    } else if (screen === "actions") {
      lines.push("**Действия**", richText(summary(p)), "Чтение блокирует все изменения на портале. В режиме записи каждое действие по-прежнему требует превью и подтверждения.", select(p.mode === "read_only" ? "✓ Только чтение" : "Только чтение", "read"), select(p.mode === "confirmed_write" ? "✓ Запись с подтверждением" : "Запись с подтверждением", "write"), select(p.uploads ? "Выключить загрузку в Bitrix" : "Разрешить загрузку в Bitrix", p.uploads ? "upload_off" : "upload_on"), select(p.deletions ? "Выключить удаление" : "Разрешить удаление", p.deletions ? "delete_off" : "delete_on"), "Загрузка и удаление действуют только при включённой записи. Скачивание доступных файлов относится к чтению. Обновление самого плагина — отдельная процедура.");
    } else {
      lines.push("**Персональные данные**", richText(`Данные сотрудников: ${peopleLabel(p)}\nEmail: ${on(p.email)}`), select(p.people === "ids" ? "✓ Только ID" : "Только ID", "ids"), "Имена скрыты; сотрудников выбирайте по ID. Поиск по имени недоступен.", select(p.people === "names" ? "✓ ID и имена" : "ID и имена", "names"), "Без должностей, подразделений и email профиля.", select(p.people === "work" ? "✓ Рабочий профиль" : "Рабочий профиль", "work"), "Имена, должности и подразделения. Email включается отдельно и требует прав webhook.");
      if (p.people === "work") lines.push(select(p.email ? "Скрыть email" : "Разрешить email", p.email ? "email_off" : "email_on"));
      lines.push("Поля ограничиваются до передачи модели, в том числе в превью. Телефоны, адреса и фото не запрашиваются. Тексты задач, обсуждений, имена файлов и содержимое документов могут содержать персональные данные: эта настройка их не обезличивает. Уже полученные сообщения и память Ивы не очищаются.");
    }
    if (screen !== "home") lines.push(nav("Назад к настройкам Bitrix", "home"));
    return { state: "screen", screen, settings, markdown: lines.join("\n\n") };
  }
}
