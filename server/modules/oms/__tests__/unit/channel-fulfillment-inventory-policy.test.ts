import { describe, expect, it } from "vitest";
import { decideChannelFulfillmentInventoryPosting } from "../../domain/channel-fulfillment-inventory-policy";

const tracked = {
  omsRequiresShipping: true,
  wmsRequiresShipping: 1,
  productVariantId: 30,
  catalogVariantId: 30,
  catalogRequiresShipping: true,
  catalogTrackInventory: true,
} as const;

describe("channel fulfillment inventory policy", () => {
  it("keeps matching untracked snapshots authoritative for a product without variants", () => {
    expect(decideChannelFulfillmentInventoryPosting({ ...tracked,
      productVariantId: null, catalogVariantId: null, catalogRequiresShipping: null, catalogTrackInventory: null,
      omsInventoryTracking: false, wmsInventoryTracking: false, omsCatalogProductId: 10, wmsCatalogProductId: 10,
    })).toEqual({ status: "resolved", requiresInventoryPosting: false, reason: "non_inventory_item" });
  });

  it.each([
    { omsInventoryTracking: false, wmsInventoryTracking: true, omsCatalogProductId: 10, wmsCatalogProductId: 10 },
    { omsInventoryTracking: false, wmsInventoryTracking: false, omsCatalogProductId: 10, wmsCatalogProductId: 11 },
    { omsInventoryTracking: true, wmsInventoryTracking: true, omsCatalogProductId: 10, wmsCatalogProductId: 10, catalogTrackInventory: false },
  ])("rejects snapshot or catalog policy disagreement", input => {
    expect(decideChannelFulfillmentInventoryPosting({ ...tracked, ...input })).toMatchObject({ status: "conflict" });
  });

  it("posts inventory only for a tracked physical line", () => {
    expect(decideChannelFulfillmentInventoryPosting(tracked)).toEqual({
      status: "resolved",
      requiresInventoryPosting: true,
      reason: "tracked_physical_item",
    });
  });

  it("separates non-shipping fulfillment from inventory custody", () => {
    expect(decideChannelFulfillmentInventoryPosting({
      ...tracked,
      omsRequiresShipping: false,
      wmsRequiresShipping: 0,
      catalogRequiresShipping: false,
      catalogTrackInventory: false,
    })).toEqual({
      status: "resolved",
      requiresInventoryPosting: false,
      reason: "non_shipping_item",
    });
  });

  it("does not post inventory for an explicitly untracked shippable item", () => {
    expect(decideChannelFulfillmentInventoryPosting({
      ...tracked,
      catalogTrackInventory: false,
    })).toEqual({
      status: "resolved",
      requiresInventoryPosting: false,
      reason: "non_inventory_item",
    });
  });

  it("retains the established tracked default for a NULL catalog flag", () => {
    expect(decideChannelFulfillmentInventoryPosting({
      ...tracked,
      catalogTrackInventory: null,
    })).toMatchObject({ requiresInventoryPosting: true });
  });

  it.each([
    { name: "invalid WMS flag", input: { ...tracked, wmsRequiresShipping: 2 }, reason: "wms_requires_shipping_invalid" },
    { name: "missing catalog shipping flag", input: { ...tracked, catalogRequiresShipping: null }, reason: "catalog_requires_shipping_missing" },
    { name: "missing catalog variant", input: { ...tracked, catalogVariantId: null }, reason: "catalog_variant_missing" },
    { name: "catalog identity disagreement", input: { ...tracked, catalogVariantId: 31 }, reason: "catalog_variant_identity_conflict" },
    { name: "owner disagreement", input: { ...tracked, omsRequiresShipping: false }, reason: "oms_requires_shipping_false" },
  ])("fails closed for $name", ({ input, reason }) => {
    expect(decideChannelFulfillmentInventoryPosting(input)).toMatchObject({
      status: "conflict",
      reasons: expect.arrayContaining([reason]),
    });
  });
});
