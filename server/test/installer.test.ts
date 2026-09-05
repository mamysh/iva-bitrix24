import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InstallerError,
  parseWebhookBaseUrl,
  probeWebhook,
  writeWebhookAtomic,
} from "../src/installer.ts";

const secret = "https://portal.example.invalid/rest/123/installer_test_secret";

test("normalizes a valid incoming webhook without exposing it in errors", () => {
  assert.equal(parseWebhookBaseUrl(`${secret}/`).toString(), secret);
  for (const value of [
    "",
    "http://portal.example.invalid/rest/1/secret",
    "https://portal.example.invalid/rest/1/secret?leak=yes",
    "https://user:password@portal.example.invalid/rest/1/secret",
    "https://portal.example.invalid/not-rest/1/secret",
  ]) {
    assert.throws(
      () => parseWebhookBaseUrl(value),
      (error: unknown) => {
        assert.ok(error instanceof InstallerError);
        if (value) assert.equal(error.message.includes(value), false);
        assert.equal(error.message.includes("password@"), false);
        return true;
      },
    );
  }
});

test("checks profile and task access using POST and refuses redirects", async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    methods.push(url.pathname.split("/").at(-1) ?? "");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.equal(await probeWebhook(secret, { fetchImpl }), secret);
  assert.deepEqual(methods, ["profile.json", "tasks.task.getFields.json"]);

  await assert.rejects(
    probeWebhook(secret, {
      fetchImpl: async () => new Response("", { status: 302 }),
    }),
    (error: unknown) =>
      error instanceof InstallerError && error.code === "REDIRECT_REFUSED",
  );
});

test("maps authorization errors without echoing the webhook", async () => {
  await assert.rejects(
    probeWebhook(secret, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "NO_AUTH_FOUND" }), { status: 401 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof InstallerError);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /не принял webhook/u);
      return true;
    },
  );

  let calls = 0;
  await assert.rejects(
    probeWebhook(secret, {
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ result: {} }), { status: 200 })
          : new Response(JSON.stringify({ error: "insufficient_scope" }), {
              status: 403,
            });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof InstallerError);
      assert.equal(error.code, "INSUFFICIENT_SCOPE");
      assert.match(error.message, /Задачи.*task.*Ресурсы разработчика/u);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );

  await assert.rejects(
    probeWebhook(secret, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: secret }), { status: 200 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof InstallerError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.code, "UPSTREAM_ERROR");
      return true;
    },
  );
});

test("writes the env atomically with mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iva-bitrix24-installer-"));
  const envPath = join(directory, "bitrix24-read.env");
  await writeWebhookAtomic(envPath, secret);
  assert.equal(await readFile(envPath, "utf8"), `BITRIX24_WEBHOOK_BASE_URL=${secret}\n`);
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
});
