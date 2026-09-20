/**
 * Autopay refill — how much a routine top-up pulls (funding design phase 5).
 *
 * The vendor keeps one number: the minimum balance ("keep $X on deposit").
 * An optional top-up amount says how much each refill pulls, so a vendor who
 * wants fewer pulls can take bigger ones; by default a refill pulls the
 * minimum itself. A refill fires when the balance, counting credits still
 * settling, is under the minimum. It pulls the top-up amount, or more when
 * that alone would not reach the minimum, and never more than the
 * single-charge bound: the standing authorization is always bounded, so a
 * deep negative is collected over several days rather than in one charge.
 *
 * The bound itself is the server's, not a vendor setting: max(minimum,
 * top-up amount). Older configurations that stored their own bound keep it.
 * Pure: no database, no clock. Money is integer cents.
 */

import { DropshipError } from "./errors";

export const DROPSHIP_AUTOPAY_REFILL_INVALID = "DROPSHIP_AUTOPAY_REFILL_INVALID";

export interface DropshipAutopayAmounts {
  minimumBalanceCents: number;
  /** What each refill pulls; null pulls the minimum. */
  topUpAmountCents: number | null;
}

/** The most one automatic charge may take: the minimum, or the top-up amount when that is larger. */
export function deriveSingleChargeBoundCents(input: DropshipAutopayAmounts): number {
  assertCents(input.minimumBalanceCents, "minimumBalanceCents");
  if (input.topUpAmountCents !== null) assertCents(input.topUpAmountCents, "topUpAmountCents");
  return Math.max(input.minimumBalanceCents, input.topUpAmountCents ?? input.minimumBalanceCents);
}

export type DropshipAutopayRefillDecision =
  | { outcome: "not_needed" }
  | {
      outcome: "refill";
      /** What the wallet is credited (a card is charged this plus the fee). */
      amountCents: number;
      /** How far the counted balance sits under the minimum. */
      shortfallCents: number;
      /** The pull before the bound: the top-up amount, or the shortfall when that is more. */
      requestedCents: number;
      boundCents: number;
      /** True when the bound cut the pull short of the minimum; the next run continues. */
      partial: boolean;
    };

export function decideAutopayRefill(input: DropshipAutopayAmounts & {
  availableBalanceCents: number;
  pendingBalanceCents: number;
  /** A stored bound; null derives it from the amounts. */
  singleChargeBoundCents: number | null;
}): DropshipAutopayRefillDecision {
  assertSignedCents(input.availableBalanceCents, "availableBalanceCents");
  assertCents(input.pendingBalanceCents, "pendingBalanceCents");
  assertCents(input.minimumBalanceCents, "minimumBalanceCents");
  if (input.topUpAmountCents !== null) assertCents(input.topUpAmountCents, "topUpAmountCents");
  if (input.singleChargeBoundCents !== null) assertCents(input.singleChargeBoundCents, "singleChargeBoundCents");
  const boundCents = input.singleChargeBoundCents ?? deriveSingleChargeBoundCents(input);
  // Credits still settling count: a refill already on its way is not stacked.
  const shortfallCents = input.minimumBalanceCents - (input.availableBalanceCents + input.pendingBalanceCents);
  if (shortfallCents <= 0) {
    return { outcome: "not_needed" };
  }
  const requestedCents = Math.max(shortfallCents, input.topUpAmountCents ?? input.minimumBalanceCents);
  const amountCents = Math.min(requestedCents, boundCents);
  if (amountCents <= 0) {
    return { outcome: "not_needed" };
  }
  return {
    outcome: "refill",
    amountCents,
    shortfallCents,
    requestedCents,
    boundCents,
    partial: amountCents < shortfallCents,
  };
}

function assertCents(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DropshipError(
      DROPSHIP_AUTOPAY_REFILL_INVALID,
      `${field} must be a non-negative safe integer number of cents.`,
      { field, value, classification: "fatal" },
    );
  }
}

function assertSignedCents(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DropshipError(
      DROPSHIP_AUTOPAY_REFILL_INVALID,
      `${field} must be a safe integer number of cents.`,
      { field, value, classification: "fatal" },
    );
  }
}
