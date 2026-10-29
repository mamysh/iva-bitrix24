import { randomBytes, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { BitrixRequestError } from "./bitrix-client.ts";
import {
  EmployeeDirectory,
  departmentSchema,
  employeeId,
  personSchema,
  type Department,
} from "./employee-directory.ts";
import { SettingsStore, withPolicyLock, writePrivateJson } from "./settings.ts";

const draftId = z.string().regex(/^[a-f0-9]{16}$/u);
const revision = z.number().int().nonnegative().max(999999999999);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (v) => !/[\p{Cc}\p{Cf}<>]/u.test(v),
      "Control characters and markup are not accepted",
    );
const fieldsSchema = z
  .object({
    userId: employeeId.nullable().optional(),
    name: text(80).nullable().optional(),
    lastName: text(80).nullable().optional(),
    email: z.email().max(254).nullable().optional(),
    position: text(120).nullable().optional(),
    departmentIds: z
      .array(employeeId)
      .min(1)
      .max(5)
      .refine((v) => new Set(v).size === v.length)
      .nullable()
      .optional(),
    departmentMode: z.enum(["replace", "add"]).nullable().optional(),
  })
  .strict();
export const employeeDraftInputSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("collect"),
      action: z.enum(["invite", "update", "dismiss"]).optional(),
      draftId: draftId.optional(),
      version: revision.optional(),
      fields: fieldsSchema,
    })
    .strict()
    .refine(
      (v) =>
        v.draftId
          ? v.version !== undefined && v.action === undefined
          : v.action !== undefined && v.version === undefined,
      "New drafts need action; edits need draftId/version",
    ),
  z.object({ op: z.literal("preview"), draftId, version: revision }).strict(),
  z.object({ op: z.literal("cancel"), draftId, version: revision }).strict(),
  z.object({ op: z.literal("status"), draftId }).strict(),
  z.object({ op: z.literal("present"), draftId, version: revision }).strict(),
]);
// MCP discovery requires an object at the root. The strict union above still
// validates operation-specific required/forbidden fields before any side effect.
export const employeeDraftToolSchema = z.object({
  op:z.enum(["collect","preview","present","cancel","status"]),
  action:z.enum(["invite","update","dismiss"]).optional(),
  draftId:draftId.optional(),version:revision.optional(),fields:fieldsSchema.optional(),
}).strict();
const snapshotSchema = z
  .object({
    before: personSchema.nullable(),
    departments: z.array(departmentSchema).max(100),
    desired: z
      .object({
        ACTIVE: z.literal("N").optional(),
        NAME: text(80).optional(),
        LAST_NAME: text(80).optional(),
        EMAIL: z.email().max(254).optional(),
        WORK_POSITION: z.string().max(120).optional(),
        UF_DEPARTMENT: z.array(employeeId).min(1).max(100).optional(),
      })
      .strict(),
    fingerprint: z.string(),
    settingsRevision: revision,
    summary: z.string().min(1).max(1500),
  })
  .strict();
const draftSchema = z
  .object({
    id: draftId,
    identity: z.string(),
    version: revision,
    action: z.enum(["invite", "update", "dismiss"]),
    fields: fieldsSchema,
    state: z.enum([
      "collecting",
      "ready",
      "queued",
      "running",
      "applied",
      "rejected",
      "unknown",
      "cancelled",
    ]),
    createdAt: z.number().finite(),
    expiresAt: z.number().finite(),
    snapshot: snapshotSchema.optional(),
    userId: employeeId.optional(),
    code: z.string().optional(),
  })
  .strict();
type Draft = z.infer<typeof draftSchema>;
const tokenSchema = z.string().regex(/^[a-f0-9]{24}$/u);
const offerSchema = z
  .object({
    token: tokenSchema,
    draftId,
    draftVersion: revision,
    revision,
    identity: z.string(),
    createdAt: z.number().finite(),
    expiresAt: z.number().finite(),
    state: z.enum(["offer", "done", "cancelled"]),
  })
  .strict();
type Offer = z.infer<typeof offerSchema>;
const documentSchema = z
  .object({
    schema: z.literal(1),
    revision,
    drafts: z.record(draftId, draftSchema),
    offers: z.record(tokenSchema, offerSchema),
  })
  .strict();
type Document = z.infer<typeof documentSchema>;
const TTL = 30 * 60_000;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const mutable = (d: Draft) => ["collecting", "ready"].includes(d.state);
const stateLabels: Record<Draft["state"], string> = {
  collecting: "нужны данные",
  ready: "ожидает апрува",
  queued: "принята, ожидает выполнения",
  running: "выполняется",
  applied: "выполнена и проверена",
  rejected: "не выполнена",
  unknown: "исход требует сверки",
  cancelled: "отменена",
};

/** MCP can collect/read/cancel only. enqueue is called exclusively by the private Panels service. */
export class EmployeeManager {
  readonly directory: EmployeeDirectory;
  readonly store: SettingsStore;
  readonly now: () => number;
  #running = false;
  constructor(
    directory: EmployeeDirectory,
    store: SettingsStore,
    now = Date.now,
  ) {
    this.directory = directory;
    this.store = store;
    this.now = now;
  }
  path() {
    this.store.path("settings.json");
    return join(this.store.data!, "employees.json");
  }
  async load(): Promise<Document> {
    try {
      if ((await stat(this.path())).size > 16 * 1024 * 1024) throw new Error();
      const d = documentSchema.parse(
        JSON.parse(await readFile(this.path(), "utf8")),
      );
      if (
        Object.entries(d.drafts).some(([id, v]) => id !== v.id) ||
        Object.entries(d.offers).some(
          ([token, v]) => token !== v.token || !d.drafts[v.draftId],
        )
      )
        throw new Error();
      return d;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schema: 1, revision: 0, drafts: {}, offers: {} };
      if (error instanceof BitrixRequestError) throw error;
      throw new BitrixRequestError("EMPLOYEE_STORAGE_INVALID");
    }
  }
  async save(d: Document, increment = true) {
    if (increment) d.revision++;
    const parsed = documentSchema.parse(d);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 16 * 1024 * 1024)
      throw new BitrixRequestError("EMPLOYEE_JOURNAL_FULL");
    await writePrivateJson(this.path(), parsed, this.store.data!);
  }
  async allowed() {
    const current = await this.directory.policy();
    if (current.policy.mode !== "confirmed_write")
      throw new BitrixRequestError("READ_ONLY_MODE");
    if (current.policy.employees !== true)
      throw new BitrixRequestError("EMPLOYEES_DISABLED");
    return current;
  }
  get(d: Document, id: string) {
    const draft = d.drafts[id];
    if (!draft || draft.identity !== this.store.identity)
      throw new BitrixRequestError("EMPLOYEE_DRAFT_NOT_FOUND");
    return draft;
  }
  fresh(draft: Draft, expectedVersion: number) {
    if (!mutable(draft) || draft.version !== expectedVersion)
      throw new BitrixRequestError("EMPLOYEE_DRAFT_CHANGED");
    if (this.now() < draft.createdAt || this.now() >= draft.expiresAt)
      throw new BitrixRequestError("EMPLOYEE_DRAFT_EXPIRED");
  }
  missing(draft: Draft) {
    const f = draft.fields;
    if (draft.action === "dismiss") return [!f.userId && "userId"].filter(Boolean);
    return draft.action === "invite"
      ? [
          !f.name && "name",
          !f.lastName && "lastName",
          !f.email && "email",
          !f.departmentIds && "departmentIds",
        ].filter(Boolean)
      : [
          !f.userId && "userId",
          f.departmentIds && !f.departmentMode && "departmentMode",
          ![
            f.name,
            f.lastName,
            f.email,
            f.departmentIds,
            f.position !== undefined,
          ].some(Boolean) && "changes",
        ].filter(Boolean);
  }
  view(draft: Draft) {
    return {
      draftId: draft.id,
      version: draft.version,
      action: draft.action,
      state: draft.state,
      stateLabel: stateLabels[draft.state],
      fields: draft.fields,
      missing: this.missing(draft),
      expiresAt: draft.expiresAt,
      ...(draft.snapshot ? { summary: draft.snapshot.summary } : {}),
      ...(draft.userId ? { userId: draft.userId } : {}),
      ...(draft.code ? { code: draft.code } : {}),
      approval:
        draft.state === "ready"
          ? "Покажите карточку подтверждения здесь в чате через op=present. Выбор сотрудника или отдела не является подтверждением действия."
          : null,
      untrustedContent: true,
    };
  }
  async request(raw: z.input<typeof employeeDraftInputSchema>) {
    const input = employeeDraftInputSchema.parse(raw);
    await this.directory.policy();
    if (input.op === "status") {
      const result = this.view(this.get(await this.load(), input.draftId));
      await this.directory.policy();
      return result;
    }
    return withPolicyLock(this.store.data, async () => {
      if (input.op !== "cancel") await this.allowed();
      const doc = await this.load();
      if (input.op === "collect") {
        if (!input.draftId && Object.keys(doc.drafts).length >= 1000)
          throw new BitrixRequestError("EMPLOYEE_JOURNAL_FULL");
        const draft: Draft = input.draftId
          ? this.get(doc, input.draftId)
          : {
              id: randomBytes(8).toString("hex"),
              identity: this.store.identity,
              version: 0,
              action: input.action!,
              fields: {},
              state: "collecting",
              createdAt: this.now(),
              expiresAt: this.now() + TTL,
            };
        if (input.draftId) this.fresh(draft, input.version!);
        const fields = { ...draft.fields, ...input.fields };
        if (
          draft.action === "invite" &&
          (fields.userId || fields.departmentMode)
        )
          throw new BitrixRequestError("EMPLOYEE_FIELDS_INVALID");
        if (draft.action === "dismiss" && Object.keys(fields).some((key) => key !== "userId"))
          throw new BitrixRequestError("EMPLOYEE_FIELDS_INVALID");
        draft.fields = fields;
        draft.version++;
        draft.state = "collecting";
        delete draft.snapshot;
        doc.drafts[draft.id] = draft;
        await this.save(doc);
        return this.view(draft);
      }
      const draft = this.get(doc, input.draftId);
      if (input.op === "present" && draft.state !== "ready") throw new BitrixRequestError("EMPLOYEE_DRAFT_CHANGED");
      if (input.op === "cancel") {
        if (!mutable(draft) || draft.version !== input.version)
          throw new BitrixRequestError("EMPLOYEE_DRAFT_CHANGED");
      } else this.fresh(draft, input.version);
      if (input.op === "cancel") {
        draft.state = "cancelled";
        draft.version++;
      } else if (input.op !== "present") {
        if (this.missing(draft).length) return this.view(draft);
        await this.directory.scopes();
        await this.noConflict(doc, draft);
        draft.snapshot = await this.snapshot(draft);
        draft.state = "ready";
        draft.version++;
      }
      if (input.op !== "present") await this.save(doc);
      return this.view(draft);
    });
  }
  async noConflict(doc: Document, draft: Draft) {
    const email = draft.fields.email?.toLowerCase();
    for (const other of Object.values(doc.drafts)) {
      if (other.state === "ready" && this.now() >= other.expiresAt) continue;
      if (
        other.id === draft.id ||
        other.identity !== draft.identity ||
        !["queued", "running", "unknown", "ready"].includes(other.state)
      )
        continue;
      if (
        (email && other.fields.email?.toLowerCase() === email) ||
        (draft.fields.userId && draft.fields.userId === other.fields.userId)
      )
        throw new BitrixRequestError("EMPLOYEE_CONFLICTING_DRAFT");
    }
  }
  async snapshot(draft: Draft): Promise<z.infer<typeof snapshotSchema>> {
    const current = await this.allowed();
    const f = draft.fields;
    const before =
      draft.action !== "invite"
        ? await this.directory.getPerson(f.userId!)
        : null;
    if (before && !before.active)
      throw new BitrixRequestError("EMPLOYEE_INACTIVE");
    if (draft.action === "dismiss") {
      if (Object.keys(f).some((key) => key !== "userId"))
        throw new BitrixRequestError("EMPLOYEE_FIELDS_INVALID");
      if (f.userId === this.directory.client.webhookUserId)
        throw new BitrixRequestError("EMPLOYEE_INTEGRATION_ACCOUNT");
    }
    const desired: z.infer<typeof snapshotSchema>["desired"] = {};
    if (draft.action === "dismiss") desired.ACTIVE = "N";
    if (f.name) desired.NAME = f.name;
    if (f.lastName) desired.LAST_NAME = f.lastName;
    if (f.email) {
      const existing = await this.directory.byEmail(f.email);
      if (existing.some((v) => v.id !== before?.id))
        throw new BitrixRequestError("EMPLOYEE_EMAIL_EXISTS");
      desired.EMAIL = f.email;
    }
    if (f.position !== undefined) desired.WORK_POSITION = f.position ?? "";
    if (f.departmentIds)
      desired.UF_DEPARTMENT = [
        ...new Set(
          f.departmentMode === "add"
            ? [...before!.departmentIds, ...f.departmentIds]
            : f.departmentIds,
        ),
      ].sort((a, b) => a - b);
    const departments: Department[] = [];
    const ids = [
      ...new Set([
        ...(before?.departmentIds ?? []),
        ...(desired.UF_DEPARTMENT ?? []),
      ]),
    ].sort((a, b) => a - b);
    for (const id of ids) departments.push(await this.directory.department(id));
    const names = (values: readonly number[]) =>
      values
        .map((id) => `${departments.find((d) => d.id === id)!.path} [${id}]`)
        .join(", ") || "не указано";
    const lines = [
      draft.action === "invite"
        ? "Пригласить сотрудника и отправить стандартное приглашение на email?"
        : `${draft.action === "dismiss" ? "Уволить" : "Изменить"} сотрудника ${before!.name} ${before!.lastName} [${before!.id}]?`,
    ];
    const line = (label: string, value: string, previous?: string) =>
      lines.push(
        `${label}: ${previous === undefined ? value : `${previous || "не указано"} → ${value || "не указано"}`}`,
      );
    if (draft.action === "dismiss") {
      line("Email", before!.email);
      line("Должность", before!.position || "не указано");
      line("Подразделения", names(before!.departmentIds));
      line("Статус", "Уволен", "Активен");
      lines.push("Учётная запись станет неактивной. Профиль, задачи, переписка и файлы сохранятся. Передача дел и управление интеграциями не выполняются.");
    }
    if (desired.NAME !== undefined) line("Имя", desired.NAME, before?.name);
    if (desired.LAST_NAME !== undefined)
      line("Фамилия", desired.LAST_NAME, before?.lastName);
    if (desired.EMAIL !== undefined)
      line("Email", desired.EMAIL, before?.email);
    if (desired.WORK_POSITION !== undefined)
      line("Должность", desired.WORK_POSITION, before?.position);
    if (desired.UF_DEPARTMENT !== undefined)
      line(
        "Подразделения",
        names(desired.UF_DEPARTMENT),
        before ? names(before.departmentIds) : undefined,
      );
    lines.push(
      "После подтверждения заявка поступит в обработку. Результат в Битриксе проверим отдельно.",
    );
    const summary = lines.join("\n");
    if (summary.length > 1500)
      throw new BitrixRequestError("PREVIEW_TOO_LARGE");
    // Include relevant profile and full hierarchy: an external edit invalidates approval.
    return snapshotSchema.parse({
      before,
      desired,
      departments,
      settingsRevision: current.revision,
      fingerprint: hash({ before, desired, departments }),
      summary,
    });
  }
  async screen(page = 0) {
    const doc = await this.load();
    let enabled = true;
    try {
      await this.allowed();
    } catch {
      enabled = false;
    }
    const drafts = Object.values(doc.drafts)
      .filter((d) => d.identity === this.store.identity)
      .reverse();
    const selected = drafts.slice(page * 3, page * 3 + 3);
    const displayName = (d: Draft) =>
      `${d.fields.name ?? d.snapshot?.before?.name ?? ""} ${d.fields.lastName ?? d.snapshot?.before?.lastName ?? ""}`
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .trim()
        .slice(0, 100) || `Сотрудник №${d.fields.userId ?? "?"}`;
    const body = enabled
      ? selected
          .map(
            (d, i) =>
              `${i + 1}. ${d.action === "invite" ? "Пригласить" : d.action === "dismiss" ? "Уволить" : "Изменить"}: ${displayName(d)} — ${stateLabels[d.state]}${this.now() >= d.expiresAt && mutable(d) ? ", срок истёк" : ""}`,
          )
          .join("\n")
      : "";
    const rows: Array<
      Array<{ label: string; action?: string; target?: string }>
    > = selected.flatMap((d, i) =>
      enabled && d.state === "ready" && this.now() < d.expiresAt
        ? [
            [
              {
                label: `${i + 1}. Проверить: ${displayName(d)}`.slice(0, 48),
                action: `emp-${d.id}`,
              },
            ],
          ]
        : [],
    );
    const nav: Array<{ label: string; target: string }> = [];
    if (page > 0)
      nav.push({ label: "‹ Назад", target: `employees-${page - 1}` });
    if (drafts.length > page * 3 + 3)
      nav.push({ label: "Далее ›", target: `employees-${page + 1}` });
    if (nav.length) rows.push(nav);
    rows.push([{ label: "‹ Настройки Bitrix24", target: "home" }]);
    if (enabled) await this.allowed();
    return {
      state: "screen",
      revision: doc.revision,
      title: "Заявки сотрудников",
      body: `${enabled ? "Подтверждение принимает заявку в очередь. Успех на портале показывается отдельно." : "Управление закрыто. Включите управление сотрудниками, запись, рабочий профиль и email в настройках."}\n\n${body || "Заявок нет. Опишите нужное действие Иве в чате."}`,
      rows,
    };
  }
  reply(offer: Offer, doc: Document) {
    if (offer.state === "done")
      return {
        state: "done",
        token: offer.token,
        revision: offer.revision + 1,
        message:
          "Заявка принята в очередь. Это ещё не подтверждение изменения в Битриксе. Обновите «Заявки сотрудников» или спросите Иву о результате.",
      };
    if (offer.state === "cancelled")
      return {
        state: "cancelled",
        token: offer.token,
        revision: offer.revision,
        message:
          "Подтверждение отменено или устарело. Подготовьте актуальное превью в чате с Ивой.",
      };
    return {
      state: "offer",
      token: offer.token,
      revision: offer.revision,
      expiresAt: offer.expiresAt,
      summary: this.get(doc, offer.draftId).snapshot!.summary,
    };
  }
  async expireOffers() {
    return withPolicyLock(this.store.data, async () => {
      const doc = await this.load();
      const current = await this.store.read();
      let changed = false;
      for (const offer of Object.values(doc.offers)) {
        if (offer.state !== "offer") continue;
        const draft = doc.drafts[offer.draftId]!;
        if (
          offer.identity !== this.store.identity ||
          this.now() < offer.createdAt ||
          this.now() >= offer.expiresAt ||
          draft.state !== "ready" ||
          draft.version !== offer.draftVersion ||
          doc.revision !== offer.revision ||
          current.revision !== draft.snapshot?.settingsRevision
        ) {
          offer.state = "cancelled";
          changed = true;
        }
      }
      if (changed) await this.save(doc, false);
    });
  }
  async hasToken(token: string) {
    return Boolean((await this.load()).offers[token]);
  }
  async panels(
    input:
      | { op: "prepare"; action: string; revision: number; token: string }
      | { op: "confirm" | "cancel" | "status"; token: string },
  ) {
    // The caller holds withPolicyLock, except for strictly read-only status.
    const doc = await this.load();
    if (input.op === "prepare") {
      const reject = () => ({
        state: "rejected",
        token: input.token,
        message:
          "Заявка или настройки изменились. Обновите экран; при необходимости подготовьте новое превью с Ивой.",
      });
      const old = doc.offers[input.token];
      if (old) {
        if (
          input.action !== `emp-${old.draftId}` ||
          input.revision !== old.revision
        )
          throw new BitrixRequestError("EMPLOYEE_DRAFT_CHANGED");
        return this.reply(old, doc);
      }
      if (
        doc.revision !== input.revision ||
        Object.keys(doc.offers).length >= 1000
      )
        return reject();
      const id = input.action.slice(4);
      const draft = this.get(doc, id);
      const current = await this.allowed();
      if (
        !draft.snapshot ||
        draft.state !== "ready" ||
        this.now() >= draft.expiresAt ||
        this.now() < draft.createdAt ||
        current.revision !== draft.snapshot.settingsRevision
      )
        return reject();
      if (
        Object.values(doc.offers).some(
          (o) => o.state === "offer" && this.now() < o.expiresAt,
        )
      )
        return reject();
      const offer: Offer = {
        token: tokenSchema.parse(input.token),
        draftId: draft.id,
        draftVersion: draft.version,
        revision: doc.revision,
        identity: this.store.identity,
        createdAt: this.now(),
        expiresAt: Math.min(this.now() + 10 * 60_000, draft.expiresAt),
        state: "offer",
      };
      doc.offers[offer.token] = offer;
      await this.save(doc, false);
      return this.reply(offer, doc);
    }
    const offer = doc.offers[input.token];
    if (!offer) throw new BitrixRequestError("EMPLOYEE_OFFER_NOT_FOUND");
    if (input.op === "status" || offer.state !== "offer")
      return this.reply(offer, doc);
    const draft = this.get(doc, offer.draftId);
    const current = await this.store.read();
    const valid =
      offer.identity === this.store.identity &&
      this.now() >= offer.createdAt &&
      this.now() < offer.expiresAt &&
      draft.state === "ready" &&
      draft.version === offer.draftVersion &&
      doc.revision === offer.revision &&
      current.revision === draft.snapshot?.settingsRevision;
    if (input.op === "cancel" || !valid) {
      offer.state = "cancelled";
      await this.save(doc, false);
      return this.reply(offer, doc);
    }
    await this.allowed();
    // Approval, queue entry and the Panels receipt are one durable atomic document.
    offer.state = "done";
    draft.state = "queued";
    await this.save(doc);
    return this.reply(offer, doc);
  }
  async runQueued() {
    if (this.#running) return;
    this.#running = true;
    try {
      await withPolicyLock(this.store.data, async () => {
        const doc = await this.load();
        // A process died after recording intent: never repeat that request, even if no response was saved.
        for (const d of Object.values(doc.drafts))
          if (d.state === "running") {
            d.state = "unknown";
            d.code = "EMPLOYEE_RESULT_UNKNOWN";
            await this.save(doc);
          }
        const draft = Object.values(doc.drafts).find(
          (d) => d.state === "queued",
        );
        if (!draft) return;
        let sent = false;
        let writeResponded = false;
        try {
          if (draft.identity !== this.store.identity)
            throw new BitrixRequestError("DRAFT_OWNER_CHANGED");
          if (this.now() < draft.createdAt || this.now() >= draft.expiresAt)
            throw new BitrixRequestError("EMPLOYEE_DRAFT_EXPIRED");
          await this.directory.scopes();
          const fresh = await this.snapshot(draft);
          if (
            fresh.settingsRevision !== draft.snapshot!.settingsRevision ||
            fresh.fingerprint !== draft.snapshot!.fingerprint
          )
            throw new BitrixRequestError("EMPLOYEE_CHANGED_SINCE_PREVIEW");
          // Block competing/unknown requests; this draft is excluded.
          await this.noConflict(doc, draft);
          draft.state = "running";
          await this.save(doc);
          if (this.now() < draft.createdAt || this.now() >= draft.expiresAt)
            throw new BitrixRequestError("EMPLOYEE_DRAFT_EXPIRED");
          sent = true;
          const result = await this.directory.client.write(
            draft.action === "invite" ? "user.add" : "user.update",
            {
              ...draft.snapshot!.desired,
              ...(draft.action !== "invite" ? { ID: draft.fields.userId } : {}),
            },
          );
          writeResponded = true;
          const id =
            draft.action === "invite"
              ? employeeId.parse(
                  Number(
                    z
                      .union([employeeId, z.string().regex(/^[1-9][0-9]*$/u)])
                      .parse(result),
                  ),
                )
              : draft.fields.userId!;
          if (draft.action !== "invite" && result !== true)
            throw new BitrixRequestError("EMPLOYEE_RESULT_UNKNOWN");
          draft.userId = id;
          // Persist the returned identity before read-back, but leave intent in running state.
          await this.save(doc);
          const actual = await this.directory.getPerson(id);
          const expected = draft.snapshot!.desired;
          if (
            actual.active !== (expected.ACTIVE !== "N") ||
            (expected.NAME !== undefined && actual.name !== expected.NAME) ||
            (expected.LAST_NAME !== undefined &&
              actual.lastName !== expected.LAST_NAME) ||
            (expected.EMAIL !== undefined &&
              actual.email.toLowerCase() !== expected.EMAIL.toLowerCase()) ||
            (expected.WORK_POSITION !== undefined &&
              actual.position !== expected.WORK_POSITION) ||
            (expected.UF_DEPARTMENT !== undefined &&
              JSON.stringify(actual.departmentIds) !==
                JSON.stringify(expected.UF_DEPARTMENT))
          )
            throw new BitrixRequestError("EMPLOYEE_READBACK_MISMATCH");
          draft.state = "applied";
        } catch (error) {
          const code =
            error instanceof BitrixRequestError
              ? error.code
              : "EMPLOYEE_RESULT_UNKNOWN";
          const definite =
            !writeResponded &&
            [
              "ACCESS_DENIED",
              "INSUFFICIENT_SCOPE",
              "ERROR_ARGUMENT",
              "ERROR_GROUPID",
              "ERROR_NO_GROUP",
            ].includes(code);
          draft.state = sent && !definite ? "unknown" : "rejected";
          draft.code = code;
        }
        await this.save(doc);
      });
    } finally {
      this.#running = false;
    }
  }
}
