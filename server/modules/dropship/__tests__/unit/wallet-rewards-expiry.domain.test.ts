import { describe, expect, it } from "vitest";
import {
  DEFAULT_REWARDS_EXPIRY_DAYS,
  MAX_REWARDS_EXPIRY_DAYS,
  allocateRewardsFromLots,
  isRewardsLotDue,
  isValidRewardsExpiryDays,
  orderRewardsLotsForUse,
  rewardsLotExpiresAt,
} from "../../domain/wallet-rewards-expiry";

const JAN = new Date("2026-01-01T00:00:00.000Z");
const FEB = new Date("2026-02-01T00:00:00.000Z");
const MAR = new Date("2026-03-01T00:00:00.000Z");
const lot = (lotId: number, remainingCents: number, expiresAt: Date | null, earnedAt = JAN) => ({ lotId, remainingCents, expiresAt, earnedAt });

describe("rewards expiry setting and instant (funding design phase 7)", () => {
  it("never expires at launch, and accepts only null or whole days up to ten years", () => {
    expect(DEFAULT_REWARDS_EXPIRY_DAYS).toBeNull();
    expect(MAX_REWARDS_EXPIRY_DAYS).toBe(3_650);
    for (const value of [null, 1, 90, 365, 3_650]) expect(isValidRewardsExpiryDays(value), String(value)).toBe(true);
    for (const value of [0, -1, 3_651, 1.5, Number.NaN, "90", undefined]) expect(isValidRewardsExpiryDays(value), String(value)).toBe(false);
  });

  it("expires a lot exactly N whole days after it was earned, or never", () => {
    expect(rewardsLotExpiresAt({ earnedAt: JAN, expiryDays: null })).toBeNull();
    expect(rewardsLotExpiresAt({ earnedAt: JAN, expiryDays: 90 })?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    // Exact milliseconds: a daylight-saving boundary does not move the instant.
    expect(rewardsLotExpiresAt({ earnedAt: new Date("2026-03-07T12:34:56.789Z"), expiryDays: 2 })?.toISOString()).toBe("2026-03-09T12:34:56.789Z");
    expect(() => rewardsLotExpiresAt({ earnedAt: JAN, expiryDays: 0 })).toThrowError(expect.objectContaining({ code: "DROPSHIP_WALLET_REWARDS_INVALID" }));
    expect(() => rewardsLotExpiresAt({ earnedAt: new Date("not a date"), expiryDays: 90 })).toThrowError(expect.objectContaining({ code: "DROPSHIP_WALLET_REWARDS_INVALID" }));
  });

  it("finds a lot due only when it still holds points and its instant has come", () => {
    expect(isRewardsLotDue(lot(1, 100, FEB), FEB)).toBe(true);
    expect(isRewardsLotDue(lot(1, 100, FEB), MAR)).toBe(true);
    expect(isRewardsLotDue(lot(1, 100, MAR), FEB)).toBe(false);
    expect(isRewardsLotDue(lot(1, 0, FEB), MAR)).toBe(false);
    expect(isRewardsLotDue(lot(1, 100, null), MAR)).toBe(false);
  });
});

describe("which points leave first", () => {
  it("takes the lot closest to expiring first, never-expiring lots last, oldest first among equals", () => {
    const ordered = orderRewardsLotsForUse([
      lot(1, 10, null, JAN),
      lot(2, 10, MAR, JAN),
      lot(3, 10, FEB, FEB),
      lot(4, 10, null, FEB),
      lot(5, 10, FEB, JAN),
    ]);
    expect(ordered.map((entry) => entry.lotId)).toEqual([5, 3, 2, 1, 4]);
  });

  it("is total and leaves its input untouched", () => {
    const input = [lot(9, 10, null, JAN), lot(8, 10, null, JAN)];
    expect(orderRewardsLotsForUse(input).map((entry) => entry.lotId)).toEqual([8, 9]);
    expect(input.map((entry) => entry.lotId)).toEqual([9, 8]);
  });

  it("splits an amount across lots in that order, and never takes more than a lot holds", () => {
    const lots = [lot(1, 300, null), lot(2, 200, MAR), lot(3, 100, FEB)];
    expect(allocateRewardsFromLots({ lots, amountCents: 250 })).toEqual([{ lotId: 3, cents: 100 }, { lotId: 2, cents: 150 }]);
    expect(allocateRewardsFromLots({ lots, amountCents: 600 })).toEqual([{ lotId: 3, cents: 100 }, { lotId: 2, cents: 200 }, { lotId: 1, cents: 300 }]);
    expect(allocateRewardsFromLots({ lots, amountCents: 0 })).toEqual([]);
  });

  it("empties a preferred lot first, the disputed credit's own points for a clawback", () => {
    const lots = [lot(1, 300, null), lot(2, 200, MAR), lot(3, 100, FEB)];
    expect(allocateRewardsFromLots({ lots, amountCents: 350, preferredLotId: 1 })).toEqual([{ lotId: 1, cents: 300 }, { lotId: 3, cents: 50 }]);
    // A preferred lot that is empty or unknown changes nothing.
    expect(allocateRewardsFromLots({ lots: [lot(1, 0, null), lot(3, 100, FEB)], amountCents: 50, preferredLotId: 1 })).toEqual([{ lotId: 3, cents: 50 }]);
    expect(allocateRewardsFromLots({ lots, amountCents: 50, preferredLotId: 99 })).toEqual([{ lotId: 3, cents: 50 }]);
  });

  it("refuses to take more than the lots hold, or a malformed amount or lot", () => {
    const code = expect.objectContaining({ code: "DROPSHIP_WALLET_REWARDS_INVALID" });
    expect(() => allocateRewardsFromLots({ lots: [lot(1, 100, null)], amountCents: 101 })).toThrowError(code);
    expect(() => allocateRewardsFromLots({ lots: [lot(1, 100, null)], amountCents: -1 })).toThrowError(code);
    expect(() => allocateRewardsFromLots({ lots: [lot(1, 100, null)], amountCents: 1.5 })).toThrowError(code);
    expect(() => allocateRewardsFromLots({ lots: [lot(0, 100, null)], amountCents: 1 })).toThrowError(code);
    expect(() => allocateRewardsFromLots({ lots: [lot(1, -5, null)], amountCents: 1 })).toThrowError(code);
  });
});
