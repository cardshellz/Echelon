import { describe, expect, it } from "vitest";
import { summarizeShopifyProductSync } from "../shopify-product-sync-result";

describe("summarizeShopifyProductSync", () => {
  it("reports catalog and canonical mapping success together", () => {
    expect(summarizeShopifyProductSync({
      products: { created: 2, updated: 3 },
      variants: { created: 4, updated: 5 },
      canonicalMappings: {
        repairedProducts: 2,
        alreadyConsistentProducts: 3,
        failedProducts: 0,
      },
      mappingConflicts: [],
      contentSync: { mappingConflicts: [] },
    })).toEqual({
      needsReview: false,
      title: "Sync Complete",
      description: "Products: 2 created, 3 updated. Variants: 4 created, 5 updated. Canonical mappings: 2 repaired, 3 already consistent.",
    });
  });

  it("does not describe a partial mapping result as successful", () => {
    const outcome = summarizeShopifyProductSync({
      success: false,
      canonicalMappings: { failedProducts: 1 },
      mappingConflicts: [{ code: "SHOPIFY_CANONICAL_MAPPING_PROJECTION_FAILED" }],
    });

    expect(outcome.needsReview).toBe(true);
    expect(outcome.description).toContain("1 canonical mapping failed");
    expect(outcome.description).toContain("1 conflict was reported");
  });

  it("fails closed when an older or malformed response omits mapping evidence", () => {
    expect(summarizeShopifyProductSync({ products: { created: 1 } })).toEqual({
      needsReview: true,
      title: "Shopify sync needs review",
      description: "Catalog content was synced, but the server did not return canonical mapping results. Treat the mapping as incomplete.",
    });
  });
});
