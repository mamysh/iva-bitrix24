import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitrixClient, BitrixRequestError } from "../src/bitrix-client.ts";
import { loadConfig } from "../src/config.ts";
import { TaskFileReader } from "../src/file-capabilities.ts";

const config = loadConfig({ BITRIX24_WEBHOOK_BASE_URL: "https://example.test/rest/1/secret" });

test("malformed tasks still consume the bounded document search budget", async () => {
  let pages = 0;
  const reader = makeReader(tmpdir(), (method) => {
    if (method === "profile") return { result: { ID: "1" } };
    if (method === "tasks.task.list") {
      pages += 1;
      assert.ok(pages <= 1, "search must stop after the first five malformed tasks");
      return { result: { tasks: Array.from({ length: 50 }, () => ({ id: "invalid" })) }, next: 50 };
    }
    assert.fail(`unexpected method: ${method}`);
  });
  const result = await reader.search({ query: "report", scope: "mine", phase: "open" });
  assert.equal(result.scannedTasks, 5);
  assert.equal(result.partial, true);
  assert.equal(result.nextCursor, "0:5");
  assert.deepEqual(result.matches, []);
});

function makeReader(root: string, handler: (method: string, params: Record<string, unknown>) => unknown, download?: (url: URL) => Response) {
  const client = new BitrixClient(config, { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return download?.(url) ?? new Response("missing", { status: 404 });
    const method = /\/([^/]+)\.json$/u.exec(url.pathname)?.[1] ?? "";
    return Response.json(handler(method, JSON.parse(String(init?.body)) as Record<string, unknown>));
  } });
  return new TaskFileReader(client, root);
}

test("combines task, current chat, and checklist files with safe metadata and n-prefixed IDs", async () => {
  const reader = makeReader(tmpdir(), (method) => {
    if (method === "tasks.task.get") return { result: { task: { ID: "7", CHAT_ID: "9", UF_TASK_WEBDAV_FILES: ["n10"] } } };
    if (method === "disk.attachedObject.get") return { result: { ID: "10", OBJECT_ID: "30", MODULE_ID: "tasks", ENTITY_TYPE: "tasks_task", ENTITY_ID: "7", NAME: "brief.pdf", SIZE: "12", CREATE_TIME: "2026-09-29T10:00:00+03:00", CREATED_BY: "2", DOWNLOAD_URL: "https://example.test/private-token" } };
    if (method === "disk.file.get") return { result: { ID: "30", CREATE_TIME: "2026-09-28T10:00:00+03:00", CREATED_BY: "2" } };
    if (method === "im.dialog.messages.get") return { result: { messages: [{ id: 11, text: "See chart", author_id: 3, date: "2026-09-29T11:00:00+03:00", params: { FILE_ID: [40] } }], files: [{ id: 40, name: "chart.png", size: 13, date: "2026-09-29T11:00:00+03:00", authorId: 3, urlDownload: "https://example.test/chat-secret" }] } };
    if (method === "task.checklistitem.getlist") return { result: [{ ID: "5", TASK_ID: "7", TITLE: "Check slide", CREATED_BY: "4", ATTACHMENTS: { 50: { FILE_ID: "50", ATTACHMENT_ID: "51", NAME: "slides.pptx", SIZE: "14", DOWNLOAD_URL: "https://example.test/check-secret" } } }] };
    throw Error(method);
  });
  const result = await reader.list(7);
  assert.deepEqual(result.files.map((item) => [item.key, item.format, item.source]), [
    ["task:10", "pdf", "task"], ["chat:11:40", "png", "chat"], ["checklist:5:50", "pptx", "checklist"],
  ]);
  assert.equal(result.files[1]?.context, "See chart");
  assert.equal(result.files[0]?.attachedAt, "2026-09-29T10:00:00+03:00");
  assert.equal(result.files[0]?.uploadedAt, "2026-09-28T10:00:00+03:00");
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  assert.equal(JSON.stringify(result).includes("chat-secret"), false);
});

test("downloads only a freshly listed file into attachments and releases that exact artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitrix-documents-"));
  try {
    const reader = makeReader(root, (method) => {
      if (method === "tasks.task.get") return { result: { task: { ID: "7", UF_TASK_WEBDAV_FILES: ["n10"] } } };
      if (method === "disk.attachedObject.get") return { result: { ID: "10", OBJECT_ID: "30", MODULE_ID: "tasks", ENTITY_TYPE: "tasks_task", ENTITY_ID: "7", NAME: "report.pdf", SIZE: 7 } };
      if (method === "task.commentitem.getlist" || method === "task.checklistitem.getlist") return { result: [] };
      if (method === "disk.file.get") return { result: { ID: "30", DOWNLOAD_URL: "https://example.test/rest/download.json?auth=private" } };
      throw Error(method);
    }, () => new Response("PDFDATA", { headers: { "content-type": "application/pdf", "content-length": "7" } }));
    const artifact = await reader.download(7, "task:10");
    assert.equal(artifact.bytes, 7);
    assert.equal(artifact.path.startsWith("bitrix24-read/"), true);
    assert.equal(await readFile(join(root, artifact.path), "utf8"), "PDFDATA");
    assert.equal((await stat(join(root, artifact.path))).mode & 0o777, 0o600);
    await reader.release(artifact.artifactId);
    await assert.rejects(stat(join(root, artifact.path)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses a signed URL outside the configured Bitrix24 origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitrix-documents-"));
  try {
    const reader = makeReader(root, (method) => {
      if (method === "tasks.task.get") return { result: { task: { ID: "7", UF_TASK_WEBDAV_FILES: [10] } } };
      if (method === "disk.attachedObject.get") return { result: { ID: "10", OBJECT_ID: "30", MODULE_ID: "tasks", ENTITY_TYPE: "tasks_task", ENTITY_ID: "7", NAME: "report.pdf", SIZE: 7 } };
      if (method === "task.commentitem.getlist" || method === "task.checklistitem.getlist") return { result: [] };
      if (method === "disk.file.get") return { result: { ID: "30", DOWNLOAD_URL: "https://untrusted.test/file" } };
      throw Error(method);
    });
    await assert.rejects(reader.download(7, "task:10"), (error: unknown) => error instanceof BitrixRequestError && error.code === "INVALID_DOWNLOAD_URL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses a download redirect to another origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitrix-documents-"));
  try {
    const reader = makeReader(root, (method) => {
      if (method === "tasks.task.get") return { result: { task: { ID: "7", UF_TASK_WEBDAV_FILES: [10] } } };
      if (method === "disk.attachedObject.get") return { result: { ID: "10", OBJECT_ID: "30", MODULE_ID: "tasks", ENTITY_TYPE: "tasks_task", ENTITY_ID: "7", NAME: "report.pdf" } };
      if (method === "task.commentitem.getlist" || method === "task.checklistitem.getlist") return { result: [] };
      if (method === "disk.file.get") return { result: { ID: "30", DOWNLOAD_URL: "https://example.test/download" } };
      throw Error(method);
    }, () => new Response(null, { status: 302, headers: { location: "https://other.test/private" } }));
    await assert.rejects(reader.download(7, "task:10"), (error: unknown) => error instanceof BitrixRequestError && error.code === "INVALID_DOWNLOAD_URL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("searches an open assigned task by filename and returns an explicit coverage cursor", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const reader = makeReader(tmpdir(), (method, params) => {
    calls.push({ method, params });
    if (method === "profile") return { result: { ID: "1" } };
    if (method === "tasks.task.list") return { result: { tasks: [{ ID: "7", TITLE: "Synthetic task" }] } };
    if (method === "tasks.task.get") return { result: { task: { ID: "7", UF_TASK_WEBDAV_FILES: [10] } } };
    if (method === "disk.attachedObject.get") return { result: { ID: "10", OBJECT_ID: "30", MODULE_ID: "tasks", ENTITY_TYPE: "tasks_task", ENTITY_ID: "7", NAME: "report.pdf", SIZE: 7 } };
    if (method === "disk.file.get") return { result: { ID: "30" } };
    if (method === "task.commentitem.getlist" || method === "task.checklistitem.getlist") return { result: [] };
    throw Error(method);
  });
  const result = await reader.search({ query: "report", scope: "mine", phase: "open" });
  assert.equal(result.found, 1);
  assert.equal(result.scannedTasks, 1);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(calls.find((call) => call.method === "tasks.task.list")?.params.filter, { RESPONSIBLE_ID: 1, "!REAL_STATUS": 5 });
});

test("views a downloaded PNG and refuses a second image page", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitrix-documents-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
  try {
    const reader = makeReader(root, (method) => {
      if (method === "tasks.task.get") return { result: { task: { ID: "7", UF_TASK_WEBDAV_FILES: [10] } } };
      if (method === "disk.attachedObject.get") return { result: { ID: "10", OBJECT_ID: "30", MODULE_ID: "tasks", ENTITY_TYPE: "tasks_task", ENTITY_ID: "7", NAME: "image.png", SIZE: png.length } };
      if (method === "task.commentitem.getlist" || method === "task.checklistitem.getlist") return { result: [] };
      if (method === "disk.file.get") return { result: { ID: "30", DOWNLOAD_URL: "https://example.test/download" } };
      throw Error(method);
    }, () => new Response(png, { headers: { "content-type": "image/png" } }));
    const artifact = await reader.download(7, "task:10");
    const view = await reader.viewPage(artifact.artifactId, 1);
    assert.equal(view.mimeType, "image/png");
    assert.equal(Buffer.from(view.data, "base64").equals(png), true);
    await assert.rejects(reader.viewPage(artifact.artifactId, 2), (error: unknown) => error instanceof BitrixRequestError && error.code === "INVALID_PAGE");
    await reader.release(artifact.artifactId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("searches employees in the owner's department and its child departments", async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const reader = makeReader(tmpdir(), (method, params) => {
    requests.push({ method, params });
    if (method === "profile") return { result: { ID: "1" } };
    if (method === "user.get" && params.ID === 1) return { result: [{ ID: "1", UF_DEPARTMENT: [10] }] };
    if (method === "department.get" && params.PARENT === 10) return { result: [{ ID: "11", PARENT: "10" }] };
    if (method === "department.get" && params.PARENT === 11) return { result: [] };
    if (method === "user.get" && params.UF_DEPARTMENT === 10) return { result: [{ ID: "1", UF_DEPARTMENT: [10] }, { ID: "2", UF_DEPARTMENT: [10] }] };
    if (method === "user.get" && params.UF_DEPARTMENT === 11) return { result: [{ ID: "3", UF_DEPARTMENT: [11] }] };
    if (method === "tasks.task.list") return { result: { tasks: [] } };
    throw Error(method);
  });
  const result = await reader.search({ query: "report", scope: "department", phase: "open" });
  assert.equal(result.nextCursor, null);
  assert.deepEqual(requests.filter(({ method }) => method === "tasks.task.list").map(({ params }) => (params.filter as Record<string, unknown>).RESPONSIBLE_ID), [2, 3]);
});
