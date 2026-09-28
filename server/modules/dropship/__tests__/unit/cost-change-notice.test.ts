import { describe, expect, it } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "../../../../../shared/dropship/cost-change-policy";
import {
  costChangeNoticeChannels,
  costChangeNoticeIdempotencyKey,
  decideCostChangeNotice,
} from "../../domain/cost-change-notice";

const settings = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };

describe("decideCostChangeNotice", () => {
  it("announces increases and decreases with a date, and reports ones applied at once", () => {
    expect(decideCostChangeNotice({ eventType: "increase_announced", fromCents: 809, toCents: 999, previouslySent: false, settings }))
      .toEqual({ decision: "sent", kind: "announced" });
    expect(decideCostChangeNotice({ eventType: "decrease_announced", fromCents: 809, toCents: 699, previouslySent: false, settings }))
      .toEqual({ decision: "sent", kind: "announced" });
    expect(decideCostChangeNotice({ eventType: "increase_applied", fromCents: 809, toCents: 999, previouslySent: false, settings }))
      .toEqual({ decision: "sent", kind: "applied" });
    expect(decideCostChangeNotice({ eventType: "decrease_applied", fromCents: 809, toCents: 699, previouslySent: false, settings }))
      .toEqual({ decision: "sent", kind: "applied" });
  });

  it("never announces a schedule start", () => {
    expect(decideCostChangeNotice({ eventType: "baseline", fromCents: null, toCents: 809, previouslySent: false, settings }))
      .toEqual({ decision: "skipped_baseline", kind: null });
  });

  it("skips decreases when the policy says not to tell, but still tells increases", () => {
    const quietDecreases = { ...settings, notifyOnDecrease: false };
    expect(decideCostChangeNotice({ eventType: "decrease_applied", fromCents: 809, toCents: 699, previouslySent: false, settings: quietDecreases }))
      .toEqual({ decision: "skipped_decrease", kind: null });
    expect(decideCostChangeNotice({ eventType: "increase_announced", fromCents: 809, toCents: 999, previouslySent: false, settings: quietDecreases }))
      .toEqual({ decision: "sent", kind: "announced" });
  });

  it("skips a change under either minimum, in whole cents", () => {
    const minimums = { ...settings, noticeMinimumChangeCents: 25, noticeMinimumChangeBps: 500 };
    expect(decideCostChangeNotice({ eventType: "increase_announced", fromCents: 809, toCents: 829, previouslySent: false, settings: minimums }))
      .toEqual({ decision: "skipped_below_minimum", kind: null });
    // 40 cents on $8.09 is 4.94%: under the 5% minimum.
    expect(decideCostChangeNotice({ eventType: "increase_announced", fromCents: 809, toCents: 849, previouslySent: false, settings: minimums }))
      .toEqual({ decision: "skipped_below_minimum", kind: null });
    expect(decideCostChangeNotice({ eventType: "increase_announced", fromCents: 809, toCents: 850, previouslySent: false, settings: minimums }))
      .toEqual({ decision: "sent", kind: "announced" });
  });

  it("sends nothing when the policy sends on no channel", () => {
    const silent = { ...settings, notifyByEmail: false, notifyInPortal: false };
    expect(decideCostChangeNotice({ eventType: "increase_announced", fromCents: 809, toCents: 999, previouslySent: false, settings: silent }))
      .toEqual({ decision: "skipped_channels_off", kind: null });
    expect(decideCostChangeNotice({ eventType: "change_withdrawn", fromCents: 999, toCents: null, previouslySent: true, settings: silent }))
      .toEqual({ decision: "skipped_channels_off", kind: null });
  });

  it("updates the vendor on a lowered or withdrawn change only when its announcement was sent", () => {
    expect(decideCostChangeNotice({ eventType: "increase_reduced", fromCents: 999, toCents: 899, previouslySent: true, settings }))
      .toEqual({ decision: "sent", kind: "updated" });
    expect(decideCostChangeNotice({ eventType: "change_withdrawn", fromCents: 999, toCents: null, previouslySent: true, settings }))
      .toEqual({ decision: "sent", kind: "updated" });
    expect(decideCostChangeNotice({ eventType: "increase_reduced", fromCents: 999, toCents: 899, previouslySent: false, settings }))
      .toEqual({ decision: "skipped_unannounced", kind: null });
    expect(decideCostChangeNotice({ eventType: "change_withdrawn", fromCents: 999, toCents: null, previouslySent: false, settings }))
      .toEqual({ decision: "skipped_unannounced", kind: null });
  });

  it("refuses a change row without both amounts", () => {
    expect(() => decideCostChangeNotice({ eventType: "increase_announced", fromCents: null, toCents: 999, previouslySent: false, settings }))
      .toThrow(RangeError);
  });
});

describe("costChangeNoticeChannels", () => {
  it("follows the policy's two switches", () => {
    expect(costChangeNoticeChannels({ notifyByEmail: true, notifyInPortal: true })).toEqual(["email", "in_app"]);
    expect(costChangeNoticeChannels({ notifyByEmail: false, notifyInPortal: true })).toEqual(["in_app"]);
    expect(costChangeNoticeChannels({ notifyByEmail: true, notifyInPortal: false })).toEqual(["email"]);
    expect(costChangeNoticeChannels({ notifyByEmail: false, notifyInPortal: false })).toEqual([]);
  });
});

describe("costChangeNoticeIdempotencyKey", () => {
  it("is one key per vendor, reading, writer and kind, and carries the vendor id", () => {
    const observedAt = new Date("2026-09-28T16:05:00.000Z");
    const key = costChangeNoticeIdempotencyKey({ vendorId: 5, kind: "announced", recordedBy: "detection", observedAt });
    expect(key).toBe("dropship-cost-change:5:announced:detection:2026-09-28T16:05:00.000Z");
    expect(costChangeNoticeIdempotencyKey({ vendorId: 6, kind: "announced", recordedBy: "detection", observedAt })).not.toBe(key);
    expect(costChangeNoticeIdempotencyKey({ vendorId: 5, kind: "applied", recordedBy: "detection", observedAt })).not.toBe(key);
    expect(costChangeNoticeIdempotencyKey({ vendorId: 5, kind: "announced", recordedBy: "acceptance", observedAt })).not.toBe(key);
    expect(() => costChangeNoticeIdempotencyKey({ vendorId: 0, kind: "announced", recordedBy: "detection", observedAt })).toThrow(RangeError);
    expect(() => costChangeNoticeIdempotencyKey({ vendorId: 5, kind: "announced", recordedBy: "detection", observedAt: new Date(Number.NaN) })).toThrow(RangeError);
  });
});
