import { describe, expect, it } from "vitest";
import {
  DROPSHIP_COST_CHANGE_LOG_ADMIN_URL,
  DROPSHIP_COST_CHANGE_LOG_PAGE_SIZE,
  DROPSHIP_COST_CHANGE_TODAY_SUMMARY,
  DROPSHIP_COST_CHANGE_TODAY_WITH_DETECTION_SUMMARY,
  DROPSHIP_COST_CHANGE_TODAY_WITH_NOTICES_SUMMARY,
  DROPSHIP_COST_CHANGE_TODAY_WITH_PROTECTION_SUMMARY,
  describeDropshipCostChangeToday,
  formatDropshipCostChangeNoticeDecision,
  describeDropshipCostDetection,
  dropshipCostChangeLogPageUrl,
  formatDropshipCostChangeAmounts,
  formatDropshipCostChangeEvent,
  formatDropshipCostChangeVariant,
  formatDropshipCostChangeVendor,
  formatDropshipCostScheduleRecorder,
  formatDropshipCostSource,
  parseDropshipCostChangeDetectionOverview,
  parseDropshipCostChangeLogPage,
  type DropshipCostDetectionStateView,
} from "../dropship-cost-change-policy-model";

const formatTime = (value: string | null) => (value ? `at ${value}` : "never");

function state(patch: Partial<DropshipCostDetectionStateView> = {}): DropshipCostDetectionStateView {
  return {
    passNumber: 0, passStartedAt: null, passCompletedAt: null, cursorVendorId: null, policyId: null,
    passVendorsProcessed: 0, passVariantsRead: 0, passUnavailableReadings: 0, passChangesRecorded: 0, lastTickAt: null, ...patch,
  };
}

const finishedPass = state({
  passNumber: 3, passStartedAt: "2026-09-28T09:00:00.000Z", passCompletedAt: "2026-09-28T09:01:00.000Z", policyId: 2,
  passVendorsProcessed: 4, passVariantsRead: 120, passUnavailableReadings: 1, passChangesRecorded: 2, lastTickAt: "2026-09-28T09:59:00.000Z",
});

describe("describeDropshipCostDetection", () => {
  it("says the worker is off here, with the last activity when there was any", () => {
    expect(describeDropshipCostDetection({ workerEnabled: false, state: state() }, formatTime)).toEqual({
      status: "worker_off",
      headline: "The detection worker is switched off in this environment, so no cost is being checked here.",
      detail: "",
    });
    expect(describeDropshipCostDetection({ workerEnabled: false, state: finishedPass }, formatTime)).toMatchObject({
      status: "worker_off",
      detail: "Last activity at 2026-09-28T09:00:00.000Z. Pass 3: 4 vendors, 120 variant readings, 2 changes recorded, 1 reading unavailable.",
    });
  });

  it("distinguishes no pass yet, a pass under way and a completed pass", () => {
    expect(describeDropshipCostDetection({ workerEnabled: true, state: state() }, formatTime))
      .toEqual({ status: "never_ran", headline: "No detection pass has run yet.", detail: "" });
    expect(describeDropshipCostDetection({ workerEnabled: true, state: { ...finishedPass, passCompletedAt: null, passVendorsProcessed: 1 } }, formatTime))
      .toEqual({
        status: "in_progress",
        headline: "A detection pass is under way, started at 2026-09-28T09:00:00.000Z.",
        detail: "Pass 3: 1 vendor, 120 variant readings, 2 changes recorded, 1 reading unavailable.",
      });
    // A completion stamp older than the start belongs to the previous pass.
    expect(describeDropshipCostDetection({ workerEnabled: true, state: { ...finishedPass, passCompletedAt: "2026-09-28T08:00:00.000Z" } }, formatTime).status)
      .toBe("in_progress");
    expect(describeDropshipCostDetection({ workerEnabled: true, state: finishedPass }, formatTime)).toEqual({
      status: "completed",
      headline: "Last detection pass completed at 2026-09-28T09:01:00.000Z.",
      detail: "Pass 3: 4 vendors, 120 variant readings, 2 changes recorded, 1 reading unavailable.",
    });
  });
});

describe("cost change words", () => {
  it("names every event, source and amount change without floating point", () => {
    expect(formatDropshipCostChangeEvent("baseline")).toBe("Schedule started");
    expect(formatDropshipCostChangeEvent("increase_announced")).toBe("Increase announced");
    expect(formatDropshipCostChangeEvent("increase_applied")).toBe("Increase applied");
    expect(formatDropshipCostChangeEvent("decrease_announced")).toBe("Decrease announced");
    expect(formatDropshipCostChangeEvent("decrease_applied")).toBe("Decrease applied");
    expect(formatDropshipCostChangeEvent("increase_reduced")).toBe("Announced increase lowered");
    expect(formatDropshipCostChangeEvent("change_withdrawn")).toBe("Announced change withdrawn");
    expect(formatDropshipCostScheduleRecorder("detection")).toBe("by detection");
    expect(formatDropshipCostScheduleRecorder("acceptance")).toBe("at order acceptance");
    expect(formatDropshipCostSource("variant_fixed_price")).toBe("Fixed .ops price");
    expect(formatDropshipCostSource("plan_percent")).toBe("Plan percentage of retail");
    expect(formatDropshipCostChangeAmounts({ fromCents: 809, toCents: 999 })).toBe("$8.09 → $9.99");
    expect(formatDropshipCostChangeAmounts({ fromCents: null, toCents: 809 })).toBe("$8.09");
    expect(formatDropshipCostChangeAmounts({ fromCents: 1099, toCents: null })).toBe("$10.99 withdrawn");
    expect(formatDropshipCostChangeAmounts({ fromCents: 100_000_029, toCents: null })).toBe("$1,000,000.29 withdrawn");
    expect(formatDropshipCostChangeAmounts({ fromCents: null, toCents: null })).toBe("");
  });

  it("labels the vendor and the variant from what is known", () => {
    expect(formatDropshipCostChangeVendor({ vendorId: 5, vendorBusinessName: "Shellz Vendor" })).toBe("Shellz Vendor");
    expect(formatDropshipCostChangeVendor({ vendorId: 5, vendorBusinessName: "  " })).toBe("Vendor 5");
    expect(formatDropshipCostChangeVendor({ vendorId: 5, vendorBusinessName: null })).toBe("Vendor 5");
    expect(formatDropshipCostChangeVariant({ variantSku: "ARM-ENV-SGL-P50", variantName: "Single pack", productName: "Armor Envelope" }))
      .toBe("ARM-ENV-SGL-P50 · Armor Envelope");
    expect(formatDropshipCostChangeVariant({ variantSku: null, variantName: "Single pack", productName: "Armor Envelope" }))
      .toBe("Single pack · Armor Envelope");
  });

  it("says what happens today with and without detection", () => {
    const none = { detection: false, priceProtection: false, vendorNotices: false, listingActions: false };
    expect(describeDropshipCostChangeToday(none)).toBe(DROPSHIP_COST_CHANGE_TODAY_SUMMARY);
    expect(describeDropshipCostChangeToday({ ...none, detection: true })).toBe(DROPSHIP_COST_CHANGE_TODAY_WITH_DETECTION_SUMMARY);
    expect(DROPSHIP_COST_CHANGE_TODAY_WITH_DETECTION_SUMMARY).toContain("still charged on the next order accepted");
    expect(describeDropshipCostChangeToday({ ...none, detection: true, priceProtection: true })).toBe(DROPSHIP_COST_CHANGE_TODAY_WITH_PROTECTION_SUMMARY);
    // Protection without detection has nothing to charge from: the detection wording still applies.
    expect(describeDropshipCostChangeToday({ ...none, priceProtection: true })).toBe(DROPSHIP_COST_CHANGE_TODAY_SUMMARY);
    expect(DROPSHIP_COST_CHANGE_TODAY_WITH_PROTECTION_SUMMARY).toContain("charged the cost in force");
    expect(describeDropshipCostChangeToday({ ...none, detection: true, priceProtection: true, vendorNotices: true }))
      .toBe(DROPSHIP_COST_CHANGE_TODAY_WITH_NOTICES_SUMMARY);
    expect(DROPSHIP_COST_CHANGE_TODAY_WITH_NOTICES_SUMMARY).toContain("vendors are told as the policy says");
    expect(formatDropshipCostChangeNoticeDecision(null)).toBe("Notice pending");
    expect(formatDropshipCostChangeNoticeDecision("sent")).toBe("Vendor notified");
    expect(formatDropshipCostChangeNoticeDecision("skipped_below_minimum")).toBe("No notice: below the minimum");
  });
});

describe("change log paging", () => {
  it("builds the first page and a cursor page", () => {
    expect(dropshipCostChangeLogPageUrl(null)).toBe(`${DROPSHIP_COST_CHANGE_LOG_ADMIN_URL}?limit=${DROPSHIP_COST_CHANGE_LOG_PAGE_SIZE}`);
    expect(dropshipCostChangeLogPageUrl(345)).toBe(`${DROPSHIP_COST_CHANGE_LOG_ADMIN_URL}?limit=${DROPSHIP_COST_CHANGE_LOG_PAGE_SIZE}&beforeId=345`);
  });

  it("refuses a detection or log answer that breaks the contract", () => {
    expect(() => parseDropshipCostChangeDetectionOverview({ workerEnabled: true, state: state(), pending: [], pendingLimit: 0, generatedAt: "x" }))
      .toThrow();
    expect(() => parseDropshipCostChangeLogPage({ items: [{ logId: 1 }], nextBeforeId: null, generatedAt: "x" })).toThrow();
    expect(() => parseDropshipCostChangeLogPage({ items: [{ ...logRowFixture, noticeDecision: "maybe" }], nextBeforeId: null, generatedAt: "x" })).toThrow();
    expect(parseDropshipCostChangeLogPage({ items: [], nextBeforeId: null, generatedAt: "2026-09-28T10:00:00.000Z" }))
      .toEqual({ items: [], nextBeforeId: null, generatedAt: "2026-09-28T10:00:00.000Z" });
  });
});

const logRowFixture = {
  logId: 31, entryId: 11, recordedBy: "detection", vendorId: 5, vendorBusinessName: null, productVariantId: 66, variantSku: null,
  variantName: "Single pack", productName: "Armor Envelope", policyId: null, costSource: "retail", effectiveAt: "2026-10-13T00:00:00.000Z",
  observedAt: "2026-09-28T16:05:00.000Z", eventType: "change_withdrawn", fromCents: 1099, toCents: null, retailDriven: true,
  noticeDecision: null, createdAt: "2026-09-28T16:05:00.000Z",
};
