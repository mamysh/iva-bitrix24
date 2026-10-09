import { loadConfig } from "./config.ts";
import { SettingsStore, LEGACY_POLICY, RESTRICTED_POLICY } from "./settings.ts";

export function settingsFromEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const marker = env.BITRIX24_SETTINGS_DEFAULTS;
  const defaults = (marker !== undefined && marker !== "legacy") || !env.BITRIX24_WEBHOOK_BASE_URL ? RESTRICTED_POLICY : LEGACY_POLICY;
  let identity = "not-configured";
  try { const config = loadConfig(env); identity = `${config.portalOrigin}/${config.webhookUserId}`; } catch { /* never persist the webhook secret */ }
  return new SettingsStore(env.PLUGIN_DATA, identity, defaults);
}
