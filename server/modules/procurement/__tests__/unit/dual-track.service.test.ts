import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDetectQtyVariance = vi.hoisted(() => vi.fn());
const mockRecomputePoFinancialAggregates = vi.hoisted(() => vi.fn());

vi.mock("../../po-exceptions.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../po-exceptions.service")>();
  return {
    ...actual,
    detectQtyVariance: (...args: any[]) => mockDetectQtyVariance(...args),
  };
});

vi.mock("../../ap-ledger.service", () => ({
  recomputePoFinancialAggregates: (...args: any[]) => mockRecomputePoFinancialAggregates(...args),
}));

import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Dual-track PO lifecycle tests (migration 0565).
//
// Covers:
//   1.  transitionPhysical — valid transitions accepted
//   2.  transitionPhysical — invalid transitions rejected
//   3.  transitionFinancial — valid transitions accepted
//   4.  transitionFinancial — invalid transitions rejected
//   5.  recomputeFinancialAggregates — delegates to the AP-owned audited writer
//   8.  onReceivingOrderClosed — auto-match by product_id when single open line
//   9.  onReceivingOrderClosed — leaves unlinked when zero matching lines
//   10. onReceivingOrderClosed — leaves unlinked when multiple open lines (ambiguous)
//   11. Legacy status field stays in sync when transitionPhysical fires (sent)
//   12. Cancellation via transitionPhysical sets physicalStatus=cancelled
//   13. transitionPhysical rejects transition from terminal state (received→*)
//   14. transitionFinancial rejects paid → invoiced (no backward)
//   15. findOpenPoLineByProduct — returns null when no remaining qty
//
// All tests run against in-memory mocks. No DB I/O.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Mock builders ───────────────────────────────────────────────────────────

function buildMockDb() {
  // Minimal db mock used by recomputeFinancialAggregates (which does direct
  // DB queries via the `db` param). We need to mock:
  //   db.select().from(...).innerJoin(...).where(...)    → invoice rows
  //   db.select({...}).from(...).where(...)              → PO state row
  //   db.update(...).set(...).where(...)                  → void
  //
  // The mock uses a registry pattern: callers can set up what each query
  // returns. For our tests we configure it at the test level.

  const mockDb: any = {
    _invoiceRows: [] as Array<{ invoicedAmountCents: number; paidAmountCents: number }>,
    _poState: null as any,
    _updateCalls: [] as any[],
    _insertRows: [] as any[],

    select: vi.fn().mockImplementation((shape?: any) => {
      // Returns a chainable builder that resolves based on what's queued.
      let isPoStateQuery = false;
      let isInvoiceQuery = false;

      const chain: any = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockImplementation(() => {
          isInvoiceQuery = true;
          return chain;
        }),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        for: vi.fn().mockImplementation(async () => {
          if (isPoStateQuery) return mockDb._poState ? [mockDb._poState] : [];
          if (isInvoiceQuery) return mockDb._invoiceRows;
          return [];
        }),
        then: (resolve: any, reject: any) => {
          const rows = isPoStateQuery
            ? (mockDb._poState ? [mockDb._poState] : [])
            : isInvoiceQuery
              ? mockDb._invoiceRows
              : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };

      // Detect PO state query by inspecting shape (has financialStatus key)
      if (shape && "financialStatus" in shape) {
        isPoStateQuery = true;
      }

      return chain;
    }),

    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((patch: any) => {
        mockDb._updateCalls.push(patch);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 1, ...patch }]),
          }),
        };
      }),
    }),

    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: any) => {
        mockDb._insertRows.push(row);
        return {
          returning: vi.fn().mockResolvedValue([]),
        };
      }),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  mockDb.transaction = vi.fn(async (fn: any) => fn(mockDb));

  return mockDb;
}

function buildMockStorage(overrides: Partial<Record<string, any>> = {}) {
  return {
    getPurchaseOrders: vi.fn(),
    getPurchaseOrdersCount: vi.fn(),
    getPurchaseOrderById: vi.fn(),
    getPurchaseOrderByPoNumber: vi.fn(),
    createPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn().mockResolvedValue({}),
    updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({}),
    deletePurchaseOrder: vi.fn(),
    generatePoNumber: vi.fn().mockResolvedValue("PO-TEST-001"),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
    getPurchaseOrderLineById: vi.fn(),
    createPurchaseOrderLine: vi.fn(),
    bulkCreatePurchaseOrderLines: vi.fn(),
    updatePurchaseOrderLine: vi.fn().mockResolvedValue({}),
    deletePurchaseOrderLine: vi.fn(),
    getOpenPoLinesForVariant: vi.fn(),
    createPoStatusHistory: vi.fn(),
    getPoStatusHistory: vi.fn(),
    createPoRevision: vi.fn(),
    getPoRevisions: vi.fn(),
    createPoReceipt: vi.fn().mockResolvedValue({}),
    getPoReceipts: vi.fn(),
    getPoReceiptsByLine: vi.fn().mockResolvedValue([]),
    reconcilePoReceiptLine: vi.fn().mockImplementation(async (input: any) => ({
      applied: true,
      purchaseOrderLine: { id: input.purchaseOrderLineId, ...input.lineUpdates },
      receipt: input.receipt,
    })),
    getAllPoApprovalTiers: vi.fn().mockResolvedValue([]),
    getPoApprovalTierById: vi.fn(),
    getMatchingApprovalTier: vi.fn().mockResolvedValue(null),
    getVendorProducts: vi.fn(),
    getVendorProductById: vi.fn(),
    getPreferredVendorProduct: vi.fn().mockResolvedValue(null),
    getVendorById: vi.fn(),
    getProductVariantById: vi.fn(),
    getProductById: vi.fn(),
    createReceivingOrder: vi.fn(),
    getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([]),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getReceivingLineById: vi.fn(),
    getReceivingOrderById: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

/** Build a minimal PO object for mock returns. */
function makePo(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: 1,
    poNumber: "PO-TEST-001",
    status: "draft",
    physicalStatus: "draft",
    financialStatus: "unbilled",
    firstInvoicedAt: null,
    firstPaidAt: null,
    fullyPaidAt: null,
    cancelledAt: null,
    cancelledBy: null,
    closedAt: null,
    closedBy: null,
    sentToVendorAt: null,
    firstShippedAt: null,
    firstArrivedAt: null,
    actualDeliveryDate: null,
    invoicedTotalCents: 0,
    paidTotalCents: 0,
    outstandingCents: 0,
    ...overrides,
  };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe("transitionPhysical", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;
  let mockDb: ReturnType<typeof buildMockDb>;

  beforeEach(() => {
    storage = buildMockStorage();
    mockDb = buildMockDb();
    svc = createPurchasingService(mockDb, storage);
  });

  it("(1) accepts a valid physical transition: draft → sent", async () => {
    const po = makePo({ status: "approved", physicalStatus: "draft" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await svc.transitionPhysical(1, "sent", "user-1");

    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalledOnce();
    const patch = mockDb._updateCalls[0];
    expect(patch.physicalStatus).toBe("sent");
    expect(patch.status).toBe("sent"); // legacy sync
  });

  it("(2) rejects an invalid physical transition: draft → received", async () => {
    const po = makePo({ physicalStatus: "draft" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await expect(
      svc.transitionPhysical(1, "received", "user-1"),
    ).rejects.toThrow(/Cannot transition physical status from 'draft' to 'received'/);
  });

  it("(2b) rejects a backward physical transition: acknowledged → sent", async () => {
    const po = makePo({ physicalStatus: "acknowledged" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await expect(
      svc.transitionPhysical(1, "sent", "user-1"),
    ).rejects.toThrow(/Cannot transition physical status/);
  });

  it("(11) legacy status is synced when transitioning to sent", async () => {
    const po = makePo({ status: "approved", physicalStatus: "draft" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await svc.transitionPhysical(1, "sent", "user-1");

    const patch = mockDb._updateCalls[0];
    expect(patch.status).toBe("sent");
  });

  it("(12) cancellation sets physicalStatus=cancelled", async () => {
    const po = makePo({ status: "sent", physicalStatus: "sent" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await svc.transitionPhysical(1, "cancelled", "user-1");

    const patch = mockDb._updateCalls[0];
    expect(patch.physicalStatus).toBe("cancelled");
    expect(patch.status).toBe("cancelled");
  });

  it("(13) rejects transition from terminal state: received → anything", async () => {
    const po = makePo({ physicalStatus: "received" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await expect(
      svc.transitionPhysical(1, "receiving", "user-1"),
    ).rejects.toThrow(/Cannot transition physical status from 'received'/);
  });
});

describe("transitionFinancial", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;
  let mockDb: ReturnType<typeof buildMockDb>;

  beforeEach(() => {
    mockDetectQtyVariance.mockReset();
    storage = buildMockStorage();
    mockDb = buildMockDb();
    svc = createPurchasingService(mockDb, storage);
  });

  it("(3) accepts valid financial transition: unbilled → invoiced", async () => {
    const po = makePo({ financialStatus: "unbilled" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await svc.transitionFinancial(1, "invoiced", "user-1");

    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    const patch = mockDb._updateCalls[0];
    expect(patch.financialStatus).toBe("invoiced");
  });

  it("(3b) accepts valid financial transition: invoiced → paid", async () => {
    const po = makePo({ financialStatus: "invoiced" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await svc.transitionFinancial(1, "paid", "user-1");

    const patch = mockDb._updateCalls[0];
    expect(patch.financialStatus).toBe("paid");
    expect(patch.fullyPaidAt).toBeInstanceOf(Date); // timestamp stamped
  });

  it("(3c) accepts disputed → paid", async () => {
    const po = makePo({ financialStatus: "disputed" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await svc.transitionFinancial(1, "paid", "user-1");

    const patch = mockDb._updateCalls[0];
    expect(patch.financialStatus).toBe("paid");
  });

  it("(4) rejects invalid financial transition: paid → invoiced", async () => {
    const po = makePo({ financialStatus: "paid" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await expect(
      svc.transitionFinancial(1, "invoiced", "user-1"),
    ).rejects.toThrow(/Cannot transition financial status from 'paid' to 'invoiced'/);
  });

  it("(14) rejects paid → unbilled (no backward transitions)", async () => {
    const po = makePo({ financialStatus: "paid" });
    storage.getPurchaseOrderById.mockResolvedValue(po);
    mockDb._poState = po;

    await expect(
      svc.transitionFinancial(1, "unbilled", "user-1"),
    ).rejects.toThrow(/Cannot transition financial status/);
  });
});

describe("createReceiptFromPO — receipt idempotency", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;
  let mockDb: ReturnType<typeof buildMockDb>;

  beforeEach(() => {
    storage = buildMockStorage();
    mockDb = buildMockDb();
    svc = createPurchasingService(mockDb, storage);
  });

  it("returns an active existing receipt instead of creating a duplicate", async () => {
    const existingReceipt = {
      id: 77,
      receiptNumber: "RCV-TEST-077",
      purchaseOrderId: 1,
      status: "open",
    };

    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getReceivingOrdersForPurchaseOrder.mockResolvedValue([existingReceipt]);

    const result = await svc.createReceiptFromPO(1, "user-1");

    expect(result).toMatchObject({
      id: 77,
      receiptNumber: "RCV-TEST-077",
      reusedExisting: true,
    });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
    expect(storage.getReceivingOrdersForPurchaseOrder).toHaveBeenCalledWith(1, mockDb);
  });

  it("serializes receipt creation with a PO-scoped advisory transaction lock", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getReceivingOrdersForPurchaseOrder.mockResolvedValue([]);
    storage.getPurchaseOrderLines.mockResolvedValue([
      {
        id: 100,
        productVariantId: 5,
        productId: 50,
        sku: "SKU-5",
        productName: "Variant 5",
        orderQty: 10,
        receivedQty: 0,
        cancelledQty: 0,
        unitsPerUom: 1,
        status: "open",
        lineType: "product",
      },
    ]);
    storage.generateReceiptNumber.mockResolvedValue("RCV-TEST-001");
    storage.createReceivingOrder.mockResolvedValue({
      id: 88,
      receiptNumber: "RCV-TEST-001",
      purchaseOrderId: 1,
      status: "draft",
    });

    const result = await svc.createReceiptFromPO(1, "user-1");

    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect((mockDb.execute as any).mock.invocationCallOrder[0]).toBeLessThan(
      (storage.createReceivingOrder as any).mock.invocationCallOrder[0],
    );
    expect(storage.createReceivingOrder).toHaveBeenCalledWith(expect.any(Object), mockDb);
    expect(storage.bulkCreateReceivingLines).toHaveBeenCalledWith(expect.any(Array), mockDb);
    expect(result).toMatchObject({
      id: 88,
      receiptNumber: "RCV-TEST-001",
    });
  });

  it("re-checks and reuses an active receipt after a create race unique conflict", async () => {
    const existingReceipt = {
      id: 89,
      receiptNumber: "RCV-TEST-089",
      purchaseOrderId: 1,
      status: "draft",
    };

    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getReceivingOrdersForPurchaseOrder
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existingReceipt]);
    storage.getPurchaseOrderLines.mockResolvedValue([
      {
        id: 100,
        productVariantId: 5,
        productId: 50,
        sku: "SKU-5",
        productName: "Variant 5",
        orderQty: 10,
        receivedQty: 0,
        cancelledQty: 0,
        unitsPerUom: 1,
        status: "open",
        lineType: "product",
      },
    ]);
    storage.generateReceiptNumber.mockResolvedValue("RCV-TEST-001");
    storage.createReceivingOrder.mockRejectedValue({ code: "23505" });

    const result = await svc.createReceiptFromPO(1, "user-1");

    expect(result).toMatchObject({
      id: 89,
      receiptNumber: "RCV-TEST-089",
      reusedExisting: true,
    });
    expect(storage.createReceivingOrder).toHaveBeenCalledOnce();
    expect(storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
  });
});

describe("createReceiptFromPO — expected-qty pack conversion (RCV-20260710-003)", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;
  let mockDb: ReturnType<typeof buildMockDb>;

  beforeEach(() => {
    storage = buildMockStorage();
    mockDb = buildMockDb();
    svc = createPurchasingService(mockDb, storage);
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getReceivingOrdersForPurchaseOrder.mockResolvedValue([]);
    storage.generateReceiptNumber.mockResolvedValue("RCV-TEST-CASE");
    storage.createReceivingOrder.mockResolvedValue({
      id: 90, receiptNumber: "RCV-TEST-CASE", purchaseOrderId: 1, status: "draft",
    });
  });

  it("divides ordered pieces by the STAMPED variant's unitsPerVariant even when the PO UOM field is unset", async () => {
    // The bug: line stamps the Case-of-750 variant but expectedReceiveUnitsPerVariant
    // is null, so packSize fell back to unitsPerUom (1) → 269640 pieces shown as
    // "269640 cases" instead of ceil(269640/750) = 360.
    storage.getPurchaseOrderLines.mockResolvedValue([
      {
        id: 100,
        expectedReceiveVariantId: 42,          // "Case of 750" variant
        productVariantId: 7,                    // base/piece variant
        productId: 50,
        sku: "ARM-ENV-SGL-C750",
        productName: "Armalope Envelope Single Pocket",
        orderQty: 269640,                       // ordered pieces
        receivedQty: 0,
        cancelledQty: 0,
        expectedReceiveUnitsPerVariant: null,   // ← the drifted/unset pair field
        unitsPerUom: 1,
        status: "open",
        lineType: "product",
      },
    ]);
    storage.getProductVariantById.mockImplementation(async (id: number) =>
      id === 42 ? { id: 42, unitsPerVariant: 750 } : { id, unitsPerVariant: 1 },
    );

    await svc.createReceiptFromPO(1, "user-1");

    const lines = (storage.bulkCreateReceivingLines as any).mock.calls[0][0];
    expect(lines).toHaveLength(1);
    expect(lines[0].productVariantId).toBe(42);
    expect(lines[0].expectedQty).toBe(360); // ceil(269640 / 750), NOT 269640
  });

  it("falls back to the PO UOM field when the variant cannot be resolved", async () => {
    storage.getPurchaseOrderLines.mockResolvedValue([
      {
        id: 101,
        expectedReceiveVariantId: 99,
        productId: 51,
        sku: "SKU-NOVAR",
        productName: "No Variant",
        orderQty: 1000,
        receivedQty: 0,
        cancelledQty: 0,
        expectedReceiveUnitsPerVariant: 10,
        unitsPerUom: 1,
        status: "open",
        lineType: "product",
      },
    ]);
    storage.getProductVariantById.mockResolvedValue(null); // unresolvable

    await svc.createReceiptFromPO(1, "user-1");

    const lines = (storage.bulkCreateReceivingLines as any).mock.calls[0][0];
    expect(lines[0].expectedQty).toBe(100); // ceil(1000 / 10) via PO UOM fallback
  });
});

describe("recomputeFinancialAggregates", () => {
  beforeEach(() => {
    mockRecomputePoFinancialAggregates.mockReset();
    mockRecomputePoFinancialAggregates.mockResolvedValue(undefined);
  });

  it("delegates compatibility calls to the AP-owned audited recompute", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage();
    const svc = createPurchasingService(db, storage);

    await svc.recomputeFinancialAggregates(1);

    expect(mockRecomputePoFinancialAggregates).toHaveBeenCalledWith(1, {
      reason: "Compatibility recompute requested through PurchasingService.",
    });
    expect(storage.updatePurchaseOrder).not.toHaveBeenCalled();
  });
});

describe("onReceivingOrderClosed — auto-match", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    mockDetectQtyVariance.mockReset();
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("(8) auto-matches unlinked receiving line to single open PO line by product_id", async () => {
    const productId = 42;
    const poLine = {
      id: 100,
      purchaseOrderId: 1,
      productId,
      lineType: "product",
      status: "open",
      orderQty: 10,
      receivedQty: 0,
      cancelledQty: 0,
      unitCostCents: 500,
      discountPercent: 0,
      taxRatePercent: 0,
      lineTotalCents: 5000,
      unitsPerUom: 1,
    };

    // Receiving order is PO-linked
    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    // PO exists
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent", physicalStatus: "sent" }));
    // PO lines: one open product line matching the product
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    // getPurchaseOrderLineById returns the same line (used in reconciliation loop)
    storage.getPurchaseOrderLineById.mockResolvedValue(poLine);
    // Receiving line has no purchaseOrderLineId, has productVariantId
    storage.getReceivingLineById.mockResolvedValue({
      id: 201,
      productId,
      productVariantId: 5,
    });
    // Variant lookup for unit conversion
    storage.getProductVariantById.mockResolvedValue({ id: 5, productId, unitsPerVariant: 1 });

    const receivingLines = [{ receivingLineId: 201, receivedQty: 3, unitCost: 0, purchaseOrderLineId: undefined }];
    await svc.onReceivingOrderClosed(99, receivingLines);

    expect(storage.reconcilePoReceiptLine).toHaveBeenCalledOnce();
    expect(storage.reconcilePoReceiptLine).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseOrderLineId: 100,
        receivingLineId: 201,
        lineUpdates: expect.objectContaining({
          receivedQty: 3,
          status: "partially_received",
        }),
        receipt: expect.objectContaining({
          purchaseOrderId: 1,
          purchaseOrderLineId: 100,
          receivingOrderId: 99,
          receivingLineId: 201,
          qtyReceived: 3,
          actualUnitCostCents: 0,
          varianceCents: -500,
        }),
      }),
      expect.any(Object),
    );
    expect(receivingLines[0].purchaseOrderLineId).toBeUndefined();
  });

  it("keeps PO physical status aligned when a partial receipt reconciles", async () => {
    const productId = 42;
    const poLine = {
      id: 100,
      purchaseOrderId: 1,
      productId,
      productVariantId: 5,
      lineType: "product",
      status: "open",
      orderQty: 10,
      receivedQty: 0,
      cancelledQty: 0,
      unitCostCents: 500,
      unitsPerUom: 1,
    };

    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent", physicalStatus: "sent" }));
    storage.getPurchaseOrderLines
      .mockResolvedValueOnce([poLine])
      .mockResolvedValueOnce([{ ...poLine, status: "partially_received", receivedQty: 3 }]);
    storage.getPurchaseOrderLineById.mockResolvedValue(poLine);
    storage.getReceivingLineById.mockResolvedValue({
      id: 201,
      productId,
      productVariantId: 5,
    });
    storage.getProductVariantById.mockResolvedValue({ id: 5, productId, unitsPerVariant: 1 });

    const result = await svc.onReceivingOrderClosed(99, [
      { receivingLineId: 201, purchaseOrderLineId: 100, receivedQty: 3 },
    ]);

    expect(result.poStatusUpdate).toEqual({
      legacyStatus: "partially_received",
      physicalStatus: "receiving",
    });
    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: "partially_received",
        physicalStatus: "receiving",
      }),
      expect.objectContaining({
        fromStatus: "sent",
        toStatus: "partially_received",
      }),
      expect.any(Object),
    );
    expect(mockDetectQtyVariance).not.toHaveBeenCalled();
  });

  it("marks fully reconciled receipts as physically received and runs quantity variance detection", async () => {
    const productId = 42;
    const poLine = {
      id: 100,
      purchaseOrderId: 1,
      productId,
      productVariantId: 5,
      lineType: "product",
      status: "open",
      orderQty: 3,
      receivedQty: 0,
      cancelledQty: 0,
      unitCostCents: 500,
      unitsPerUom: 1,
    };

    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent", physicalStatus: "sent" }));
    storage.getPurchaseOrderLines
      .mockResolvedValueOnce([poLine])
      .mockResolvedValueOnce([{ ...poLine, status: "received", receivedQty: 3 }]);
    storage.getPurchaseOrderLineById.mockResolvedValue(poLine);
    storage.getReceivingLineById.mockResolvedValue({
      id: 201,
      productId,
      productVariantId: 5,
    });
    storage.getProductVariantById.mockResolvedValue({ id: 5, productId, unitsPerVariant: 1 });

    const result = await svc.onReceivingOrderClosed(99, [
      { receivingLineId: 201, purchaseOrderLineId: 100, receivedQty: 3 },
    ]);

    expect(result.poStatusUpdate).toEqual({
      legacyStatus: "received",
      physicalStatus: "received",
    });
    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: "received",
        physicalStatus: "received",
        actualDeliveryDate: expect.any(Date),
      }),
      expect.objectContaining({
        fromStatus: "sent",
        toStatus: "received",
      }),
      expect.any(Object),
    );
    expect(mockDetectQtyVariance).toHaveBeenCalledWith(1);
  });

  it("converts received configurations into PO piece quantities", async () => {
    const productId = 42;
    const poLine = {
      id: 100,
      purchaseOrderId: 1,
      productId,
      lineType: "product",
      status: "open",
      orderQty: 5000,
      receivedQty: 0,
      damagedQty: 0,
      cancelledQty: 0,
      unitCostCents: 500,
      discountPercent: 0,
      taxRatePercent: 0,
      lineTotalCents: 250000,
      expectedReceiveVariantId: 5,
      expectedReceiveUnitsPerVariant: 1000,
      unitsPerUom: 1000,
    };

    storage.getPurchaseOrderLineById.mockResolvedValue(poLine);
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent", physicalStatus: "sent" }));
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    storage.getReceivingLineById.mockResolvedValue({
      id: 201,
      productId,
      productVariantId: 5,
    });
    storage.getProductVariantById.mockResolvedValue({ id: 5, productId, unitsPerVariant: 1000 });

    await svc.onReceivingOrderClosed(99, [
      { receivingLineId: 201, purchaseOrderLineId: 100, receivedQty: 2, damagedQty: 1 },
    ]);

    const reconciliationCall = storage.reconcilePoReceiptLine.mock.calls.find(
      (c: any[]) => c[0]?.purchaseOrderLineId === 100,
    );
    expect(reconciliationCall?.[0]?.lineUpdates).toMatchObject({
      receivedQty: 2000,
      damagedQty: 1000,
      status: "partially_received",
    });
    expect(reconciliationCall?.[0]?.receipt).toMatchObject({
      purchaseOrderLineId: 100,
      receivingLineId: 201,
      qtyReceived: 2000,
    });
  });

  it("(9) rejects the reconciliation when no open PO line matches the product_id", async () => {
    const unrelatedPoLine = {
      id: 100,
      purchaseOrderId: 1,
      productId: 999, // different product
      lineType: "product",
      status: "open",
      orderQty: 10,
      receivedQty: 0,
      cancelledQty: 0,
      unitCostCents: 500,
      discountPercent: 0,
      taxRatePercent: 0,
      lineTotalCents: 5000,
    };

    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getPurchaseOrderLines.mockResolvedValue([unrelatedPoLine]);
    storage.getReceivingLineById.mockResolvedValue({ id: 201, productId: 42, productVariantId: 5 });

    const receivingLines = [{ receivingLineId: 201, receivedQty: 3, purchaseOrderLineId: undefined }];
    await expect(svc.onReceivingOrderClosed(99, receivingLines)).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ expectedReceiptLines: 1, reconciledLines: 0 }),
    });

    expect(storage.reconcilePoReceiptLine).not.toHaveBeenCalled();
  });

  it("(10) rejects the reconciliation when multiple PO lines make the match ambiguous", async () => {
    const productId = 42;
    const line1 = { id: 100, purchaseOrderId: 1, productId, lineType: "product", status: "open", orderQty: 5, receivedQty: 0, cancelledQty: 0, unitCostCents: 500, discountPercent: 0, taxRatePercent: 0, lineTotalCents: 2500 };
    const line2 = { id: 101, purchaseOrderId: 1, productId, lineType: "product", status: "open", orderQty: 5, receivedQty: 0, cancelledQty: 0, unitCostCents: 500, discountPercent: 0, taxRatePercent: 0, lineTotalCents: 2500 };

    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getPurchaseOrderLines.mockResolvedValue([line1, line2]);
    storage.getReceivingLineById.mockResolvedValue({ id: 201, productId, productVariantId: 5 });

    const receivingLines = [{ receivingLineId: 201, receivedQty: 3, purchaseOrderLineId: undefined }];
    await expect(svc.onReceivingOrderClosed(99, receivingLines)).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ expectedReceiptLines: 1, reconciledLines: 0 }),
    });

    expect(storage.reconcilePoReceiptLine).not.toHaveBeenCalled();
  });

  it("skips a receiving line that already has a PO receipt record", async () => {
    const productId = 42;
    const poLine = {
      id: 100,
      purchaseOrderId: 1,
      productId,
      productVariantId: 5,
      lineType: "product",
      status: "open",
      orderQty: 10,
      receivedQty: 0,
      cancelledQty: 0,
      unitCostCents: 500,
      discountPercent: 0,
      taxRatePercent: 0,
      lineTotalCents: 5000,
      unitsPerUom: 1,
    };

    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    storage.getPurchaseOrderLineById.mockResolvedValue(poLine);
    storage.getReceivingLineById.mockResolvedValue({
      id: 201,
      productId,
      productVariantId: 5,
    });
    storage.getProductVariantById.mockResolvedValue({ id: 5, productId, unitsPerVariant: 1 });
    storage.reconcilePoReceiptLine.mockResolvedValue({
      applied: false,
      receipt: { receivingLineId: 201 },
    });

    await svc.onReceivingOrderClosed(99, [
      { receivingLineId: 201, purchaseOrderLineId: 100, receivedQty: 3 },
    ]);

    expect(storage.reconcilePoReceiptLine).toHaveBeenCalledOnce();
    expect(storage.createPoReceipt).not.toHaveBeenCalled();
  });
});

describe("findOpenPoLineByProduct", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("(15) returns null for a line with no remaining qty", async () => {
    storage.getPurchaseOrderLines.mockResolvedValue([
      {
        id: 100,
        productId: 42,
        lineType: "product",
        status: "open",
        orderQty: 5,
        receivedQty: 5,   // fully received
        cancelledQty: 0,
      },
    ]);

    const result = await svc.findOpenPoLineByProduct(1, 42);
    expect(result).toBeNull();
  });
});
