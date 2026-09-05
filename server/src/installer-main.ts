import { readConfiguredWebhook, probeWebhook, writeWebhookAtomic } from "./installer.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 4096) throw new Error("Введённое значение слишком длинное.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath) throw new Error("Не указан путь конфигурации плагина.");

  const entered = await readStdin();
  const raw = entered || (await readConfiguredWebhook(envPath));
  if (!raw) throw new Error("Webhook не введён, а сохранённой конфигурации нет.");

  const normalized = await probeWebhook(raw);
  await writeWebhookAtomic(envPath, normalized);
  console.log("✓ Webhook принят, доступ к профилю и задачам проверен.");
  console.log("✓ Конфигурация сохранена с закрытыми правами.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка настройки.";
  console.error(`✗ ${message}`);
  process.exitCode = 1;
});
