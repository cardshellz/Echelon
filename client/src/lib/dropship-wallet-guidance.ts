/**
 * Wallet guidance model (spec §3).
 *
 * Pure, deterministic, integer cents. Every number the Wallet page shows about
 * floors, limits, fees and cover comes from one of these functions, so the
 * page contains no money policy of its own. Fees are computed with the shared
 * helper the server charges with, so every fee shown equals the fee charged.
 *
 * Two input contracts, enforced at every entry point (RangeError otherwise):
 * - `assertCents`: safe integer ≥ 0 for amounts, fees, floors, limits, daily
 *   costs and presets;
 * - `assertSignedCents`: safe integer of any sign for balances — a return fee
 *   can take the available balance below zero and the page must still render.
 * A fee is only ever computed on a clamped, non-negative amount.
 *
 * Constants marked "assumption" are stated on screen as assumptions: no ETA
 * for a bank transfer exists anywhere in the code or in Stripe's data.
 */

import { calculateCardFundingFeeCents, quoteWalletFunding } from "@shared/dropship/wallet-funding-fee";
import type { WalletLimits } from "./dropship-wallet-view-adapter";

export type WalletSourceRail = "stripe_ach" | "stripe_card";

// ---------------------------------------------------------------------------
// Constants (each with its rationale; those stated on screen say "our assumption")
// ---------------------------------------------------------------------------

/** Assumption: the upper figure of what a US ACH debit takes to settle; no ETA exists in code or Stripe data. */
export const ASSUMED_BANK_SETTLEMENT_BUSINESS_DAYS = 5;
/** The estimate on its own, for copy that already sits inside a bracket of its own. */
export const BANK_SETTLEMENT_DAYS_PHRASE = `up to ${ASSUMED_BANK_SETTLEMENT_BUSINESS_DAYS} business days`;
/** The one settlement phrase every screen uses; built from the constant above, never typed. */
export const BANK_SETTLEMENT_PHRASE = `${BANK_SETTLEMENT_DAYS_PHRASE} (our assumption)`;
/** The two floors quoted in the card floor copy; fees computed, never typed. */
export const FIRST_FILL_EXAMPLE_FLOORS_CENTS: readonly [number, number] = [10_000, 100_000];
/** Existing presets; the floor is added at runtime; clamped to the manual funding limits. */
export const DEPOSIT_PRESETS_CENTS: readonly number[] = [2_500, 5_000, 10_000, 25_000];
/** Card-source example when no daily cost is entered, prefixed "for example". */
export const EXAMPLE_MONTHLY_SPEND_CENTS = 100_000;
/** Card-source example when no daily cost is entered: what one $100 top-up charges. */
export const EXAMPLE_CARD_TOP_UP_CENTS = 10_000;
/** Fixed illustration of the shortfall rule: a $75 order with $20 available. */
export const EXAMPLE_SHORTFALL = Object.freeze({ orderCents: 7_500, availableCents: 2_000 });
/** Warn two months ahead: time for a new card and a Stripe round-trip. */
export const CARD_EXPIRY_WARNING_MONTHS = 2;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;

// ---------------------------------------------------------------------------
// Input contracts
// ---------------------------------------------------------------------------

export function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative whole number of cents.`);
  }
}

export function assertSignedCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be a whole number of cents.`);
  }
}

/** Integer division for non-negative operands. */
function floorDiv(numerator: number, denominator: number): number {
  return (numerator - (numerator % denominator)) / denominator;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** The presets plus whatever is already saved, so an existing choice is never shown as "none of these". */
export function presetsIncluding(presets: readonly number[], ...extra: Array<number | null>): number[] {
  const values = new Set<number>(presets);
  for (const value of extra) {
    if (value !== null && Number.isSafeInteger(value) && value > 0) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/** Card source: the one-time fee on filling an empty wallet to the floor. */
export function firstFillFeeCents(floorCents: number, bps: number): number {
  assertCents(floorCents, "floorCents");
  return calculateCardFundingFeeCents(floorCents, bps);
}

// ---------------------------------------------------------------------------
// The single-charge bound (funding design phase 5)
// ---------------------------------------------------------------------------

/**
 * The most autopay may take in one charge: the minimum, or the top-up amount
 * when that is larger. Mirrors the bound the server derives and enforces
 * (`domain/autopay-refill.ts`); the vendor never sets it.
 */
export function chargeBoundCents(floorCents: number, topUpCents: number | null): number {
  assertCents(floorCents, "floorCents");
  if (topUpCents !== null) assertCents(topUpCents, "topUpCents");
  return Math.max(floorCents, topUpCents ?? floorCents);
}

/** The cap applies to the whole shortfall, which includes a deficit: available −$50, limit $500 → $450. */
export function largestCoverableOrderCents(availableCents: number, limitCents: number): number {
  assertSignedCents(availableCents, "availableCents");
  assertCents(limitCents, "limitCents");
  return Math.max(0, availableCents + limitCents);
}

// ---------------------------------------------------------------------------
// What activation and a cover would charge (mirrors the server's math)
// ---------------------------------------------------------------------------

export type ActivationTopUp =
  | { outcome: "not_needed" }
  | {
      outcome: "top_up";
      amountCents: number;
      feeCents: number;
      chargedCents: number;
      lands: "instant" | "pending";
      /** True when the single-charge bound left part of the shortfall for the next daily check. */
      partial: boolean;
    };

/**
 * Mirrors the server's routine refill (`domain/autopay-refill.ts`): the
 * top-up amount (the minimum by default), or the whole shortfall when that is
 * more, never past the single-charge bound; pending money counts.
 */
export function activationTopUp(input: {
  sourceRail: WalletSourceRail;
  floorCents: number;
  topUpCents: number | null;
  availableCents: number;
  pendingCents: number;
  bps: number;
}): ActivationTopUp {
  const bound = chargeBoundCents(input.floorCents, input.topUpCents);
  assertSignedCents(input.availableCents, "availableCents");
  assertSignedCents(input.pendingCents, "pendingCents");
  const needed = input.floorCents - (input.availableCents + input.pendingCents);
  if (needed <= 0) return { outcome: "not_needed" };
  const amount = Math.min(Math.max(needed, input.topUpCents ?? input.floorCents), bound);
  const quote = quoteWalletFunding({ rail: input.sourceRail, creditCents: amount, cardFeeBps: input.bps });
  return {
    outcome: "top_up",
    amountCents: quote.creditCents,
    feeCents: quote.feeCents,
    chargedCents: quote.chargedCents,
    lands: input.sourceRail === "stripe_card" ? "instant" : "pending",
    partial: amount < needed,
  };
}

export interface ShortfallExample {
  shortfallCents: number;
  feeCents: number;
  chargedCents: number;
}

/** The backup-card charge for an order the balance cannot cover: the shortfall (deficit included) plus the fee. */
export function shortfallExample(input: { orderCents: number; availableCents: number; bps: number }): ShortfallExample {
  assertCents(input.orderCents, "orderCents");
  assertSignedCents(input.availableCents, "availableCents");
  const shortfallCents = Math.max(0, input.orderCents - input.availableCents);
  const feeCents = calculateCardFundingFeeCents(shortfallCents, input.bps);
  return { shortfallCents, feeCents, chargedCents: shortfallCents + feeCents };
}

export function depositAmountDefault(floorCents: number, limits: WalletLimits): number {
  assertCents(floorCents, "floorCents");
  return Math.min(Math.max(floorCents, limits.manualFundingMinCents), limits.manualFundingMaxCents);
}

// ---------------------------------------------------------------------------
// Card expiry (spec §2.9) and durations
// ---------------------------------------------------------------------------

export type CardExpiryState = "expired" | "expiring" | "ok" | "unknown";

export function cardExpiryState(card: { expMonth: number | null; expYear: number | null }, now: Date): CardExpiryState {
  if (card.expMonth === null || card.expYear === null) return "unknown";
  const months = (card.expYear - now.getUTCFullYear()) * 12 + (card.expMonth - (now.getUTCMonth() + 1));
  if (months < 0) return "expired";
  if (months <= CARD_EXPIRY_WARNING_MONTHS) return "expiring";
  return "ok";
}

/** 45 → "45 minutes", 90 → "1 hour 30 minutes", 2 880 → "48 hours", 10 080 → "7 days". Integer input ≥ 1. */
export function formatDurationMinutes(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new RangeError("minutes must be a whole number of at least 1.");
  if (minutes % MINUTES_PER_DAY === 0 && minutes >= 7 * MINUTES_PER_DAY) {
    const days = minutes / MINUTES_PER_DAY;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes >= MINUTES_PER_HOUR) {
    const hours = floorDiv(minutes, MINUTES_PER_HOUR);
    const rest = minutes % MINUTES_PER_HOUR;
    const hourPart = `${hours} ${hours === 1 ? "hour" : "hours"}`;
    return rest === 0 ? hourPart : `${hourPart} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** "$250" for whole dollars, "$7.50" otherwise. Display only. */
export function formatWholeDollars(centsValue: number): string {
  assertSignedCents(centsValue, "cents");
  const sign = centsValue < 0 ? "−" : "";
  const absolute = Math.abs(centsValue);
  const dollars = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  if (remainder === 0) return `${sign}$${dollars.toLocaleString("en-US")}`;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

/** Signed money with a typographic minus: −$50.00. */
export function formatSignedCents(centsValue: number): string {
  assertSignedCents(centsValue, "cents");
  const sign = centsValue < 0 ? "−" : "";
  const absolute = Math.abs(centsValue);
  return `${sign}$${Math.trunc(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`;
}
