import assert from "node:assert/strict";
import test from "node:test";
import {
  BitrixClient,
  BitrixRequestError,
  type AllowedMethod,
} from "../src/bitrix-client.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig({
  BITRIX24_WEBHOOK_BASE_URL:
    "https://portal.example.invalid/rest/123/test",
});

test("sends an allowlisted method by POST without exposing the secret in output", async () => {
  let request: { url: string; init: RequestInit | undefined } | undefined;
  const client = new BitrixClient(config, {
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return Response.json({ result: { ID: "123" } });
    },
  });

  assert.deepEqual(await client.call("profile"), { ID: "123" });
  assert.equal(request?.url.endsWith("/profile.json"), true);
  assert.equal(request?.init?.method, "POST");
  assert.equal(request?.init?.redirect, "manual");
  assert.equal(JSON.stringify(await client.call("profile")).includes("/rest/123/test"), false);
});

test("preserves safe pagination metadata for bounded list consumers", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json({
        result: { tasks: [{ id: "1" }] },
        next: 50,
        total: 73,
      }),
  });

  assert.deepEqual(await client.callPage("tasks.task.list"), {
    result: { tasks: [{ id: "1" }] },
    next: 50,
    total: 73,
  });
});

test("rejects negative pagination metadata from upstream", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json({ result: { tasks: [] }, next: -50, total: -1 }),
  });

  const page = await client.callPage("tasks.task.list");
  assert.equal(page.next, null);
  assert.equal(page.total, null);
});

test("builds a task page URL without exposing the webhook secret", () => {
  const client = new BitrixClient(config);
  const url = client.taskWebUrl(77);
  assert.equal(
    url,
    "https://portal.example.invalid/company/personal/user/123/tasks/task/view/77/",
  );
  assert.equal(url.includes("/rest/"), false);
  assert.equal(url.includes("secret"), false);
});

test("refuses a non-allowlisted method before network access", async () => {
  let fetched = false;
  const client = new BitrixClient(config, {
    fetch: async () => {
      fetched = true;
      return Response.json({ result: {} });
    },
  });

  await assert.rejects(
    client.call("tasks.task.delete" as AllowedMethod),
    (error: unknown) =>
      error instanceof BitrixRequestError && error.code === "METHOD_NOT_ALLOWED",
  );
  assert.equal(fetched, false);
});

test("retries 503 and returns a safe terminal error", async () => {
  let calls = 0;
  const waits: number[] = [];
  const client = new BitrixClient(config, {
    fetch: async () => {
      calls += 1;
      return Response.json(
        {
          error: "QUERY_LIMIT_EXCEEDED",
          error_description:
            "do not leak https://portal.example.invalid/rest/123/test",
        },
        { status: 503 },
      );
    },
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    random: () => 0,
  });

  await assert.rejects(client.call("profile"), (error: unknown) => {
    assert.ok(error instanceof BitrixRequestError);
    assert.equal(error.code, "QUERY_LIMIT_EXCEEDED");
    assert.equal(error.message.includes("/rest/123/test"), false);
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test("refuses redirects", async () => {
  const client = new BitrixClient(config, {
    fetch: async () => new Response(null, { status: 302 }),
  });
  await assert.rejects(
    client.call("profile"),
    (error: unknown) =>
      error instanceof BitrixRequestError && error.code === "REDIRECT_REFUSED",
  );
});

test("does not retry authorization failures or expose their description", async () => {
  let calls = 0;
  const client = new BitrixClient(config, {
    fetch: async () => {
      calls += 1;
      return Response.json(
        {
          error: "NO_AUTH_FOUND",
          error_description: "synthetic upstream details /rest/123/test",
        },
        { status: 401 },
      );
    },
  });
  await assert.rejects(client.call("profile"), (error: unknown) => {
    assert.ok(error instanceof BitrixRequestError);
    assert.equal(error.code, "NO_AUTH_FOUND");
    assert.equal(error.message.includes("/rest/123/test"), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("does not expose a malformed upstream error code", async () => {
  const secret = "https://portal.example.invalid/rest/123/test";
  const client = new BitrixClient(config, {
    fetch: async () => Response.json({ error: secret }, { status: 400 }),
  });

  await assert.rejects(client.call("profile"), (error: unknown) => {
    assert.ok(error instanceof BitrixRequestError);
    assert.equal(error.code, "UPSTREAM_ERROR");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("attaches only the allowlisted required scope to insufficient-scope errors", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json(
        { error: "insufficient_scope", error_description: "hidden upstream detail" },
        { status: 403 },
      ),
  });

  await assert.rejects(client.call("im.dialog.messages.get"), (error: unknown) => {
    assert.ok(error instanceof BitrixRequestError);
    assert.equal(error.code, "INSUFFICIENT_SCOPE");
    assert.equal(error.requiredScope, "im");
    assert.equal(error.message.includes("hidden upstream detail"), false);
    return true;
  });
});

test("normalizes ambiguous task error zero without reading its description", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      Response.json(
        {
          error: "0",
          error_description: "secret task context must not be reflected",
        },
        { status: 400 },
      ),
  });

  await assert.rejects(client.call("tasks.task.get", { taskId: 1 }), (error: unknown) => {
    assert.ok(error instanceof BitrixRequestError);
    assert.equal(error.code, "TASK_NOT_FOUND_OR_DENIED");
    assert.equal(error.message.includes("secret task context"), false);
    return true;
  });
});

test("bounds the upstream response body", async () => {
  const client = new BitrixClient(config, {
    fetch: async () =>
      new Response("{}", {
        headers: { "content-length": "1000001" },
      }),
  });
  await assert.rejects(
    client.call("profile"),
    (error: unknown) =>
      error instanceof BitrixRequestError &&
      error.code === "RESPONSE_TOO_LARGE",
  );
});

test("turns an aborted request into a safe timeout error", async () => {
  const client = new BitrixClient(
    { ...config, timeoutMs: 5, maxAttempts: 1 },
    {
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("contains unsafe upstream context", "AbortError"));
          });
        }),
    },
  );
  await assert.rejects(
    client.call("profile"),
    (error: unknown) =>
      error instanceof BitrixRequestError && error.code === "TIMEOUT",
  );
});
