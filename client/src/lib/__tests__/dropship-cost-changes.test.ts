import { describe, expect, it } from "vitest";
import {
  describeVendorNoticeDecision,
  describeVendorNoticeTerms,
  describeVendorRecentChange,
  formatVendorCostCents,
  formatVendorCostChangeVariant,
  isVendorCostIncrease,
  parseDropshipVendorCostChanges,
  type DropshipVendorRecentChange,
} from "../dropship-cost-changes";

const formatDate = (iso: string) => `on ${iso.slice(0, 10)}`;

function recent(patch: Partial<DropshipVendorRecentChange> = {}): DropshipVendorRecentChange {
  return {
    logId: 31, productVariantId: 66, variantSku: "ARM-ENV-SGL-P50", variantName: "Single pack", productName: "Armor Envelope",
    eventType: "increase_announced", fromCents: 809, toCents: 999, effectiveAt: "2026-10-13T00:00:00.000Z",
    observedAt: "2026-09-28T16:05:00.000Z", noticeDecision: "sent", ...patch,
  };
}

const policy = { increaseNoticeDays: 14, decreaseTiming: "immediate" as const, priceProtection: true, notifyByEmail: true, notifyInPortal: true, notifyOnDecrease: true };

describe("vendor cost changes words", () => {
  it("formats cents digit by digit and labels the variant from what is known", () => {
    expect(formatVendorCostCents(809)).toBe("$8.09");
    expect(formatVendorCostCents(100_000_029)).toBe("$1,000,000.29");
    expect(formatVendorCostCents(-1)).toBe("$0.00");
    expect(formatVendorCostChangeVariant(recent())).toBe("ARM-ENV-SGL-P50 · Armor Envelope");
    expect(formatVendorCostChangeVariant(recent({ variantSku: " " }))).toBe("Single pack · Armor Envelope");
  });

  it("describes every kind of recorded change", () => {
    expect(describeVendorRecentChange(recent(), formatDate)).toBe("$8.09 → $9.99 from on 2026-10-13");
    expect(describeVendorRecentChange(recent({ eventType: "decrease_applied", toCents: 699 }), formatDate)).toBe("$8.09 → $6.99, applied at once");
    expect(describeVendorRecentChange(recent({ eventType: "increase_reduced", fromCents: 999, toCents: 899 }), formatDate))
      .toBe("The increase announced for on 2026-10-13 is now $8.99 instead of $9.99");
    expect(describeVendorRecentChange(recent({ eventType: "change_withdrawn", fromCents: 999, toCents: null }), formatDate))
      .toBe("The change to $9.99 announced for on 2026-10-13 was withdrawn");
    expect(describeVendorRecentChange(recent({ eventType: "baseline", fromCents: null, toCents: 809 }), formatDate)).toBe("Cost recorded at $8.09");
    expect(isVendorCostIncrease("increase_applied")).toBe(true);
    expect(isVendorCostIncrease("decrease_announced")).toBe(false);
  });

  it("explains every notice decision in the vendor's words", () => {
    expect(describeVendorNoticeDecision(null)).toBe("Notice pending");
    expect(describeVendorNoticeDecision("sent")).toBe("You were notified");
    expect(describeVendorNoticeDecision("skipped_decrease")).toBe("No notice: decreases are not announced");
    expect(describeVendorNoticeDecision("skipped_below_minimum")).toBe("No notice: below the notice minimum");
    expect(describeVendorNoticeDecision("skipped_channels_off")).toBe("No notice: notices are switched off");
    expect(describeVendorNoticeDecision("skipped_unannounced")).toBe("No notice: the original change was not announced");
    expect(describeVendorNoticeDecision("skipped_baseline")).toBe("No notice: first reading");
  });

  it("states the notice terms the policy gives", () => {
    expect(describeVendorNoticeTerms(policy)).toEqual([
      "You get 14 days' notice before a higher .ops cost is charged.",
      "A lower cost applies as soon as it is found.",
      "Orders accepted before a change takes effect are charged the cost in force at the time.",
      "Notices reach you by email and in Alerts.",
    ]);
    expect(describeVendorNoticeTerms({ ...policy, increaseNoticeDays: 0, decreaseTiming: "after_notice", priceProtection: false, notifyByEmail: false }))
      .toEqual([
        "A higher .ops cost applies as soon as it is found.",
        "A lower cost applies after the same notice.",
        "Orders are charged the current catalog cost when they are accepted.",
        "Notices reach you in Alerts.",
      ]);
    expect(describeVendorNoticeTerms({ ...policy, increaseNoticeDays: 1, notifyByEmail: false, notifyInPortal: false })[0]).toBe("You get 1 day' notice before a higher .ops cost is charged.".replace("1 day'", "1 day'"));
    expect(describeVendorNoticeTerms({ ...policy, notifyByEmail: false, notifyInPortal: false })[3]).toBe("Changes are recorded here but not sent as notices.");
  });

  it("refuses a response outside the contract and accepts a whole one", () => {
    expect(() => parseDropshipVendorCostChanges({ announced: [], recent: [], policy: { increaseNoticeDays: 14 }, generatedAt: "x" })).toThrow(/contract/);
    const parsed = parseDropshipVendorCostChanges({
      announced: [{ entryId: 11, productVariantId: 66, variantSku: null, variantName: "Pack", productName: "Armor", kind: "increase",
        fromCents: 809, unitCostCents: 999, effectiveAt: "2026-10-13T00:00:00.000Z", announcedAt: "2026-09-28T16:00:00.000Z" }],
      recent: [recent()],
      policy,
      generatedAt: "2026-09-28T16:05:00.000Z",
    });
    expect(parsed.announced).toHaveLength(1);
    expect(parsed.recent[0]?.noticeDecision).toBe("sent");
  });
});
