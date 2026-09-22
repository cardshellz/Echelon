import { describe, expect, it } from "vitest";
import {
  CustomerReturnEligibilityError,
  DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS,
  customerReturnEligibilityInputSchema,
  customerReturnEligibilityOutputSchema,
  evaluateCustomerReturnEligibility,
  type CustomerReturnEligibilityInput,
} from "../../domain/customer-return-eligibility";

const PURCHASED_AT = "2026-08-20T12:00:00.000Z";
const DELIVERED_AT = "2026-09-21T17:36:00.000Z";
const NOW = "2026-09-22T12:00:00.000Z";
type Line = CustomerReturnEligibilityInput["order"]["lines"][number];
type Allocation = Line["allocations"][number];

function allocation(id = "1", overrides: Partial<Allocation> = {}): Allocation {
  return {
    allocationId: `allocation-${id}`,
    fulfillmentId: `gid://shopify/Fulfillment/${id}`,
    fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${id}`,
    quantity: 2,
    status: "active",
    deliveryEvidence: [{
      evidenceId: `event-${id}`,
      source: "shopify",
      status: "delivered",
      occurredAt: DELIVERED_AT,
      observedAt: NOW,
    }],
    staffDeliveryOverride: null,
    ...overrides,
  };
}

function line(id = "1", overrides: Partial<Line> = {}): Line {
  return {
    lineId: `gid://shopify/LineItem/${id}`,
    sku: "SAME-SKU",
    requiresShipping: true,
    purchasedQuantity: 2,
    allocations: [allocation(id)],
    claims: [],
    ...overrides,
  };
}

function input(): CustomerReturnEligibilityInput {
  return {
    now: NOW,
    policy: { channelId: 36, version: 4, returnWindowDays: DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS },
    order: {
      orderId: "gid://shopify/Order/0009007199254740993",
      channelId: 36,
      provider: "shopify",
      destinationCountryCode: "US",
      purchasedAt: PURCHASED_AT,
      lines: [line()],
    },
  };
}

function staffOverride(quantity: number): NonNullable<Allocation["staffDeliveryOverride"]> {
  return {
    overrideId: "override-1", quantity, actor: "user:7", approvedAt: NOW,
    reason: "Customer confirmed possession during support review.", verificationReference: "support-case:123",
  };
}

function invalidFacts(value: unknown): void {
  expect(customerReturnEligibilityInputSchema.safeParse(value).success).toBe(false);
  expect(() => evaluateCustomerReturnEligibility(value)).toThrow(CustomerReturnEligibilityError);
}

describe("evaluateCustomerReturnEligibility", () => {
  it("preserves exact identities and validates its output without mutating source facts", () => {
    const facts = input();
    const before = structuredClone(facts);
    const result = evaluateCustomerReturnEligibility(facts);
    expect(result).toMatchObject({
      orderId: facts.order.orderId, policyVersion: 4, evaluatedAt: NOW,
      returnWindowEndsAt: "2027-08-20T12:00:00.000Z", eligibleQuantity: 2, hasEligibleItems: true,
      reasons: [], lines: [{ lineId: facts.order.lines[0].lineId, deliveredQuantity: 2, claimedQuantity: 0,
        remainingPurchasedQuantity: 2, eligibleQuantity: 2, allocations: [{ deliveryBasis: "provider" }] }],
    });
    expect(customerReturnEligibilityOutputSchema.safeParse(result).success).toBe(true);
    expect(evaluateCustomerReturnEligibility(facts)).toEqual(result);
    expect(facts).toEqual(before);
  });

  it("keeps identically named SKUs on separate purchased lines", () => {
    const facts = input();
    facts.order.lines.push(line("2"));
    facts.order.lines[0].claims = [{ claimId: "claim-1", allocationId: "allocation-1", quantity: 2 }];
    const result = evaluateCustomerReturnEligibility(facts);
    expect(result.lines.map((item) => item.eligibleQuantity)).toEqual([0, 2]);
    expect(result.eligibleQuantity).toBe(2);
  });

  it("exposes delivered lines without requiring the rest of the order to arrive (#63210)", () => {
    const facts = input();
    const inTransit = allocation("2", { quantity: 1 });
    inTransit.deliveryEvidence[0].status = "in_transit";
    facts.order.lines.push(line("2", { purchasedQuantity: 1, allocations: [inTransit] }));
    expect(evaluateCustomerReturnEligibility(facts).lines.map((item) => item.eligibleQuantity)).toEqual([2, 0]);
  });

  it("does not treat fulfilled but in-transit goods as delivered (#63268)", () => {
    const facts = input();
    facts.order.lines[0].allocations[0].deliveryEvidence[0].status = "in_transit";
    const result = evaluateCustomerReturnEligibility(facts);
    expect(result.hasEligibleItems).toBe(false);
    expect(result.lines[0].allocations[0]).toMatchObject({ deliveryStatus: "in_transit", reasons: ["not_delivered"] });
  });

  it("supports one purchased line delivered in parts across several fulfillments", () => {
    const facts = input();
    const pending = allocation("2", { quantity: 1, deliveryEvidence: [] });
    facts.order.lines[0].allocations = [allocation("1", { quantity: 1 }), pending];
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({
      purchasedQuantity: 2, deliveredQuantity: 1, eligibleQuantity: 1, reasons: ["delivery_unknown"],
    });
  });

  it.each(["cancelled", "superseded"] as const)("ignores %s fulfillment evidence without inflating replaced units", (status) => {
    const facts = input();
    facts.order.lines[0].allocations.push(allocation("old", { status }));
    const result = evaluateCustomerReturnEligibility(facts);
    expect(result.eligibleQuantity).toBe(2);
    expect(result.lines[0].allocations[1]).toMatchObject({ deliveryStatus: "inactive", deliveredQuantity: 0, eligibleQuantity: 0 });
  });

  it("does not let inactive allocations or unfulfilled purchased units grant entitlement", () => {
    const facts = input();
    facts.order.lines[0].allocations[0].status = "cancelled";
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({ eligibleQuantity: 0, reasons: ["no_active_fulfillment"] });
    facts.order.lines[0].allocations = [];
    expect(evaluateCustomerReturnEligibility(facts).hasEligibleItems).toBe(false);
  });

  it("uses valid provider delivery despite a later observed unknown or older transit event", () => {
    const facts = input();
    facts.order.lines[0].allocations[0].deliveryEvidence.push(
      { evidenceId: "carrier-1", source: "carrier", status: "in_transit", occurredAt: "2026-09-20T12:00:00Z", observedAt: NOW },
      { evidenceId: "carrier-2", source: "carrier", status: "unknown", occurredAt: NOW, observedAt: NOW },
    );
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(2);
  });

  it("accepts carrier delivery without requiring Shopify agreement or a local delivered timestamp", () => {
    const facts = input();
    facts.order.lines[0].allocations[0].deliveryEvidence[0].source = "carrier";
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(2);
  });

  it("holds contradictory effective delivery facts without blocking independent valid lines", () => {
    const facts = input();
    facts.order.lines.push(line("2"));
    facts.order.lines[0].allocations[0].deliveryEvidence.push({
      evidenceId: "contradiction", source: "carrier", status: "in_transit", occurredAt: NOW, observedAt: NOW,
    });
    facts.order.lines[0].allocations[0].staffDeliveryOverride = staffOverride(2);
    const result = evaluateCustomerReturnEligibility(facts);
    expect(result.lines[0].allocations[0]).toMatchObject({
      deliveryStatus: "conflict", eligibleQuantity: 0, reasons: ["delivery_evidence_conflict"],
    });
    expect(result.lines[1].eligibleQuantity).toBe(2);
  });

  it.each(["unknown", "in_transit"] as const)("allows audited staff verification of exact quantities while tracking is %s", (status) => {
    const facts = input();
    const source = facts.order.lines[0].allocations[0];
    source.deliveryEvidence[0].status = status;
    source.staffDeliveryOverride = staffOverride(1);
    expect(evaluateCustomerReturnEligibility(facts).lines[0].allocations[0]).toMatchObject({
      deliveryStatus: "partially_verified", deliveryBasis: "staff", deliveredQuantity: 1,
      eligibleQuantity: 1, staffOverrideId: "override-1",
    });
  });

  it("does not add staff-verified quantities to provider-delivered units", () => {
    const facts = input();
    facts.order.lines[0].allocations[0].staffDeliveryOverride = staffOverride(2);
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(2);
  });

  it("conservatively deducts claims from staff-verified units and purchased limits", () => {
    const facts = input();
    facts.order.lines[0].allocations[0].deliveryEvidence = [];
    facts.order.lines[0].allocations[0].staffDeliveryOverride = staffOverride(1);
    facts.order.lines[0].claims = [{ claimId: "claim-1", allocationId: "allocation-1", quantity: 1 }];
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({
      eligibleQuantity: 0, deliveredQuantity: 1, claimedQuantity: 1, remainingPurchasedQuantity: 1,
    });
  });

  it("deducts each allocated claim exactly once", () => {
    const facts = input();
    facts.order.lines[0].claims = [{ claimId: "claim-1", allocationId: "allocation-1", quantity: 1 }];
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(1);
    facts.order.lines[0].claims.push({ claimId: "claim-2", allocationId: "allocation-1", quantity: 1 });
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({ eligibleQuantity: 0, reasons: ["all_quantity_claimed"] });
  });

  it("requires reconciliation instead of guessing the fulfillment behind an unallocated claim", () => {
    const facts = input();
    facts.order.lines[0].claims = [{ claimId: "legacy-1", allocationId: null, quantity: 1 }];
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({
      eligibleQuantity: 0, remainingPurchasedQuantity: 1, reasons: ["claim_allocation_unknown"],
      allocations: [{ eligibleQuantity: 0 }],
    });
  });

  it("holds claims on superseded allocations without silently releasing or moving them", () => {
    const facts = input();
    facts.order.lines[0].allocations.push(allocation("old", { status: "superseded" }));
    facts.order.lines[0].claims = [{ claimId: "claim-1", allocationId: "allocation-old", quantity: 1 }];
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({ eligibleQuantity: 0, reasons: ["claim_on_inactive_allocation"] });
  });

  it.each([
    ["provider", "ebay", "provider_not_supported"],
    ["channelId", 42, "channel_not_supported"],
    ["destinationCountryCode", "CA", "destination_not_supported"],
    ["destinationCountryCode", null, "destination_unknown"],
  ] as const)("blocks unsupported %s before approving any units", (field, value, reason) => {
    const facts = input();
    Object.assign(facts.order, { [field]: value });
    facts.order.lines[0].allocations[0].staffDeliveryOverride = staffOverride(2);
    expect(evaluateCustomerReturnEligibility(facts)).toMatchObject({ eligibleQuantity: 0, hasEligibleItems: false, reasons: [reason] });
  });

  it("keeps the exact 365-day endpoint inclusive and rejects the next millisecond", () => {
    const facts = input();
    facts.now = "2027-08-20T12:00:00.000Z";
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(2);
    facts.now = "2027-08-20T12:00:00.001Z";
    expect(evaluateCustomerReturnEligibility(facts)).toMatchObject({ eligibleQuantity: 0, reasons: ["return_window_elapsed"] });
  });

  it("measures elapsed policy days across leap years and timezone offsets, not calendar years", () => {
    const facts = input();
    facts.order.purchasedAt = "2024-02-29T07:00:00-05:00";
    facts.order.lines[0].allocations[0].deliveryEvidence = [];
    facts.now = "2025-02-28T12:00:00.000Z";
    expect(evaluateCustomerReturnEligibility(facts).returnWindowEndsAt).toBe(facts.now);
    facts.policy.returnWindowDays = 30;
    expect(evaluateCustomerReturnEligibility(facts).returnWindowEndsAt).toBe("2024-03-30T12:00:00.000Z");
  });

  it("blocks future purchases and nonphysical lines while retaining accurate source quantities", () => {
    const facts = input();
    facts.order.lines[0].requiresShipping = false;
    expect(evaluateCustomerReturnEligibility(facts).lines[0]).toMatchObject({ eligibleQuantity: 0, reasons: ["non_physical_item"] });
    facts.order.purchasedAt = "2026-09-23T12:00:00.000Z";
    facts.order.lines[0].allocations = [];
    expect(evaluateCustomerReturnEligibility(facts).reasons).toEqual(["purchase_in_future"]);
  });

  it("handles zero purchased quantities and an empty order without inventing returnable units", () => {
    const facts = input();
    facts.order.lines = [line("zero", { purchasedQuantity: 0, allocations: [] })];
    expect(evaluateCustomerReturnEligibility(facts).lines[0].reasons).toContain("no_purchased_quantity");
    facts.order.lines = [];
    expect(evaluateCustomerReturnEligibility(facts)).toMatchObject({ eligibleQuantity: 0, hasEligibleItems: false, lines: [] });
  });

  it("supports safe maximum units and maximum bounded evidence IDs", () => {
    const facts = input();
    facts.order.lines[0].purchasedQuantity = Number.MAX_SAFE_INTEGER;
    facts.order.lines[0].allocations[0].quantity = Number.MAX_SAFE_INTEGER;
    facts.order.lines[0].allocations[0].deliveryEvidence[0].evidenceId = "x".repeat(255);
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("customer return source-fact validation", () => {
  it.each([
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines.push(structuredClone(facts.order.lines[0])); },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations.push(structuredClone(facts.order.lines[0].allocations[0])); },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations.push(allocation("2", { fulfillmentLineItemId: facts.order.lines[0].allocations[0].fulfillmentLineItemId })); },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].deliveryEvidence.push(structuredClone(facts.order.lines[0].allocations[0].deliveryEvidence[0])); },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].claims = [{ claimId: "dup", allocationId: "allocation-1", quantity: 1 }, { claimId: "dup", allocationId: "allocation-1", quantity: 1 }]; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].quantity = 3; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].claims = [{ claimId: "excess", allocationId: "allocation-1", quantity: 3 }]; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].claims = [{ claimId: "wrong", allocationId: "other-line", quantity: 1 }]; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].staffDeliveryOverride = staffOverride(3); },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].staffDeliveryOverride = { ...staffOverride(1), actor: "" }; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].staffDeliveryOverride = { ...staffOverride(1), verificationReference: "  " }; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].staffDeliveryOverride = { ...staffOverride(1), approvedAt: "2026-09-23T12:00:00Z" }; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].deliveryEvidence[0].occurredAt = "2026-09-23T12:00:00Z"; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].deliveryEvidence[0].observedAt = "2026-09-23T12:00:00Z"; },
    (facts: CustomerReturnEligibilityInput) => { facts.order.lines[0].allocations[0].deliveryEvidence[0].occurredAt = "2025-01-01T12:00:00Z"; },
  ])("rejects inconsistent, duplicate or unaudited facts %#", (change) => {
    const facts = input(); change(facts); invalidFacts(facts);
  });

  it("rejects one source evidence identity presenting contradictory facts across line joins", () => {
    const facts = input();
    facts.order.lines.push(line("2"));
    facts.order.lines[1].allocations[0].deliveryEvidence = [{
      ...facts.order.lines[0].allocations[0].deliveryEvidence[0], status: "in_transit",
    }];
    invalidFacts(facts);
  });

  it("allows identical package evidence to be joined to several distinct purchased lines", () => {
    const facts = input();
    facts.order.lines.push(line("2"));
    facts.order.lines[1].allocations[0].deliveryEvidence = structuredClone(facts.order.lines[0].allocations[0].deliveryEvidence);
    expect(evaluateCustomerReturnEligibility(facts).eligibleQuantity).toBe(4);
  });

  it("rejects overflow in aggregates even when every individual quantity is safe", () => {
    const facts = input();
    facts.order.lines[0].purchasedQuantity = Number.MAX_SAFE_INTEGER;
    facts.order.lines[0].allocations[0].quantity = Number.MAX_SAFE_INTEGER;
    facts.order.lines.push(line("2"));
    invalidFacts(facts);
    facts.order.lines.pop();
    facts.order.lines[0].allocations.push(allocation("2"));
    invalidFacts(facts);
    facts.order.lines[0].allocations.pop();
    facts.order.lines[0].claims = [
      { claimId: "max", allocationId: "allocation-1", quantity: Number.MAX_SAFE_INTEGER },
      { claimId: "overflow", allocationId: "allocation-1", quantity: 1 },
    ];
    invalidFacts(facts);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid unit quantity %s", (quantity) => {
    const facts = input(); facts.order.lines[0].purchasedQuantity = quantity; invalidFacts(facts);
  });

  it.each([0, -1, 1.5, 3651])("rejects invalid configured window %s", (days) => {
    const facts = input(); facts.policy.returnWindowDays = days; invalidFacts(facts);
  });

  it("rejects unbounded collections, invalid timestamps, unknown fields and unsupported coercion", () => {
    const facts = input();
    facts.order.lines = Array.from({ length: 201 }, (_, index) => line(String(index)));
    invalidFacts(facts);
    invalidFacts({ ...input(), now: "not-a-date" });
    invalidFacts({ ...input(), now: new Date(NOW) });
    invalidFacts({ ...input(), reasonCode: "buyer_return" });
    invalidFacts({ ...input(), order: { ...input().order, delivered: true } });
    invalidFacts({ ...input(), policy: { ...input().policy, channelId: "36" } });
  });

  it("rejects timestamp overflow and never includes the original evidence payload in its error", () => {
    const facts = input();
    facts.order.purchasedAt = "9999-12-31T23:59:59.999Z";
    facts.order.lines = [];
    invalidFacts(facts);
    try { evaluateCustomerReturnEligibility({ ...input(), now: "private-invalid-value" }); }
    catch (error) {
      expect(error).toBeInstanceOf(CustomerReturnEligibilityError);
      expect(JSON.stringify(error)).not.toContain("private-invalid-value");
      expect(error).toMatchObject({ code: "CUSTOMER_RETURN_ELIGIBILITY_FACTS_INVALID", context: {
        issues: expect.arrayContaining([expect.objectContaining({ path: "now" })]),
      } });
    }
  });
});
