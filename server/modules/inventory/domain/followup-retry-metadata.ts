/**
 * Bounded exponential-backoff and dead-letter metadata encoding for outbox
 * tables that store `last_error: text` without a dedicated retry-counter column
 * (zero-migration outbox resilience for `transfer_followups` and `replen_followups`).
 */

export const DEFAULT_MAX_FOLLOWUP_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

const RETRY_PREFIX_RE = /^\[retry attempt=(\d+) next=([^\]]+)\]\s*/;
const DEAD_LETTER_PREFIX_RE = /^\[DEAD_LETTER attempts=(\d+)\]\s*/;

export interface ParsedFollowupRetryState {
  attempts: number;
  nextRetryAt: Date | null;
  deadLettered: boolean;
  rawMessage: string;
}

export function parseFollowupRetryState(
  lastError: string | null | undefined,
): ParsedFollowupRetryState {
  const text = String(lastError ?? "");
  if (!text) {
    return { attempts: 0, nextRetryAt: null, deadLettered: false, rawMessage: "" };
  }

  const deadMatch = DEAD_LETTER_PREFIX_RE.exec(text);
  if (deadMatch) {
    return {
      attempts: Math.max(1, Number.parseInt(deadMatch[1], 10) || DEFAULT_MAX_FOLLOWUP_ATTEMPTS),
      nextRetryAt: null,
      deadLettered: true,
      rawMessage: text.slice(deadMatch[0].length),
    };
  }

  const retryMatch = RETRY_PREFIX_RE.exec(text);
  if (retryMatch) {
    const attempts = Math.max(1, Number.parseInt(retryMatch[1], 10) || 1);
    const parsedTs = new Date(retryMatch[2]);
    return {
      attempts,
      nextRetryAt: Number.isNaN(parsedTs.getTime()) ? null : parsedTs,
      deadLettered: false,
      rawMessage: text.slice(retryMatch[0].length),
    };
  }

  return { attempts: 1, nextRetryAt: null, deadLettered: false, rawMessage: text };
}

export function isFollowupReadyForRetry(
  lastError: string | null | undefined,
  now: Date,
): boolean {
  const parsed = parseFollowupRetryState(lastError);
  if (parsed.deadLettered) return false;
  if (parsed.nextRetryAt && now.getTime() < parsed.nextRetryAt.getTime()) {
    return false;
  }
  return true;
}

export function computeFollowupBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, safeAttempt - 1));
}

export function formatFollowupRetryError(
  previousLastError: string | null | undefined,
  errorMessage: string,
  now: Date,
  maxAttempts: number = DEFAULT_MAX_FOLLOWUP_ATTEMPTS,
): { formattedError: string; attempts: number; deadLettered: boolean; nextRetryAt: Date | null } {
  const prior = parseFollowupRetryState(previousLastError);
  const attempts = prior.attempts + 1;
  const cleanMsg = String(prior.rawMessage && !errorMessage ? prior.rawMessage : errorMessage || "unknown_error").trim();

  if (attempts >= maxAttempts) {
    const prefix = `[DEAD_LETTER attempts=${attempts}] `;
    return {
      formattedError: `${prefix}${cleanMsg}`.slice(0, 2000),
      attempts,
      deadLettered: true,
      nextRetryAt: null,
    };
  }

  if (attempts === 1) {
    return {
      formattedError: cleanMsg.slice(0, 2000),
      attempts: 1,
      deadLettered: false,
      nextRetryAt: null,
    };
  }

  const backoffMs = computeFollowupBackoffMs(attempts);
  const nextRetryAt = new Date(now.getTime() + backoffMs);
  const prefix = `[retry attempt=${attempts} next=${nextRetryAt.toISOString()}] `;
  return {
    formattedError: `${prefix}${cleanMsg}`.slice(0, 2000),
    attempts,
    deadLettered: false,
    nextRetryAt,
  };
}
