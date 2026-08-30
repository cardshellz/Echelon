import { describe, expect, it, vi } from "vitest";

import {
  assertVariantSalesEligibilityTransitionAllowed,
  assertVariantSalesIdentityCompatible,
  coerceVariantSalesEligibilityOnPayload,
  VariantSalesEligibilityError,
} from "../../variant-sales-eligibility-policy";

const existing = {
  id: 511,
  salesEligibility: "sellable" as const,
  shopifyVariantId: null,
  shopifyInventoryItemId: null,
  dropshipEligible: false,
};

describe("catalog variant sales eligibility policy", () => {
  it("accepts only the explicit catalog identities", () => {
    expect(coerceVariantSalesEligibilityOnPayload({ salesEligibility: "sellable" }))
      .toEqual({ salesEligibility: "sellable" });
    expect(coerceVariantSalesEligibilityOnPayload({ salesEligibility: "internal_only" }))
      .toEqual({ salesEligibility: "internal_only" });
    expect(() => coerceVariantSalesEligibilityOnPayload({ salesEligibility: "hidden" }))
      .toThrow("salesEligibility must be either sellable or internal_only");
    expect(() => coerceVariantSalesEligibilityOnPayload({ salesEligibility: null }))
      .toThrow("salesEligibility must be either sellable or internal_only");
  });

  it("rejects internal-only identity when a direct Shopify or dropship identity remains", () => {
    expect(() => assertVariantSalesIdentityCompatible({
      salesEligibility: "internal_only",
      shopifyVariantId: "123",
      shopifyInventoryItemId: null,
      dropshipEligible: true,
    })).toThrow(VariantSalesEligibilityError);
  });

  it("serializes and permits a clean transition", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }] })
      .mockResolvedValueOnce({ rows: [{
        active_channel_feed: false,
        channel_listing: false,
        channel_allocation_configuration: false,
        active_channel_availability: false,
        dropship_listing: false,
        active_marketplace_publication: false,
        pending_inventory_publication: false,
        open_customer_order: false,
      }] });

    await expect(assertVariantSalesEligibilityTransitionAllowed(
      { execute },
      existing,
      "internal_only",
    )).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns every discovered customer-facing blocker", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }] })
      .mockResolvedValueOnce({ rows: [{
        active_channel_feed: true,
        channel_listing: true,
        channel_allocation_configuration: true,
        active_channel_availability: true,
        dropship_listing: true,
        active_marketplace_publication: true,
        pending_inventory_publication: true,
        open_customer_order: true,
      }] });

    const error = await assertVariantSalesEligibilityTransitionAllowed(
      { execute },
      existing,
      "internal_only",
    ).then(() => null, (caught) => caught);
    expect(error).toBeInstanceOf(VariantSalesEligibilityError);
    expect(error.blockers).toEqual([
      "active_channel_feed",
      "channel_listing",
      "channel_allocation_configuration",
      "active_channel_availability",
      "dropship_listing",
      "active_marketplace_publication",
      "pending_inventory_publication",
      "open_customer_order",
    ]);
  });

  it("does not query dependencies for unchanged or sellable transitions", async () => {
    const execute = vi.fn();
    await assertVariantSalesEligibilityTransitionAllowed({ execute }, existing, "sellable");
    expect(execute).not.toHaveBeenCalled();
  });
});
