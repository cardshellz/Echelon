/** Bound local session ownership. An abort does NOT prove the provider cancelled its write. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
export const PROVIDER_RETRY_AFTER_MAX_SECONDS = 15;

export class QuantityProviderRequestTimeoutError extends Error {
  readonly code = "QUANTITY_PROVIDER_REQUEST_TIMEOUT";
  readonly outcome = "uncertain";
  constructor() { super("Provider request exceeded the local deadline; remote outcome remains uncertain."); }
}

export function createProviderRequestDeadline(timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS): {
  signal: AbortSignal; dispose(): void;
} {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PROVIDER_REQUEST_TIMEOUT_MS) throw new Error("Invalid provider request deadline.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new QuantityProviderRequestTimeoutError()), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export function boundedProviderRetryAfterSeconds(value: string | null | undefined, fallback: number): number {
  const seconds = value != null && /^\d+$/.test(value.trim()) ? Number(value) : fallback;
  return Number.isFinite(seconds) ? Math.min(PROVIDER_RETRY_AFTER_MAX_SECONDS, Math.max(0, seconds))
    : PROVIDER_RETRY_AFTER_MAX_SECONDS;
}
