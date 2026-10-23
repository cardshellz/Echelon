import { DropshipError } from "./errors";

/**
 * eBay cancellations of dropship orders already taken in (plan v4 §7.2, v2
 * §7.2). Pure: what an eBay cancel does to an intake, what dropship does with
 * the OMS answer for an accepted one, and what a stopped order gives back to
 * the wallet. No clock, database or network; the caller passes the facts.
 */

/** The intake's cancellation statuses this flow writes (dropship_order_intake.cancellation_status, varchar(40)). */
export const MARKETPLACE_CANCEL_STATUSES = {
  /** Never charged: cancelled here because eBay cancelled it. Outside the outbound-cancel claim list, so eBay is never asked to cancel it again. */
  cancelledOnMarketplace: "cancelled_on_marketplace",
  /** A pending outbound cancel eBay already did itself (the existing success status of the outbound cancel). */
  marketplaceCancelled: "marketplace_cancelled",
  /** Accepted, then cancelled on eBay: waiting for OMS to stop it. */
  stopPending: "marketplace_cancel_stop_pending",
  /** OMS stopped it before it shipped: the wallet got its money back. */
  stopped: "marketplace_cancel_stopped",
  /** OMS could not prove it stopped (a label was bought, the engine could not confirm the cancel, the order is gone, or the stop or its refund kept failing): a person decides; no credit. */
  review: "marketplace_cancel_review",
  /** It had already shipped: a person decides; no credit. */
  afterShipment: "marketplace_cancel_after_shipment",
  /**
   * The eBay cancel could not be applied for a reason no retry fixes
   * (dead-lettered once, review ARCH-2/3): requires review. The poll never
   * asks about it or applies it again; only a person clears it.
   */
  unprocessable: "marketplace_cancel_unprocessable",
} as const;

/**
 * The wallet references of a stopped order's refund (dropship_wallet_ref_idx:
 * one row per reference, ever). Finance reads the cash one as an expected
 * order refund, never as an unexpected entry (review MS3/ARCH-1).
 */
export const MARKETPLACE_CANCEL_REFUND_REFERENCE_TYPES = {
  cash: "order_marketplace_cancel_refund",
  rewards: "order_marketplace_cancel_rewards",
} as const;

/** The dead-letter audit event of an eBay cancellation the poll could not apply (one per store and order; ops health reads it). */
export const EBAY_ORDER_CANCEL_DEAD_LETTER_EVENT_TYPE = "order_marketplace_cancel_unprocessable";

/** The outbound-cancel statuses still waiting to ask eBay (dropship-order-cancellation.repository.ts CLAIMABLE_CANCELLATION_STATUSES, plus a failed one). */
const PENDING_OUTBOUND_CANCEL_STATUSES: ReadonlySet<string> = new Set([
  "payment_hold_expired", "order_intake_rejected", "marketplace_cancellation_retrying", "marketplace_cancellation_failed",
]);

/**
 * Canonical acceptance stage states that hold no inventory: given back
 * (inventory_released) or expired. `prepared` may already have a claim that
 * was never recorded (a crash between the claim and its record), so it counts
 * as holding, with `inventory_claimed` and `compensation_pending`
 * (migration 0667 state machine).
 */
const STAGE_STATES_HOLDING_NO_INVENTORY: ReadonlySet<string> = new Set(["inventory_released", "expired"]);
const NEVER_CHARGED_STATUSES: ReadonlySet<string> = new Set(["received", "retrying", "failed", "payment_hold", "exception"]);

export interface IntakeCancelFacts {
  status: string;
  cancellationStatus: string | null;
  marketplaceCancelledAt: Date | null;
  /** The canonical acceptance stage's state; null when the intake has none (legacy, or not staged). */
  stageState: string | null;
}

export type MarketplaceCancelAction =
  /** This cancel was applied before (a replayed poll): nothing new. */
  | { kind: "already_applied" }
  /** Cancelled or rejected here, and an outbound cancel was still to ask eBay: mark it done instead. */
  | { kind: "outbound_cancel_unneeded" }
  /** Cancelled or rejected here and nothing pending: nothing to do. */
  | { kind: "nothing_to_do" }
  /** Never charged and nothing held: cancel the intake now. */
  | { kind: "cancel_intake" }
  /**
   * Being processed, or a canonical stage may hold inventory: flag it and make
   * it due. The processing claim cancels it once nothing is held; an
   * acceptance that still completes goes to the accepted path below.
   */
  | { kind: "flag_for_processing" }
  /** Accepted: OMS is asked to stop it (marketplace_cancel_stop_pending). */
  | { kind: "stop_accepted" };

/** The intake table (plan v2 §7.2) for one eBay cancellation. */
export function decideMarketplaceCancel(facts: IntakeCancelFacts): MarketplaceCancelAction {
  // Dead-lettered for review: a permanent failure is never retried (CLAUDE.md §6), so a replayed cancel writes nothing.
  if (facts.cancellationStatus === MARKETPLACE_CANCEL_STATUSES.unprocessable) return { kind: "already_applied" };
  if (facts.status === "cancelled" || facts.status === "rejected") {
    return facts.cancellationStatus !== null && PENDING_OUTBOUND_CANCEL_STATUSES.has(facts.cancellationStatus)
      ? { kind: "outbound_cancel_unneeded" }
      : { kind: "nothing_to_do" };
  }
  if (facts.marketplaceCancelledAt !== null) return { kind: "already_applied" };
  if (facts.status === "accepted") return { kind: "stop_accepted" };
  if (facts.status === "processing") return { kind: "flag_for_processing" };
  if (!NEVER_CHARGED_STATUSES.has(facts.status)) {
    throw new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "An eBay cancellation met an intake status this flow does not cover.",
      { status: facts.status, classification: "permanent", retryable: false });
  }
  return stageHoldsInventory(facts.stageState) ? { kind: "flag_for_processing" } : { kind: "cancel_intake" };
}

/**
 * Whether a flagged intake can be cancelled when the processing worker claims
 * it: only once nothing is held. An intake whose stage still holds inventory
 * is processed as usual and either finishes accepted (then stopped through
 * OMS and refunded) or gives the inventory back first.
 */
export function canCancelFlaggedIntakeAtClaim(stageState: string | null): boolean {
  return !stageHoldsInventory(stageState);
}

function stageHoldsInventory(stageState: string | null): boolean {
  return stageState !== null && !STAGE_STATES_HOLDING_NO_INVENTORY.has(stageState);
}

/** OMS's answer for an accepted order eBay cancelled (OMS/dropship-marketplace-cancel.ts). */
export type MarketplaceCancelStopKind = "stopped" | "already_shipped" | "not_stopped" | "not_found";

export interface AcceptedCancelOutcome {
  cancellationStatus: string;
  /** Only an order OMS stopped before it shipped is refunded. */
  refund: boolean;
  /** The vendor notice kind (rule 7d), or null for a staff-only review. */
  notice: { kind: "order_cancel_refunded" } | { kind: "order_cancel_not_stopped"; shipped: boolean } | null;
  /** A person must decide (requires_review): logged at ERROR and counted by ops health. */
  requiresReview: boolean;
}

/** The dropship side of an accepted order eBay cancelled (plan v2 §7.2 table). */
export function decideAcceptedCancelOutcome(kind: MarketplaceCancelStopKind): AcceptedCancelOutcome {
  switch (kind) {
    case "stopped":
      return { cancellationStatus: MARKETPLACE_CANCEL_STATUSES.stopped, refund: true, notice: { kind: "order_cancel_refunded" }, requiresReview: false };
    case "not_stopped":
      return { cancellationStatus: MARKETPLACE_CANCEL_STATUSES.review, refund: false,
        notice: { kind: "order_cancel_not_stopped", shipped: false }, requiresReview: true };
    case "already_shipped":
      return { cancellationStatus: MARKETPLACE_CANCEL_STATUSES.afterShipment, refund: false,
        notice: { kind: "order_cancel_not_stopped", shipped: true }, requiresReview: true };
    case "not_found":
      // Permanent: the intake names an OMS order that does not exist. Staff only (the vendor has nothing to act on).
      return { cancellationStatus: MARKETPLACE_CANCEL_STATUSES.review, refund: false, notice: null, requiresReview: true };
  }
}

/** What the order's acceptance debited, as recorded (signed integer cents; null when the row does not exist). */
export interface RecordedOrderDebit {
  /** The cash `order_debit` row (negative). */
  orderDebitCents: number | null;
  /** The `advance_fee` row (negative), when pending money let the order through early. */
  advanceFeeCents: number | null;
  /** The `rewards_spent` row (negative), when points paid part or all of it. */
  rewardsSpentCents: number | null;
}

export interface MarketplaceCancelRefundPlan {
  /** Back to the cash balance as one `refund_credit`: the order debit and the advance fee (owner Q5: fee included). */
  cashCents: number;
  /** Back to the points balance, to the lots the order took them from. */
  rewardsCents: number;
  orderDebitRefundCents: number;
  advanceFeeRefundCents: number;
}

/**
 * Gives back exactly what the order's acceptance took, each from where it was
 * taken: cash as cash (with the advance fee), points as points. Integer
 * cents; a debit row that is not negative is a broken ledger, never refunded.
 */
export function planMarketplaceCancelRefund(debit: RecordedOrderDebit): MarketplaceCancelRefundPlan {
  const orderDebitRefundCents = refundOf(debit.orderDebitCents, "orderDebitCents");
  const advanceFeeRefundCents = refundOf(debit.advanceFeeCents, "advanceFeeCents");
  const rewardsCents = refundOf(debit.rewardsSpentCents, "rewardsSpentCents");
  const cashCents = orderDebitRefundCents + advanceFeeRefundCents;
  if (!Number.isSafeInteger(cashCents)) throw invariant("The refund is outside the safe integer range.", { cashCents });
  return { cashCents, rewardsCents, orderDebitRefundCents, advanceFeeRefundCents };
}

function refundOf(cents: number | null, field: string): number {
  if (cents === null) return 0;
  if (!Number.isSafeInteger(cents) || cents >= 0) throw invariant("A recorded order debit is not a negative whole number of cents.", { field, cents });
  return -cents;
}

/** The wallet keys of a stopped order's refund: one credit per intake, ever (dropship_wallet_idem_idx). */
export function marketplaceCancelCreditKey(intakeId: number): string {
  return `order-cancel-credit:${positiveId(intakeId)}`;
}

export function marketplaceCancelRewardsCreditKey(intakeId: number): string {
  return `${marketplaceCancelCreditKey(intakeId)}:rewards`;
}

/** The notice subject of an intake's cancel outcome: once per intake and kind (dropship_sync_notice_subject_uk). */
export function marketplaceCancelSubjectKey(intakeId: number): string {
  return `order-cancel:${positiveId(intakeId)}`;
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invariant("An intake id must be a positive integer.", { value });
  return value;
}

function invariant(message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_INVARIANT_FAILED", message, { ...context, classification: "fatal", retryable: false });
}
