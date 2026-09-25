/**
 * Dropship wallet rewards expiry — when points expire and which points leave
 * first (funding design phase 7, owner decision of 2026-09-24).
 *
 * Staff set how many days after they are earned unused points expire, or
 * never (the setting is empty at launch). Each earning is a lot carrying its
 * own expiry date, fixed from the policy in force when it was earned, so a
 * change to the setting applies to points earned after it.
 *
 * Points leave lots in one order for every use (an order debit, the part of
 * a clawback not taken from the disputed credit's own lot, a reconciliation):
 * the lot closest to expiring first, never-expiring lots last, the oldest
 * first among equals. With one setting throughout that is simply oldest
 * first; when the setting changes it keeps points from expiring while
 * longer-lived ones are spent.
 *
 * Pure: no database, no clock. Money is integer cents (one point per cent).
 * Every input is validated so a malformed stored value fails closed
 * (classification `fatal`) instead of producing a wrong number.
 */

import { DropshipError } from "./errors";
import { DROPSHIP_WALLET_REWARDS_INVALID } from "./wallet-rewards";

/** Ten years. A bound on the date arithmetic and a typo guard, mirrored by the policy CHECK constraint. */
export const MAX_REWARDS_EXPIRY_DAYS = 3_650;

/** None at launch (owner decision, 2026-09-24): points never expire until staff set a number of days. */
export const DEFAULT_REWARDS_EXPIRY_DAYS: number | null = null;

const MS_PER_DAY = 86_400_000;

/** Null (never) or a whole number of days from 1 to the ceiling. */
export function isValidRewardsExpiryDays(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REWARDS_EXPIRY_DAYS);
}

/**
 * The instant a lot earned at `earnedAt` expires under `expiryDays`, or null
 * when it never does. Whole days of exact milliseconds: no calendar or
 * daylight-saving arithmetic, so the same inputs always give the same instant.
 */
export function rewardsLotExpiresAt(input: { earnedAt: Date; expiryDays: number | null }): Date | null {
  assertDate(input.earnedAt, "earnedAt");
  if (!isValidRewardsExpiryDays(input.expiryDays)) {
    throw invalid(`expiryDays must be null or a whole number of days from 1 to ${MAX_REWARDS_EXPIRY_DAYS}.`, { expiryDays: input.expiryDays });
  }
  if (input.expiryDays === null) return null;
  return new Date(input.earnedAt.getTime() + input.expiryDays * MS_PER_DAY);
}

/** A lot as the allocation rules need it. */
export interface DropshipRewardsLotBalance {
  lotId: number;
  remainingCents: number;
  expiresAt: Date | null;
  earnedAt: Date;
}

/** Points taken from one lot. */
export interface DropshipRewardsLotTake {
  lotId: number;
  cents: number;
}

/** True when a lot still holding points has reached its expiry instant at `now`; a due lot always has a date. */
export function isRewardsLotDue<T extends Pick<DropshipRewardsLotBalance, "remainingCents" | "expiresAt">>(
  lot: T,
  now: Date,
): lot is T & { expiresAt: Date } {
  assertDate(now, "now");
  return lot.remainingCents > 0 && lot.expiresAt !== null && lot.expiresAt.getTime() <= now.getTime();
}

/**
 * The order points leave lots in: closest to expiring first, never-expiring
 * last, oldest first among equals, then the lower id, so the order is total
 * and the same lots always give the same result. Returns a new array.
 */
export function orderRewardsLotsForUse<T extends DropshipRewardsLotBalance>(lots: readonly T[]): T[] {
  for (const lot of lots) assertLot(lot);
  return [...lots].sort((left, right) => {
    if (left.expiresAt !== null && right.expiresAt === null) return -1;
    if (left.expiresAt === null && right.expiresAt !== null) return 1;
    if (left.expiresAt !== null && right.expiresAt !== null && left.expiresAt.getTime() !== right.expiresAt.getTime()) {
      return left.expiresAt.getTime() - right.expiresAt.getTime();
    }
    if (left.earnedAt.getTime() !== right.earnedAt.getTime()) return left.earnedAt.getTime() - right.earnedAt.getTime();
    return left.lotId - right.lotId;
  });
}

/**
 * Which lots `amountCents` points come out of. A preferred lot (the disputed
 * credit's own lot, for a clawback) gives what it holds first; the rest
 * follows `orderRewardsLotsForUse`. The lots must hold at least the amount:
 * the rewards balance, which the lots mirror, is never overdrawn, so a
 * shortfall is a data fault and is refused rather than papered over.
 */
export function allocateRewardsFromLots(input: {
  lots: readonly DropshipRewardsLotBalance[];
  amountCents: number;
  preferredLotId?: number | null;
}): DropshipRewardsLotTake[] {
  assertCents(input.amountCents, "amountCents");
  if (input.amountCents === 0) return [];
  const open = orderRewardsLotsForUse(input.lots.filter((lot) => lot.remainingCents > 0));
  const preferredId = input.preferredLotId ?? null;
  const preferred = preferredId === null ? [] : open.filter((lot) => lot.lotId === preferredId);
  const ordered = [...preferred, ...open.filter((lot) => lot.lotId !== preferredId)];
  const available = ordered.reduce((sum, lot) => sum + lot.remainingCents, 0);
  if (available < input.amountCents) {
    throw invalid("The lots hold fewer points than the amount to take.", { amountCents: input.amountCents, availableCents: available });
  }
  const takes: DropshipRewardsLotTake[] = [];
  let outstanding = input.amountCents;
  for (const lot of ordered) {
    if (outstanding === 0) break;
    const cents = Math.min(lot.remainingCents, outstanding);
    takes.push({ lotId: lot.lotId, cents });
    outstanding -= cents;
  }
  return takes;
}

function assertLot(lot: DropshipRewardsLotBalance): void {
  if (!Number.isSafeInteger(lot.lotId) || lot.lotId <= 0) throw invalid("lotId must be a positive integer.", { lotId: lot.lotId });
  assertCents(lot.remainingCents, "remainingCents");
  assertDate(lot.earnedAt, "earnedAt");
  if (lot.expiresAt !== null) assertDate(lot.expiresAt, "expiresAt");
}

function assertCents(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative safe integer number of cents.`, { field, value });
  }
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw invalid(`${field} must be a valid date.`, { field, value: String(value) });
  }
}

function invalid(message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(DROPSHIP_WALLET_REWARDS_INVALID, message, { ...context, classification: "fatal" });
}
