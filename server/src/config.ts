const WEBHOOK_VARIABLE = "BITRIX24_WEBHOOK_BASE_URL";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type BitrixConfig = {
  readonly webhookBaseUrl: URL;
  readonly portalOrigin: string;
  readonly webhookUserId: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
};

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BitrixConfig {
  const raw = env[WEBHOOK_VARIABLE]?.trim();
  if (!raw) {
    throw new ConfigurationError(
      `${WEBHOOK_VARIABLE} is not configured in the plugin environment`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${WEBHOOK_VARIABLE} is not a valid URL`);
  }

  if (url.protocol !== "https:")
    throw new ConfigurationError(`${WEBHOOK_VARIABLE} must use HTTPS`);
  if (url.username || url.password)
    throw new ConfigurationError(`${WEBHOOK_VARIABLE} must not contain user info`);
  if (url.search || url.hash)
    throw new ConfigurationError(
      `${WEBHOOK_VARIABLE} must not contain a query string or fragment`,
    );
  const path = /^\/rest\/([1-9][0-9]*)\/[A-Za-z0-9_-]+\/?$/u.exec(
    url.pathname,
  );
  if (!path)
    throw new ConfigurationError(
      `${WEBHOOK_VARIABLE} must end with /rest/USER_ID/WEBHOOK_SECRET`,
    );

  url.pathname = url.pathname.replace(/\/+$/u, "");
  return {
    webhookBaseUrl: url,
    portalOrigin: url.origin,
    webhookUserId: Number(path[1]),
    timeoutMs: 10_000,
    maxAttempts: 3,
  };
}
