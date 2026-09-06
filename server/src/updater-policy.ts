export const UPDATE_START_DELAY_MS = 5_000;

export function updateStartDelay(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return environment.IVA_BITRIX24_WORKER_DELAY_MS === "0"
    ? 0
    : UPDATE_START_DELAY_MS;
}
