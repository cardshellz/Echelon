/**
 * ShipStation V1 HTTP requester with an explicit replay policy.
 *
 * WHY THIS EXISTS. The previous in-service `apiRequest` treated every 429 the
 * same way: sleep for `X-Rate-Limit-Reset + 1` seconds and re-send the identical
 * request, regardless of method. For `POST /orders/createorder` WITHOUT an
 * `orderId` that is a blind replay of a non-idempotent create whose first
 * attempt has an unknown outcome. ShipStation's orderKey upsert is not a
 * reliable dedup under that pattern (see #58408 and #62452), so the replay can
 * mint a second ShipStation order for the same shipment.
 *
 * Policy:
 *   - Read-only methods (GET/HEAD/OPTIONS) are replay-safe by default.
 *   - Mutations are NOT replay-safe by default. A caller opts in with
 *     `{ replaySafe: true }` only when the request is an idempotent upsert
 *     addressed by an explicit provider id (`orderId`), e.g. cancel, hold,
 *     mark-as-shipped, or a fetch-modify-write-back update.
 *   - A 429 on a request that is not replay-safe is surfaced as a transient
 *     `ShipStationRateLimitError` after exactly one send. Callers on the durable
 *     retry ladder re-drive the whole operation later, where the pre-create
 *     lookup (`getOrderByKey`) adopts whatever the first attempt created.
 *   - Every request carries an abort timeout. A push holds a pinned database
 *     connection (session advisory lock) for the duration of its HTTP calls,
 *     so an unbounded hang would pin a pool slot indefinitely.
 */

export const SS_RATE_LIMITED = "SS_RATE_LIMITED";
export const SS_REQUEST_TIMEOUT = "SS_REQUEST_TIMEOUT";

export type ShipStationTransientErrorCode =
  | typeof SS_RATE_LIMITED
  | typeof SS_REQUEST_TIMEOUT;

export interface ShipStationTransientErrorContext {
  code: ShipStationTransientErrorCode;
  method: string;
  path: string;
  attempt: number;
  replaySafe: boolean;
  retryAfterSeconds?: number;
  timeoutMs?: number;
}

/**
 * Transient ShipStation transport failure. Deliberately NOT a
 * `ShipStationPushError`: the retry worker classifies `SS_PUSH_INVALID_SHIPMENT`
 * as permanent (dead-letter + requires_review); everything else, including
 * these, stays on the transient ladder.
 */
export class ShipStationTransientError extends Error {
  readonly classification = "transient" as const;

  constructor(
    message: string,
    public readonly context: ShipStationTransientErrorContext,
  ) {
    super(message);
    this.name = "ShipStationTransientError";
  }
}

export class ShipStationRateLimitError extends ShipStationTransientError {
  constructor(message: string, context: ShipStationTransientErrorContext) {
    super(message, context);
    this.name = "ShipStationRateLimitError";
  }
}

export class ShipStationRequestTimeoutError extends ShipStationTransientError {
  constructor(message: string, context: ShipStationTransientErrorContext) {
    super(message, context);
    this.name = "ShipStationRequestTimeoutError";
  }
}

export interface ShipStationRequestOptions {
  /**
   * Whether this exact request may be re-sent after a 429. Defaults to true
   * for read-only methods and false for mutations. Opt a mutation in ONLY when
   * it is an idempotent upsert addressed by an explicit provider id.
   */
  replaySafe?: boolean;
  /** Maximum number of replays after a 429 for replay-safe requests. */
  retries?: number;
  /** Per-attempt abort timeout. */
  timeoutMs?: number;
}

export type ShipStationApiRequester = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: ShipStationRequestOptions,
) => Promise<T>;

export interface ShipStationApiRequesterDependencies {
  buildUrl: (path: string) => string;
  getAuthHeader: () => string;
  /** Resolved per call so tests that swap `globalThis.fetch` keep working. */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn(line: string): void };
  requestTimeoutMs?: number;
}

/** Matches the replay budget the service has always used for rate limits. */
export const DEFAULT_RATE_LIMIT_RETRIES = 3;
/** Fallback when ShipStation sends no usable reset header. */
const DEFAULT_RATE_LIMIT_RESET_SECONDS = 5;
/**
 * ShipStation's documented window is one minute; anything larger is a
 * malformed header, and a replay-safe wait happens under a pinned connection.
 */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 90;
/** Extra second on top of the reset header, unchanged from the old behavior. */
const RATE_LIMIT_WAIT_BUFFER_SECONDS = 1;

export const DEFAULT_SHIPSTATION_REQUEST_TIMEOUT_MS = 60_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isReplaySafeByDefault(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toUpperCase());
}

export function resolveShipStationRequestTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(environment.SHIPSTATION_REQUEST_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= MIN_REQUEST_TIMEOUT_MS && raw <= MAX_REQUEST_TIMEOUT_MS
    ? raw
    : DEFAULT_SHIPSTATION_REQUEST_TIMEOUT_MS;
}

/**
 * Seconds to wait before a replay-safe retry. Reads ShipStation's
 * `X-Rate-Limit-Reset` (seconds until the window resets) and falls back to the
 * standard `Retry-After`. Non-numeric or negative values fall back to a fixed
 * default; oversized values are clamped.
 */
export function parseRateLimitResetSeconds(headers: { get(name: string): string | null }): number {
  const raw = headers.get("x-rate-limit-reset") ?? headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RATE_LIMIT_RESET_SECONDS;
  }
  return Math.min(parsed, MAX_RATE_LIMIT_WAIT_SECONDS);
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < MIN_REQUEST_TIMEOUT_MS || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `ShipStation request timeoutMs must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}, got ${String(value)}`,
    );
  }
  return value;
}

function normalizeRetries(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`ShipStation request retries must be an integer between 0 and 10, got ${String(value)}`);
  }
  return value;
}

export function createShipStationApiRequester(
  dependencies: ShipStationApiRequesterDependencies,
): ShipStationApiRequester {
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = dependencies.logger ?? console;
  const defaultTimeoutMs = normalizeTimeoutMs(
    dependencies.requestTimeoutMs ?? resolveShipStationRequestTimeoutMs(),
  );

  return async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    options: ShipStationRequestOptions = {},
  ): Promise<T> {
    const normalizedMethod = method.toUpperCase();
    const replaySafe = options.replaySafe ?? isReplaySafeByDefault(normalizedMethod);
    const retries = normalizeRetries(options.retries ?? DEFAULT_RATE_LIMIT_RETRIES);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? defaultTimeoutMs);
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const url = dependencies.buildUrl(path);
    const headers: Record<string, string> = {
      Authorization: dependencies.getAuthHeader(),
      "Content-Type": "application/json",
    };
    const serializedBody = body ? JSON.stringify(body) : undefined;

    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: normalizedMethod,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new ShipStationRequestTimeoutError(
            `ShipStation API ${normalizedMethod} ${path} timed out after ${timeoutMs}ms`,
            {
              code: SS_REQUEST_TIMEOUT,
              method: normalizedMethod,
              path,
              attempt,
              replaySafe,
              timeoutMs,
            },
          );
        }
        throw error;
      }

      if (res.status === 429) {
        const retryAfterSeconds = parseRateLimitResetSeconds(res.headers);
        const canReplay = replaySafe && attempt < retries;
        logger.warn(JSON.stringify({
          level: "warn",
          action: "shipstation_rate_limited",
          outcome: canReplay ? "replay_scheduled" : "aborted_without_replay",
          method: normalizedMethod,
          path,
          attempt,
          retries,
          replay_safe: replaySafe,
          retry_after_seconds: retryAfterSeconds,
        }));
        if (!canReplay) {
          throw new ShipStationRateLimitError(
            `ShipStation API ${normalizedMethod} ${path} was rate limited (429)` +
              (replaySafe
                ? ` and exhausted ${retries} replay(s)`
                : "; the request is not replay-safe, so it was sent exactly once"),
            {
              code: SS_RATE_LIMITED,
              method: normalizedMethod,
              path,
              attempt,
              replaySafe,
              retryAfterSeconds,
            },
          );
        }
        await sleep((retryAfterSeconds + RATE_LIMIT_WAIT_BUFFER_SECONDS) * 1000);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(
          `ShipStation API ${normalizedMethod} ${path} failed (${res.status}): ${errorBody}`,
        );
      }

      return res.json() as Promise<T>;
    }
  };
}
