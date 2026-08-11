import { describe, expect, it, vi } from "vitest";
import {
  CatalogExportService,
  type CatalogExportRepository,
} from "../../application/catalog-export.service";
import {
  decodeCatalogExportCursor,
  InvalidCatalogExportCursorError,
  type CatalogVariantSnapshot,
} from "../../domain/catalog-export";

function snapshot(overrides: Partial<CatalogVariantSnapshot> = {}): CatalogVariantSnapshot {
  return {
    variantId: 11,
    productId: 7,
    variantName: "Shellz Club annual membership",
    productName: "Shellz Club",
    variantSku: "SHLZ-CLUB-ANNUAL-US",
    productSku: "SHLZ-CLUB",
    gtin: null,
    barcode: null,
    mpn: null,
    brand: "Card Shellz",
    baseUnit: "piece",
    inventoryType: "non_inventory",
    productStatus: "active",
    productIsActive: true,
    variantIsActive: true,
    productUpdatedAt: new Date("2026-08-01T12:00:00.000Z"),
    variantUpdatedAt: new Date("2026-08-02T12:00:00.000Z"),
    externalIdentifiers: [{
      provider: "shopify",
      scope: "cardshellz.myshopify.com",
      identifierType: "variant_id",
      value: "62621541925023",
    }],
    ...overrides,
  };
}

function repository(rows: CatalogVariantSnapshot[]): CatalogExportRepository {
  return { listVariantSnapshots: vi.fn().mockResolvedValue(rows) };
}

describe("CatalogExportService", () => {
  it("normalizes variant identity and emits a deterministic keyset cursor", async () => {
    const repo = repository([
      snapshot(),
      snapshot({ variantId: 12, variantName: "Second item" }),
    ]);
    const service = new CatalogExportService(repo, "echelon:cardshellz-production");

    const page = await service.listPage({ cursor: null, limit: 1 });

    expect(repo.listVariantSnapshots).toHaveBeenCalledWith({ afterVariantId: null, limit: 2 });
    expect(page).toMatchObject({
      externalSourceId: "echelon:cardshellz-production",
      items: [{
        externalItemId: "variant:11",
        externalParentId: "product:7",
        name: "Shellz Club annual membership",
        parentName: "Shellz Club",
        variantName: "Shellz Club annual membership",
        sku: "SHLZ-CLUB-ANNUAL-US",
        kind: "non_inventory",
        status: "active",
        sourceUpdatedAt: "2026-08-02T12:00:00.000Z",
        identifiers: [{
          provider: "shopify",
          scope: "cardshellz.myshopify.com",
          identifierType: "variant_id",
          value: "62621541925023",
        }],
      }],
    });
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCatalogExportCursor(page.nextCursor)).toBe(11);
  });

  it("preserves uncertain expense classifications and archives inactive records", async () => {
    const service = new CatalogExportService(repository([
      snapshot({
        inventoryType: "expense",
        productStatus: "draft",
        productIsActive: true,
        variantIsActive: true,
      }),
    ]), "tenant-1");

    const page = await service.listPage({ cursor: null, limit: 10 });

    expect(page.items[0]).toMatchObject({ kind: "unknown", status: "archived" });
  });

  it("rejects malformed cursors before querying the repository", async () => {
    const repo = repository([]);
    const service = new CatalogExportService(repo, "tenant-1");

    await expect(service.listPage({ cursor: "not-a-cursor", limit: 10 }))
      .rejects.toBeInstanceOf(InvalidCatalogExportCursorError);
    expect(repo.listVariantSnapshots).not.toHaveBeenCalled();
  });

  it("rejects non-monotonic repository results", async () => {
    const service = new CatalogExportService(repository([
      snapshot({ variantId: 12 }),
      snapshot({ variantId: 12 }),
    ]), "tenant-1");

    await expect(service.listPage({ cursor: null, limit: 10 }))
      .rejects.toThrow("non-monotonic variant identities");
  });
});
