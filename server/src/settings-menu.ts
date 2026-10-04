import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod/v4";
import { BitrixRequestError } from "./bitrix-client.ts";
import { SettingsStore, policySchema, withPolicyLock, writePrivateJson, type PluginPolicy } from "./settings.ts";

const screens = ["home", "connection", "capabilities", "actions", "privacy"] as const;
export const settingsInputSchema = z.object({ screen: z.enum(screens).optional(), reply: z.string().min(1).max(64).optional() }).strict().refine(input => !(input.screen && input.reply));
export type SettingsInput = z.infer<typeof settingsInputSchema>;
export const screenEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), eventId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("action"), eventId: z.string().min(1).max(128), screen: z.string().regex(/^[a-f0-9]{32}$/u), revision: z.number().int().nonnegative(), actionId: z.string().min(1).max(64) }).strict(),
]);

/** Return structured actions; the host owns all Telegram callback identifiers. */
export function settingsScreenView(markdown: string) {
  const rows: Array<Array<{ id: string; label: string; style?: "success" | "danger" }>> = [];
  const text = markdown.replace(/<tg-button-row>([\s\S]*?)<\/tg-button-row>/gu, (_row, inner: string) => {
    const buttons = [...inner.matchAll(/<tg-button\b([^>]*)>([^<]+)<\/tg-button>/gu)]
      .flatMap(match => {
        const id = /\bdata="([^"]+)"/u.exec(match[1]!)?.[1];
        const style = /\bstyle="(success|danger)"/u.exec(match[1]!)?.[1] as "success" | "danger" | undefined;
        return id ? [{ id, label: match[2]!, ...(style ? { style } : {}) }] : [];
      });
    if (buttons.length) rows.push(buttons);
    return "";
  }).replace(/\n{3,}/gu, "\n\n").trim();
  rows.push([{ id: "close", label: "✕ Закрыть", style: "danger" }]);
  return { markdown: text, rows };
}
type Screen = typeof screens[number];
type Diagnostics = { configured: boolean; connectionCheck?: () => Promise<unknown>; capabilities?: () => Promise<unknown> };
const offerSchema = z.object({ schema: z.literal(1), identity: z.string(), revision: z.number().int().min(0), policy: policySchema, screen: z.enum(screens), createdAt: z.number().finite(), token: z.uuid() }).strict();
const TTL = 10 * 60_000;
const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/([\\`*_{}\[\]()#+.!|~=-])/gu, "\\$1");
const richText = (value: string) => escape(value).split("\n").map(line => line ? `${line}  ` : "").join("\n");
const button = (label: string, reply: string, style?: "success" | "danger") => `<tg-button-row><tg-button type="callback_data"${style ? ` style="${style}"` : ""} data="${reply}">${label}</tg-button></tg-button-row>`;
const row = (...buttons: string[]) => `<tg-button-row>${buttons.map(value => value.replace(/<\/?tg-button-row>/gu, "")).join("")}</tg-button-row>`;
const block = (title: string, text: string) => `**${title}**  \n${text}`;
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
  async screen(raw: z.infer<typeof screenEventSchema>) {
    const event = screenEventSchema.parse(raw);
    if (event.type === "action" && event.actionId === "close")
      return { type: "close" as const, markdown: "Настройки Bitrix24 закрыты." };
    const result = await this.run(event.type === "open" ? { screen: "home" } : { reply: event.actionId });
    return { type: "show" as const, view: settingsScreenView(result.markdown) };
  }
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
      return { state: "confirmation_required", settings: current, expiresAt: new Date(offer.createdAt + TTL).toISOString(), confirmReply, cancelReply, approvalPrompt: prompt, markdown: [`# ⚙️ Изменить настройки`, block("Сейчас", richText(summary(current.policy))), block("После подтверждения", richText(summary(policy))), block("Что изменится", "Предыдущее превью задачи станет недействительным. Права webhook в Bitrix24 остаются прежними."), row(button("✓ Подтвердить", confirmReply, "success"), button("✕ Отменить", cancelReply, "danger"))].join("\n\n") };
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
    const titles: Record<Screen, string> = { home: "⚙️ Настройки Bitrix24", connection: "🔗 Подключение", capabilities: "🧩 Возможности", actions: "✍️ Действия", privacy: "🛡️ Персональные данные" };
    const lines = [`# ${titles[screen]}`];
    if (notice) lines.push(block("Результат", escape(notice)));
    const select = (label: string, choice: Choice) => button(label, `b24s:set:${settings.revision}:${choice}`);
    if (screen === "home") {
      let connection = "не настроен";
      if (this.#diagnostics.configured) {
        try { await this.#diagnostics.connectionCheck!(); connection = "работает"; }
        catch (error) { connection = `проверка не прошла (${error instanceof BitrixRequestError ? error.code : "CHECK_FAILED"})`; }
      }
      lines.push(block("Сейчас", richText(`Webhook: ${connection}\nДействия: ${modeLabel(p)}\nСотрудники: ${peopleLabel(p)}\nEmail: ${on(p.email)}`)),
        row(nav("🔗 Подключение", "connection"), nav("🧩 Возможности", "capabilities")),
        "**Подключение** — проверить webhook.  \n**Возможности** — посмотреть выданные права.",
        row(nav("✍️ Действия", "actions"), nav("🛡️ Данные", "privacy")),
        "**Действия** — выбрать чтение или запись.  \n**Данные** — выбрать поля сотрудников.");
      if (!this.#store.data) lines.push(block("Нужна проверка установки", "Приватные данные плагина недоступны. Изменение настроек и запись закрыты."));
      if (settings.revision === 0) lines.push(block("Первый запуск", "Показаны исходные настройки установки. Выберите и сохраните нужный режим в разделах выше."));
    } else if (screen === "connection" || screen === "capabilities") {
      if (!this.#diagnostics.configured) lines.push(block("Webhook не настроен", "Запустите установщик в терминале сервера Ивы. Секрет в чат не отправляйте."));
      else {
        try {
          if (screen === "connection") {
            await this.#diagnostics.connectionCheck!();
            lines.push(block("✅ Соединение работает", "Доступ к методам задач проверен. Задачи и документы не читались."));
          } else {
            const result = await this.#diagnostics.capabilities!() as { grantedScopes?: string[] };
            const scopes = new Set(result.grantedScopes ?? []);
            const hasPeople = ["user_brief", "user_basic", "user"].some(value => scopes.has(value));
            const features = [["Задачи и чек-листы", scopes.has("task")], ["Обсуждения нового чата", scopes.has("task") && scopes.has("im")], ["Проекты", scopes.has("sonet_group")], ["Сотрудники", hasPeople], ["Подразделения", scopes.has("department")], ["Вложения задач", scopes.has("task") && scopes.has("disk")], ["Методы действий", scopes.has("task") && hasPeople]] as const;
            lines.push(block("Права webhook", features.map(([label, available]) => `${available ? "✅" : "○"} ${label}: ${available ? "есть" : "нет"}`).join("  \n")),
              block("Ограничения плагина", richText(`Действия: ${modeLabel(p)}\nEmail: ${p.email ? "разрешён настройкой" : "скрыт настройкой"}\nПраво на email: ${scopes.has("user_basic") || scopes.has("user") ? "есть" : "нужен user_basic"}`)),
              block("Как понимать проверку", "Права webhook не доказывают доступ ко всем объектам или возможность записи. Права сотрудника проверяются для каждого действия."),
              block("Изменить права", "Bitrix24 → Приложения → Ресурсы разработчика → webhook → Права доступа."));
          }
          const timestamp = new Date(this.#now()).toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
          lines.push(block("Проверено", escape(timestamp)));
        } catch (error) {
          const code = error instanceof BitrixRequestError ? error.code : "CHECK_FAILED";
          const hint = ["NO_AUTH_FOUND", "INVALID_CREDENTIALS"].includes(code) ? "Проверьте или замените webhook через установщик."
            : ["ACCESS_DENIED", "INSUFFICIENT_SCOPE"].includes(code) ? "Проверьте права webhook и его пользователя в Bitrix24."
            : "Повторите проверку. При повторной ошибке проверьте сеть и настройку webhook.";
          lines.push(block("Проверка не завершена", `${escape(code)}  \n${hint}`));
        }
      }
      lines.push(nav("↻ Проверить снова", screen));
    } else if (screen === "actions") {
      lines.push(block("Режим работы", escape(modeLabel(p))),
        row(select(p.mode === "read_only" ? "Чтение ✓" : "Чтение", "read"), select(p.mode === "confirmed_write" ? "Запись ✓" : "Запись", "write")),
        "**Чтение** — без изменений на портале.  \n**Запись** — каждое действие через превью и подтверждение.",
        block("Файлы и сообщения", richText(`Загрузка в Bitrix: ${on(p.uploads)}\nУдаление из чата задачи: ${on(p.deletions)}`)),
        row(select(p.uploads ? "Загрузка ✓" : "Загрузка ○", p.uploads ? "upload_off" : "upload_on"), select(p.deletions ? "Удаление ✓" : "Удаление ○", p.deletions ? "delete_off" : "delete_on")),
        "**Загрузка** — отправлять выбранные файлы в Bitrix.  \n**Удаление** — удалять выбранные сообщения и файлы чата.",
        block("Когда действуют разрешения", "Загрузка и удаление доступны только в режиме записи. Скачивание относится к чтению. Обновление самого плагина подтверждается отдельно."));
    } else {
      lines.push(block("Поля сотрудников", escape(peopleLabel(p))),
        row(select(p.people === "ids" ? "ID ✓" : "ID", "ids"), select(p.people === "names" ? "Имена ✓" : "Имена", "names"), select(p.people === "work" ? "Профиль ✓" : "Профиль", "work")),
        "**ID** — имена скрыты, сотрудников выбирают по номеру; поиск по имени недоступен.  \n**Имена** — ID и имя без должности, подразделений и email.  \n**Профиль** — имя, должность и подразделения.",
        block("Рабочая почта", p.email ? "Email разрешён настройкой и зависит от прав webhook." : "Email скрыт."));
      if (p.people === "work") lines.push(select(p.email ? "✉️ Скрыть email" : "✉️ Разрешить email", p.email ? "email_off" : "email_on"));
      else lines.push("Для email сначала выберите рабочий профиль.");
      lines.push(block("Что ограничивается", "Структурированные поля сотрудников и превью до передачи модели. Телефоны, адреса и фото не запрашиваются."),
        block("Что остаётся в данных", "Тексты задач, обсуждений, имена файлов и документы могут содержать персональные сведения. Эта настройка их не обезличивает. Уже полученные сообщения и память Ивы не очищаются."));
    }
    if (screen !== "home") lines.push(nav("‹ Настройки Bitrix24", "home"));
    return { state: "screen", screen, settings, markdown: lines.join("\n\n") };
  }
}
