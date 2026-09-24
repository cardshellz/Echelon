/**
 * Card funding fee.
 *
 * Policy: bank transfer (ACH) and USDC are the primary funding rails and carry
 * no fee. A card charge — a manual top-up, a routine auto-reload bound to a
 * card, or the backstop charge that covers an order the balance cannot —
 * carries a percentage fee ON TOP of the amount that lands in the wallet: a
 * $100 top-up charges the card $103 and the wallet is credited exactly $100.
 *
 * One calculation, shared by the server (which charges) and the client (which
 * discloses), so the number the vendor sees before confirming is the number
 * Stripe charges. Integer cents throughout; the fee rounds half up at the
 * sub-cent boundary.
 */

import { roundHalfUp } from "../utils/money";

export const CARD_FUNDING_FEE_RAIL = "stripe_card" as const;

/** 100 bps = 1%. */
export const BASIS_POINTS_PER_WHOLE = 10_000;

/**
 * Zero: no processing fee on any rail (funding design phase 7, owner decision
 * 2026-09-23). The rate in force is the wallet policy's `cardFundingFeeBps`;
 * this constant is only the fallback when no policy row exists and
 * DROPSHIP_CARD_FUNDING_FEE_BPS is unset. The fee stays a setting so the
 * disclosure machinery keeps working should a fee ever return.
 */
export const DEFAULT_CARD_FUNDING_FEE_BPS = 0;

/**
 * Misconfiguration guard, not a business limit. A rate above 10% is far more
 * likely a typo in the environment than a policy, and it would be charged to
 * vendors' cards before anyone noticed.
 */
export const MAX_CARD_FUNDING_FEE_BPS = 1_000;

export interface WalletFundingQuote {
  /** The rail that will be charged. */
  rail: string;
  /** What lands in the wallet. */
  creditCents: number;
  /** The fee on top. Zero on every rail but a card. */
  feeCents: number;
  /** The rate applied. Zero on every rail but a card. */
  feeBps: number;
  /** What the payment method is charged: credit plus fee. */
  chargedCents: number;
}

/** True for a rate the system will accept from configuration or a client. */
export function isValidCardFundingFeeBps(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_CARD_FUNDING_FEE_BPS;
}

/**
 * The fee for crediting `creditCents` at `feeBps`, rounded half up.
 * 10_000 cents at 300 bps → 300; 1_234 cents at 300 bps → 37 (37.02).
 */
export function calculateCardFundingFeeCents(creditCents: number, feeBps: number): number {
  assertCents(creditCents, "creditCents");
  assertFeeBps(feeBps);
  const scaled = creditCents * feeBps;
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError("creditCents * feeBps exceeds the safe integer range.");
  }
  return roundHalfUp(scaled, BASIS_POINTS_PER_WHOLE);
}

/**
 * The charge for putting `creditCents` into the wallet over `rail`. Only a
 * card carries the fee; every other rail is quoted at exactly the credit.
 */
export function quoteWalletFunding(input: {
  rail: string;
  creditCents: number;
  cardFeeBps: number;
}): WalletFundingQuote {
  assertCents(input.creditCents, "creditCents");
  assertFeeBps(input.cardFeeBps);
  const feeBps = input.rail === CARD_FUNDING_FEE_RAIL ? input.cardFeeBps : 0;
  const feeCents = feeBps === 0 ? 0 : calculateCardFundingFeeCents(input.creditCents, feeBps);
  return {
    rail: input.rail,
    creditCents: input.creditCents,
    feeCents,
    feeBps,
    chargedCents: input.creditCents + feeCents,
  };
}

/** "3%" for 300 bps, "2.5%" for 250, "0.25%" for 25. Display only. */
export function formatFeeRate(feeBps: number): string {
  assertFeeBps(feeBps);
  const whole = Math.floor(feeBps / 100);
  const fraction = feeBps % 100;
  if (fraction === 0) return `${whole}%`;
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0+$/, "")}%`;
}

function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative whole number of cents.`);
  }
}

function assertFeeBps(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > BASIS_POINTS_PER_WHOLE) {
    throw new RangeError(`feeBps must be a whole number between 0 and ${BASIS_POINTS_PER_WHOLE}.`);
  }
}
