import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Dual-track PO lifecycle tests (migration 0565).
//
// Covers:
//   1.  transitionPhysical — valid transitions accepted
//   2.  transitionPhysical — invalid transitions rejected
//   3.  transitionFinancial — valid transitions accepted
//   4.  transitionFinancial — invalid transitions rejected
//   5.  recomputeFinancialAggregates — correctly sums invoices and payments
//   6.  recomputeFinancialAggregates — stays "disputed" if currently disputed
//   7.  recomputeFinancialAggregates — correctly derives financial_status values
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
        where: vi.fn().mockImplementation(() => {
          if (isPoStateQuery) return Promise.resolve(mockDb._poState ? [mockDb._poState] : []);
          if (isInvoiceQuery) return Promise.resolve(mockDb._invoiceRows);
          return Promise.resolve([]);
        }),
        limit: vi.fn().mockResolvedValue([]),
        orderBy: vi.fn().mockReturnThis(),
      };

      // Detect PO state query by inspecting shape (has financialStatus key)
      if (shape && "financialStatus" in shape) {
        isPoStateQuery = true;
        chain.where = vi.fn().mockResolvedValue(mockDb._poState ? [mockDb._poState] : []);
      }

      return chain;
    }),

    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((patch: any) => {
        mockDb._updateCalls.push(patch);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }),

    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

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

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("(1) accepts a valid physical transition: draft → sent", async () => {
    const po = makePo({ status: "approved", physicalStatus: "draft" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await svc.transitionPhysical(1, "sent", "user-1");

    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledOnce();
    const [, patch] = storage.updatePurchaseOrderStatusWithHistory.mock.calls[0];
    expect(patch.physicalStatus).toBe("sent");
    expect(patch.status).toBe("sent"); // legacy sync
  });

  it("(2) rejects an invalid physical transition: draft → received", async () => {
    const po = makePo({ physicalStatus: "draft" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await expect(
      svc.transitionPhysical(1, "received", "user-1"),
    ).rejects.toThrow(/Cannot transition physical status from 'draft' to 'received'/);
  });

  it("(2b) rejects a backward physical transition: acknowledged → sent", async () => {
    const po = makePo({ physicalStatus: "acknowledged" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await expect(
      svc.transitionPhysical(1, "sent", "user-1"),
    ).rejects.toThrow(/Cannot transition physical status/);
  });

  it("(11) legacy status is synced when transitioning to sent", async () => {
    const po = makePo({ status: "approved", physicalStatus: "draft" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await svc.transitionPhysical(1, "sent", "user-1");

    const [, patch] = storage.updatePurchaseOrderStatusWithHistory.mock.calls[0];
    expect(patch.status).toBe("sent");
  });

  it("(12) cancellation sets physicalStatus=cancelled", async () => {
    const po = makePo({ status: "sent", physicalStatus: "sent" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await svc.transitionPhysical(1, "cancelled", "user-1");

    const [, patch] = storage.updatePurchaseOrderStatusWithHistory.mock.calls[0];
    expect(patch.physicalStatus).toBe("cancelled");
    expect(patch.status).toBe("cancelled");
  });

  it("(13) rejects transition from terminal state: received → anything", async () => {
    const po = makePo({ physicalStatus: "received" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await expect(
      svc.transitionPhysical(1, "receiving", "user-1"),
    ).rejects.toThrow(/Cannot transition physical status from 'received'/);
  });
});

describe("transitionFinancial", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("(3) accepts valid financial transition: unbilled → invoiced", async () => {
    const po = makePo({ financialStatus: "unbilled" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await svc.transitionFinancial(1, "invoiced", "user-1");

    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledOnce();
    const [, patch] = storage.updatePurchaseOrderStatusWithHistory.mock.calls[0];
    expect(patch.financialStatus).toBe("invoiced");
  });

  it("(3b) accepts valid financial transition: invoiced → paid", async () => {
    const po = makePo({ financialStatus: "invoiced" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await svc.transitionFinancial(1, "paid", "user-1");

    const [, patch] = storage.updatePurchaseOrderStatusWithHistory.mock.calls[0];
    expect(patch.financialStatus).toBe("paid");
    expect(patch.fullyPaidAt).toBeInstanceOf(Date); // timestamp stamped
  });

  it("(3c) accepts disputed → paid", async () => {
    const po = makePo({ financialStatus: "disputed" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await svc.transitionFinancial(1, "paid", "user-1");

    const [, patch] = storage.updatePurchaseOrderStatusWithHistory.mock.calls[0];
    expect(patch.financialStatus).toBe("paid");
  });

  it("(4) rejects invalid financial transition: paid → invoiced", async () => {
    const po = makePo({ financialStatus: "paid" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await expect(
      svc.transitionFinancial(1, "invoiced", "user-1"),
    ).rejects.toThrow(/Cannot transition financial status from 'paid' to 'invoiced'/);
  });

  it("(14) rejects paid → unbilled (no backward transitions)", async () => {
    const po = makePo({ financialStatus: "paid" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    await expect(
      svc.transitionFinancial(1, "unbilled", "user-1"),
    ).rejects.toThrow(/Cannot transition financial status/);
  });
});

describe("recomputeFinancialAggregates", () => {
  let db: ReturnType<typeof buildMockDb>;
  let storage: ReturnType<typeof buildMockStorage>;
  let svc: ReturnType<typeof createPurchasingService>;

  beforeEach(() => {
    db = buildMockDb();
    storage = buildMockStorage();
    svc = createPurchasingService(db, storage);
  });

  it("(5) correctly sums invoiced and paid amounts from linked invoices", async () => {
    const po = makePo({ financialStatus: "unbilled" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    // Two invoices: one fully paid, one partially paid
    db._invoiceRows = [
      { invoicedAmountCents: 10000, paidAmountCents: 10000 },
      { invoicedAmountCents: 5000, paidAmountCents: 2500 },
    ];
    db._poState = { financialStatus: "unbilled", firstInvoicedAt: null, firstPaidAt: null, fullyPaidAt: null };

    await svc.recomputeFinancialAggregates(1);

    const updateCall = storage.updatePurchaseOrder.mock.calls[0][1];
    expect(updateCall.invoicedTotalCents).toBe(15000);
    expect(updateCall.paidTotalCents).toBe(12500);
    expect(updateCall.outstandingCents).toBe(2500);
    expect(updateCall.financialStatus).toBe("partially_paid");
  });

  it("(6) stays disputed if currently disputed", async () => {
    const po = makePo({ financialStatus: "disputed" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    db._invoiceRows = [
      { invoicedAmountCents: 5000, paidAmountCents: 0 },
    ];
    db._poState = { financialStatus: "disputed", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null };

    await svc.recomputeFinancialAggregates(1);

    const updateCall = storage.updatePurchaseOrder.mock.calls[0][1];
    expect(updateCall.financialStatus).toBe("disputed");
  });

  it("(7) derives unbilled when no invoices linked", async () => {
    const po = makePo({ financialStatus: "unbilled" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    db._invoiceRows = [];
    db._poState = { financialStatus: "unbilled", firstInvoicedAt: null, firstPaidAt: null, fullyPaidAt: null };

    await svc.recomputeFinancialAggregates(1);

    const updateCall = storage.updatePurchaseOrder.mock.calls[0][1];
    expect(updateCall.financialStatus).toBe("unbilled");
    expect(updateCall.invoicedTotalCents).toBe(0);
    expect(updateCall.outstandingCents).toBe(0);
  });

  it("(7b) derives paid when all invoices fully paid", async () => {
    const po = makePo({ financialStatus: "invoiced" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    db._invoiceRows = [
      { invoicedAmountCents: 8000, paidAmountCents: 8000 },
    ];
    db._poState = { financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null };

    await svc.recomputeFinancialAggregates(1);

    const updateCall = storage.updatePurchaseOrder.mock.calls[0][1];
    expect(updateCall.financialStatus).toBe("paid");
    expect(updateCall.fullyPaidAt).toBeInstanceOf(Date);
  });

  it("(7c) outstanding_cents is always non-negative", async () => {
    const po = makePo({ financialStatus: "invoiced" });
    storage.getPurchaseOrderById.mockResolvedValue(po);

    // Overpayment edge case (shouldn't happen but must not go negative)
    db._invoiceRows = [
      { invoicedAmountCents: 1000, paidAmountCents: 1500 },
    ];
    db._poState = { financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null };

    await svc.recomputeFinancialAggregates(1);

    const updateCall = storage.updatePurchaseOrder.mock.calls[0][1];
    expect(updateCall.outstandingCents).toBe(0); // clamped to 0
  });
});

describe("onReceivingOrderClosed — auto-match", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
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

    const receivingLines = [{ receivingLineId: 201, receivedQty: 3, purchaseOrderLineId: undefined }];
    await svc.onReceivingOrderClosed(99, receivingLines);

    // After auto-match, the reconciliation loop should update the PO line with receivedQty.
    // recalculateTotals may also call updatePurchaseOrderLine; we check that at least
    // ONE call contained receivedQty (the reconciliation update).
    const callsWithReceivedQty = storage.updatePurchaseOrderLine.mock.calls.filter(
      (c: any[]) => c[0] === 100 && "receivedQty" in c[1],
    );
    expect(callsWithReceivedQty.length).toBeGreaterThan(0);
    expect(callsWithReceivedQty[0][1].receivedQty).toBeGreaterThan(0);
  });

  it("(9) leaves unlinked when no open PO lines match the product_id", async () => {
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
    await svc.onReceivingOrderClosed(99, receivingLines);

    // No auto-match: updatePurchaseOrderLine should NOT have been called with receivedQty
    const callsWithReceivedQty = storage.updatePurchaseOrderLine.mock.calls.filter(
      (c: any[]) => "receivedQty" in c[1],
    );
    expect(callsWithReceivedQty.length).toBe(0);
  });

  it("(10) leaves unlinked when multiple open PO lines match product_id (ambiguous)", async () => {
    const productId = 42;
    const line1 = { id: 100, purchaseOrderId: 1, productId, lineType: "product", status: "open", orderQty: 5, receivedQty: 0, cancelledQty: 0, unitCostCents: 500, discountPercent: 0, taxRatePercent: 0, lineTotalCents: 2500 };
    const line2 = { id: 101, purchaseOrderId: 1, productId, lineType: "product", status: "open", orderQty: 5, receivedQty: 0, cancelledQty: 0, unitCostCents: 500, discountPercent: 0, taxRatePercent: 0, lineTotalCents: 2500 };

    storage.getReceivingOrderById.mockResolvedValue({ id: 99, purchaseOrderId: 1 });
    storage.getPurchaseOrderById.mockResolvedValue(makePo({ id: 1, status: "sent" }));
    storage.getPurchaseOrderLines.mockResolvedValue([line1, line2]);
    storage.getReceivingLineById.mockResolvedValue({ id: 201, productId, productVariantId: 5 });

    const receivingLines = [{ receivingLineId: 201, receivedQty: 3, purchaseOrderLineId: undefined }];
    await svc.onReceivingOrderClosed(99, receivingLines);

    // Ambiguous — no receivedQty updates should have happened
    const callsWithReceivedQty = storage.updatePurchaseOrderLine.mock.calls.filter(
      (c: any[]) => "receivedQty" in c[1],
    );
    expect(callsWithReceivedQty.length).toBe(0);
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
