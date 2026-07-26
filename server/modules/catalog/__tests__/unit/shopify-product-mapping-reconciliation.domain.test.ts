import { describe, expect, it } from "vitest";

import {
  buildShopifyMappingReconciliationReport,
  buildShopifyOwnershipReview,
  collectDuplicateShopifyOwnershipProductIds,
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

describe("Shopify duplicate ownership review", () => {
  function ownershipReview(input: {
    products: ShopifyMappingLocalProduct[];
    remote?: ShopifyRemoteProductSnapshot[];
    filter?: "all" | "canonical_owner_recommended" | "manual_review";
    page?: number;
    pageSize?: number;
  }) {
    return buildShopifyOwnershipReview({
      generatedAt: "2026-07-24T12:00:00.000Z",
      channel: {
        id: 36,
        name: "Shopify",
        shopDomain: "cardshellz.myshopify.com",
      },
      localProducts: input.products,
      remoteProducts: new Map(
        (input.remote ?? [remoteProduct()])
          .map((product) => [product.productId, product]),
      ),
      filter: input.filter ?? "all",
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 20,
    });
  }

  it("collects only Shopify identities with more than one local owner", () => {
    expect(collectDuplicateShopifyOwnershipProductIds([
      localProduct(),
      localProduct({
        productId: 11,
        rawShopifyProductId: null,
        shopifyProductId: null,
        evidenceProductIds: ["9001"],
      }),
      localProduct({
        productId: 12,
        rawShopifyProductId: "9002",
        shopifyProductId: "9002",
        evidenceProductIds: ["9002"],
      }),
    ])).toEqual(["9001"]);
  });

  it("recommends one canonical owner only when active catalog and channel evidence agree", () => {
    const result = ownershipReview({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          productName: "Archived duplicate",
          shopifyProductId: null,
          rawShopifyProductId: null,
          mappingStatus: "channel_only",
          mappingFingerprint: "fingerprint-11",
          evidenceProductIds: ["9001"],
          activeVariantCount: 0,
        }),
      ],
    });

    expect(result).toMatchObject({
      readOnly: true,
      summary: {
        duplicateOwnershipGroupCount: 1,
        canonicalOwnerRecommendationCount: 1,
        manualReviewOwnershipGroupCount: 0,
      },
      pagination: {
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
      },
    });
    expect(result.items[0]).toMatchObject({
      shopifyProductId: "9001",
      decision: "canonical_owner_recommended",
      reason: "single_active_owner_with_matching_evidence",
      recommendedProductId: 10,
      nonCanonicalProductIds: [11],
    });
  });

  it("requires manual review when multiple owners remain active", () => {
    const result = ownershipReview({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          productName: "Second active owner",
          mappingFingerprint: "fingerprint-11",
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      decision: "manual_review",
      reason: "multiple_active_owners",
      recommendedProductId: null,
      nonCanonicalProductIds: [],
    });
  });

  it("requires manual review when owner shipping groups conflict", () => {
    const result = ownershipReview({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          shopifyProductId: null,
          rawShopifyProductId: null,
          shippingGroupCode: "storage_boxes",
          mappingStatus: "channel_only",
          mappingFingerprint: "fingerprint-11",
          evidenceProductIds: ["9001"],
          activeVariantCount: 0,
        }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      decision: "manual_review",
      reason: "shipping_group_conflict",
      shippingGroupCode: null,
    });
  });

  it("filters and paginates groups without changing the global summary", () => {
    const result = ownershipReview({
      products: [
        localProduct(),
        localProduct({
          productId: 11,
          shopifyProductId: null,
          rawShopifyProductId: null,
          mappingStatus: "channel_only",
          mappingFingerprint: "fingerprint-11",
          evidenceProductIds: ["9001"],
          activeVariantCount: 0,
        }),
        localProduct({
          productId: 20,
          productName: "Second Shopify product",
          rawShopifyProductId: "9002",
          shopifyProductId: "9002",
          mappingFingerprint: "fingerprint-20",
          evidenceProductIds: ["9002"],
        }),
        localProduct({
          productId: 21,
          productName: "Second active duplicate",
          rawShopifyProductId: "9002",
          shopifyProductId: "9002",
          mappingFingerprint: "fingerprint-21",
          evidenceProductIds: ["9002"],
        }),
      ],
      remote: [
        remoteProduct(),
        remoteProduct({
          productId: "9002",
          title: "Second Shopify product",
        }),
      ],
      filter: "manual_review",
      page: 1,
      pageSize: 1,
    });

    expect(result.summary).toEqual({
      duplicateOwnershipGroupCount: 2,
      canonicalOwnerRecommendationCount: 1,
      manualReviewOwnershipGroupCount: 1,
    });
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 1,
      totalItems: 1,
      totalPages: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].shopifyProductId).toBe("9002");
  });

  it("returns an empty bounded page when no ownership groups match", () => {
    const result = ownershipReview({
      products: [localProduct()],
      filter: "manual_review",
      page: 1,
      pageSize: 20,
    });

    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    });
    expect(result.items).toEqual([]);
  });

  it("rejects ownership pages outside the bounded contract", () => {
    expect(() => ownershipReview({
      products: [],
      page: 10_001,
    })).toThrow("from 1 through 10000");
    expect(() => ownershipReview({
      products: [],
      pageSize: 51,
    })).toThrow("from 1 through 50");
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
