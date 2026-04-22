import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the mills (4-decimal per-unit cost) service contract.
//
// Covers:
//   1. validateCreateWithLinesInput accepts mills-only, cents-only, and
//      matching mills+cents pairs; rejects disagreeing pairs with 400.
//   2. createPurchaseOrderWithLines writes BOTH unit_cost_mills and
//      unit_cost_cents on INSERT (cents derived via half-up from mills).
//   3. bulkUpsertVendorCatalog accepts mills; rejects disagreeing pairs.
//   4. getNewPoPreload surfaces unit_cost_mills on returned lines.
//
// We mock storage + db so the tests stay unit-level; integration tests
// cover the real SQL.
// ─────────────────────────────────────────────────────────────────────────────

function buildInsertChain(returnValue: any[] = []) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returnValue),
    }),
  };
}

function buildMockDb(headerReturn: any, captureInserts: any[]) {
  // We capture each .insert(table).values(rows) call so we can assert on
  // the row payload written for purchase_order_lines.
  const txInsert = vi.fn((table: any) => {
    const chain = {
      values: vi.fn((rows: any) => {
        captureInserts.push({ table, rows });
        const returning = vi.fn().mockResolvedValue([]);
        // For the header insert, return the synthetic row so the service
        // can read header.id back.
        if (captureInserts.length === 1) {
          returning.mockResolvedValue([headerReturn]);
        }
        return { returning };
      }),
    };
    return chain;
  });
  const tx = {
    insert: txInsert,
    update: vi.fn(),
    select: vi.fn(),
  };
  return {
    insert: vi.fn().mockReturnValue(buildInsertChain()),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn(),
    transaction: vi.fn(async (fn: any) => fn(tx)),
  };
}

function buildMockStorage(overrides: Partial<Record<string, any>> = {}) {
  return {
    getPurchaseOrders: vi.fn(),
    getPurchaseOrdersCount: vi.fn(),
    getPurchaseOrderById: vi.fn(),
    getPurchaseOrderByPoNumber: vi.fn(),
    createPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn(),
    updatePurchaseOrderStatusWithHistory: vi.fn(),
    deletePurchaseOrder: vi.fn(),
    generatePoNumber: vi.fn().mockResolvedValue("PO-TEST-001"),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
    getPurchaseOrderLineById: vi.fn(),
    createPurchaseOrderLine: vi.fn(),
    bulkCreatePurchaseOrderLines: vi.fn(),
    updatePurchaseOrderLine: vi.fn(),
    deletePurchaseOrderLine: vi.fn(),
    getOpenPoLinesForVariant: vi.fn(),
    createPoStatusHistory: vi.fn(),
    getPoStatusHistory: vi.fn(),
    createPoRevision: vi.fn(),
    getPoRevisions: vi.fn(),
    createPoReceipt: vi.fn(),
    getPoReceipts: vi.fn(),
    getAllPoApprovalTiers: vi.fn().mockResolvedValue([]),
    getPoApprovalTierById: vi.fn(),
    getMatchingApprovalTier: vi.fn().mockResolvedValue(null),
    getVendorProducts: vi.fn(),
    getVendorProductById: vi.fn(),
    getPreferredVendorProduct: vi.fn().mockResolvedValue(null),
    getVendorById: vi.fn().mockResolvedValue({ id: 1, currency: "USD" }),
    getProductVariantById: vi.fn().mockResolvedValue({
      id: 11,
      productId: 1,
      sku: "SKU-1",
      name: "case size",
      unitsPerVariant: 1,
    }),
    getProductById: vi.fn().mockResolvedValue({ id: 1, name: "Product 1" }),
    createReceivingOrder: vi.fn(),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    searchVendorCatalog: vi.fn(),
    ...overrides,
  } as any;
}

describe("mills — validateCreateWithLinesInput", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(
      buildMockDb({ id: 42 }, []),
      storage,
    );
  });

  it("accepts mills-only input", async () => {
    // 375 mills = $0.0375. No cents supplied.
    const captureInserts: any[] = [];
    svc = createPurchasingService(
      buildMockDb({ id: 42 }, captureInserts),
      storage,
    );
    const created = await svc.createPurchaseOrderWithLines({
      vendorId: 1,
      lines: [{ productVariantId: 11, orderQty: 100, unitCostMills: 375 } as any],
    });
    expect(created).toEqual({ id: 42 });
  });

  it("accepts cents-only input (legacy caller)", async () => {
    const captureInserts: any[] = [];
    svc = createPurchasingService(
      buildMockDb({ id: 42 }, captureInserts),
      storage,
    );
    await svc.createPurchaseOrderWithLines({
      vendorId: 1,
      lines: [{ productVariantId: 11, orderQty: 5, unitCostCents: 1299 }],
    });
    // Lines row should carry BOTH fields populated.
    const linesInsert = captureInserts.find(
      (c) => Array.isArray(c.rows) && c.rows[0]?.unitCostMills !== undefined,
    );
    expect(linesInsert).toBeTruthy();
    expect(linesInsert.rows[0].unitCostCents).toBe(1299);
    // centsToMills(1299) = 129900
    expect(linesInsert.rows[0].unitCostMills).toBe(129900);
  });

  it("accepts matching mills+cents pair", async () => {
    const captureInserts: any[] = [];
    svc = createPurchasingService(
      buildMockDb({ id: 42 }, captureInserts),
      storage,
    );
    // 375 mills = $0.0375 → millsToCents = 4 (half-up at 0.75 remainder)
    await svc.createPurchaseOrderWithLines({
      vendorId: 1,
      lines: [
        {
          productVariantId: 11,
          orderQty: 100,
          unitCostMills: 375,
          unitCostCents: 4,
        } as any,
      ],
    });
    const linesInsert = captureInserts.find(
      (c) => Array.isArray(c.rows) && c.rows[0]?.unitCostMills !== undefined,
    );
    expect(linesInsert.rows[0].unitCostMills).toBe(375);
    expect(linesInsert.rows[0].unitCostCents).toBe(4);
  });

  it("rejects disagreeing mills+cents pair (400)", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productVariantId: 11,
            orderQty: 1,
            unitCostMills: 375, // → 4 cents
            unitCostCents: 5,   // disagrees
          } as any,
        ],
      }),
    ).rejects.toMatchObject({ message: /disagree/i, statusCode: 400 });
  });

  it("rejects when neither mills nor cents is provided", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [{ productVariantId: 11, orderQty: 1 } as any],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects non-integer unit_cost_mills", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          { productVariantId: 11, orderQty: 1, unitCostMills: 12.5 } as any,
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects negative unit_cost_mills", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          { productVariantId: 11, orderQty: 1, unitCostMills: -1 } as any,
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("mills — createPurchaseOrderWithLines stores both columns", () => {
  it("writes unit_cost_mills AND unit_cost_cents on INSERT", async () => {
    const storage = buildMockStorage();
    const captureInserts: any[] = [];
    const svc = createPurchasingService(
      buildMockDb({ id: 99 }, captureInserts),
      storage,
    );

    await svc.createPurchaseOrderWithLines({
      vendorId: 1,
      lines: [
        { productVariantId: 11, orderQty: 10, unitCostMills: 12345 } as any,
      ],
    });

    const linesInsert = captureInserts.find(
      (c) => Array.isArray(c.rows) && c.rows[0]?.unitCostMills !== undefined,
    );
    expect(linesInsert).toBeTruthy();
    // $1.2345 × 10 = $12.345 → half-up to 1235 cents
    expect(linesInsert.rows[0].lineTotalCents).toBe(1235);
    expect(linesInsert.rows[0].unitCostMills).toBe(12345);
    // millsToCents(12345) = round_half_up(12345/100) = 123
    expect(linesInsert.rows[0].unitCostCents).toBe(123);
  });
});

describe("mills — bulkUpsertVendorCatalog", () => {
  it("rejects disagreeing mills+cents pair (400)", async () => {
    const storage = buildMockStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 42 }),
    });
    const svc = createPurchasingService(buildMockDb({ id: 1 }, []), storage);
    await expect(
      svc.bulkUpsertVendorCatalog(
        42,
        [
          {
            productId: 1,
            productVariantId: 11,
            unitCostMills: 375,
            unitCostCents: 5, // disagrees
          } as any,
        ],
        "u1",
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: /disagree/i });
  });

  it("rejects when neither mills nor cents provided", async () => {
    const storage = buildMockStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 42 }),
    });
    const svc = createPurchasingService(buildMockDb({ id: 1 }, []), storage);
    await expect(
      svc.bulkUpsertVendorCatalog(
        42,
        [{ productId: 1, productVariantId: 11 } as any],
        "u1",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("mills — getNewPoPreload", () => {
  it("returns unit_cost_mills from vendor_products when present", async () => {
    const storage = buildMockStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 1 }),
      getPreferredVendorProduct: vi.fn().mockResolvedValue({
        id: 9,
        vendorId: 1,
        productId: 1,
        productVariantId: 11,
        unitCostMills: 375,
        unitCostCents: 4, // would-be rounded value
      }),
    });
    const svc = createPurchasingService(buildMockDb({ id: 1 }, []), storage);
    const result = await svc.getNewPoPreload({
      vendorId: 1,
      variantIds: [11],
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].unitCostMills).toBe(375);
    expect(result.lines[0].unitCostCents).toBe(4); // millsToCents(375)
    expect(result.lines[0].catalogSource).toBe("vendor_catalog");
  });

  it("derives unit_cost_mills from vendor_products cents when mills is null", async () => {
    const storage = buildMockStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 1 }),
      getPreferredVendorProduct: vi.fn().mockResolvedValue({
        id: 9,
        vendorId: 1,
        productId: 1,
        productVariantId: 11,
        unitCostMills: null,
        unitCostCents: 1299,
      }),
    });
    const svc = createPurchasingService(buildMockDb({ id: 1 }, []), storage);
    const result = await svc.getNewPoPreload({
      vendorId: 1,
      variantIds: [11],
    });
    expect(result.lines[0].unitCostMills).toBe(129900); // centsToMills(1299)
    expect(result.lines[0].unitCostCents).toBe(1299);
  });

  it("falls back to variant.standardCostCents when no vendor match", async () => {
    const storage = buildMockStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 1 }),
      getPreferredVendorProduct: vi.fn().mockResolvedValue(null),
      getProductVariantById: vi.fn().mockResolvedValue({
        id: 11,
        productId: 1,
        sku: "SKU-1",
        name: "case size",
        unitsPerVariant: 1,
        standardCostCents: 500,
        lastCostCents: null,
      }),
    });
    const svc = createPurchasingService(buildMockDb({ id: 1 }, []), storage);
    const result = await svc.getNewPoPreload({
      vendorId: 1,
      variantIds: [11],
    });
    expect(result.lines[0].unitCostMills).toBe(50000); // centsToMills(500)
    expect(result.lines[0].unitCostCents).toBe(500);
    expect(result.lines[0].catalogSource).toBe("product_default");
  });

  it("returns 0 when no cost source is available", async () => {
    const storage = buildMockStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 1 }),
      getPreferredVendorProduct: vi.fn().mockResolvedValue(null),
      getProductVariantById: vi.fn().mockResolvedValue({
        id: 11,
        productId: 1,
        sku: "SKU-1",
        name: "case",
        unitsPerVariant: 1,
        standardCostCents: null,
        lastCostCents: null,
      }),
    });
    const svc = createPurchasingService(buildMockDb({ id: 1 }, []), storage);
    const result = await svc.getNewPoPreload({
      vendorId: 1,
      variantIds: [11],
    });
    expect(result.lines[0].unitCostMills).toBe(0);
    expect(result.lines[0].unitCostCents).toBe(0);
  });
});
