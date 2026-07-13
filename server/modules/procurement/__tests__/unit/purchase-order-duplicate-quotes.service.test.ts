import { describe, expect, it, vi } from "vitest";
import {
  poEvents,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  vendorProducts,
  vendors,
} from "@shared/schema";
import { createPurchasingService } from "../../purchasing.service";

const NOW = new Date("2026-07-13T16:00:00.000Z");

type InsertCapture = { table: unknown; rows: any[] };

function buildDb(context: {
  vendor: any;
  product: any;
  variant: any;
  lockedVendorProducts?: any[];
}) {
  const inserts: InsertCapture[] = [];
  const updates: Array<{ table: unknown; patch: any }> = [];
  let nextLineId = 1_000;

  function rowsFor(table: unknown): any[] {
    if (table === vendors) return [context.vendor];
    if (table === products) return [context.product];
    if (table === productVariants) return context.variant ? [context.variant] : [];
    if (table === vendorProducts) return context.lockedVendorProducts ?? [];
    return [];
  }

  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      const chain: any = {
        from: vi.fn((selectedTable: unknown) => {
          table = selectedTable;
          return chain;
        }),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        for: vi.fn(async () => rowsFor(table)),
        then: (resolve: any, reject: any) =>
          Promise.resolve(rowsFor(table)).then(resolve, reject),
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: any) => {
        const rows = Array.isArray(value) ? value : [value];
        inserts.push({ table, rows });
        const returned = rows.map((row) => {
          if (table === purchaseOrders) return { id: 900, ...row };
          if (table === purchaseOrderLines) return { id: nextLineId++, ...row };
          return row;
        });
        const result: any = Promise.resolve(returned);
        result.returning = vi.fn(async () => returned);
        return result;
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: any) => {
        updates.push({ table, patch });
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  };

  const db: any = {
    insert: vi.fn(),
    transaction: vi.fn(async (callback: any) => callback(tx)),
  };
  return { db, inserts, updates };
}

function baseSourceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    lineNumber: 1,
    status: "open",
    lineType: "product",
    productId: 100,
    productVariantId: 101,
    expectedReceiveVariantId: 101,
    expectedReceiveUnitsPerVariant: 1,
    unitsPerUom: 1,
    orderQty: 24,
    unitCostCents: 100,
    unitCostMills: 10_000,
    totalProductCostCents: 2_400,
    packagingCostCents: 25,
    pricingBasis: "legacy_unknown",
    pricingSource: "legacy",
    vendorProductId: null,
    vendorSku: "SOURCE-SKU",
    description: "Preserve handling instructions",
    notes: "Preserve internal line note",
    ...overrides,
  };
}

function buildFixture(options: {
  sourceLines: any[];
  sourceVendorId?: number;
  targetVendorId?: number;
  catalogRows?: any[];
  lockedVendorProducts?: any[];
}) {
  const sourceVendorId = options.sourceVendorId ?? 1;
  const targetVendorId = options.targetVendorId ?? sourceVendorId;
  const source = {
    id: 77,
    poNumber: "PO-SOURCE",
    vendorId: sourceVendorId,
    warehouseId: 8,
    poType: "standard",
    priority: "high",
    incoterms: "FOB",
    vendorNotes: "vendor note",
    internalNotes: "internal note",
  };
  const product = { id: 100, name: "Widget", sku: "W-100", isActive: true };
  const variant = {
    id: 101,
    productId: 100,
    name: "Each",
    sku: "W-100-EA",
    unitsPerVariant: 1,
    isActive: true,
  };
  const targetVendor = {
    id: targetVendorId,
    active: 1,
    currency: "USD",
    paymentTermsDays: 30,
    paymentTermsType: "net",
    shipFromAddress: "Target warehouse",
  };
  const dbState = buildDb({
    vendor: targetVendor,
    product,
    variant,
    lockedVendorProducts: options.lockedVendorProducts,
  });
  const catalogRows = options.catalogRows ?? [];
  const storage: any = {
    getPurchaseOrderById: vi.fn().mockResolvedValue(source),
    getPurchaseOrderLines: vi.fn().mockResolvedValue(options.sourceLines),
    getVendorProducts: vi.fn().mockResolvedValue(catalogRows),
    getVendorProductById: vi.fn(async (id: number) =>
      catalogRows.find((row) => Number(row.id) === id),
    ),
    getVendorById: vi.fn().mockResolvedValue(targetVendor),
    getProductById: vi.fn().mockResolvedValue(product),
    getProductVariantById: vi.fn().mockResolvedValue(variant),
    generatePoNumber: vi.fn().mockResolvedValue("PO-DUPLICATE"),
  };
  const service = createPurchasingService(dbState.db, storage, { now: () => NOW });
  return { service, storage, source, ...dbState };
}

function insertedLines(inserts: InsertCapture[]): any[] {
  return inserts.find((entry) => entry.table === purchaseOrderLines)?.rows ?? [];
}

function insertedEvents(inserts: InsertCapture[]): any[] {
  return inserts
    .filter((entry) => entry.table === poEvents)
    .flatMap((entry) => entry.rows);
}

describe("duplicatePurchaseOrder quote provenance", () => {
  it("preserves every explicit source basis as manual provenance for the same vendor", async () => {
    const cases = [
      {
        source: baseSourceLine({
          pricingBasis: "per_piece",
          pricingSource: "vendor_catalog",
          vendorProductId: 501,
          quotedUnitCostMills: 12_345,
          quoteReference: "Q-PIECE",
          quotedAt: new Date("2026-07-01T12:00:00.000Z"),
          quoteValidUntil: "2026-08-01",
        }),
        expected: {
          pricingBasis: "per_piece",
          quotedUnitCostMills: 12_345,
          quotedTotalCents: null,
        },
      },
      {
        source: baseSourceLine({
          pricingBasis: "per_purchase_uom",
          pricingSource: "recommendation",
          vendorProductId: 502,
          purchaseUom: "case",
          purchaseUomQuantity: 2,
          piecesPerPurchaseUom: 12,
          quotedUnitCostMills: 159_995,
          quoteReference: "Q-CASE",
          quotedAt: new Date("2026-07-02T12:00:00.000Z"),
          quoteValidUntil: "2026-08-02",
        }),
        expected: {
          pricingBasis: "per_purchase_uom",
          quotedUnitCostMills: 159_995,
          quotedTotalCents: null,
        },
      },
      {
        source: baseSourceLine({
          pricingBasis: "extended_total",
          pricingSource: "manual",
          quotedUnitCostMills: null,
          quotedTotalCents: 4_321,
          quoteReference: "Q-TOTAL",
          quotedAt: new Date("2026-07-03T12:00:00.000Z"),
          quoteValidUntil: "2026-08-03",
        }),
        expected: {
          pricingBasis: "extended_total",
          quotedUnitCostMills: null,
          quotedTotalCents: 4_321,
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = buildFixture({ sourceLines: [testCase.source] });
      await fixture.service.duplicatePurchaseOrder(77, undefined, "buyer-1");

      const [line] = insertedLines(fixture.inserts);
      expect(line).toMatchObject({
        orderQty: 24,
        pricingBasis: testCase.expected.pricingBasis,
        pricingSource: "manual",
        vendorProductId: null,
        quotedUnitCostMills: testCase.expected.quotedUnitCostMills,
        quotedTotalCents: testCase.expected.quotedTotalCents,
        quoteReference: testCase.source.quoteReference,
        quoteValidUntil: testCase.source.quoteValidUntil,
        packagingCostCents: 25,
      });
      expect(new Date(line.quotedAt).toISOString()).toBe(
        testCase.source.quotedAt.toISOString(),
      );
      expect(fixture.db.insert).not.toHaveBeenCalled();
      expect(insertedEvents(fixture.inserts).map((event) => event.eventType)).toEqual([
        "created",
        "duplicated_from",
      ]);
    }
  });

  it("uses a compatible target-vendor UOM quote and copies metadata from the locked row", async () => {
    const catalog = {
      id: 600,
      vendorId: 2,
      productId: 100,
      productVariantId: 101,
      vendorSku: "TARGET-PREFLIGHT",
      isActive: 1,
      isPreferred: 0,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      piecesPerPurchaseUom: 12,
      quotedUnitCostMills: 180_000,
      unitCostMills: 15_000,
      unitCostCents: 150,
      quoteReference: "Q-PREFLIGHT",
      quotedAt: new Date("2026-07-05T12:00:00.000Z"),
      quoteValidUntil: "2026-08-05",
    };
    const lockedCatalog = {
      ...catalog,
      vendorSku: "TARGET-LOCKED",
      quoteReference: "Q-LOCKED",
    };
    const fixture = buildFixture({
      sourceVendorId: 1,
      targetVendorId: 2,
      sourceLines: [
        baseSourceLine({
          pricingBasis: "extended_total",
          pricingSource: "manual",
          quotedTotalCents: 9_999,
          packagingCostCents: 0,
        }),
      ],
      catalogRows: [catalog],
      lockedVendorProducts: [lockedCatalog],
    });

    await fixture.service.duplicatePurchaseOrder(77, { vendorId: 2 }, "buyer-2");

    const [line] = insertedLines(fixture.inserts);
    expect(line).toMatchObject({
      orderQty: 24,
      pricingBasis: "per_purchase_uom",
      pricingSource: "vendor_catalog",
      vendorProductId: 600,
      purchaseUom: "case",
      purchaseUomQuantity: 2,
      piecesPerPurchaseUom: 12,
      quotedUnitCostMills: 180_000,
      vendorSku: "TARGET-LOCKED",
      quoteReference: "Q-LOCKED",
    });
    const [header] = fixture.inserts.find((entry) => entry.table === purchaseOrders)!.rows;
    expect(header).toMatchObject({
      vendorId: 2,
      warehouseId: 8,
      incoterms: null,
      vendorNotes: null,
      internalNotes: "internal note",
    });
    expect(fixture.storage.getVendorProducts).toHaveBeenCalledWith({
      vendorId: 2,
      productId: 100,
      isActive: 1,
    });
  });

  it("blocks a vendor change when the only UOM quote would alter the source quantity", async () => {
    const incompatibleCatalog = {
      id: 700,
      vendorId: 2,
      productId: 100,
      productVariantId: 101,
      isActive: 1,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      piecesPerPurchaseUom: 12,
      quotedUnitCostMills: 180_000,
      unitCostMills: 15_000,
      unitCostCents: 150,
      quotedAt: new Date("2026-07-05T12:00:00.000Z"),
      quoteValidUntil: "2026-08-05",
    };
    const fixture = buildFixture({
      sourceVendorId: 1,
      targetVendorId: 2,
      sourceLines: [baseSourceLine({ orderQty: 25, packagingCostCents: 0 })],
      catalogRows: [incompatibleCatalog],
    });

    await expect(
      fixture.service.duplicatePurchaseOrder(77, { vendorId: 2 }, "buyer-3"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "PO_DUPLICATE_TARGET_VENDOR_QUOTE_REQUIRED",
        sourceLineId: 10,
        targetVendorId: 2,
      },
    });
    expect(fixture.db.transaction).not.toHaveBeenCalled();
  });

  it("does not trust an expired catalog quote during a vendor change", async () => {
    const expiredCatalog = {
      id: 701,
      vendorId: 2,
      productId: 100,
      productVariantId: 101,
      isActive: 1,
      pricingBasis: "per_piece",
      quotedUnitCostMills: 15_000,
      unitCostMills: 15_000,
      unitCostCents: 150,
      quotedAt: new Date("2026-06-01T12:00:00.000Z"),
      quoteValidUntil: "2026-07-12",
    };
    const fixture = buildFixture({
      sourceVendorId: 1,
      targetVendorId: 2,
      sourceLines: [
        baseSourceLine({
          pricingBasis: "per_piece",
          pricingSource: "manual",
          quotedUnitCostMills: 12_500,
          packagingCostCents: 0,
        }),
      ],
      catalogRows: [expiredCatalog],
    });

    await expect(
      fixture.service.duplicatePurchaseOrder(77, { vendorId: 2 }, "buyer-3"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DUPLICATE_TARGET_VENDOR_QUOTE_REQUIRED" },
    });
    expect(fixture.db.transaction).not.toHaveBeenCalled();
  });

  it("blocks cross-vendor carryover of a product packaging cost", async () => {
    const usableCatalog = {
      id: 702,
      vendorId: 2,
      productId: 100,
      productVariantId: 101,
      isActive: 1,
      pricingBasis: "per_piece",
      quotedUnitCostMills: 15_000,
      unitCostMills: 15_000,
      unitCostCents: 150,
      quotedAt: new Date("2026-07-05T12:00:00.000Z"),
      quoteValidUntil: "2026-08-05",
    };
    const fixture = buildFixture({
      sourceVendorId: 1,
      targetVendorId: 2,
      sourceLines: [baseSourceLine({ packagingCostCents: 25 })],
      catalogRows: [usableCatalog],
      lockedVendorProducts: [usableCatalog],
    });

    await expect(
      fixture.service.duplicatePurchaseOrder(77, { vendorId: 2 }, "buyer-3"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "PO_DUPLICATE_TARGET_VENDOR_PACKAGING_REVIEW_REQUIRED",
        sourceLineId: 10,
        targetVendorId: 2,
        packagingCostCents: 25,
      },
    });
    expect(fixture.db.transaction).not.toHaveBeenCalled();
  });

  it("blocks cross-vendor carryover of typed non-product economics", async () => {
    const fixture = buildFixture({
      sourceVendorId: 1,
      targetVendorId: 2,
      sourceLines: [
        {
          id: 12,
          lineNumber: 1,
          status: "open",
          lineType: "fee",
          description: "Vendor handling fee",
          orderQty: 1,
          unitCostMills: 2_500,
          unitCostCents: 25,
          pricingBasis: "not_applicable",
          pricingSource: "manual",
        },
      ],
    });

    await expect(
      fixture.service.duplicatePurchaseOrder(77, { vendorId: 2 }, "buyer-3"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "PO_DUPLICATE_TARGET_VENDOR_NON_PRODUCT_REVIEW_REQUIRED",
        sourceLineId: 12,
        lineType: "fee",
        targetVendorId: 2,
      },
    });
    expect(fixture.storage.getVendorProducts).not.toHaveBeenCalled();
    expect(fixture.db.transaction).not.toHaveBeenCalled();
  });

  it("preserves legacy product totals, signed non-product economics, and parent linkage", async () => {
    const fixture = buildFixture({
      sourceLines: [
        baseSourceLine({
          id: 10,
          orderQty: 3,
          totalProductCostCents: 1_000,
          packagingCostCents: 25,
        }),
        {
          id: 11,
          lineNumber: 2,
          status: "open",
          lineType: "discount",
          parentLineId: 10,
          description: "Contract discount",
          notes: "Signed adjustment",
          orderQty: 1,
          unitCostMills: -125,
          unitCostCents: -1,
          pricingBasis: "not_applicable",
          pricingSource: "manual",
        },
      ],
    });

    await fixture.service.duplicatePurchaseOrder(77, undefined, "buyer-4");

    const [productLine, discountLine] = insertedLines(fixture.inserts);
    expect(productLine).toMatchObject({
      orderQty: 3,
      pricingBasis: "legacy_unknown",
      pricingSource: "legacy",
      totalProductCostCents: 1_000,
      packagingCostCents: 25,
      lineTotalCents: 1_025,
    });
    expect(discountLine).toMatchObject({
      lineType: "discount",
      productId: null,
      orderQty: 1,
      unitCostMills: -125,
      unitCostCents: -1,
      lineTotalCents: -1,
      pricingBasis: "not_applicable",
      pricingSource: "manual",
    });
    expect(fixture.updates).toContainEqual({
      table: purchaseOrderLines,
      patch: { parentLineId: 1_000 },
    });
  });
});
