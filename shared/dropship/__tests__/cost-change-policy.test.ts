import { describe, expect, it } from "vitest";
import {
  DEFAULT_DROPSHIP_COST_CHANGE_POLICY,
  MAX_INCREASE_NOTICE_DAYS,
  costChangeMeetsNoticeMinimum,
  dropshipCostChangePolicySettingsSchema,
} from "../cost-change-policy";

describe("dropshipCostChangePolicySettingsSchema", () => {
  it("accepts the defaults", () => {
    expect(dropshipCostChangePolicySettingsSchema.parse(DEFAULT_DROPSHIP_COST_CHANGE_POLICY)).toEqual(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);
  });

  it("refuses values outside each setting's range and unknown settings", () => {
    const invalid = [
      { increaseNoticeDays: -1 },
      { increaseNoticeDays: MAX_INCREASE_NOTICE_DAYS + 1 },
      { increaseNoticeDays: 1.5 },
      { decreaseTiming: "never" },
      { noticeMinimumChangeCents: -1 },
      { noticeMinimumChangeBps: 10_001 },
      { rulePricedListings: "delete" },
      { belowCostFixedListings: "raise_price" },
      { detectionIntervalMinutes: 14 },
      { detectionIntervalMinutes: 1_441 },
      { unexpected: true },
    ];
    for (const change of invalid) {
      expect(dropshipCostChangePolicySettingsSchema.safeParse({ ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY, ...change }).success).toBe(false);
    }
  });

  it("keeps the defaults frozen", () => {
    expect(Object.isFrozen(DEFAULT_DROPSHIP_COST_CHANGE_POLICY)).toBe(true);
  });
});

describe("costChangeMeetsNoticeMinimum", () => {
  const none = { noticeMinimumChangeCents: 0, noticeMinimumChangeBps: 0 };

  it("announces any real change when no minimum is set, and never a non-change", () => {
    expect(costChangeMeetsNoticeMinimum(none, 809, 810)).toBe(true);
    expect(costChangeMeetsNoticeMinimum(none, 810, 809)).toBe(true);
    expect(costChangeMeetsNoticeMinimum(none, 809, 809)).toBe(false);
  });

  it("needs both the cents and the percentage minimum, compared without rounding", () => {
    const both = { noticeMinimumChangeCents: 10, noticeMinimumChangeBps: 100 };
    // 10 cents on $8.09 is 1.24%: both met.
    expect(costChangeMeetsNoticeMinimum(both, 809, 819)).toBe(true);
    // 9 cents: under the cents minimum.
    expect(costChangeMeetsNoticeMinimum(both, 809, 818)).toBe(false);
    // 50 cents on $100 is 0.5%: under the percentage minimum.
    expect(costChangeMeetsNoticeMinimum(both, 10_000, 10_050)).toBe(false);
    // Exactly 1% of $100.
    expect(costChangeMeetsNoticeMinimum(both, 10_000, 10_100)).toBe(true);
  });

  it("treats a change from zero as unbounded and refuses invalid cents", () => {
    expect(costChangeMeetsNoticeMinimum({ noticeMinimumChangeCents: 0, noticeMinimumChangeBps: 500 }, 0, 1)).toBe(true);
    expect(() => costChangeMeetsNoticeMinimum(none, -1, 5)).toThrow(RangeError);
    expect(() => costChangeMeetsNoticeMinimum(none, 5, 1.5)).toThrow(RangeError);
  });
});
