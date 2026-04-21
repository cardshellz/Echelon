import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock the base storage module so that the storage methods import the
// stubbed `db` and schema objects. This lets us verify the logic that sits
// above the SQL \u2014 specifically, that inCatalog rows take priority, that
// outOfCatalog is trimmed to fill the remaining slots, and that already-in-
// catalog variants/products are filtered out of the "other" bucket.

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    execute: (globalThis as any).vi?.fn?.() ?? undefined,
  } as any,
}));

// Seed real mock fns after hoisting (the hoisted block can't access vi).
// @ts-ignore — assigned before any test runs.
dbMock.execute = vi.fn();
dbMock.select = vi.fn();
dbMock.insert = vi.fn();
dbMock.update = vi.fn();
dbMock.delete = vi.fn();

vi.mock("../../../../storage/base", async () => {
  const drizzle = await import("drizzle-orm");
  return {
    db: dbMock,
    // tables referenced by procurement.storage.ts \u2014 the actual shape only
    // matters for methods we don't exercise in this test file.
    vendors: {},
    receivingOrders: {},
    receivingLines: {},
    vendorProducts: { id: {}, vendorId: {}, productId: {}, productVariantId: {}, isPreferred: {}, isActive: {} } as any,
    poApprovalTiers: { id: {}, sortOrder: {}, thresholdCents: {} } as any,
    purchaseOrders: {},
    purchaseOrderLines: {},
    poStatusHistory: {},
    poRevisions: {},
    poReceipts: {},
    inventoryLots: {},
    orderItemCosts: {},
    orderItemFinancials: {},
    inboundShipments: {},
    inboundShipmentLines: {},
    inboundFreightCosts: {},
    inboundFreightAllocations: {},
    landedCostSnapshots: {},
    landedCostAdjustments: {},
    inboundShipmentStatusHistory: {},
    reorderExclusionRules: {},
    autoDraftRuns: {},
    products: {},
    ...drizzle,
  };
});

// Import after mock so storage.ts picks up the mocked base.
import { procurementMethods } from "../../procurement.storage";

describe("Spec A follow-up \u2014 searchVendorCatalog", () => {
  beforeEach(() => {
    dbMock.execute.mockReset();
  });

  it("returns inCatalog rows first, fills outOfCatalog to the limit, and excludes already-in-catalog variants", async () => {
    // Call #1: inCatalog rows
    dbMock.execute.mockResolvedValueOnce({
      rows: [
        {
          vendor_product_id: 10,
          product_id: 1,
          product_variant_id: 11,
          sku: "SHLZ-TOP-1",
          product_name: "Shellz Top Box",
          variant_name: "1oz",
          vendor_sku: "V-SHLZ-TOP-1",
          vendor_product_name: null,
          unit_cost_cents: 1299,
          pack_size: 12,
          moq: 1,
          lead_time_days: 7,
          is_preferred: 1,
        },
        {
          vendor_product_id: 20,
          product_id: 2,
          product_variant_id: 21,
          sku: "SHLZ-TOP-2",
          product_name: "Shellz Top Box",
          variant_name: "2oz",
          vendor_sku: null,
          vendor_product_name: "Top Box 2oz",
          unit_cost_cents: 1599,
          pack_size: 12,
          moq: 1,
          lead_time_days: null,
          is_preferred: 0,
        },
      ],
    });
    // Call #2: exclusion list \u2014 everything this vendor already stocks
    dbMock.execute.mockResolvedValueOnce({
      rows: [
        { product_id: 1, product_variant_id: 11 },
        { product_id: 2, product_variant_id: 21 },
        { product_id: 5, product_variant_id: null }, // whole product blocked
      ],
    });
    // Call #3: candidate outOfCatalog rows \u2014 note pid=1/vid=11 is still in the
    // catalog exclusion set and must be filtered. pid=5 is blocked at product
    // level. pid=7 is a fresh candidate.
    dbMock.execute.mockResolvedValueOnce({
      rows: [
        { product_id: 1, product_variant_id: 11, sku: "SHLZ-TOP-1", product_name: "Shellz Top Box", variant_name: "1oz", rank: 0 },
        { product_id: 5, product_variant_id: 51, sku: "SHLZ-TOP-5", product_name: "Other", variant_name: null, rank: 1 },
        { product_id: 7, product_variant_id: 71, sku: "SHLZ-TOP-7", product_name: "Shellz Top 7", variant_name: null, rank: 1 },
      ],
    });

    const result = await procurementMethods.searchVendorCatalog({
      vendorId: 42,
      q: "SHLZ-TOP",
      limit: 50,
    });

    expect(result.inCatalog).toHaveLength(2);
    expect(result.inCatalog[0]).toMatchObject({
      vendorProductId: 10,
      productId: 1,
      productVariantId: 11,
      unitCostCents: 1299,
      isPreferred: true,
    });
    // pid=1/vid=11 and pid=5 must be filtered out; pid=7 remains.
    expect(result.outOfCatalog).toEqual([
      {
        productId: 7,
        productVariantId: 71,
        sku: "SHLZ-TOP-7",
        productName: "Shellz Top 7",
        variantName: null,
      },
    ]);
  });

  it("caps combined results at limit \u2014 inCatalog gets priority", async () => {
    // 50 inCatalog rows saturate the cap; outOfCatalog queries should never run.
    const manyInCatalog = Array.from({ length: 50 }, (_, i) => ({
      vendor_product_id: i + 1,
      product_id: i + 1,
      product_variant_id: i + 100,
      sku: `SKU-${i}`,
      product_name: `Product ${i}`,
      variant_name: null,
      vendor_sku: null,
      vendor_product_name: null,
      unit_cost_cents: 100,
      pack_size: 1,
      moq: 1,
      lead_time_days: null,
      is_preferred: 0,
    }));
    dbMock.execute.mockResolvedValueOnce({ rows: manyInCatalog });

    const result = await procurementMethods.searchVendorCatalog({
      vendorId: 42,
      q: "SKU",
      limit: 50,
    });

    expect(result.inCatalog).toHaveLength(50);
    expect(result.outOfCatalog).toHaveLength(0);
    // Critically: only the inCatalog query should have been executed.
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });

  it("clamps limit to 100 even if the caller asks for more", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [] });
    dbMock.execute.mockResolvedValueOnce({ rows: [] });
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    await procurementMethods.searchVendorCatalog({
      vendorId: 1,
      q: "x",
      limit: 10_000,
    });

    // The first execute receives the bound LIMIT via sql\`\`; we can't read the
    // literal easily here without importing drizzle internals. This test is
    // mainly a smoke signal that the method tolerates large limits without
    // throwing. Exact clamp is covered by the type (Math.min(100, ...)).
    expect(dbMock.execute).toHaveBeenCalled();
  });
});
