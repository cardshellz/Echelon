import { randomUUID } from "node:crypto";
import { DropshipError } from "../domain/errors";
import type { DropshipLogger } from "../application/dropship-ports";

// Each resource/page gets at most 15 seconds of provider IO plus two bounded
// delays. Paginated discovery can read multiple pages. Writes never use this helper.
export const EBAY_SETUP_READ_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [250, 750] as const;
const MAX_RETRY_AFTER_MS = 2_000;
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface EbaySetupReadRuntime {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  reference(): string;
  logger: DropshipLogger;
}

export const defaultEbaySetupReadRuntime: EbaySetupReadRuntime = {
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  reference: randomUUID,
  logger: {
    info: (event) => console.info(JSON.stringify({ level: "info", ...event })),
    warn: (event) => console.warn(JSON.stringify({ level: "warn", ...event })),
    error: (event) => console.error(JSON.stringify({ level: "error", ...event })),
  },
};

export function retryAfterMilliseconds(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000
      ? seconds * 1000 : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Retry transient setup GETs only. Permission, validation and unknown errors fail immediately. */
export async function retryEbaySetupRead<T>(read: () => Promise<T>, runtime = defaultEbaySetupReadRuntime): Promise<T> {
  const diagnosticReference = runtime.reference();
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await read();
      if (attempt > 1) runtime.logger.info({ code: "DROPSHIP_EBAY_SETUP_READ_RECOVERED",
        message: "eBay setup read recovered after a transient failure.", context: { diagnosticReference, attempts: attempt } });
      return result;
    } catch (error) {
      if (!(error instanceof DropshipError)) throw error;
      const status = error.context?.status;
      const transient = error.code === "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE"
        && error.context?.retryable === true
        && (status === undefined || (typeof status === "number" && TRANSIENT_HTTP_STATUSES.has(status)));
      const retryAfter = typeof error.context?.retryAfterMs === "number" ? error.context.retryAfterMs : 0;
      const canRetry = transient && attempt <= RETRY_DELAYS_MS.length && retryAfter <= MAX_RETRY_AFTER_MS;
      const failure = new DropshipError(error.code, error.message, {
        ...error.context, diagnosticReference, attempts: attempt,
      });
      // Allowlist diagnostic fields. Never emit provider bodies, URLs, credentials or header values.
      const context = { diagnosticReference, attempts: attempt, errorCode: failure.code,
        storeConnectionId: error.context?.storeConnectionId, resource: error.context?.resource,
        status, providerErrorIds: error.context?.providerErrorIds, retryable: transient };
      if (!canRetry) {
        runtime.logger.warn({ code: "DROPSHIP_EBAY_SETUP_READ_FAILED", message: "eBay setup read failed.", context });
        throw failure;
      }
      const delayMs = Math.max(RETRY_DELAYS_MS[attempt - 1], retryAfter);
      runtime.logger.warn({ code: "DROPSHIP_EBAY_SETUP_READ_RETRY", message: "Retrying a transient eBay setup read.",
        context: { ...context, delayMs } });
      await runtime.sleep(delayMs);
    }
  }
}
