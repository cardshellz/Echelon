import { describe, expect, it } from "vitest";
import { listingDraftItemSchema } from "@shared/types/channel-listing-publication";
import { selectListingMethod } from "../listing-method-model";

describe("switching a Walmart recreation to catalog matching", () => {
  const original = listingDraftItemSchema.parse({
    variantId: 25, method: "create", recreateFromOperationId: "00000000-0000-4000-8000-000000000001",
    identifier: { type: "GTIN", value: "00850025354769" }, productType: "Trading Card Sleeves & Holders",
    title: "Retained custom title", images: ["https://example.com/item.jpg"], priceOverrideCents: 2499,
    attributes: { Orderable: { ShippingWeight: 3, country_of_origin_substantial_transformation: "China" },
      Visible: { condition: "New", pieceCount: 200 } },
  });
  it("keeps identity, price and overrides while transferring shipping weight and condition into offer fields", () => {
    const before = structuredClone(original);
    const result = selectListingMethod(original, "match");
    expect(result).toEqual({ ...original, method: "match", attributes: { Orderable: { ShippingWeight: 3, condition: "New" } } });
    expect(original).toEqual(before);
    expect(selectListingMethod(result, "match")).toBe(result);
    expect(selectListingMethod(result, "create")).toEqual({ ...original,
      attributes: { Orderable: { ShippingWeight: 3 }, Visible: { condition: "New" } } });
  });
  it("does not invent missing condition or shipping weight", () => {
    expect(selectListingMethod({ ...original, attributes: {} }, "match").attributes).toEqual({ Orderable: {} });
    expect(selectListingMethod({ ...original, attributes: { Orderable: { ShippingWeight: 0 } } }, "match").attributes)
      .toEqual({ Orderable: { ShippingWeight: 0 } });
  });
});
