import { describe, expect, it } from "vitest";
import { pageListingPreviews, safeListingImageUrl } from "../dropship-listing-preview";
import type { DropshipListingPreviewRow } from "../dropship-ops-surface";

describe("listing preview rendering bounds", () => {
  const rows = Array.from({ length: 10000 }, (_, index) => ({ productVariantId: index + 1, title: `Product ${index + 1}`, sku: `SKU-${index + 1}` } as DropshipListingPreviewRow));
  it("mounts one bounded page without mutating or sorting the source", () => {
    expect(pageListingPreviews(rows, "", 2)).toMatchObject({ page: 2, pages: 200, total: 10000, start: 51, end: 100 });
    expect(pageListingPreviews(rows, "", 2).rows).toHaveLength(50);
    expect(rows[0].productVariantId).toBe(1);
  });
  it("clamps pages after filtering and handles no results/invalid page numbers", () => {
    expect(pageListingPreviews(rows, " sku-10000 ", 200)).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(pageListingPreviews(rows, "no match", 200)).toMatchObject({ page: 1, start: 0, end: 0, total: 0 });
    expect(pageListingPreviews(rows, "", NaN).page).toBe(1);
  });
});

describe("preview media URL boundary", () => {
  it.each(["https://images.example.test/photo.jpg", "http://images.example.test/photo.jpg", "/api/dropship/listings/stores/1/variants/2/assets/3/file"])("accepts intended image route %s", (url) => {
    expect(safeListingImageUrl(url)).toBe(url);
  });
  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//images.example.test/a", "/api/product-assets/3/file", "/api/dropship/settings", "https://user:secret@example.test/a", " https://example.test/a", "https://example.test/\na", "https:\\example.test/a", "", null])("rejects unsafe/unauthorized URL %s", (url) => {
    expect(safeListingImageUrl(url)).toBeNull();
  });
});
