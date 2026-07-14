import { canonicalJson } from "@shared/utils/canonical-json";

export const FINANCIAL_COMMAND_MAX_RETRIES = 3;
export const FINANCIAL_COMMAND_MAX_RETRY_AFTER_MS = 300_000;

type FinancialCommandErrorOptions = {
  status: number | null;
  code?: string;
  details?: Record<string, unknown>;
  responseBody?: unknown;
  retryAfterMs?: number | null;
  retryable: boolean;
  ambiguous: boolean;
  cause?: unknown;
};

/**
 * A structured command failure. `ambiguous` means the server may have applied
 * the mutation, so the caller must retain the intent key for an exact retry.
 */
export class FinancialCommandRequestError extends Error {
  readonly status: number | null;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly responseBody?: unknown;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(message: string, options: FinancialCommandErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FinancialCommandRequestError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.responseBody = options.responseBody;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable;
    this.ambiguous = options.ambiguous;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function structuredError(body: unknown): {
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (!isRecord(body)) {
    return { message: nonEmptyString(body)?.slice(0, 500) };
  }

  const nestedError = isRecord(body.error) ? body.error : undefined;
  const details = isRecord(body.details)
    ? body.details
    : nestedError && isRecord(nestedError.details)
      ? nestedError.details
      : undefined;
  return {
    message: nonEmptyString(body.error)
      ?? nonEmptyString(body.message)
      ?? nonEmptyString(nestedError?.message),
    code: nonEmptyString(details?.code)
      ?? nonEmptyString(body.code)
      ?? nonEmptyString(nestedError?.code),
    details,
  };
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds)) return FINANCIAL_COMMAND_MAX_RETRY_AFTER_MS;
    return Math.min(FINANCIAL_COMMAND_MAX_RETRY_AFTER_MS, seconds * 1_000);
  }
  if (!/[A-Za-z]/.test(normalized)) return null;
  const dueAt = Date.parse(normalized);
  return Number.isFinite(dueAt)
    ? Math.min(FINANCIAL_COMMAND_MAX_RETRY_AFTER_MS, Math.max(0, dueAt - nowMs))
    : null;
}

function retryableHttpFailure(status: number, code?: string): boolean {
  return status === 429
    || status >= 500
    || code === "FINANCIAL_COMMAND_IN_PROGRESS"
    || code === "FINANCIAL_COMMAND_STALE_OWNER";
}

/**
 * Fetch and decode a financial command without losing its structured error
 * contract. Every failure that could follow a committed mutation is marked
 * ambiguous so the same intent key can be reused safely.
 */
export async function financialCommandFetchJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (cause) {
    throw new FinancialCommandRequestError(
      "The request could not be completed. Retry will reuse the same command key.",
      {
        status: null,
        code: "FINANCIAL_COMMAND_TRANSPORT_ERROR",
        retryable: true,
        ambiguous: true,
        cause,
      },
    );
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (cause) {
    throw new FinancialCommandRequestError(
      "The command response could not be read. Retry will reuse the same command key.",
      {
        status: response.status,
        code: "FINANCIAL_COMMAND_RESPONSE_UNREADABLE",
        retryable: true,
        ambiguous: true,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        cause,
      },
    );
  }

  let body: unknown = rawBody;
  let parsedJson = false;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
      parsedJson = true;
    } catch {
      // Non-JSON error bodies are retained as text for a useful message. A
      // successful financial command must always return replayable JSON.
    }
  }

  if (!response.ok) {
    const structured = structuredError(body);
    const retryable = retryableHttpFailure(response.status, structured.code);
    throw new FinancialCommandRequestError(
      structured.message ?? `Financial command failed with HTTP ${response.status}`,
      {
        status: response.status,
        code: structured.code,
        details: structured.details,
        responseBody: body,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        retryable,
        ambiguous: retryable,
      },
    );
  }

  if (!rawBody || !parsedJson) {
    throw new FinancialCommandRequestError(
      "The command may have completed, but the server returned an invalid response. Retry will safely reuse the command key.",
      {
        status: response.status,
        code: "FINANCIAL_COMMAND_RESPONSE_INVALID",
        responseBody: body,
        retryable: true,
        ambiguous: true,
      },
    );
  }

  return body as T;
}

export function shouldRetryFinancialCommand(
  failureCount: number,
  error: unknown,
): boolean {
  return error instanceof FinancialCommandRequestError
    && error.retryable
    && failureCount < FINANCIAL_COMMAND_MAX_RETRIES;
}

export function financialCommandRetryDelay(
  attemptIndex: number,
  error: unknown,
): number {
  if (error instanceof FinancialCommandRequestError && error.retryAfterMs !== null) {
    return error.retryAfterMs;
  }
  return Math.min(10_000, 2_000 * (2 ** Math.max(0, attemptIndex)));
}

export type FinancialCommandIntentStore = {
  acquire(effectiveCommand: unknown): string;
  complete(idempotencyKey: string): void;
  fail(idempotencyKey: string, error: unknown): void;
};

/**
 * Retain a key only while an identical command is pending or its final outcome
 * is ambiguous. Acquiring a changed payload rotates the key immediately.
 */
export function createFinancialCommandIntentStore(
  generateKey: () => string,
): FinancialCommandIntentStore {
  let retained: { fingerprint: string; idempotencyKey: string } | null = null;

  return {
    acquire(effectiveCommand) {
      const fingerprint = canonicalJson(effectiveCommand);
      if (retained?.fingerprint === fingerprint) return retained.idempotencyKey;
      retained = { fingerprint, idempotencyKey: generateKey() };
      return retained.idempotencyKey;
    },

    complete(idempotencyKey) {
      if (retained?.idempotencyKey === idempotencyKey) retained = null;
    },

    fail(idempotencyKey, error) {
      if (retained?.idempotencyKey !== idempotencyKey) return;
      if (!(error instanceof FinancialCommandRequestError) || !error.ambiguous) {
        retained = null;
      }
    },
  };
}
