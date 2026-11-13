import { describe, expect, it } from "vitest";
import { describeDelistedShopifyVariants, formatShopifyMappingRepairError } from "../shopify-product-mapping";

describe("formatShopifyMappingRepairError", () => {
  it("renders actionable active-variant repair issues", () => {
    expect(formatShopifyMappingRepairError({
      error: "One or more active variants could not be matched uniquely to the verified Shopify product",
      context: {
        issues: [
          {
            code: "EXACT_SKU_NOT_FOUND",
            variantId: 219,
            sku: "SHLZ-MAG-STND-C200",
          },
        ],
      },
    })).toBe(
      "One or more active variants could not be matched uniquely to the verified Shopify product. "
      + "SHLZ-MAG-STND-C200: no exact SKU exists on the verified Shopify product",
    );
  });

  it("falls back when the response body is unavailable", () => {
    expect(formatShopifyMappingRepairError(null, "Failed to link Shopify variant"))
      .toBe("Failed to link Shopify variant");
  });
});

describe("describeDelistedShopifyVariants", () => {
  it("names each SKU unlinked because Shopify deleted its variant", () => {
    expect(describeDelistedShopifyVariants({ delistedVariants: [{ variantId: 110, sku: "GLV-MAG-180PT-C5000" }, { variantId: 7, sku: null }] }))
      .toBe("Not listed on this store anymore (deleted in Shopify): GLV-MAG-180PT-C5000, variant 7.");
  });

  it("says nothing when no SKU was delisted or the body is unexpected", () => {
    expect(describeDelistedShopifyVariants({ delistedVariants: [] })).toBeNull();
    expect(describeDelistedShopifyVariants(null)).toBeNull();
    expect(describeDelistedShopifyVariants({ delistedVariants: "nope" })).toBeNull();
  });
});
