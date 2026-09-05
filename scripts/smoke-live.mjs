import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { BitrixClient } from "../server/src/bitrix-client.ts";
import { loadConfig } from "../server/src/config.ts";
import { TaskReader } from "../server/src/tasks.ts";

const secretFile = process.argv[2];
if (!secretFile) {
  console.error("Usage: npm run smoke:live -- /absolute/path/to/secrets.env");
  process.exit(2);
}

const info = await stat(secretFile);
if ((info.mode & 0o077) !== 0) {
  console.error("Refusing to read a secrets file accessible to group or other users");
  process.exit(2);
}

const source = await readFile(secretFile, "utf8");
const values = {};
for (const line of source.split("\n")) {
  const match = line.match(
    /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u,
  );
  if (!match) continue;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  values[match[1]] = value;
}

const webhook =
  values.BITRIX24_WEBHOOK_BASE_URL ?? values.BITRIX24_WEBHOOK_URL;
const config = loadConfig({ BITRIX24_WEBHOOK_BASE_URL: webhook });
const reader = new TaskReader(new BitrixClient(config));

const report = {};
try {
  const connection = await reader.connectionCheck();
  report.profileRead = connection?.connected === true;

  const listed = await reader.listTasks({
    scope: "mine",
    limit: 1,
    start: 0,
    sortBy: "CHANGED_DATE",
    sortDirection: "desc",
  });
  report.taskListRead = Array.isArray(listed?.tasks);
  report.returned = typeof listed?.returned === "number" ? listed.returned : null;
  report.taskPayloadShapeValid =
    !listed?.tasks?.length ||
    (typeof listed.tasks[0] === "object" &&
      Object.hasOwn(listed.tasks[0], "title") &&
      !Object.hasOwn(listed.tasks[0], "description"));

  const firstTaskId = listed?.tasks?.[0]?.id;
  if (
    (typeof firstTaskId === "number" && Number.isInteger(firstTaskId)) ||
    (typeof firstTaskId === "string" && /^\d+$/u.test(firstTaskId))
  ) {
    const history = await reader.taskHistory({
      taskId: Number(firstTaskId),
      limit: 1,
      start: 0,
      sortDirection: "desc",
    });
    report.taskHistoryRead = Array.isArray(history?.events);
    report.historyPayloadShapeValid =
      !history?.events?.length ||
      (typeof history.events[0] === "object" &&
        !Object.hasOwn(history.events[0]?.actor ?? {}, "login"));
  } else {
    report.taskHistoryRead = null;
    report.historyPayloadShapeValid = null;
  }

  const fields = await reader.taskFields();
  report.taskFieldsRead = Array.isArray(fields?.fields);
  report.fieldCount = Array.isArray(fields?.fields) ? fields.fields.length : null;
  report.ok =
    report.profileRead &&
    report.taskListRead &&
    report.taskPayloadShapeValid &&
    report.taskHistoryRead !== false &&
    report.historyPayloadShapeValid !== false &&
    report.taskFieldsRead;
} catch (error) {
  report.ok = false;
  report.error = typeof error?.code === "string" ? error.code : "SMOKE_FAILED";
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
