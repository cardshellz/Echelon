import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Spec A follow-up: bulkUpsertVendorCatalog unit tests.
//
// Boundaries covered:
//   - validation rejects bad input BEFORE touching the db (Rule #4)
//   - floats in unitCostCents are rejected (Rule #3)
//   - whole batch runs inside one transaction; a failing tx surfaces the
//     error without partial state bleeding through
//   - idempotent replay semantics: identical entries on an existing row
//     produce an update (not a duplicate insert)
//
// The actual SQL is exercised by integration tests; here we mock db + storage
// and verify flow control.
// ─────────────────────────────────────────────────────────────────────────────

function buildInsertChain(returnValue: any[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returnValue),
    }),
  };
}

function buildUpdateChain(returnValue: any[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returnValue),
      }),
    }),
  };
}

function buildSelectChain(returnValue: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(returnValue),
  };
}

function buildMockDb(options: {
  executeRows?: any[][];
  updateReturns?: any[][];
  transactionThrows?: Error;
} = {}) {
  const executeQueue = [...(options.executeRows ?? [])];
  const updateQueue = [...(options.updateReturns ?? [])];

  const tx = {
    execute: vi.fn(async () => ({ rows: executeQueue.shift() ?? [] })),
    select: vi.fn(() => buildSelectChain([])),
    insert: vi.fn(() => buildInsertChain([])),
    update: vi.fn(() => buildUpdateChain(updateQueue.shift() ?? [])),
  };

  return {
    insert: vi.fn(() => buildInsertChain([])), // used by emitPoEvent
    select: vi.fn(() => buildSelectChain([])),
    update: vi.fn(() => buildUpdateChain([])),
    transaction: vi.fn(async (fn: any) => {
      if (options.transactionThrows) throw options.transactionThrows;
      return fn(tx);
    }),
    _tx: tx,
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
    getVendorById: vi.fn().mockResolvedValue({ id: 42, name: "Acme", code: "ACME" }),
    getProductVariantById: vi.fn(),
    getProductById: vi.fn(),
    createReceivingOrder: vi.fn(),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

describe("Spec A follow-up \u2014 bulkUpsertVendorCatalog validation", () => {
  it("rejects empty entries", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [], "u1"),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects invalid vendorId", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(0, [
        { productId: 1, unitCostCents: 100 },
      ], "u1"),
    ).rejects.toThrow(/vendorId must be a positive PostgreSQL integer/);
  });

  it("rejects float unitCostCents (Rule #3 guard)", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [
        { productId: 1, unitCostCents: 10.5 },
      ], "u1"),
    ).rejects.toThrow(/non-negative safe integer/);
  });

  it("rejects negative unitCostCents", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [
        { productId: 1, unitCostCents: -1 },
      ], "u1"),
    ).rejects.toThrow(/non-negative safe integer/);
  });

  it("requires a real quote date before explicit pricing becomes reusable", async () => {
    const db = buildMockDb();
    const svc = createPurchasingService(db as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [{
        productId: 1,
        pricing: {
          basis: "per_piece",
          quantityPieces: 12,
          unitCostMills: 10_000,
        },
      }], "u1"),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: "VENDOR_CATALOG_QUOTED_AT_REQUIRED", index: 0 },
    } satisfies Partial<PurchasingError>);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("404s when vendor missing", async () => {
    const svc = createPurchasingService(buildMockDb({ executeRows: [[]] }) as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(999, [
        { productId: 1, unitCostCents: 100 },
      ], "u1"),
    ).rejects.toThrow(/Vendor not found/);
  });

  it("rejects non-integer productId", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [
        { productId: 1.5 as any, unitCostCents: 100 },
      ], "u1"),
    ).rejects.toThrow(/productId must be a positive PostgreSQL integer/);
  });
});

describe("Spec A follow-up \u2014 bulkUpsertVendorCatalog flow", () => {
  it("reuses a caller transaction so PO and catalog writes share one commit boundary", async () => {
    const db = buildMockDb({
      executeRows: [
        [{ id: 42, active: 1 }],
        [{ id: 1, is_active: true }],
        [{ id: 11, product_id: 1, is_active: true }],
        [{
          id: 100,
          product_id: 1,
          product_variant_id: 11,
          unit_cost_cents: 1299,
          unit_cost_mills: 129900,
          pricing_basis: "legacy_unknown",
          pack_size: 12,
          moq: 1,
          is_preferred: 0,
          is_active: 1,
        }],
      ],
    });
    const svc = createPurchasingService(db as any, buildMockStorage());

    const result = await (svc.bulkUpsertVendorCatalog as any)(42, [
      { productId: 1, productVariantId: 11, unitCostCents: 1299 },
    ], "u1", db._tx);

    expect(result.created).toEqual([
      { vendorProductId: 100, productId: 1, productVariantId: 11 },
    ]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db._tx.insert).toHaveBeenCalledTimes(1);
  });

  it("inserts a new row when none exists and skips the update path", async () => {
    const db = buildMockDb({
      executeRows: [
        [{ id: 42, active: 1 }],
        [{ id: 1, is_active: true }],
        [{ id: 11, product_id: 1, is_active: true }],
        [{
        id: 100,
        product_id: 1,
        product_variant_id: 11,
        unit_cost_cents: 1299,
        unit_cost_mills: 129900,
        pricing_basis: "legacy_unknown",
        pack_size: 12,
        moq: 1,
        lead_time_days: null,
        is_preferred: 0,
        is_active: 1,
        vendor_sku: null,
      }],
      ],
    });
    const svc = createPurchasingService(db as any, buildMockStorage());
    const result = await svc.bulkUpsertVendorCatalog(42, [
      { productId: 1, productVariantId: 11, unitCostCents: 1299, packSize: 12 },
    ], "u1");

    expect(result.created).toEqual([
      { vendorProductId: 100, productId: 1, productVariantId: 11 },
    ]);
    expect(result.updated).toEqual([]);
    expect(db._tx.execute).toHaveBeenCalledTimes(4);
    expect(db._tx.insert).toHaveBeenCalledTimes(1); // durable audit
    expect(db._tx.update).not.toHaveBeenCalled();
  });

  it("updates an existing row (idempotent replay) instead of inserting duplicate", async () => {
    const db = buildMockDb({
      executeRows: [
        [{ id: 42, active: 1 }],
        [{ id: 1, is_active: true }],
        [{ id: 11, product_id: 1, is_active: true }],
        [],
        [{
        id: 100,
        vendor_id: 42,
        product_id: 1,
        product_variant_id: 11,
        unit_cost_cents: 1000,
        unit_cost_mills: 100000,
        pricing_basis: "legacy_unknown",
        pack_size: 6,
        moq: 1,
        lead_time_days: null,
        is_preferred: 0,
        is_active: 1,
        vendor_sku: null,
      }],
      ],
      updateReturns: [[{
        id: 100,
        productId: 1,
        productVariantId: 11,
        unitCostCents: 1299, // refreshed\n        packSize: 6,
        moq: 1,
        leadTimeDays: null,
        isPreferred: 0,
        vendorSku: null,
      }]],
    });
    const svc = createPurchasingService(db as any, buildMockStorage());
    const result = await svc.bulkUpsertVendorCatalog(42, [
      { productId: 1, productVariantId: 11, unitCostCents: 1299 },
    ], "u1");

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([
      { vendorProductId: 100, productId: 1, productVariantId: 11 },
    ]);
    expect(db._tx.update).toHaveBeenCalledTimes(1);
    expect(db._tx.insert).toHaveBeenCalledTimes(1); // durable audit
  });

  it("rolls back the whole batch when the transaction throws", async () => {
    const bang = new Error("db explode");
    const db = buildMockDb({ transactionThrows: bang });
    const svc = createPurchasingService(db as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(42, [
        { productId: 1, productVariantId: 11, unitCostCents: 1299 },
        { productId: 2, productVariantId: 21, unitCostCents: 1599 },
      ], "u1"),
    ).rejects.toThrow("db explode");
    // Nothing was logged/returned \u2014 the caller gets an error.
  });
});
