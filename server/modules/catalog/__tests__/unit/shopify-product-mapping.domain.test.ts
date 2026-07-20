import { describe, expect, it } from "vitest";
import {
  buildShopifyProductMappingSummary,
  collectMappedShopifyVariantIds,
  decideImportedShopifyProductMapping,
  evaluateShopifyProductMappingRepair,
  normalizeShopifyId,
  type ShopifyProductMappingSource,
} from "../../shopify-product-mapping.domain";

function source(input: Partial<ShopifyProductMappingSource> = {}): ShopifyProductMappingSource {
  return {
    productId: 30,
    productName: "Acrylic Stand for Magnetic Holders",
    productSku: "SHLZ-MAG-STND",
    catalogProductId: "9056299122847",
    channel: { id: 36, name: "Shopify" },
    variants: [{
      variantId: 59,
      sku: "SHLZ-MAG-STND-P5",
      isActive: true,
      catalogVariantId: "gid://shopify/ProductVariant/42926954709151",
      feedId: 100,
      feedIsActive: true,
      feedProductId: "7626813735071",
      feedVariantId: "42926954709151",
      listingId: 200,
      listingProductId: "gid://shopify/Product/7626813735071",
      listingVariantId: "42926954709151",
    }],
    ...input,
  };
}

describe("normalizeShopifyId", () => {
  it("normalizes numeric IDs, GIDs, and admin URLs", () => {
    expect(normalizeShopifyId("7626813735071")).toBe("7626813735071");
    expect(normalizeShopifyId("gid://shopify/Product/7626813735071")).toBe("7626813735071");
    expect(normalizeShopifyId("https://admin.shopify.com/store/cardshellz/products/7626813735071")).toBe("7626813735071");
  });

  it("rejects empty and non-numeric references", () => {
    expect(normalizeShopifyId(null)).toBeNull();
    expect(normalizeShopifyId("not-an-id")).toBeNull();
  });
});

describe("decideImportedShopifyProductMapping", () => {
  it("adopts an incoming ID only when the catalog mapping is empty", () => {
    expect(decideImportedShopifyProductMapping(null, 7626813735071)).toEqual({
      action: "adopt",
      productId: "7626813735071",
    });
  });

  it("retains the canonical ID when normalized values agree", () => {
    expect(decideImportedShopifyProductMapping(
      "gid://shopify/Product/7626813735071",
      7626813735071,
    )).toEqual({ action: "retain", productId: "7626813735071" });
  });

  it("surfaces drift instead of overwriting an established mapping", () => {
    expect(decideImportedShopifyProductMapping("9056299122847", 7626813735071)).toEqual({
      action: "conflict",
      existingProductId: "9056299122847",
      incomingProductId: "7626813735071",
    });
  });
});

describe("buildShopifyProductMappingSummary", () => {
  it("marks a stale catalog parent as repairable when channel evidence agrees", () => {
    const summary = buildShopifyProductMappingSummary(source());
    expect(summary.status).toBe("mismatch");
    expect(summary.evidenceProductIds).toEqual(["7626813735071"]);
    expect(summary.recommendedProductId).toBe("7626813735071");
    expect(summary.repairable).toBe(true);
  });

  it("marks normalized catalog and channel IDs as consistent", () => {
    const summary = buildShopifyProductMappingSummary(source({
      catalogProductId: "gid://shopify/Product/7626813735071",
    }));
    expect(summary.status).toBe("consistent");
    expect(summary.repairable).toBe(false);
  });

  it("blocks automatic repair when channel records disagree", () => {
    const original = source();
    const summary = buildShopifyProductMappingSummary(source({
      variants: [
        original.variants[0],
        {
          ...original.variants[0],
          variantId: 60,
          sku: "SHLZ-MAG-STND-C20",
          feedId: 101,
          feedProductId: "9999999999999",
          listingId: 201,
          listingProductId: "9999999999999",
        },
      ],
    }));
    expect(summary.status).toBe("conflict");
    expect(summary.recommendedProductId).toBeNull();
    expect(summary.repairable).toBe(false);
  });

  it("collects every mapped variant identity for Shopify ownership verification", () => {
    const summary = buildShopifyProductMappingSummary(source({
      variants: [{
        ...source().variants[0],
        catalogVariantId: "gid://shopify/ProductVariant/3",
        feedVariantId: "2",
        listingVariantId: "1",
      }],
    }));
    expect(collectMappedShopifyVariantIds(summary)).toEqual(["1", "2", "3"]);
  });
});

describe("evaluateShopifyProductMappingRepair", () => {
  it("accepts the unanimous target only when every mapped variant belongs to it", () => {
    const summary = buildShopifyProductMappingSummary(source());
    expect(evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariantIds: ["42926954709151"],
    })).toEqual({
      ok: true,
      targetProductId: "7626813735071",
      mappedVariantIds: ["42926954709151"],
    });
  });

  it("rejects a target selected by the caller instead of channel evidence", () => {
    const summary = buildShopifyProductMappingSummary(source());
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "1111111111111",
      verifiedRemoteVariantIds: ["42926954709151"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SHOPIFY_MAPPING_NOT_REPAIRABLE");
  });

  it("rejects a repair when a linked variant is absent from the live Shopify product", () => {
    const summary = buildShopifyProductMappingSummary(source());
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariantIds: ["999"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SHOPIFY_VARIANTS_OUTSIDE_TARGET_PRODUCT");
      expect(result.context).toEqual({
        targetProductId: "7626813735071",
        foreignVariantIds: ["42926954709151"],
      });
    }
  });

  it("accepts a verified retry when the requested mapping is already consistent", () => {
    const summary = buildShopifyProductMappingSummary(source({
      catalogProductId: "7626813735071",
    }));
    expect(evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariantIds: ["42926954709151"],
    })).toEqual({
      ok: true,
      targetProductId: "7626813735071",
      mappedVariantIds: ["42926954709151"],
    });
  });
});
