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
      catalogBarcode: null,
      catalogVariantId: "gid://shopify/ProductVariant/42926954709151",
      catalogInventoryItemId: "45068358877343",
      feedId: 100,
      feedIsActive: true,
      feedProductId: "7626813735071",
      feedVariantId: "42926954709151",
      feedInventoryItemId: "45068358877343",
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

  it("excludes archived variants from product evidence and variant verification", () => {
    const original = source();
    const summary = buildShopifyProductMappingSummary(source({
      variants: [
        original.variants[0],
        {
          ...original.variants[0],
          variantId: 60,
          sku: "SHLZ-MAG-STND-B100",
          isActive: false,
          catalogVariantId: "44505488916639",
          catalogInventoryItemId: null,
          feedId: 101,
          feedIsActive: false,
          feedProductId: "9999999999999",
          feedVariantId: "44505488916639",
          feedInventoryItemId: null,
          listingId: null,
          listingProductId: null,
          listingVariantId: null,
        },
      ],
    }));

    expect(summary.evidenceProductIds).toEqual(["7626813735071"]);
    expect(summary.archivedVariantCount).toBe(1);
    expect(collectMappedShopifyVariantIds(summary)).toEqual(["42926954709151"]);
  });

  it("marks a product incomplete when an active variant lacks child mappings", () => {
    const original = source();
    const summary = buildShopifyProductMappingSummary(source({
      catalogProductId: "7626813735071",
      variants: [
        original.variants[0],
        {
          ...original.variants[0],
          variantId: 219,
          sku: "SHLZ-MAG-STND-C200",
          catalogVariantId: null,
          catalogInventoryItemId: null,
          feedId: null,
          feedIsActive: null,
          feedProductId: null,
          feedVariantId: null,
          feedInventoryItemId: null,
          listingId: null,
          listingProductId: null,
          listingVariantId: null,
        },
      ],
    }));

    expect(summary.status).toBe("incomplete");
    expect(summary.activeVariantIssueIds).toEqual([219]);
    expect(summary.recommendedProductId).toBe("7626813735071");
    expect(summary.repairable).toBe(true);
  });

  it("changes the optimistic-lock fingerprint when matching inputs change", () => {
    const baseline = buildShopifyProductMappingSummary(source());
    const skuChanged = buildShopifyProductMappingSummary(source({
      variants: [{ ...source().variants[0], sku: "SHLZ-MAG-STND-P5-RENAMED" }],
    }));
    const activationChanged = buildShopifyProductMappingSummary(source({
      variants: [{ ...source().variants[0], isActive: false }],
    }));

    expect(skuChanged.fingerprint).not.toBe(baseline.fingerprint);
    expect(activationChanged.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("does not offer automatic repair when no active variants remain", () => {
    const summary = buildShopifyProductMappingSummary(source({
      variants: [{ ...source().variants[0], isActive: false }],
    }));

    expect(summary.activeVariantCount).toBe(0);
    expect(summary.archivedVariantCount).toBe(1);
    expect(summary.repairable).toBe(false);
  });
});

describe("evaluateShopifyProductMappingRepair", () => {
  it("accepts the unanimous target only when every mapped variant belongs to it", () => {
    const summary = buildShopifyProductMappingSummary(source());
    expect(evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariants: [{
        id: "42926954709151",
        sku: "SHLZ-MAG-STND-P5",
        inventoryItemId: "45068358877343",
      }],
    })).toEqual({
      ok: true,
      targetProductId: "7626813735071",
      mappedVariantIds: ["42926954709151"],
      variantMappings: [{
        variantId: 59,
        sku: "SHLZ-MAG-STND-P5",
        remoteSku: "SHLZ-MAG-STND-P5",
        remoteBarcode: null,
        remoteVariantId: "42926954709151",
        remoteInventoryItemId: "45068358877343",
        matchedBy: "existing_id",
        replacedVariantIds: [],
      }],
    });
  });

  it("rejects a target selected by the caller instead of channel evidence", () => {
    const summary = buildShopifyProductMappingSummary(source());
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "1111111111111",
      verifiedRemoteVariants: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SHOPIFY_MAPPING_NOT_REPAIRABLE");
  });

  it("rejects a repair when an active linked variant cannot be resolved on the live product", () => {
    const summary = buildShopifyProductMappingSummary(source());
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariants: [{ id: "999", sku: "OTHER-SKU", inventoryItemId: "1000" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED");
      expect(result.context).toMatchObject({
        targetProductId: "7626813735071",
        issues: [{
          code: "EXACT_SKU_NOT_FOUND",
          variantId: 59,
          sku: "SHLZ-MAG-STND-P5",
        }],
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
      verifiedRemoteVariants: [{
        id: "42926954709151",
        sku: "SHLZ-MAG-STND-P5",
        inventoryItemId: "45068358877343",
      }],
    })).toEqual({
      ok: true,
      targetProductId: "7626813735071",
      mappedVariantIds: ["42926954709151"],
      variantMappings: [{
        variantId: 59,
        sku: "SHLZ-MAG-STND-P5",
        remoteSku: "SHLZ-MAG-STND-P5",
        remoteBarcode: null,
        remoteVariantId: "42926954709151",
        remoteInventoryItemId: "45068358877343",
        matchedBy: "existing_id",
        replacedVariantIds: [],
      }],
    });
  });

  it("maps an active unmapped variant by one exact Shopify SKU and ignores archived IDs", () => {
    const original = source();
    const summary = buildShopifyProductMappingSummary(source({
      variants: [
        original.variants[0],
        {
          ...original.variants[0],
          variantId: 60,
          sku: "SHLZ-MAG-STND-B100",
          isActive: false,
          catalogVariantId: "44505488916639",
          catalogInventoryItemId: null,
        },
        {
          ...original.variants[0],
          variantId: 219,
          sku: "SHLZ-MAG-STND-C200",
          catalogVariantId: null,
          catalogInventoryItemId: null,
          feedId: null,
          feedIsActive: null,
          feedProductId: null,
          feedVariantId: null,
          feedInventoryItemId: null,
          listingId: null,
          listingProductId: null,
          listingVariantId: null,
        },
      ],
    }));
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariants: [
        {
          id: "42926954709151",
          sku: "SHLZ-MAG-STND-P5",
          inventoryItemId: "45068358877343",
        },
        {
          id: "62784043745439",
          sku: "SHLZ-MAG-STND-C200",
          inventoryItemId: "59937879064735",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mappedVariantIds).toEqual(["42926954709151", "62784043745439"]);
    expect(result.variantMappings[1]).toEqual({
      variantId: 219,
      sku: "SHLZ-MAG-STND-C200",
      remoteSku: "SHLZ-MAG-STND-C200",
      remoteBarcode: null,
      remoteVariantId: "62784043745439",
      remoteInventoryItemId: "59937879064735",
      matchedBy: "exact_sku",
      replacedVariantIds: [],
    });
  });

  it("refuses to guess when an active SKU is duplicated on Shopify", () => {
    const original = source();
    const summary = buildShopifyProductMappingSummary(source({
      catalogProductId: "7626813735071",
      variants: [{
        ...original.variants[0],
        catalogVariantId: null,
        catalogInventoryItemId: null,
        feedId: null,
        feedIsActive: null,
        feedProductId: null,
        feedVariantId: null,
        feedInventoryItemId: null,
        listingId: null,
        listingProductId: null,
        listingVariantId: null,
      }],
    }));
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariants: [
        { id: "1", sku: "SHLZ-MAG-STND-P5", inventoryItemId: "10" },
        { id: "2", sku: "shlz-mag-stnd-p5", inventoryItemId: "20" },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED");
      expect(result.context).toMatchObject({
        issues: [{ code: "EXACT_SKU_AMBIGUOUS", variantId: 59 }],
      });
    }
  });

  it("refuses a product remap when the selected variant is not the verified resolution", () => {
    const summary = buildShopifyProductMappingSummary(source());
    const result = evaluateShopifyProductMappingRepair({
      summary,
      requestedProductId: "7626813735071",
      verifiedRemoteVariants: [{
        id: "42926954709151",
        sku: "SHLZ-MAG-STND-P5",
        inventoryItemId: "45068358877343",
      }],
      expectedVariant: {
        variantId: 59,
        remoteVariantId: "62784043745439",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED");
      expect(result.context).toMatchObject({
        issues: [{
          code: "SELECTED_VARIANT_MISMATCH",
          variantId: 59,
          selectedRemoteVariantId: "62784043745439",
          resolvedRemoteVariantId: "42926954709151",
        }],
      });
    }
  });
});
