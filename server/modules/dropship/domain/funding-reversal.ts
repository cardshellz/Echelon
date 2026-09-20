/**
 * Dropship wallet funding reversals — the rules for a credit that settled and
 * is then taken back (funding design phase 4).
 *
 * A card chargeback and an ACH debit returned after it cleared both reach us
 * as a Stripe dispute on the funding payment intent. The wallet's answer:
 *
 *   - funds withdrawn   → debit the wallet by the disputed amount, never more
 *                         than what the credit put in (a card credit was
 *                         charged plus the card fee; the fee is Card Shellz's
 *                         loss, not the vendor's), pause the vendor;
 *   - dispute won       → credit the reversal back;
 *   - dispute lost      → nothing more: the reversal stands.
 *
 * An inquiry ("warning" statuses) withdraws nothing yet, so it moves nothing.
 * Pure: no database, no clock. Money is integer cents.
 */

import { DropshipError } from "./errors";
import type { DropshipVendorStandingReason } from "../../../../shared/schema/dropship.schema";

export const DROPSHIP_FUNDING_REVERSAL_INVALID = "DROPSHIP_FUNDING_REVERSAL_INVALID";

/** Stripe's dispute statuses, as the SDK types them. */
export type DropshipDisputeStatus =
  | "warning_needs_response"
  | "warning_under_review"
  | "warning_closed"
  | "needs_response"
  | "under_review"
  | "won"
  | "lost"
  | "prevented";

export const DROPSHIP_DISPUTE_STATUSES: readonly DropshipDisputeStatus[] = [
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
];

/**
 * Whether a dispute in this status has taken the funds: the two active
 * statuses and a loss. Warnings are inquiries, `won` and `prevented` end with
 * the funds on our side.
 */
export function disputeWithdrawsFunds(status: DropshipDisputeStatus): boolean {
  return status === "needs_response" || status === "under_review" || status === "lost";
}

export type DropshipDisputeOutcome = "open" | "won" | "lost" | "inquiry_closed";

/**
 * What a dispute's status means for the money: won (the funds come back),
 * lost (the reversal stands), inquiry_closed (an inquiry ended without a
 * chargeback, so nothing was ever taken), or still open.
 */
export function disputeOutcomeFor(status: DropshipDisputeStatus): DropshipDisputeOutcome {
  if (status === "won" || status === "prevented") return "won";
  if (status === "lost") return "lost";
  if (status === "warning_closed") return "inquiry_closed";
  return "open";
}

/**
 * The standing reason for a vendor whose settled credit was taken back. The
 * bank sent the money back whichever rail it came over, so the existing
 * `funding_returned` reason applies; the pause evidence says it was a dispute.
 */
export const DROPSHIP_FUNDING_REVERSAL_STANDING_REASON: DropshipVendorStandingReason = "funding_returned";

export type DropshipFundingReversalDecision =
  | { outcome: "reverse"; reversalCents: number }
  | { outcome: "ignore"; reason: "credit_not_settled" | "currency_mismatch" | "nothing_to_reverse" };

export function decideFundingReversal(input: {
  credit: { amountCents: number; currency: string; status: string };
  dispute: { amountCents: number; currency: string };
}): DropshipFundingReversalDecision {
  assertCents(input.credit.amountCents, "credit.amountCents");
  assertCents(input.dispute.amountCents, "dispute.amountCents");
  if (input.credit.status !== "settled") {
    return { outcome: "ignore", reason: "credit_not_settled" };
  }
  if (input.credit.currency.toUpperCase() !== input.dispute.currency.toUpperCase()) {
    return { outcome: "ignore", reason: "currency_mismatch" };
  }
  const reversalCents = Math.min(input.dispute.amountCents, input.credit.amountCents);
  if (reversalCents <= 0) {
    return { outcome: "ignore", reason: "nothing_to_reverse" };
  }
  return { outcome: "reverse", reversalCents };
}

function assertCents(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DropshipError(
      DROPSHIP_FUNDING_REVERSAL_INVALID,
      `${field} must be a non-negative safe integer number of cents.`,
      { field, value, classification: "fatal" },
    );
  }
}
