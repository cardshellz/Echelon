import { describe, expect, it } from "vitest";
import {
  buildCatalogSkuSearchUrl,
  normalizeCatalogSkuSearchResults,
} from "../pricing-programs/rate-test-sku-search";

describe("rate-test SKU search", () => {
  it("waits for a meaningful query and safely encodes it", () => {
    expect(buildCatalogSkuSearchUrl(" A ")).toBeNull();
    expect(buildCatalogSkuSearchUrl(" BOX / 5 ")).toBe(
      "/api/inventory/skus/search?q=BOX%20%2F%205&limit=20",
    );
  });

  it("keeps valid unique SKUs and deterministically selects the lowest variant ID", () => {
    expect(normalizeCatalogSkuSearchResults([
      { sku: " PACK-1 ", name: "Pack of 5", productVariantId: 9 },
      { sku: "PACK-1", name: "Duplicate catalog row", productVariantId: 4 },
      { sku: "CASE-1", name: "Case", productVariantId: 12 },
      { sku: "", name: "Missing SKU", productVariantId: 13 },
      { sku: "INVALID", name: "", productVariantId: 14 },
      null,
    ])).toEqual([
      { sku: "CASE-1", name: "Case", productVariantId: 12 },
      { sku: "PACK-1", name: "Duplicate catalog row", productVariantId: 4 },
    ]);
  });

  it("rejects malformed endpoint payloads", () => {
    expect(normalizeCatalogSkuSearchResults(null)).toEqual([]);
    expect(normalizeCatalogSkuSearchResults({ rows: [] })).toEqual([]);
  });
});
