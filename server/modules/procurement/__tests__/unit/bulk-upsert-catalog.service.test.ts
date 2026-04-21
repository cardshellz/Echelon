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
  existingRowsPerEntry?: any[][];
  insertReturns?: any[][];
  updateReturns?: any[][];
  transactionThrows?: Error;
} = {}) {
  const existingQueue = [...(options.existingRowsPerEntry ?? [])];
  const insertQueue = [...(options.insertReturns ?? [])];
  const updateQueue = [...(options.updateReturns ?? [])];

  const tx = {
    select: vi.fn(() => buildSelectChain(existingQueue.shift() ?? [])),
    insert: vi.fn(() => buildInsertChain(insertQueue.shift() ?? [])),
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
    ).rejects.toThrow(/vendorId is required/);
  });

  it("rejects float unitCostCents (Rule #3 guard)", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [
        { productId: 1, unitCostCents: 10.5 },
      ], "u1"),
    ).rejects.toThrow(/non-negative integer/);
  });

  it("rejects negative unitCostCents", async () => {
    const svc = createPurchasingService(buildMockDb() as any, buildMockStorage());
    await expect(
      svc.bulkUpsertVendorCatalog(1, [
        { productId: 1, unitCostCents: -1 },
      ], "u1"),
    ).rejects.toThrow(/non-negative integer/);
  });

  it("404s when vendor missing", async () => {
    const storage = buildMockStorage({ getVendorById: vi.fn().mockResolvedValue(null) });
    const svc = createPurchasingService(buildMockDb() as any, storage);
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
    ).rejects.toThrow(/productId must be a positive integer/);
  });
});

describe("Spec A follow-up \u2014 bulkUpsertVendorCatalog flow", () => {
  it("inserts a new row when none exists and skips the update path", async () => {
    const db = buildMockDb({
      existingRowsPerEntry: [[]], // one entry, no existing row
      insertReturns: [[{
        id: 100,
        productId: 1,
        productVariantId: 11,
        unitCostCents: 1299,
        packSize: 12,
        moq: 1,
        leadTimeDays: null,
        isPreferred: 0,
        vendorSku: null,
      }]],
    });
    const svc = createPurchasingService(db as any, buildMockStorage());
    const result = await svc.bulkUpsertVendorCatalog(42, [
      { productId: 1, productVariantId: 11, unitCostCents: 1299, packSize: 12 },
    ], "u1");

    expect(result.created).toEqual([
      { vendorProductId: 100, productId: 1, productVariantId: 11 },
    ]);
    expect(result.updated).toEqual([]);
    expect(db._tx.insert).toHaveBeenCalledTimes(1);
    expect(db._tx.update).not.toHaveBeenCalled();
  });

  it("updates an existing row (idempotent replay) instead of inserting duplicate", async () => {
    const db = buildMockDb({
      existingRowsPerEntry: [[{
        id: 100,
        vendorId: 42,
        productId: 1,
        productVariantId: 11,
        unitCostCents: 1000,
        packSize: 6,
        moq: 1,
        leadTimeDays: null,
        isPreferred: 0,
        vendorSku: null,
      }]],
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
    expect(db._tx.insert).not.toHaveBeenCalled();
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
