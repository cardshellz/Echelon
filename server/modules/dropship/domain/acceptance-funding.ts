/**
 * Dropship order acceptance funding — the shortfall waterfall.
 *
 * Funding design phase 3 (owner decisions, 2026-09-20). When an order's debit
 * outruns the available balance, acceptance walks a fixed order of sources:
 *
 *   1. available balance    — free;
 *   2. pending-ACH advance  — the order is accepted against bank transfers
 *                             still settling, for a fee on the amount used,
 *                             up to a cap (decideAcceptanceFunding);
 *   3. card backstop        — charged by the order-processing pass once the
 *                             order is held, at the card fee
 *                             (decideCardBackstopCharge);
 *   4. payment hold         — the order waits for funds until the hold expires.
 *
 * How an advance is represented. The wallet keeps two stored balances,
 * available and pending. An advance moves nothing between them: the order
 * debit is allowed to take the AVAILABLE balance negative, by at most the
 * eligible pending credits it is drawn against (and never past the cap). The
 * negative is the vendor's exposure. When the pending credit settles, the
 * existing settlement path adds it to available and the exposure clears; when
 * the credit fails, the existing void path removes it from pending and the
 * negative stays as a receivable that the daily wallet run collects and that
 * pauses the vendor. No new balance movement and no new reversal path exist.
 *
 * Eligibility is judged per bank account a pending credit was pulled from.
 * All three facts are required; each is recorded elsewhere and only read here:
 *   - the account holder is a company (a business account can return an ACH
 *     debit as unauthorized for 2 banking days; a consumer account for ~60);
 *   - the account's balance was read through the provider when it was linked;
 *   - an earlier pull from the same account has settled (the trust ramp).
 *
 * Pure: no database, no clock, no randomness. Money is integer cents; rates
 * are basis points. Every input is validated so a malformed stored value
 * fails closed (classification `fatal`) instead of producing a wrong number.
 */

import { BASIS_POINTS_PER_WHOLE } from "../../../../shared/dropship/wallet-funding-fee";
import { roundHalfUp } from "../../../../shared/utils/money";
import { DropshipError } from "./errors";
import type { DropshipFundingAccountHolderType } from "./funding-method";
import type { DropshipAdvanceCapSource } from "./vendor-credit";

export const DROPSHIP_ACCEPTANCE_FUNDING_INVALID = "DROPSHIP_ACCEPTANCE_FUNDING_INVALID";

/** Why a bank account's pending credits cannot be advanced against. */
export type DropshipAdvanceIneligibilityReason =
  | "no_bank_account"
  | "no_pending_credit"
  | "account_holder_not_company"
  | "bank_balance_not_verified"
  | "first_pull_not_settled"
  | "advance_cap_zero";

/** One bank account (ACH funding method) and the facts the advance depends on. */
export interface DropshipAdvanceSource {
  fundingMethodId: number;
  /** Sum of this account's funding credits still pending, in cents; zero when none. */
  pendingCents: number;
  accountHolderType: DropshipFundingAccountHolderType | null;
  /** A balance read through the provider succeeded for this account. */
  balanceVerified: boolean;
  /** At least one earlier ACH pull from this account has settled. */
  priorPullSettled: boolean;
}

export interface DropshipAdvancePolicy {
  /** Service fee on the amount advanced, in basis points. */
  feeBps: number;
  /** The effective cap: the vendor's override when set, else the policy cap. */
  capCents: number;
  capSource: DropshipAdvanceCapSource;
}

export interface DropshipAdvanceContext {
  policy: DropshipAdvancePolicy;
  sources: readonly DropshipAdvanceSource[];
}

export interface DropshipAdvanceSourceStanding extends DropshipAdvanceSource {
  eligible: boolean;
  reasons: DropshipAdvanceIneligibilityReason[];
}

/** The vendor's advance position as things stand, for the wallet view and the decision. */
export interface DropshipAdvanceStanding {
  policy: DropshipAdvancePolicy;
  sources: DropshipAdvanceSourceStanding[];
  /** Pending credits on eligible accounts. */
  eligiblePendingCents: number;
  /** min(eligible pending, cap): how far the available balance may be overdrawn. */
  allowanceCents: number;
  /** max(0, -available): how far it already is. */
  exposureCents: number;
  /** allowance - exposure, floored at zero: what a new order could still draw, before its fee. */
  headroomCents: number;
  /** Why nothing can be advanced right now; empty when an eligible account with pending credit exists. */
  reasons: DropshipAdvanceIneligibilityReason[];
}

export interface DropshipAcceptanceAdvance {
  /** The part of the debit funded by pending credits: the debit less any positive available balance. */
  advanceCents: number;
  feeCents: number;
  feeBps: number;
  capCents: number;
  capSource: DropshipAdvanceCapSource;
  eligiblePendingCents: number;
  exposureBeforeCents: number;
  /** Exposure after the debit and the fee both post. Never above the allowance. */
  exposureAfterCents: number;
  /** The eligible accounts, ascending; recorded with the debit as evidence. */
  fundingMethodIds: number[];
}

export type DropshipAdvanceRefusal =
  | { code: "advance_unavailable" }
  | { code: "no_eligible_source"; reasons: DropshipAdvanceIneligibilityReason[] }
  | {
      code: "exceeds_allowance";
      requiredExposureCents: number;
      allowanceCents: number;
      eligiblePendingCents: number;
      capCents: number;
    };

export type DropshipAcceptanceFundingDecision =
  | { outcome: "accepted"; source: "available"; advance: null }
  | { outcome: "accepted"; source: "advance"; advance: DropshipAcceptanceAdvance }
  | {
      outcome: "payment_hold";
      reason: "vendor_paused" | "insufficient_balance";
      advance: null;
      /** What the order was short by and why the advance did not cover it; null for a standing hold. */
      shortfall: { gapCents: number; advanceRefusal: DropshipAdvanceRefusal } | null;
    };

export interface DropshipAcceptanceFundingInput {
  availableBalanceCents: number;
  totalDebitCents: number;
  /** True when the vendor is paused for funding: the order waits whatever the balance. */
  standingHold: boolean;
  /** Null when the advance facts could not be read: the order then holds rather than guesses. */
  advance: DropshipAdvanceContext | null;
}

/** The fee for advancing `advanceCents` at `feeBps`, rounded half up at the sub-cent boundary. */
export function calculateAdvanceFeeCents(advanceCents: number, feeBps: number): number {
  assertCents(advanceCents, "advanceCents");
  assertBps(feeBps, "feeBps");
  const scaled = advanceCents * feeBps;
  if (!Number.isSafeInteger(scaled)) {
    throw invalid("advanceCents * feeBps exceeds the safe integer range.", { advanceCents, feeBps });
  }
  return roundHalfUp(scaled, BASIS_POINTS_PER_WHOLE);
}

export function assessAdvanceStanding(input: {
  availableBalanceCents: number;
  context: DropshipAdvanceContext;
}): DropshipAdvanceStanding {
  assertInteger(input.availableBalanceCents, "availableBalanceCents");
  const policy = validatePolicy(input.context.policy);
  const sources = input.context.sources.map(assessSource);
  const eligiblePendingCents = sources
    .filter((source) => source.eligible)
    .reduce((sum, source) => sum + source.pendingCents, 0);
  const allowanceCents = Math.min(eligiblePendingCents, policy.capCents);
  const exposureCents = Math.max(0, -input.availableBalanceCents);
  const headroomCents = Math.max(0, allowanceCents - exposureCents);
  return {
    policy,
    sources,
    eligiblePendingCents,
    allowanceCents,
    exposureCents,
    headroomCents,
    reasons: standingReasons(sources, policy),
  };
}

/**
 * The waterfall at acceptance. Available money always pays first; the advance
 * covers the whole remaining gap or none of it (a partial advance topped up by
 * a card would fee the vendor twice for one order). The fee posts with the
 * debit, so it counts toward the allowance too: an order that only fits
 * without its fee does not fit.
 */
export function decideAcceptanceFunding(input: DropshipAcceptanceFundingInput): DropshipAcceptanceFundingDecision {
  assertInteger(input.availableBalanceCents, "availableBalanceCents");
  assertInteger(input.totalDebitCents, "totalDebitCents");
  if (input.totalDebitCents <= 0) {
    throw invalid("totalDebitCents must be positive.", { totalDebitCents: input.totalDebitCents });
  }
  if (input.standingHold) {
    return { outcome: "payment_hold", reason: "vendor_paused", advance: null, shortfall: null };
  }
  if (input.availableBalanceCents >= input.totalDebitCents) {
    return { outcome: "accepted", source: "available", advance: null };
  }
  const gapCents = input.totalDebitCents - input.availableBalanceCents;
  if (input.advance === null) {
    return hold(gapCents, { code: "advance_unavailable" });
  }
  const standing = assessAdvanceStanding({
    availableBalanceCents: input.availableBalanceCents,
    context: input.advance,
  });
  if (standing.eligiblePendingCents === 0) {
    return hold(gapCents, { code: "no_eligible_source", reasons: standing.reasons });
  }
  // The debit less any positive balance is what pending money pays for; when
  // the balance is already negative the whole debit is advanced.
  const advanceCents = input.totalDebitCents - Math.max(0, input.availableBalanceCents);
  const feeCents = calculateAdvanceFeeCents(advanceCents, standing.policy.feeBps);
  const exposureAfterCents = gapCents + feeCents;
  if (exposureAfterCents > standing.allowanceCents) {
    return hold(gapCents, {
      code: "exceeds_allowance",
      requiredExposureCents: exposureAfterCents,
      allowanceCents: standing.allowanceCents,
      eligiblePendingCents: standing.eligiblePendingCents,
      capCents: standing.policy.capCents,
    });
  }
  return {
    outcome: "accepted",
    source: "advance",
    advance: {
      advanceCents,
      feeCents,
      feeBps: standing.policy.feeBps,
      capCents: standing.policy.capCents,
      capSource: standing.policy.capSource,
      eligiblePendingCents: standing.eligiblePendingCents,
      exposureBeforeCents: standing.exposureCents,
      exposureAfterCents,
      fundingMethodIds: standing.sources
        .filter((source) => source.eligible)
        .map((source) => source.fundingMethodId)
        .sort((left, right) => left - right),
    },
  };
}

export type DropshipCardBackstopDecision =
  | { outcome: "not_needed" }
  | {
      outcome: "charge";
      /** What the wallet must receive: the gap, plus a refill toward the minimum within the vendor's single-charge bound, never above the program ceiling. */
      amountCents: number;
      gapCents: number;
      backToMinimumCents: number;
    }
  | { outcome: "ceiling_below_gap"; gapCents: number; ceilingCents: number };

/**
 * The card charge for an order the balance cannot cover (funding design
 * phase 7: "the whole shortfall, whatever its size").
 *
 * The gap is always covered: an order the vendor sold goes out. Beyond the
 * gap the charge also brings the balance back toward the minimum, and only
 * that refill part is shaped by the vendor's single-charge bound, which is a
 * promise about routine top-ups, not about orders. The one ceiling is the
 * program's limit on any single payment (the policy's manual funding
 * maximum): a gap above it is not charged and the order waits. Before phase 7
 * the bound capped the whole charge, so a large order sat held with a card
 * that could have paid for it.
 */
export function decideCardBackstopCharge(input: {
  availableBalanceCents: number;
  minimumBalanceCents: number;
  requiredBalanceCents: number;
  singleChargeLimitCents: number | null;
  /** The program's ceiling on any single payment; null means none. */
  chargeCeilingCents: number | null;
}): DropshipCardBackstopDecision {
  assertInteger(input.availableBalanceCents, "availableBalanceCents");
  assertCents(input.minimumBalanceCents, "minimumBalanceCents");
  assertCents(input.requiredBalanceCents, "requiredBalanceCents");
  if (input.singleChargeLimitCents !== null) {
    assertCents(input.singleChargeLimitCents, "singleChargeLimitCents");
  }
  if (input.chargeCeilingCents !== null) {
    assertCents(input.chargeCeilingCents, "chargeCeilingCents");
  }
  const gapCents = input.requiredBalanceCents - input.availableBalanceCents;
  if (gapCents <= 0) {
    return { outcome: "not_needed" };
  }
  if (input.chargeCeilingCents !== null && gapCents > input.chargeCeilingCents) {
    return { outcome: "ceiling_below_gap", gapCents, ceilingCents: input.chargeCeilingCents };
  }
  const backToMinimumCents = Math.max(input.minimumBalanceCents, input.requiredBalanceCents) - input.availableBalanceCents;
  // The bound shapes only the refill beyond the gap; the gap itself is never cut.
  const refillCents = input.singleChargeLimitCents === null
    ? backToMinimumCents
    : Math.max(gapCents, Math.min(backToMinimumCents, input.singleChargeLimitCents));
  const amountCents = input.chargeCeilingCents === null ? refillCents : Math.min(refillCents, input.chargeCeilingCents);
  return { outcome: "charge", amountCents, gapCents, backToMinimumCents };
}

function assessSource(source: DropshipAdvanceSource): DropshipAdvanceSourceStanding {
  assertInteger(source.fundingMethodId, "fundingMethodId");
  if (source.fundingMethodId <= 0) {
    throw invalid("fundingMethodId must be positive.", { fundingMethodId: source.fundingMethodId });
  }
  assertCents(source.pendingCents, "pendingCents");
  const reasons: DropshipAdvanceIneligibilityReason[] = [];
  if (source.pendingCents === 0) reasons.push("no_pending_credit");
  if (source.accountHolderType !== "company") reasons.push("account_holder_not_company");
  if (!source.balanceVerified) reasons.push("bank_balance_not_verified");
  if (!source.priorPullSettled) reasons.push("first_pull_not_settled");
  return { ...source, eligible: reasons.length === 0, reasons };
}

/**
 * The reasons a vendor sees when nothing can be advanced: the union of every
 * account's reasons in a fixed order, or the absence of an account at all. An
 * exhausted cap is reported even when an account qualifies, because a zero
 * cap is a decision about this vendor that the view must show.
 */
function standingReasons(
  sources: readonly DropshipAdvanceSourceStanding[],
  policy: DropshipAdvancePolicy,
): DropshipAdvanceIneligibilityReason[] {
  const reasons = new Set<DropshipAdvanceIneligibilityReason>();
  if (sources.length === 0) {
    reasons.add("no_bank_account");
  } else if (!sources.some((source) => source.eligible)) {
    for (const source of sources) {
      for (const reason of source.reasons) reasons.add(reason);
    }
  }
  if (policy.capCents === 0) reasons.add("advance_cap_zero");
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

const REASON_ORDER: readonly DropshipAdvanceIneligibilityReason[] = [
  "no_bank_account",
  "no_pending_credit",
  "account_holder_not_company",
  "bank_balance_not_verified",
  "first_pull_not_settled",
  "advance_cap_zero",
];

function validatePolicy(policy: DropshipAdvancePolicy): DropshipAdvancePolicy {
  assertBps(policy.feeBps, "feeBps");
  assertCents(policy.capCents, "capCents");
  if (policy.capSource !== "policy" && policy.capSource !== "vendor_override") {
    throw invalid("capSource must be 'policy' or 'vendor_override'.", { capSource: policy.capSource });
  }
  return { feeBps: policy.feeBps, capCents: policy.capCents, capSource: policy.capSource };
}

function hold(gapCents: number, advanceRefusal: DropshipAdvanceRefusal): DropshipAcceptanceFundingDecision {
  return {
    outcome: "payment_hold",
    reason: "insufficient_balance",
    advance: null,
    shortfall: { gapCents, advanceRefusal },
  };
}

function assertInteger(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid(`${field} must be a safe integer number of cents.`, { field, value });
  }
}

function assertCents(value: number, field: string): void {
  assertInteger(value, field);
  if (value < 0) {
    throw invalid(`${field} must not be negative.`, { field, value });
  }
}

function assertBps(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > BASIS_POINTS_PER_WHOLE) {
    throw invalid(`${field} must be a whole number between 0 and ${BASIS_POINTS_PER_WHOLE}.`, { field, value });
  }
}

function invalid(message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(DROPSHIP_ACCEPTANCE_FUNDING_INVALID, message, {
    ...context,
    classification: "fatal",
  });
}
