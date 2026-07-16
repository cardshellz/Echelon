import { describe, expect, it } from "vitest";
import {
  buildSupplierEvidenceImportPreview,
  type SupplierEvidenceImportDependencies,
  type SupplierEvidenceImportRow,
} from "../../supplier-evidence-import.service";

function dependencies(overrides: Partial<SupplierEvidenceImportDependencies> = {}): SupplierEvidenceImportDependencies {
  return {
    getVendorById: async () => ({ id: 7, code: "VEND-7", name: "Verified Vendor", active: 1 }),
    getAllProducts: async () => [
      { id: 10, sku: "BASE-10", name: "Variant Product", isActive: true },
      { id: 20, sku: "SINGLE-20", name: "Single Product", isActive: true },
    ],
    getAllProductVariants: async () => [
      { id: 101, productId: 10, sku: "VAR-101", name: "Case of 12", isActive: true },
    ],
    getVendorProductsByProductIds: async () => [],
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    ...overrides,
  };
}

function row(overrides: Partial<SupplierEvidenceImportRow> = {}): SupplierEvidenceImportRow {
  return {
    sku: "VAR-101",
    vendorSku: "V-101",
    pricingBasis: "per_piece",
    quotedUnitCost: "0.0075",
    purchaseUom: null,
    piecesPerPurchaseUom: null,
    quoteReference: "QUOTE-2026-101",
    quotedAt: new Date("2026-07-15T00:00:00.000Z"),
    quoteValidUntil: "2026-08-15",
    moqPieces: 24,
    leadTimeDays: 5,
    isPreferred: true,
    ...overrides,
  };
}

describe("supplier evidence import preview", () => {
  it("resolves an exact receive variant, preserves mills, and previews reactivation plus demotion", async () => {
    const preview = await buildSupplierEvidenceImportPreview({
      vendorId: 7,
      rows: [row()],
      dependencies: dependencies({
        getVendorProductsByProductIds: async () => [
          {
            id: 501,
            vendorId: 7,
            productId: 10,
            productVariantId: 101,
            isActive: 0,
            isPreferred: 0,
          },
          {
            id: 502,
            vendorId: 8,
            productId: 10,
            productVariantId: 101,
            isActive: 1,
            isPreferred: 1,
          },
        ],
      }),
    });

    expect(preview.summary).toEqual({
      total: 1,
      creates: 0,
      updates: 0,
      reactivations: 1,
      preferredDemotions: 1,
      warnings: 1,
    });
    expect(preview.items[0]).toMatchObject({
      sku: "VAR-101",
      productId: 10,
      productVariantId: 101,
      action: "reactivate",
      existingVendorProductId: 501,
      willDemoteVendorProductIds: [502],
      quotedUnitCost: "0.0075",
      normalizedUnitCostMills: 75,
    });
    expect(preview.catalogEntries[0]).toMatchObject({
      productId: 10,
      productVariantId: 101,
      packSize: 1,
      moq: 24,
      leadTimeDays: 5,
      isPreferred: true,
      pricing: {
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: 75,
      },
    });
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalizes a quoted purchase UOM without treating the line total as reusable pricing", async () => {
    const preview = await buildSupplierEvidenceImportPreview({
      vendorId: 7,
      rows: [
        row({
          sku: "SINGLE-20",
          pricingBasis: "per_purchase_uom",
          quotedUnitCost: "12.3456",
          purchaseUom: "case",
          piecesPerPurchaseUom: 24,
          moqPieces: 48,
        }),
      ],
      dependencies: dependencies(),
    });

    expect(preview.summary.creates).toBe(1);
    expect(preview.catalogEntries[0]).toMatchObject({
      productId: 20,
      productVariantId: null,
      packSize: 24,
      moq: 48,
      pricing: {
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: 1,
        piecesPerUom: 24,
        quotedCostMillsPerUom: 123456,
      },
    });
  });

  it("keeps expired evidence visible but warns that it will not clear automation review", async () => {
    const preview = await buildSupplierEvidenceImportPreview({
      vendorId: 7,
      rows: [row({ quoteValidUntil: "2026-07-15" })],
      dependencies: dependencies(),
    });

    expect(preview.items[0]).toMatchObject({
      quoteValidityStatus: "expired",
      warnings: expect.arrayContaining([
        expect.stringContaining("automation will continue to require quote review"),
      ]),
    });
  });

  it("collects duplicate, ambiguous base-product, and missing SKU errors before any write", async () => {
    await expect(buildSupplierEvidenceImportPreview({
      vendorId: 7,
      rows: [
        row({ sku: "BASE-10" }),
        row({ sku: "MISSING" }),
        row({ sku: "MISSING" }),
      ],
      dependencies: dependencies(),
    })).rejects.toMatchObject({
      statusCode: 422,
      details: {
        code: "SUPPLIER_EVIDENCE_IMPORT_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "VARIANT_SKU_REQUIRED", rowNumber: 2 }),
          expect.objectContaining({ code: "SKU_NOT_FOUND", rowNumber: 3 }),
          expect.objectContaining({ code: "DUPLICATE_IMPORT_SKU", rowNumber: 4 }),
        ]),
      },
    });
  });

  it("changes the preview hash when current mapping state changes without changing the requested rows", async () => {
    const first = await buildSupplierEvidenceImportPreview({
      vendorId: 7,
      rows: [row()],
      dependencies: dependencies({
        getVendorProductsByProductIds: async () => [{
          id: 501,
          vendorId: 7,
          productId: 10,
          productVariantId: 101,
          isActive: 1,
          isPreferred: 1,
          updatedAt: "2026-07-15T10:00:00.000Z",
        }],
      }),
    });
    const changed = await buildSupplierEvidenceImportPreview({
      vendorId: 7,
      rows: [row()],
      dependencies: dependencies({
        getVendorProductsByProductIds: async () => [{
          id: 501,
          vendorId: 7,
          productId: 10,
          productVariantId: 101,
          isActive: 1,
          isPreferred: 1,
          updatedAt: "2026-07-16T10:00:00.000Z",
        }],
      }),
    });

    expect(first.items[0].action).toBe("update");
    expect(changed.items[0].action).toBe("update");
    expect(first.previewHash).not.toBe(changed.previewHash);
  });
});
