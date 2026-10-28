import type { StockLinkCheckStatus, StockLinkErrorClass } from "@shared/types/stock-link";
import {
  STOCK_LINK_RETRY, stockLinkBusyDelayMs, stockLinkTransientDelayMs, stockLinkWaitDelayMs,
  type StockLinkRandom, type StockLinkSizeDecision,
} from "./stock-link";
import { STOCK_LINK_ERROR_CODES, StockLinkError, type StockLinkFailureClassification } from "./stock-link-errors";

/**
 * What a check row (inventory.stock_link_checks, M1) becomes after its claim ends (channels PR2, PLAN-CH2 v4.1 §4.3
 * step 10, §4.6, §7.2 step 8, §10). Pure: the caller passes the row as it locked it, the injected clock and random,
 * and writes the result guarded by the claim's lease token and revision. Every outcome ends the lease.
 *
 * - A settled decision resets the failure streaks; linked and flagged rows are re-observed daily, waits back off
 *   (D-P2-11), a WAITING_FOR_FREED_ITEM row is due again at once (next tick, SAF-5).
 * - busy counts no attempt and keeps (or starts) the busy streak (DV4-4, TST-9);
 * - transient counts an attempt and starts (or keeps) the failure streak; Retry-After never shortens the backoff;
 * - permanent stops the row (`error`, no next check) until Check again.
 */

/** The check row's columns as the claim locked them. */
export interface StockLinkCheckFacts {
  readonly status: StockLinkCheckStatus;
  readonly reasonCode: string | null;
  readonly attemptCount: number;
  readonly firstFailureAt: Date | null;
  readonly busySince: Date | null;
  readonly nextCheckAt: Date | null;
  readonly updatedAt: Date;
  readonly waitingItemId: string | null;
  readonly observedSku: string | null;
}

/** Every column the outcome writes (lease, revision and updated_at are the writer's). */
export interface StockLinkCheckWrite {
  readonly status: StockLinkCheckStatus;
  readonly reasonCode: string | null;
  readonly errorClass: StockLinkErrorClass | null;
  readonly message: string | null;
  readonly attemptCount: number;
  readonly firstFailureAt: Date | null;
  readonly busySince: Date | null;
  readonly nextCheckAt: Date | null;
  readonly waitingItemId: string | null;
  readonly observedSku: string | null;
}

/** M1's message column is varchar(1000). */
export const STOCK_LINK_CHECK_MESSAGE_MAX = 1_000;

export function boundedStockLinkMessage(message: string | null): string | null {
  if (message === null) return null;
  const trimmed = message.trim();
  if (trimmed.length === 0) return null;
  const chars = Array.from(trimmed);
  return chars.length <= STOCK_LINK_CHECK_MESSAGE_MAX ? trimmed : `${chars.slice(0, STOCK_LINK_CHECK_MESSAGE_MAX - 1).join("")}…`;
}

/** A technical summary of why a size is flagged or waiting (the row's message; never staff wording). */
export function stockLinkDecisionMessage(decision: Pick<StockLinkSizeDecision, "detail">): string | null {
  const detail = decision.detail;
  if (detail === null) return null;
  switch (detail.kind) {
    case "ECHELON_SKU_SHARED": return `ECHELON_SKU_SHARED: sizes ${detail.productVariantIds.join(", ")}`;
    case "ITEM_HELD": return `ITEM_HELD: store item ${detail.itemId} held by sizes ${detail.heldByProductVariantIds.join(", ")}`;
    case "SKU_DUPLICATE": return `SKU_DUPLICATE: store items ${detail.itemIds.join(", ")}`;
    case "SELECTION_BLOCKED":
      return `SELECTION_BLOCKED: ${detail.action}${detail.blockerCodes.length ? ` (${detail.blockerCodes.join(", ")})` : ""}`;
    case "WAITING_FOR_FREED_ITEM":
      return `WAITING_FOR_FREED_ITEM: store item ${detail.itemId} freed by sizes ${detail.freedByProductVariantIds.join(", ")}`;
  }
}

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** A row stopped on an error is never due (M1's due index), so it is never claimed; recording on it is a broken invariant. */
function assertClaimable(previous: StockLinkCheckFacts): void {
  if (previous.status === "error") {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A check row stopped on an error was claimed.", {});
  }
}

/** The interval of the same wait last time (next_check_at − updated_at), when the row was waiting for the same reason. */
function previousWaitIntervalMs(previous: StockLinkCheckFacts, code: string | null): number | null {
  if (previous.status !== "waiting" || previous.reasonCode !== code || previous.nextCheckAt === null) return null;
  return previous.nextCheckAt.getTime() - previous.updatedAt.getTime();
}

/** busy (no attempt): released, due again in 60-180 s, the busy streak kept. */
function busyWrite(previous: StockLinkCheckFacts, code: string, message: string | null, now: Date,
  random: StockLinkRandom): StockLinkCheckWrite {
  return { status: previous.status, reasonCode: code, errorClass: "transient", message: boundedStockLinkMessage(message),
    attemptCount: previous.attemptCount, firstFailureAt: previous.firstFailureAt, busySince: previous.busySince ?? now,
    nextCheckAt: later(now, stockLinkBusyDelayMs(random)), waitingItemId: previous.waitingItemId, observedSku: previous.observedSku };
}

/** transient (an attempt): backed off from the streak's attempt count; a busy streak ends (the row got through). */
function transientWrite(previous: StockLinkCheckFacts, status: StockLinkCheckStatus, code: string, message: string | null,
  retryAfterMs: number | null, now: Date, keep: Pick<StockLinkCheckWrite, "waitingItemId" | "observedSku">): StockLinkCheckWrite {
  const attemptCount = previous.attemptCount + 1;
  return { status, reasonCode: code, errorClass: "transient", message: boundedStockLinkMessage(message), attemptCount,
    firstFailureAt: previous.firstFailureAt ?? now, busySince: null,
    nextCheckAt: later(now, stockLinkTransientDelayMs(attemptCount, retryAfterMs)), ...keep };
}

/**
 * The row after a decision (§4.2): a command member after its commit (step 10), or a size the tick settles without a
 * command (§7.2 step 8). A decision the tick could not make (`unchanged`) is busy, or held by the retire hold
 * (re-checked daily, kept as it was).
 */
export function stockLinkCheckAfterDecision(decision: StockLinkSizeDecision, previous: StockLinkCheckFacts, now: Date,
  random: StockLinkRandom): StockLinkCheckWrite {
  assertClaimable(previous);
  if (decision.status === "unchanged") {
    if (decision.retry === "busy") return busyWrite(previous, decision.code ?? STOCK_LINK_ERROR_CODES.callBudgetUsed, null, now, random);
    if (decision.retry === null && decision.code !== null) {
      // The retire hold keeps the link writing; the size is looked at again tomorrow, or at once after Continue.
      return { status: previous.status, reasonCode: decision.code, errorClass: null, message: null,
        attemptCount: previous.attemptCount, firstFailureAt: previous.firstFailureAt, busySince: null,
        nextCheckAt: later(now, STOCK_LINK_RETRY.verifyIntervalMs), waitingItemId: previous.waitingItemId,
        observedSku: previous.observedSku };
    }
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "An undecided size has no outcome to record.",
      { productVariantId: decision.productVariantId, rule: decision.rule });
  }
  const status: StockLinkCheckStatus = decision.status;
  const keep = {
    // F4 and WAITING_FOR_FREED_ITEM name the item they wait on (SAF-5); nothing else waits on an item.
    waitingItemId: decision.waitingItemId,
    // V6 records the grandfathered store SKU once; a size whose link changes starts without one.
    observedSku: decision.recordObservedSku ?? (decision.change === "none" ? previous.observedSku : null),
  };
  const message = stockLinkDecisionMessage(decision);
  if (decision.retry === "busy") return { ...busyWrite(previous, decision.code ?? STOCK_LINK_ERROR_CODES.callBudgetUsed, message, now, random), ...keep };
  if (decision.retry === "transient") {
    return transientWrite(previous, status, decision.code ?? STOCK_LINK_ERROR_CODES.lookupMissed, message, null, now, keep);
  }
  const nextCheckAt = status !== "waiting" ? later(now, STOCK_LINK_RETRY.verifyIntervalMs)
    : decision.dueNextTick ? now
      : later(now, stockLinkWaitDelayMs(previousWaitIntervalMs(previous, decision.code)));
  return { status, reasonCode: decision.code, errorClass: null, message: boundedStockLinkMessage(message), attemptCount: 0,
    firstFailureAt: null, busySince: null, nextCheckAt, ...keep };
}

/**
 * The row after a row-scoped failure (§4.6): busy, transient or permanent. A failure that is not the row's (a
 * destination pause or halt, a lost database) is never written to the row; the tick owns those.
 */
export function stockLinkCheckAfterFailure(failure: Pick<StockLinkFailureClassification, "kind" | "code" | "retryAfterMs">,
  message: string | null, previous: StockLinkCheckFacts, now: Date, random: StockLinkRandom): StockLinkCheckWrite {
  assertClaimable(previous);
  const keep = { waitingItemId: previous.waitingItemId, observedSku: previous.observedSku };
  switch (failure.kind) {
    case "busy": return busyWrite(previous, failure.code, message, now, random);
    // A cleanup-uncertain command that did not apply (no receipt) is a transient attempt (§4.3, TST-7).
    case "transient": case "cleanup_uncertain":
      return transientWrite(previous, previous.status, failure.code, message, failure.retryAfterMs, now, keep);
    case "permanent":
      return { status: "error", reasonCode: failure.code, errorClass: "permanent", message: boundedStockLinkMessage(message),
        attemptCount: previous.attemptCount, firstFailureAt: previous.firstFailureAt, busySince: null, nextCheckAt: null, ...keep };
    default:
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "This failure is not recorded on a check row.",
        { kind: failure.kind, code: failure.code });
  }
}
