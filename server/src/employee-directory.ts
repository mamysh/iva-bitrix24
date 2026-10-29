import { candidatePresentation } from "./employee-presentation.ts";
import { z } from "zod/v4";
import { BitrixClient, BitrixRequestError } from "./bitrix-client.ts";
import type { SettingsStore } from "./settings.ts";

export const employeeId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const employeeLookupSchema = z
  .object({
    kind: z.enum(["people", "departments"]),
    query: z.string().trim().min(2).max(100).optional(),
    id: employeeId.optional(),
    email: z.email().max(254).optional(),
    start: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict()
  .refine(
    (v) =>
      [v.query, v.id, v.email].filter((v) => v !== undefined).length === 1 &&
      !(v.kind === "departments" && v.email),
    "Provide exactly one query, id or employee email",
  );

export const personSchema = z
  .object({
    id: employeeId,
    name: z.string().max(200),
    lastName: z.string().max(200),
    email: z.string().max(320),
    position: z.string().max(300),
    departmentIds: z.array(employeeId).max(100),
    active: z.boolean(),
  })
  .strict();
export const departmentSchema = z
  .object({
    id: employeeId,
    name: z.string().min(1).max(500),
    path: z.string().min(1).max(2000),
  })
  .strict();
export type Person = z.infer<typeof personSchema>;
export type Department = z.infer<typeof departmentSchema>;
const rawPerson = z.object({
  ID: z.union([z.string(), z.number()]),
  NAME: z.string(),
  LAST_NAME: z.string(),
  EMAIL: z.string(),
  WORK_POSITION: z.string().optional(),
  UF_DEPARTMENT: z.array(z.union([z.string(), z.number()])),
  ACTIVE: z.union([z.enum(["Y", "N"]), z.boolean()]),
});
const rawDepartment = z.object({
  ID: z.union([z.string(), z.number()]),
  NAME: z.string().min(1),
  PARENT: z.union([z.string(), z.number()]).optional(),
});
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(
          next[j]! + 1,
          row[j + 1]! + 1,
          row[j]! + (a[i] === b[j] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[b.length]!;
}
export function approximateMatch(query: string, label: string): boolean {
  const words = normalize(label).split(" ");
  return normalize(query)
    .split(" ")
    .every((q) =>
      words.some(
        (w) =>
          w.includes(q) ||
          (q.length >= 4 &&
            ((q.includes(w) && w.length >= 4) ||
              distance(q, w) <= (q.length >= 8 ? 2 : 1))),
      ),
    );
}
export class EmployeeDirectory {
  readonly client: BitrixClient;
  readonly settings: SettingsStore;
  constructor(client: BitrixClient, settings: SettingsStore) {
    this.client = client;
    this.settings = settings;
  }
  async policy() {
    const current = await this.settings.read();
    if (current.policy.people !== "work" || !current.policy.email)
      throw new BitrixRequestError("EMPLOYEE_PROFILE_REQUIRED");
    return current;
  }
  async scopes() {
    const scopes = await this.client.call("scope");
    if (!Array.isArray(scopes))
      throw new BitrixRequestError("INVALID_RESPONSE");
    const granted = new Set(
      scopes
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.toLowerCase()),
    );
    for (const scope of ["user", "department"])
      if (!granted.has(scope))
        throw new BitrixRequestError("INSUFFICIENT_SCOPE", false, scope);
  }
  person(raw: unknown): Person {
    const p = rawPerson.safeParse(raw);
    if (!p.success) throw new BitrixRequestError("EMPLOYEE_RESPONSE_INVALID");
    const v = p.data;
    const out = personSchema.safeParse({
      id: Number(v.ID),
      name: v.NAME,
      lastName: v.LAST_NAME,
      email: v.EMAIL,
      position: v.WORK_POSITION ?? "",
      departmentIds: [...new Set(v.UF_DEPARTMENT.map(Number).filter((id) =>
        !((v.ACTIVE === "N" || v.ACTIVE === false) && id === 0),
      ))].sort(
        (a, b) => a - b,
      ),
      active: v.ACTIVE === "Y" || v.ACTIVE === true,
    });
    if (!out.success) throw new BitrixRequestError("EMPLOYEE_RESPONSE_INVALID");
    return out.data;
  }
  async getPerson(id: number) {
    const result = await this.client.call("user.get", {
      FILTER: { ID: id },
      select: [
        "ID",
        "NAME",
        "LAST_NAME",
        "EMAIL",
        "WORK_POSITION",
        "UF_DEPARTMENT",
        "ACTIVE",
      ],
    });
    if (!Array.isArray(result) || result.length !== 1)
      throw new BitrixRequestError("EMPLOYEE_NOT_FOUND");
    const person = this.person(result[0]);
    if (person.id !== id) throw new BitrixRequestError("EMPLOYEE_NOT_FOUND");
    return person;
  }
  async byEmail(email: string) {
    const page = await this.client.callPage("user.get", {
      FILTER: { EMAIL: email },
      select: [
        "ID",
        "NAME",
        "LAST_NAME",
        "EMAIL",
        "WORK_POSITION",
        "UF_DEPARTMENT",
        "ACTIVE",
      ],
      start: 0,
    });
    if (
      !Array.isArray(page.result) ||
      page.next !== null ||
      page.result.length > 1
    )
      throw new BitrixRequestError("EMPLOYEE_EMAIL_AMBIGUOUS");
    const result = page.result.map((v) => this.person(v));
    if (result.some((v) => v.email.toLowerCase() !== email.toLowerCase()))
      throw new BitrixRequestError("EMPLOYEE_EMAIL_AMBIGUOUS");
    return result;
  }
  async department(id: number): Promise<Department> {
    const seen = new Set<number>();
    const names: string[] = [];
    let current = id;
    while (current !== 0 && seen.size < 12) {
      if (seen.has(current))
        throw new BitrixRequestError("DEPARTMENT_PATH_INVALID");
      seen.add(current);
      const result = await this.client.call("department.get", { ID: current });
      if (!Array.isArray(result) || result.length !== 1)
        throw new BitrixRequestError("DEPARTMENT_NOT_FOUND");
      const parsed = rawDepartment.safeParse(result[0]);
      if (!parsed.success || Number(parsed.data.ID) !== current)
        throw new BitrixRequestError("DEPARTMENT_PATH_INVALID");
      names.unshift(parsed.data.NAME);
      const parent =
        parsed.data.PARENT === undefined || parsed.data.PARENT === ""
          ? 0
          : Number(parsed.data.PARENT);
      if (!Number.isSafeInteger(parent) || parent < 0)
        throw new BitrixRequestError("DEPARTMENT_PATH_INVALID");
      current = parent;
    }
    if (current !== 0) throw new BitrixRequestError("DEPARTMENT_PATH_INVALID");
    const result = departmentSchema.safeParse({
      id,
      name: names[names.length - 1],
      path: names.join(" / "),
    });
    if (!result.success)
      throw new BitrixRequestError("DEPARTMENT_PATH_INVALID");
    return result.data;
  }
  async lookup(raw: z.input<typeof employeeLookupSchema>) {
    const input = employeeLookupSchema.parse(raw);
    await this.policy();
    const items: Array<Person | Department> = [];
    let nextStart: number | null = null;
    let skipped = 0;
    if (input.id !== undefined)
      items.push(
        input.kind === "people"
          ? await this.getPerson(input.id)
          : await this.department(input.id),
      );
    else if (input.email) items.push(...(await this.byEmail(input.email)));
    else {
      // Inspect ten raw records per call. Search never hides an unscanned tail.
      const page = await this.client.callPage(
        input.kind === "people" ? "user.get" : "department.get",
        {
          sort: "ID",
          order: "ASC",
          start: input.start,
          ...(input.kind === "people"
            ? {
                select: [
                  "ID",
                  "NAME",
                  "LAST_NAME",
                  "EMAIL",
                  "WORK_POSITION",
                  "UF_DEPARTMENT",
                  "ACTIVE",
                ],
              }
            : {}),
        },
      );
      if (!Array.isArray(page.result))
        throw new BitrixRequestError("INVALID_RESPONSE");
      const selected = page.result.slice(0, 10);
      nextStart = page.result.length > 10 ? input.start + 10 : page.next;
      if (nextStart !== null && nextStart <= input.start)
        throw new BitrixRequestError("INVALID_RESPONSE");
      for (const raw of selected) {
        try {
          if (input.kind === "people") {
            const person = this.person(raw);
            if (
              approximateMatch(
                input.query!,
                `${person.name} ${person.lastName}`,
              )
            )
              items.push(person);
          } else {
            const d = rawDepartment.parse(raw);
            const department = await this.department(
              employeeId.parse(Number(d.ID)),
            );
            if (approximateMatch(input.query!, department.path))
              items.push(department);
          }
        } catch (error) {
          if (
            error instanceof z.ZodError ||
            (error instanceof BitrixRequestError &&
              [
                "EMPLOYEE_RESPONSE_INVALID",
                "DEPARTMENT_PATH_INVALID",
                "DEPARTMENT_NOT_FOUND",
              ].includes(error.code))
          )
            skipped++;
          else throw error;
        }
      }
    }
    await this.policy(); // Recheck privacy after the portal requests.
    return {
      kind: input.kind,
      items,
      presentation: candidatePresentation(input.kind, items, nextStart === null && skipped === 0),
      nextStart,
      complete: nextStart === null && skipped === 0,
      skipped,
      approximate: input.query !== undefined,
      untrustedContent: true,
    };
  }
}
