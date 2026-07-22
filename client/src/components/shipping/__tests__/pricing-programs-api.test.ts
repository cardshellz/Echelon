import { describe, expect, it } from "vitest";
import {
  PRICING_FLOW_CHOICES,
  assignmentLabel,
  pricingFlowKey,
  pricingFlowLabel,
  productRuleRevisionStatus,
  type RateBookAssignment,
} from "../pricing-programs/api";

function assignment(overrides: Partial<RateBookAssignment> = {}): RateBookAssignment {
  return {
    id: 1,
    pricingChannel: "shopify",
    ratePurpose: "customer_checkout",
    originWarehouseId: null,
    originWarehouseName: null,
    isActive: true,
    ...overrides,
  };
}

describe("pricing program business-flow labels", () => {
  it("offers only supported runtime pricing flows", () => {
    expect(PRICING_FLOW_CHOICES.map((choice) => choice.value)).toEqual([
      "shopify:customer_checkout",
      "internal:customer_checkout",
      "dropship:vendor_fulfillment_charge",
    ]);
  });

  it("maps persisted channel and purpose values to operator labels", () => {
    const shopify = assignment();
    const dropship = assignment({
      pricingChannel: "dropship",
      ratePurpose: "vendor_fulfillment_charge",
      originWarehouseId: 1,
      originWarehouseName: "LEON",
    });

    expect(pricingFlowKey(shopify)).toBe("shopify:customer_checkout");
    expect(pricingFlowLabel(shopify)).toBe("Shopify checkout");
    expect(assignmentLabel(dropship)).toBe("Dropship vendor fulfillment · LEON");
  });

  it("preserves a readable fallback for an existing custom assignment", () => {
    expect(pricingFlowLabel(assignment({
      pricingChannel: "partner_portal",
      ratePurpose: "customer_checkout",
    }))).toBe("Partner Portal customer checkout");
  });
});

describe("pricing program product-rule status", () => {
  it("keeps live and draft rule counts separate", () => {
    expect(productRuleRevisionStatus({
      active: { productRuleCount: 2 },
      draft: { productRuleCount: 3 },
    })).toEqual({ liveCount: 2, draftCount: 3 });
  });

  it("distinguishes a missing revision from a revision with zero rules", () => {
    expect(productRuleRevisionStatus({
      active: null,
      draft: { productRuleCount: 0 },
    })).toEqual({ liveCount: null, draftCount: 0 });
  });
});
