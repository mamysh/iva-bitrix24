import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, loadConfig } from "../src/config.ts";

test("accepts a canonical HTTPS webhook base URL", () => {
  const config = loadConfig({
    BITRIX24_WEBHOOK_BASE_URL:
      "https://portal.example.invalid/rest/123/test/",
  });
  assert.equal(
    config.webhookBaseUrl.href,
    "https://portal.example.invalid/rest/123/test",
  );
  assert.equal(config.portalOrigin, "https://portal.example.invalid");
  assert.equal(config.webhookUserId, 123);
});

for (const [name, value] of [
  ["missing", undefined],
  ["plain HTTP", "http://example.test/rest/1/secret"],
  ["query string", "https://example.test/rest/1/secret?leak=yes"],
  ["fragment", "https://example.test/rest/1/secret#leak"],
  ["user info", "https://owner:password@example.test/rest/1/secret"],
  ["wrong path", "https://example.test/not-rest/1/secret"],
] as const) {
  test(`rejects ${name} without echoing the configured value`, () => {
    assert.throws(
      () => loadConfig({ BITRIX24_WEBHOOK_BASE_URL: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        if (value) assert.equal(error.message.includes(value), false);
        assert.equal(error.message.includes("password"), false);
        assert.equal(error.message.includes("secret?"), false);
        return true;
      },
    );
  });
}
