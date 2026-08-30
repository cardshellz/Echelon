import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DropshipCatalogResponse, DropshipCatalogRow } from "@/lib/dropship-ops-surface";
import { fetchAllSelectedCatalogRows } from "../DropshipPortalCatalog";

function row(productVariantId: number): DropshipCatalogRow {
  return { productVariantId } as DropshipCatalogRow;
}

function page(input: {
  rows: DropshipCatalogRow[];
  total: number;
  page: number;
  limit: number;
}): DropshipCatalogResponse {
  return {
    ...input,
    facets: {
      categories: [],
      productLines: [],
      products: [],
    },
  };
}

describe("DropshipPortalCatalog workflow", () => {
  it("loads every selected catalog page and removes duplicate variants", async () => {
    const loadPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber === 1) {
        return page({
          rows: [row(11), row(12)],
          total: 3,
          page: 1,
          limit: 2,
        });
      }
      return page({
        rows: [row(12), row(13)],
        total: 3,
        page: 2,
        limit: 2,
      });
    });

    const rows = await fetchAllSelectedCatalogRows(loadPage);

    expect(loadPage.mock.calls).toEqual([
      [1, 200],
      [2, 200],
    ]);
    expect(rows.map((catalogRow) => catalogRow.productVariantId)).toEqual([11, 12, 13]);
  });

  it("puts catalog choice before listing preview and reserves MFA for push", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const filterPosition = source.indexOf("<CatalogFilterPanel");
    const availableCatalogPosition = source.indexOf("Available catalog");
    const catalogTablePosition = source.indexOf("<CatalogTable");
    const listingPreviewPosition = source.indexOf("<ListingPreviewPanel");

    expect(filterPosition).toBeGreaterThan(-1);
    expect(availableCatalogPosition).toBeGreaterThan(filterPosition);
    expect(catalogTablePosition).toBeGreaterThan(availableCatalogPosition);
    expect(listingPreviewPosition).toBeGreaterThan(catalogTablePosition);
    expect(source).not.toContain("CatalogSelectionProofPanel");
    expect(source).not.toContain("manage_catalog_selection");
    expect(source).toContain("MFA is requested only when you queue ready listings.");
    expect(source).toContain('verifyPasskeyStepUp("bulk_listing_push")');
    expect(source).toContain('startEmailStepUp("bulk_listing_push")');
  });

  it("separates required marketplace categorization from optional seller Store organization", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const comboboxSource = readFileSync(
      join(process.cwd(), "client", "src", "components", "dropship", "EbayStoreCategoryCombobox.tsx"),
      "utf8",
    );

    expect(source).toContain("Your eBay Store organization (optional)");
    expect(source).toContain("Card Shellz supplies the required eBay marketplace category.");
    expect(source).toContain("Leaving both fields blank does not block preview or push.");
    expect(source).toContain("Marketplace category");
    expect(source).toContain("Your Store:");
    expect(comboboxSource).toContain("Search your eBay Store categories...");
    expect(comboboxSource).toContain('className="max-h-64 overflow-y-auto overscroll-contain"');
  });
});
