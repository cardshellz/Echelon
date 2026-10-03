import { describe, expect, it } from "vitest";
import {
  decidePickPriorityPlanSource,
  DROPSHIP_VENDOR_PLAN_ID_MAX_LENGTH,
  MEMBER_PLAN_BADGE_MAX_LENGTH,
  NO_PICK_PRIORITY_PLAN,
  readDropshipVendorPlanId,
  toPickPriorityPlan,
} from "../../dropship-order-priority";

// Production values from order 22039 (OMS order 1013417): the Dropship OMS
// channel and vendor 1's `.ops` plan.
const DROPSHIP_OMS_CHANNEL_ID = 103;
const OPS_PLAN_ID = "14d8698f-09d8-4dea-8089-fa9a1ec0fb28";

function stampedPayload(vendorMembershipPlanId: unknown): Record<string, unknown> {
  return {
    dropship: {
      intakeId: 43,
      vendorId: 1,
      storeConnectionId: 1,
      vendorMembershipPlanId,
      externalOrderId: "22039",
    },
    marketplace: {},
  };
}

describe("readDropshipVendorPlanId", () => {
  it("reads the vendor's plan id from the acceptance stamp", () => {
    expect(readDropshipVendorPlanId(stampedPayload(OPS_PLAN_ID))).toEqual({
      kind: "present",
      planId: OPS_PLAN_ID,
    });
  });

  it("accepts a plan id at the widest length acceptance can record", () => {
    const widest = "p".repeat(DROPSHIP_VENDOR_PLAN_ID_MAX_LENGTH);
    expect(readDropshipVendorPlanId(stampedPayload(widest))).toEqual({ kind: "present", planId: widest });
  });

  it.each([
    { label: "a null payload", payload: null },
    { label: "a string payload", payload: "dropship" },
    { label: "an array payload", payload: [{ dropship: { vendorMembershipPlanId: OPS_PLAN_ID } }] },
    { label: "a payload without a stamp", payload: { marketplace: {} } },
    { label: "a stamp that is not an object", payload: { dropship: "intake-43" } },
    { label: "a stamp that is an array", payload: { dropship: [OPS_PLAN_ID] } },
    { label: "an order accepted before the plan was recorded", payload: { dropship: { intakeId: 43 } } },
    { label: "a vendor without a plan", payload: stampedPayload(null) },
  ])("reads $label as absent", ({ payload }) => {
    expect(readDropshipVendorPlanId(payload)).toEqual({ kind: "absent" });
  });

  it.each([
    { label: "a number", value: 100 },
    { label: "an object", value: { id: OPS_PLAN_ID } },
    { label: "an empty string", value: "" },
    { label: "a padded id", value: ` ${OPS_PLAN_ID} ` },
    { label: "an id longer than any plan id", value: "p".repeat(DROPSHIP_VENDOR_PLAN_ID_MAX_LENGTH + 1) },
  ])("reads $label as invalid", ({ value }) => {
    expect(readDropshipVendorPlanId(stampedPayload(value))).toEqual({ kind: "invalid" });
  });
});

describe("decidePickPriorityPlanSource", () => {
  it("scores 22039 from the vendor's plan, not the buyer's membership", () => {
    expect(decidePickPriorityPlanSource({
      identity: {
        omsOrderChannelId: DROPSHIP_OMS_CHANNEL_ID,
        dropshipOmsChannelId: DROPSHIP_OMS_CHANNEL_ID,
        hasDropshipAcceptanceStamp: true,
      },
      rawPayload: stampedPayload(OPS_PLAN_ID),
    })).toEqual({ kind: "dropship_vendor_plan", planId: OPS_PLAN_ID });
  });

  it("still recognises a stamped Dropship order when the channel cannot be resolved", () => {
    expect(decidePickPriorityPlanSource({
      identity: {
        omsOrderChannelId: DROPSHIP_OMS_CHANNEL_ID,
        dropshipOmsChannelId: null,
        hasDropshipAcceptanceStamp: true,
      },
      rawPayload: stampedPayload(OPS_PLAN_ID),
    })).toEqual({ kind: "dropship_vendor_plan", planId: OPS_PLAN_ID });
  });

  it("never falls back to the buyer for a Dropship order without a recorded plan", () => {
    expect(decidePickPriorityPlanSource({
      identity: {
        omsOrderChannelId: DROPSHIP_OMS_CHANNEL_ID,
        dropshipOmsChannelId: DROPSHIP_OMS_CHANNEL_ID,
        hasDropshipAcceptanceStamp: false,
      },
      rawPayload: { marketplace: {} },
    })).toEqual({ kind: "dropship_vendor_plan_unavailable", reason: "absent" });
  });

  it("reports an unreadable plan id on a Dropship order", () => {
    expect(decidePickPriorityPlanSource({
      identity: {
        omsOrderChannelId: DROPSHIP_OMS_CHANNEL_ID,
        dropshipOmsChannelId: DROPSHIP_OMS_CHANNEL_ID,
        hasDropshipAcceptanceStamp: true,
      },
      rawPayload: stampedPayload(42),
    })).toEqual({ kind: "dropship_vendor_plan_unavailable", reason: "invalid" });
  });

  it.each([
    { label: "a Shopify order", omsOrderChannelId: 36, dropshipOmsChannelId: DROPSHIP_OMS_CHANNEL_ID },
    { label: "an order when the Dropship channel cannot be resolved", omsOrderChannelId: 36, dropshipOmsChannelId: null },
    { label: "an order with no channel", omsOrderChannelId: null, dropshipOmsChannelId: DROPSHIP_OMS_CHANNEL_ID },
  ])("keeps the buyer's membership for $label", ({ omsOrderChannelId, dropshipOmsChannelId }) => {
    expect(decidePickPriorityPlanSource({
      identity: { omsOrderChannelId, dropshipOmsChannelId, hasDropshipAcceptanceStamp: false },
      rawPayload: { customer: { id: 123 } },
    })).toEqual({ kind: "customer_membership" });
  });
});

describe("toPickPriorityPlan", () => {
  it("maps the .ops plan row to its modifier and badge", () => {
    expect(toPickPriorityPlan({ priority_modifier: 100, name: ".ops", primary_color: "#C060E0" })).toEqual({
      modifier: 100,
      name: ".ops",
      color: "#C060E0",
    });
  });

  it.each([
    { label: "a numeric string", value: "100", expected: 100 },
    { label: "zero", value: 0, expected: 0 },
    { label: "a negative modifier", value: -5, expected: -5 },
    { label: "a negative numeric string", value: "-5", expected: -5 },
  ])("reads $label as an integer modifier", ({ value, expected }) => {
    expect(toPickPriorityPlan({ priority_modifier: value, name: ".ops", primary_color: null })?.modifier)
      .toBe(expected);
  });

  it.each([
    { label: "a missing modifier", value: undefined },
    { label: "a null modifier", value: null },
    { label: "a fraction", value: 1.5 },
    { label: "a decimal string", value: "1.5" },
    { label: "a non-numeric string", value: "high" },
    { label: "an empty string", value: "" },
    { label: "infinity", value: Number.POSITIVE_INFINITY },
    { label: "NaN", value: Number.NaN },
    { label: "an unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses $label instead of guessing a score", ({ value }) => {
    expect(toPickPriorityPlan({ priority_modifier: value, name: ".ops", primary_color: null })).toBeNull();
  });

  it("keeps the modifier but drops badge text the WMS column cannot hold", () => {
    // "Hobby Shop International" is 24 characters; wms.orders.member_plan_name is varchar(20).
    expect(toPickPriorityPlan({
      priority_modifier: 0,
      name: "Hobby Shop International",
      primary_color: "c".repeat(MEMBER_PLAN_BADGE_MAX_LENGTH + 1),
    })).toEqual({ modifier: 0, name: null, color: null });
    const widest = "n".repeat(MEMBER_PLAN_BADGE_MAX_LENGTH);
    expect(toPickPriorityPlan({ priority_modifier: 5, name: widest, primary_color: widest }))
      .toEqual({ modifier: 5, name: widest, color: widest });
  });

  it.each([
    { label: "an empty name", name: "" },
    { label: "a missing name", name: undefined },
    { label: "a non-string name", name: 7 },
  ])("leaves the badge empty for $label", ({ name }) => {
    expect(toPickPriorityPlan({ priority_modifier: 50, name, primary_color: undefined })).toEqual({
      modifier: 50,
      name: null,
      color: null,
    });
  });
});

describe("NO_PICK_PRIORITY_PLAN", () => {
  it("scores like a non-member and cannot be changed by a caller", () => {
    expect(NO_PICK_PRIORITY_PLAN).toEqual({ modifier: 0, name: null, color: null });
    expect(Object.isFrozen(NO_PICK_PRIORITY_PLAN)).toBe(true);
  });
});
