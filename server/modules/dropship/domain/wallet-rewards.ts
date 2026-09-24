/**
 * Dropship wallet rewards — the rules for the third, spend-only balance
 * (funding design phase 7, owner decisions of 2026-09-23).
 *
 * In place of a fee on card, an incentive on the free rails: a settled bank
 * or USDC transfer earns rewards at a per-rail rate (1% at launch, card 0%).
 * Rewards are money Card Shellz issues, so:
 *
 *   - they are EARNED when a transfer settles, on the amount credited to the
 *     wallet, rounded DOWN to the cent (a gift never rounds up);
 *   - they are SPENT first on each order debit, cash second, unless the
 *     vendor chose to save them;
 *   - a returned or disputed transfer takes them back pro rata to the amount
 *     reversed: what is still in the rewards balance leaves it, and the part
 *     already spent comes out of the cash balance through the existing
 *     reversal (the rewards balance is never negative);
 *   - the rate has a ceiling (10%), so a typo cannot pay out 100%;
 *   - a manual staff credit is a correction, not a transfer, and earns
 *     nothing.
 *
 * Pure: no database, no clock, no randomness. Money is integer cents; rates
 * are basis points. Every input is validated so a malformed stored value
 * fails closed (classification `fatal`) instead of producing a wrong number.
 */

import { BASIS_POINTS_PER_WHOLE } from "../../../../shared/dropship/wallet-funding-fee";
import { DropshipError } from "./errors";

export const DROPSHIP_WALLET_REWARDS_INVALID = "DROPSHIP_WALLET_REWARDS_INVALID";

/** 10%. A rewards rate above this is a data error, not a policy. */
export const MAX_REWARDS_RATE_BPS = 1_000;

/** Launch rates (owner decision, 2026-09-23): bank and USDC earn 1%, card earns nothing. */
export const DEFAULT_REWARDS_RATE_BANK_BPS = 100;
export const DEFAULT_REWARDS_RATE_USDC_BPS = 100;
export const DEFAULT_REWARDS_RATE_CARD_BPS = 0;

/** The rates in force, one per rail a vendor can move money over. */
export interface DropshipWalletRewardsRates {
  bankBps: number;
  usdcBps: number;
  cardBps: number;
}

export const DEFAULT_WALLET_REWARDS_RATES: Readonly<DropshipWalletRewardsRates> = Object.freeze({
  bankBps: DEFAULT_REWARDS_RATE_BANK_BPS,
  usdcBps: DEFAULT_REWARDS_RATE_USDC_BPS,
  cardBps: DEFAULT_REWARDS_RATE_CARD_BPS,
});

/** The rails a funding credit records (`metadata.rail` on the ledger row). */
export type DropshipRewardsRail = "stripe_ach" | "stripe_card" | "usdc_base" | "manual";

export function isValidRewardsRateBps(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_REWARDS_RATE_BPS;
}

/**
 * The rate a credit over `rail` earns. A manual staff credit is a correction
 * (a transfer the watcher missed, a make-good), never a transfer the vendor
 * made, so it earns nothing whatever the rates say.
 */
export function rewardsRateForRail(rates: DropshipWalletRewardsRates, rail: DropshipRewardsRail): number {
  validateRates(rates);
  switch (rail) {
    case "stripe_ach":
      return rates.bankBps;
    case "usdc_base":
      return rates.usdcBps;
    case "stripe_card":
      return rates.cardBps;
    case "manual":
      return 0;
    default:
      throw invalid("rail is not a funding rail.", { rail });
  }
}

/**
 * Rewards on `amountCents` at `rateBps`, rounded down to the cent. BigInt
 * keeps the product exact for any amount the ledger can hold; the result is
 * never above the amount, so it always fits a safe integer.
 */
export function calculateRewardsEarnedCents(amountCents: number, rateBps: number): number {
  assertCents(amountCents, "amountCents");
  assertRateBps(rateBps, "rateBps");
  return Number((BigInt(amountCents) * BigInt(rateBps)) / BigInt(BASIS_POINTS_PER_WHOLE));
}

export interface DropshipRewardsAccrualDecision {
  rateBps: number;
  /** Zero means no ledger line: the ledger refuses a zero amount. */
  rewardsCents: number;
}

/** What a settled credit of `creditAmountCents` over `rail` earns under `rates`. */
export function decideRewardsAccrual(input: {
  rail: DropshipRewardsRail;
  creditAmountCents: number;
  rates: DropshipWalletRewardsRates;
}): DropshipRewardsAccrualDecision {
  assertCents(input.creditAmountCents, "creditAmountCents");
  const rateBps = rewardsRateForRail(input.rates, input.rail);
  return { rateBps, rewardsCents: calculateRewardsEarnedCents(input.creditAmountCents, rateBps) };
}

export interface DropshipRewardsSpendDecision {
  /** The part of the debit rewards pay. */
  rewardsCents: number;
  /** The part cash pays; the funding waterfall runs on this. */
  cashCents: number;
}

/**
 * How an order debit splits between rewards and cash. Rewards pay first, up
 * to the rewards balance, unless the vendor is saving them; cash pays the
 * rest. The split never depends on the cash balance: rewards are spent
 * whether or not cash could have covered the order.
 */
export function decideRewardsSpend(input: {
  rewardsBalanceCents: number;
  totalDebitCents: number;
  spendRewardsFirst: boolean;
}): DropshipRewardsSpendDecision {
  assertCents(input.rewardsBalanceCents, "rewardsBalanceCents");
  assertCents(input.totalDebitCents, "totalDebitCents");
  if (input.totalDebitCents <= 0) {
    throw invalid("totalDebitCents must be positive.", { totalDebitCents: input.totalDebitCents });
  }
  const rewardsCents = input.spendRewardsFirst ? Math.min(input.rewardsBalanceCents, input.totalDebitCents) : 0;
  return { rewardsCents, cashCents: input.totalDebitCents - rewardsCents };
}

export interface DropshipRewardsClawbackDecision {
  /** The rewards the reversed part of the credit earned. */
  clawbackCents: number;
  /** What leaves the rewards balance: the clawback, up to what is there. */
  fromRewardsCents: number;
  /** The rest, already spent, which the cash reversal takes on top of the credit. */
  fromCashCents: number;
}

/**
 * What a reversal of `reversalCents` out of a credit of `creditAmountCents`
 * that earned `earnedCents` takes back. Pro rata and rounded down, so a
 * partial dispute takes back its share and a full one takes back everything
 * the credit earned. The rewards balance is spend-only and never negative:
 * whatever the balance cannot cover was already spent on product and comes
 * out of cash instead.
 */
export function decideRewardsClawback(input: {
  earnedCents: number;
  creditAmountCents: number;
  reversalCents: number;
  rewardsBalanceCents: number;
}): DropshipRewardsClawbackDecision {
  assertCents(input.earnedCents, "earnedCents");
  assertCents(input.creditAmountCents, "creditAmountCents");
  assertCents(input.reversalCents, "reversalCents");
  assertCents(input.rewardsBalanceCents, "rewardsBalanceCents");
  if (input.creditAmountCents <= 0) {
    throw invalid("creditAmountCents must be positive.", { creditAmountCents: input.creditAmountCents });
  }
  if (input.reversalCents > input.creditAmountCents) {
    throw invalid("reversalCents cannot exceed the credit.", {
      reversalCents: input.reversalCents,
      creditAmountCents: input.creditAmountCents,
    });
  }
  const clawbackCents = Number(
    (BigInt(input.earnedCents) * BigInt(input.reversalCents)) / BigInt(input.creditAmountCents),
  );
  const fromRewardsCents = Math.min(clawbackCents, input.rewardsBalanceCents);
  return { clawbackCents, fromRewardsCents, fromCashCents: clawbackCents - fromRewardsCents };
}

function validateRates(rates: DropshipWalletRewardsRates): void {
  assertRateBps(rates.bankBps, "rates.bankBps");
  assertRateBps(rates.usdcBps, "rates.usdcBps");
  assertRateBps(rates.cardBps, "rates.cardBps");
}

function assertRateBps(value: number, field: string): void {
  if (!isValidRewardsRateBps(value)) {
    throw invalid(`${field} must be an integer between 0 and ${MAX_REWARDS_RATE_BPS} basis points.`, { field, value });
  }
}

function assertCents(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative safe integer number of cents.`, { field, value });
  }
}

function invalid(message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(DROPSHIP_WALLET_REWARDS_INVALID, message, { ...context, classification: "fatal" });
}
