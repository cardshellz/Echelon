import { describe, expect, it } from "vitest";
import { productAssetScopeSchema, productAssetScopeResultSchema } from "../product-asset-scope";

describe("catalog photo assignment contract", () => {
  it.each([null, 1, 2_147_483_647])("accepts explicit shared or variant scope %s", productVariantId => {
    expect(productAssetScopeSchema.parse({ productVariantId, expectedProductVariantId: null })).toEqual({ productVariantId, expectedProductVariantId: null });
  });
  it.each([{}, { productVariantId: null }, { expectedProductVariantId: null },
    { productVariantId: 0, expectedProductVariantId: null }, { productVariantId: -1, expectedProductVariantId: null },
    { productVariantId: 1.5, expectedProductVariantId: null }, { productVariantId: "1", expectedProductVariantId: null },
    { productVariantId: 2_147_483_648, expectedProductVariantId: null },
    { productVariantId: null, expectedProductVariantId: undefined },
    { productVariantId: null, expectedProductVariantId: 0 },
    { productVariantId: null, expectedProductVariantId: null, productId: 2 },
  ])("rejects incomplete, ambiguous or over-posted commands %j", input => {
    expect(productAssetScopeSchema.safeParse(input).success).toBe(false);
  });
  it("validates the returned assignment and resource identity", () => {
    expect(productAssetScopeResultSchema.safeParse({ productId: 1, assetId: 2, productVariantId: null, changed: true }).success).toBe(true);
    expect(productAssetScopeResultSchema.safeParse({ productId: 1, assetId: 2, changed: true }).success).toBe(false);
  });
});
