import { describe, expect, it } from "vitest";

import {
  buildShopifyMappingReconciliationReport,
  evaluateDeadMappingRetirement,
  normalizeShopifyAdminDomain,
  normalizeShopifyProductReference,
  type ShopifyMappingLocalProduct,
  type ShopifyRemoteProductSnapshot,
} from "../../shopify-product-mapping-reconciliation.domain";

describe("normalizeShopifyProductReference", () => {
  it("accepts numeric IDs and exact Product GIDs", () => {
    expect(normalizeShopifyProductReference("9001")).toBe("9001");
    expect(normalizeShopifyProductReference(
      "gid://shopify/Product/9001",
    )).toBe("9001");
  });

  it("rejects URLs, other resource types, and arbitrary trailing digits", () => {
    expect(normalizeShopifyProductReference(
      "https://admin.shopify.com/store/cardshellz/products/9001",
    )).toBeNull();
    expect(normalizeShopifyProductReference(
      "gid://shopify/ProductVariant/9001",
    )).toBeNull();
    expect(normalizeShopifyProductReference("not-a-product-9001")).toBeNull();
  });
});

describe("normalizeShopifyAdminDomain", () => {
  it("normalizes a store handle and canonical Shopify admin domain", () => {
    expect(normalizeShopifyAdminDomain("CardShellz")).toBe(
      "cardshellz.myshopify.com",
    );
    expect(normalizeShopifyAdminDomain(
      "https://cardshellz.myshopify.com/admin",
    )).toBe("cardshellz.myshopify.com");
  });

  it("rejects non-Shopify and malformed request targets", () => {
    expect(normalizeShopifyAdminDomain("example.com")).toBeNull();
    expect(normalizeShopifyAdminDomain("https://example.com")).toBeNull();
    expect(normalizeShopifyAdminDomain("")).toBeNull();
    expect(normalizeShopifyAdminDomain(
      "evil.com@cardshellz.myshopify.com",
    )).toBeNull();
  });
});

function localProduct(
  input: Partial<ShopifyMappingLocalProduct> = {},
): ShopifyMappingLocalProduct {
  return {
    productId: 10,
    productName: "100PT Toploader",
    productSku: "SHLZ-TOP-100PT",
    rawShopifyProductId: "9001",
    shopifyProductId: "9001",
    shippingGroupCode: "protection",
    mappingStatus: "consistent",
    mappingFingerprint: "fingerprint-10",
    evidenceProductIds: ["9001"],
    activeVariantCount: 2,
    activeVariantIssueIds: [],
    ...input,
  };
}

function remoteProduct(
  input: Partial<ShopifyRemoteProductSnapshot> = {},
): ShopifyRemoteProductSnapshot {
  return {
    productId: "9001",
    exists: true,
    title: "100PT Toploader",
    status: "ACTIVE",
    shippingGroupCode: "protection",
    ...input,
  };
}

function report(input: {
  products?: ShopifyMappingLocalProduct[];
  remote?: ShopifyRemoteProductSnapshot[];
}) {
  return buildShopifyMappingReconciliationReport({
    generatedAt: "2026-07-24T12:00:00.000Z",
    channel: {
      id: 36,
      name: "Shopify",
      shopDomain: "cardshellz.myshopify.com",
    },
    localProducts: input.products ?? [localProduct()],
    remoteProducts: new Map(
      (input.remote ?? [remoteProduct()])
        .map((product) => [product.productId, product]),
    ),
  });
}

describe("Shopify product mapping reconciliation", () => {
  it("reports a consistent local and storefront mapping as healthy", () => {
    const result = report({});

    expect(result.summary).toMatchObject({
      localProductCount: 1,
      uniqueShopifyProductCount: 1,
      healthyProductCount: 1,
      issueProductCount: 0,
    });
    expect(result.items[0]).toMatchObject({
      productId: 10,
      remoteTitle: "100PT Toploader",
      issueCodes: [],
      canRetireDeadMapping: false,
    });
  });

  it("identifies every local owner of a duplicate Shopify product", () => {
    const result = report({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          productName: "Legacy 100PT Toploader",
          mappingFingerprint: "fingerprint-11",
        }),
      ],
    });

    expect(result.summary.issueCounts.duplicate_local_owner).toBe(2);
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.ownerProductIds).toEqual([10, 11]);
      expect(item.issueCodes).toEqual(["duplicate_local_owner"]);
    }
  });

  it("separately identifies duplicate owners with conflicting shipping groups", () => {
    const result = report({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          shippingGroupCode: "storage_boxes",
          mappingFingerprint: "fingerprint-11",
        }),
      ],
    });

    expect(result.items.find((item) => item.productId === 10)?.issueCodes)
      .toEqual([
        "duplicate_local_owner",
        "shipping_group_conflict",
      ]);
    expect(result.items.find((item) => item.productId === 11)?.issueCodes)
      .toEqual([
        "duplicate_local_owner",
        "shipping_group_conflict",
        "storefront_shipping_group_drift",
      ]);
  });

  it("marks a missing remote product as eligible for verified retirement", () => {
    const result = report({
      remote: [remoteProduct({
        exists: false,
        title: null,
        status: null,
        shippingGroupCode: null,
      })],
    });

    expect(result.items[0]).toMatchObject({
      issueCodes: ["remote_product_missing"],
      canRetireDeadMapping: true,
    });
  });

  it("detects storefront shipping-group drift without treating it as missing", () => {
    const result = report({
      remote: [remoteProduct({ shippingGroupCode: "storage_boxes" })],
    });

    expect(result.items[0]).toMatchObject({
      remoteShippingGroupCode: "storage_boxes",
      issueCodes: ["storefront_shipping_group_drift"],
      canRetireDeadMapping: false,
    });
  });

  it("keeps invalid IDs and incomplete local mappings as distinct issues", () => {
    const result = report({
      products: [localProduct({
        rawShopifyProductId: "not-a-shopify-id",
        shopifyProductId: null,
        mappingStatus: "incomplete",
        evidenceProductIds: [],
      })],
      remote: [],
    });

    expect(result.summary.uniqueShopifyProductCount).toBe(0);
    expect(result.items[0].issueCodes).toEqual([
      "invalid_shopify_product_id",
      "local_mapping_inconsistent",
    ]);
  });

  it("distinguishes a missing catalog parent ID from a malformed ID", () => {
    const result = report({
      products: [localProduct({
        rawShopifyProductId: null,
        shopifyProductId: null,
        mappingStatus: "channel_only",
        evidenceProductIds: ["9001"],
      })],
      remote: [remoteProduct()],
    });

    expect(result.items[0].issueCodes).toEqual([
      "catalog_product_id_missing",
      "local_mapping_inconsistent",
    ]);
    expect(result.items[0]).toMatchObject({
      comparedShopifyProductId: "9001",
      remoteTitle: "100PT Toploader",
    });
  });

  it("detects duplicate ownership through channel evidence when the parent ID is missing", () => {
    const result = report({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          rawShopifyProductId: null,
          shopifyProductId: null,
          mappingStatus: "channel_only",
          mappingFingerprint: "fingerprint-11",
          evidenceProductIds: ["9001"],
        }),
      ],
    });

    expect(result.summary.issueCounts.duplicate_local_owner).toBe(2);
    for (const item of result.items) {
      expect(item.ownerProductIds).toEqual([10, 11]);
      expect(item.issueCodes).toContain("duplicate_local_owner");
    }
  });
});

describe("dead Shopify mapping retirement guard", () => {
  it("allows retirement only when the product and all referenced variants are absent", () => {
    expect(evaluateDeadMappingRetirement({
      expectedProductId: "9001",
      remoteProductExists: false,
      liveVariantIds: [],
    })).toEqual({ ok: true });
  });

  it("blocks retirement when the product still exists", () => {
    expect(evaluateDeadMappingRetirement({
      expectedProductId: "9001",
      remoteProductExists: true,
      liveVariantIds: [],
    })).toEqual({
      ok: false,
      code: "SHOPIFY_PRODUCT_STILL_EXISTS",
      context: { shopifyProductId: "9001" },
    });
  });

  it("blocks retirement when any referenced variant still exists", () => {
    expect(evaluateDeadMappingRetirement({
      expectedProductId: "9001",
      remoteProductExists: false,
      liveVariantIds: ["22", "3"],
    })).toEqual({
      ok: false,
      code: "SHOPIFY_VARIANT_STILL_EXISTS",
      context: {
        shopifyProductId: "9001",
        liveVariantIds: ["3", "22"],
      },
    });
  });
});
