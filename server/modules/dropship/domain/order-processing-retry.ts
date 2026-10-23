import { DropshipError } from "./errors";

/**
 * Stuck dropship orders (plan v4 §7.1, v2 §7.1): a short, capped backoff, then
 * review. Before this, an intake that kept failing retryably was taken again
 * on every 10-second pass, oldest first, forever
 * (dropship-order-processing-runner.ts listProcessableIntakeIds), so a few
 * stuck orders filled every pass and newer orders for the same stock waited
 * behind them. Now each failure waits 1, 5, then 15 minutes, then every 15
 * minutes; the 64th failure leaves the intake `failed` for a person (Ops
 * Retry starts the count again). The 15-minute ceiling keeps an older stuck
 * order at most 15 minutes behind a newer order for the same stock.
 * Pure: the caller passes the failures so far and the time.
 */

/** // PROPOSED (sync-back): the waits after the 1st, 2nd and 3rd failure; every later failure waits the ceiling. */
export const ORDER_PROCESSING_RETRY_DELAYS_MS: readonly number[] = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);
/** // PROPOSED (sync-back): the longest wait between two attempts. */
export const ORDER_PROCESSING_RETRY_CEILING_MS = 15 * 60_000;
/** // PROPOSED (sync-back): the failure that stops automatic retries (about 15 hours after the first, at the delays above). */
export const ORDER_PROCESSING_MAX_ATTEMPTS = 64;

/** The code an intake is left `failed` with when its retries ran out. */
export const ORDER_PROCESSING_RETRIES_EXHAUSTED_CODE = "DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED";
/** A shortfall of stock, from either inventory system: passing, so retried within the cap. */
export const ORDER_INVENTORY_SHORTFALL_CODE = "DROPSHIP_ORDER_INVENTORY_SHORTFALL";
/** A whole-order inventory claim refused for a reason other than stock: permanent. */
export const ORDER_INVENTORY_CLAIM_FAILED_CODE = "DROPSHIP_ORDER_INVENTORY_CLAIM_FAILED";
/** The claim failed and so did giving it back (an AggregateError): fatal, a person checks the stock. */
export const ORDER_INVENTORY_CLAIM_COMPENSATION_FAILED_CODE = "DROPSHIP_ORDER_INVENTORY_CLAIM_COMPENSATION_FAILED";

/** How long to wait after the `failedAttempts`-th failure (1-based). */
export function orderProcessingRetryDelayMs(failedAttempts: number): number {
  assertAttempts(failedAttempts, 1);
  return ORDER_PROCESSING_RETRY_DELAYS_MS[failedAttempts - 1] ?? ORDER_PROCESSING_RETRY_CEILING_MS;
}

export type OrderProcessingFailureDecision =
  | { status: "retrying"; attemptCount: number; nextAttemptAt: Date; exhausted: false }
  /** A permanent or fatal failure (exhausted false), or the last retryable one (exhausted true). */
  | { status: "failed"; attemptCount: number; nextAttemptAt: null; exhausted: boolean };

/**
 * What one failed processing attempt does to the intake: `attemptsBefore`
 * is the count stored on it before this attempt. A permanent failure is never
 * retried (CLAUDE.md §6).
 */
export function decideOrderProcessingFailure(input: {
  attemptsBefore: number; retryable: boolean; now: Date;
}): OrderProcessingFailureDecision {
  assertAttempts(input.attemptsBefore, 0);
  const attemptCount = input.attemptsBefore + 1;
  if (!input.retryable) return { status: "failed", attemptCount, nextAttemptAt: null, exhausted: false };
  if (attemptCount >= ORDER_PROCESSING_MAX_ATTEMPTS) return { status: "failed", attemptCount, nextAttemptAt: null, exhausted: true };
  return {
    status: "retrying",
    attemptCount,
    nextAttemptAt: new Date(input.now.getTime() + orderProcessingRetryDelayMs(attemptCount)),
    exhausted: false,
  };
}

function assertAttempts(value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    // A stored count the CHECK keeps >= 0 can only fail this through a caller defect: fatal, never retried.
    throw new DropshipError("DROPSHIP_ORDER_PROCESSING_ATTEMPTS_INVALID", `An attempt count must be a whole number of at least ${min}.`,
      { value, classification: "fatal", retryable: false });
  }
}
