import { describe, expect, it } from "vitest";

import {
  canCancelFlaggedIntakeAtClaim,
  decideAcceptedCancelOutcome,
  decideMarketplaceCancel,
  MARKETPLACE_CANCEL_STATUSES,
  marketplaceCancelCreditKey,
  marketplaceCancelRewardsCreditKey,
  marketplaceCancelSubjectKey,
  planMarketplaceCancelRefund,
  type IntakeCancelFacts,
} from "../../domain/marketplace-order-cancel";
import { decideParkedOrderLine, type ParkedOrderLineFacts } from "../../domain/marketplace-unmatched-order";
import {
  decideOrderProcessingFailure,
  ORDER_PROCESSING_MAX_ATTEMPTS,
  ORDER_PROCESSING_RETRY_CEILING_MS,
  orderProcessingRetryDelayMs,
} from "../../domain/order-processing-retry";

/**
 * The order fixes' pure rules (eBay sync-back plan v4 §7): stuck-order
 * backoff and cap (§7.1), the eBay-cancel intake table, OMS answer and refund
 * plan (§7.2), and parked lines on an unknown item number (§7.3).
 */
const NOW = new Date("2026-10-22T12:00:00.000Z");
const MINUTE = 60_000;

describe("stuck orders: backoff and cap (plan v4 §7.1)", () => {
  it("waits 1, 5, then 15 minutes, and 15 minutes after every later failure", () => {
    expect([1, 2, 3, 4, 10, 63].map(orderProcessingRetryDelayMs)).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE, 15 * MINUTE, 15 * MINUTE, 15 * MINUTE]);
    expect(ORDER_PROCESSING_RETRY_CEILING_MS).toBe(15 * MINUTE);
  });

  it("schedules the next attempt from the injected time", () => {
    expect(decideOrderProcessingFailure({ attemptsBefore: 0, retryable: true, now: NOW })).toEqual({
      status: "retrying", attemptCount: 1, nextAttemptAt: new Date(NOW.getTime() + MINUTE), exhausted: false });
    expect(decideOrderProcessingFailure({ attemptsBefore: 2, retryable: true, now: NOW })).toEqual({
      status: "retrying", attemptCount: 3, nextAttemptAt: new Date(NOW.getTime() + 15 * MINUTE), exhausted: false });
  });

  it("stops at the 64th failure and leaves the intake for a person, about 15 hours after the first", () => {
    expect(ORDER_PROCESSING_MAX_ATTEMPTS).toBe(64);
    expect(decideOrderProcessingFailure({ attemptsBefore: 62, retryable: true, now: NOW })).toMatchObject({ status: "retrying", attemptCount: 63 });
    expect(decideOrderProcessingFailure({ attemptsBefore: 63, retryable: true, now: NOW })).toEqual({
      status: "failed", attemptCount: 64, nextAttemptAt: null, exhausted: true });
    // A count past the cap (a failure recorded twice by racing workers) still stops.
    expect(decideOrderProcessingFailure({ attemptsBefore: 70, retryable: true, now: NOW })).toMatchObject({ status: "failed", exhausted: true });
    let waited = 0;
    for (let failures = 1; failures < ORDER_PROCESSING_MAX_ATTEMPTS; failures += 1) waited += orderProcessingRetryDelayMs(failures);
    expect(waited / (60 * MINUTE)).toBeCloseTo(15.35, 2);
  });

  it("never retries a permanent failure, whatever the count", () => {
    expect(decideOrderProcessingFailure({ attemptsBefore: 0, retryable: false, now: NOW })).toEqual({
      status: "failed", attemptCount: 1, nextAttemptAt: null, exhausted: false });
    expect(decideOrderProcessingFailure({ attemptsBefore: 63, retryable: false, now: NOW })).toMatchObject({ status: "failed", exhausted: false });
  });

  it("refuses a count that is not a whole number at or above its floor as a fatal caller defect", () => {
    for (const attemptsBefore of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decideOrderProcessingFailure({ attemptsBefore, retryable: true, now: NOW })).toThrow(expect.objectContaining({
        code: "DROPSHIP_ORDER_PROCESSING_ATTEMPTS_INVALID", context: expect.objectContaining({ classification: "fatal", retryable: false }) }));
    }
    expect(() => orderProcessingRetryDelayMs(0)).toThrow(expect.objectContaining({ code: "DROPSHIP_ORDER_PROCESSING_ATTEMPTS_INVALID" }));
  });
});

describe("an eBay cancel of an order already taken in (plan v4 §7.2, v2 §7.2 intake table)", () => {
  const facts = (overrides: Partial<IntakeCancelFacts>): IntakeCancelFacts => ({
    status: "received", cancellationStatus: null, marketplaceCancelledAt: null, stageState: null, ...overrides });

  it("marks a pending outbound cancel done instead of asking eBay to cancel what it already cancelled", () => {
    for (const cancellationStatus of ["payment_hold_expired", "order_intake_rejected", "marketplace_cancellation_retrying",
      "marketplace_cancellation_failed"]) {
      for (const status of ["cancelled", "rejected"]) {
        expect(decideMarketplaceCancel(facts({ status, cancellationStatus })), `${status}/${cancellationStatus}`).toEqual({ kind: "outbound_cancel_unneeded" });
      }
    }
    expect(decideMarketplaceCancel(facts({ status: "cancelled", cancellationStatus: MARKETPLACE_CANCEL_STATUSES.marketplaceCancelled })))
      .toEqual({ kind: "nothing_to_do" });
    expect(decideMarketplaceCancel(facts({ status: "rejected" }))).toEqual({ kind: "nothing_to_do" });
  });

  it("cancels a never-charged intake that holds nothing", () => {
    for (const status of ["received", "retrying", "failed", "payment_hold", "exception"]) {
      for (const stageState of [null, "inventory_released", "expired"]) {
        expect(decideMarketplaceCancel(facts({ status, stageState })), `${status}/${stageState}`).toEqual({ kind: "cancel_intake" });
      }
    }
  });

  it("flags an intake being processed, or whose canonical stage may hold inventory, for the processing claim", () => {
    expect(decideMarketplaceCancel(facts({ status: "processing" }))).toEqual({ kind: "flag_for_processing" });
    for (const stageState of ["prepared", "inventory_claimed", "compensation_pending"]) {
      expect(decideMarketplaceCancel(facts({ status: "retrying", stageState })), stageState).toEqual({ kind: "flag_for_processing" });
      expect(canCancelFlaggedIntakeAtClaim(stageState)).toBe(false);
    }
    for (const stageState of [null, "inventory_released", "expired"]) expect(canCancelFlaggedIntakeAtClaim(stageState)).toBe(true);
  });

  it("asks OMS to stop an accepted order, and applies a replayed cancel only once", () => {
    expect(decideMarketplaceCancel(facts({ status: "accepted" }))).toEqual({ kind: "stop_accepted" });
    for (const status of ["accepted", "received", "processing", "payment_hold"]) {
      expect(decideMarketplaceCancel(facts({ status, marketplaceCancelledAt: NOW })), status).toEqual({ kind: "already_applied" });
    }
  });

  it("ARCH-2: never applies again an eBay cancel already dead-lettered for review, whatever the intake's status", () => {
    for (const status of ["accepted", "received", "processing", "unknown_status"]) {
      expect(decideMarketplaceCancel(facts({ status, cancellationStatus: "marketplace_cancel_unprocessable" })), status)
        .toEqual({ kind: "already_applied" });
    }
  });

  it("refuses an intake status the table does not cover, for good", () => {
    expect(() => decideMarketplaceCancel(facts({ status: "shipped" }))).toThrow(expect.objectContaining({
      code: "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", context: expect.objectContaining({ classification: "permanent", retryable: false }) }));
  });

  it("does not mutate the facts it is given", () => {
    const frozen = Object.freeze(facts({ status: "accepted" }));
    expect(() => decideMarketplaceCancel(frozen)).not.toThrow();
  });
});

describe("what dropship does with OMS's answer for an accepted order (plan v2 §7.2 table)", () => {
  it("refunds only an order OMS stopped before it shipped", () => {
    expect(decideAcceptedCancelOutcome("stopped")).toEqual({ cancellationStatus: "marketplace_cancel_stopped", refund: true,
      notice: { kind: "order_cancel_refunded" }, requiresReview: false });
  });

  it("sends one OMS could not stop, or that shipped, to a person with a critical vendor notice and no credit", () => {
    expect(decideAcceptedCancelOutcome("not_stopped")).toEqual({ cancellationStatus: "marketplace_cancel_review", refund: false,
      notice: { kind: "order_cancel_not_stopped", shipped: false }, requiresReview: true });
    expect(decideAcceptedCancelOutcome("already_shipped")).toEqual({ cancellationStatus: "marketplace_cancel_after_shipment", refund: false,
      notice: { kind: "order_cancel_not_stopped", shipped: true }, requiresReview: true });
  });

  it("sends an intake naming an OMS order that does not exist to staff only", () => {
    expect(decideAcceptedCancelOutcome("not_found")).toEqual({ cancellationStatus: "marketplace_cancel_review", refund: false,
      notice: null, requiresReview: true });
  });
});

describe("the refund of a stopped order (owner Q5: the advance fee too)", () => {
  it("gives back the order debit and the advance fee as cash, and points as points, in integer cents", () => {
    expect(planMarketplaceCancelRefund({ orderDebitCents: -1599, advanceFeeCents: -125, rewardsSpentCents: -300 })).toEqual({
      cashCents: 1724, rewardsCents: 300, orderDebitRefundCents: 1599, advanceFeeRefundCents: 125 });
  });

  it("refunds nothing for a debit the acceptance never wrote", () => {
    expect(planMarketplaceCancelRefund({ orderDebitCents: null, advanceFeeCents: null, rewardsSpentCents: -450 })).toEqual({
      cashCents: 0, rewardsCents: 450, orderDebitRefundCents: 0, advanceFeeRefundCents: 0 });
    expect(planMarketplaceCancelRefund({ orderDebitCents: null, advanceFeeCents: null, rewardsSpentCents: null })).toEqual({
      cashCents: 0, rewardsCents: 0, orderDebitRefundCents: 0, advanceFeeRefundCents: 0 });
  });

  it("refuses a broken ledger (a zero, positive or fractional debit) rather than refund it", () => {
    for (const debit of [{ orderDebitCents: 0 }, { orderDebitCents: 500 }, { advanceFeeCents: -1.5 }, { rewardsSpentCents: Number.NaN }]) {
      expect(() => planMarketplaceCancelRefund({ orderDebitCents: null, advanceFeeCents: null, rewardsSpentCents: null, ...debit }))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_INVARIANT_FAILED",
          context: expect.objectContaining({ classification: "fatal" }) }));
    }
  });

  it("keys one credit per intake, ever", () => {
    expect(marketplaceCancelCreditKey(42)).toBe("order-cancel-credit:42");
    expect(marketplaceCancelRewardsCreditKey(42)).toBe("order-cancel-credit:42:rewards");
    expect(marketplaceCancelSubjectKey(42)).toBe("order-cancel:42");
    for (const id of [0, -1, 1.5]) {
      expect(() => marketplaceCancelCreditKey(id)).toThrow(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_INVARIANT_FAILED" }));
    }
  });
});

describe("a line parked on an unknown eBay item number (plan v4 §7.3 step 4)", () => {
  const seen = new Date("2026-10-22T10:00:00.000Z");
  const line = (overrides: Partial<ParkedOrderLineFacts>): ParkedOrderLineFacts => ({
    externalListingId: "2000", candidateListingId: 7, candidateExternalListingId: "1000", candidateHadItemNumber: false,
    candidateReadAt: null, firstSeenAt: seen, ...overrides });

  it("releases the line once the candidate shows the number now, or had it before a relist", () => {
    expect(decideParkedOrderLine(line({ candidateExternalListingId: "2000" }))).toBe("release");
    expect(decideParkedOrderLine(line({ candidateHadItemNumber: true }))).toBe("release");
  });

  it("asks the vendor once the sweep read the candidate after the line was parked and did not prove it", () => {
    expect(decideParkedOrderLine(line({ candidateReadAt: new Date(seen.getTime() + 1) }))).toBe("ask_vendor");
    expect(decideParkedOrderLine(line({ candidateListingId: null, candidateExternalListingId: null }))).toBe("ask_vendor");
  });

  it("waits while the sweep has not read the candidate since the line was parked", () => {
    expect(decideParkedOrderLine(line({}))).toBe("wait");
    expect(decideParkedOrderLine(line({ candidateReadAt: seen }))).toBe("wait");
    expect(decideParkedOrderLine(line({ candidateReadAt: new Date(seen.getTime() - MINUTE) }))).toBe("wait");
  });
});
