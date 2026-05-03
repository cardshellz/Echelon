import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for PR 2 — 3-way match gate at PO close.
//
// Covers:
//   1. close() succeeds when no invoices are linked to the PO.
//   2. close() succeeds when linked invoices have all lines 'matched'.
//   3. close() succeeds when linked invoices have lines 'pending' (pending
//      = not yet evaluated, not a mismatch).
//   4. close() throws 409 when any linked invoice line has a mismatch status
//      (e.g. qty_mismatch, cost_mismatch).
//   5. close() calls detectMatchMismatch() on each linked invoice before
//      throwing, so exceptions are freshly raised on the PO.
//   6. closeShort() still works regardless of match status (no gate).
// ─────────────────────────────────────────────────────────────────────────────

// Mock detectMatchMismatch from po-exceptions.service
const mockDetectMatchMismatch = vi.fn().mockResolvedValue(undefined);
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: (...args: any[]) => mockDetectMatchMismatch(...args),
}));

// Data queues: the first db.select() call returns poLinks data, the second
// returns all invoice lines. We then simulate the SQL NOT IN filter
// ('matched','pending') inside the mock's where.
let allPoLinks: any[] = [];
let allInvoiceLines: any[] = [];
let selectCallCount = 0;

function buildMockDb() {
  selectCallCount = 0;
  const chain: any = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(async () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // First query: vendor_invoice_po_links for this PO
        return allPoLinks;
      }
      // Second query: vendor_invoice_lines with match_status NOT IN ('matched','pending')
      // Simulate the SQL filter since the real code uses raw sql`` for this.
      return allInvoiceLines.filter(
        (l) => l.matchStatus !== "matched" && l.matchStatus !== "pending"
      );
    }),
  };
  return {
    select: vi.fn(() => chain),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
    transaction: vi.fn(async (fn: any) => fn(buildMockDb())),
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
    updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 1, status: "closed" }),
    deletePurchaseOrder: vi.fn(),
    generatePoNumber: vi.fn(),
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
    getPreferredVendorProduct: vi.fn(),
    getVendorById: vi.fn(),
    getProductVariantById: vi.fn(),
    getProductById: vi.fn(),
    createReceivingOrder: vi.fn(),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    ...overrides,
  } as any;
}

describe("PR 2 — 3-way match gate at PO close", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;
  let mockDb: ReturnType<typeof buildMockDb>;

  const poReceived = { id: 1, status: "received", poNumber: "PO-001" };

  beforeEach(() => {
    allPoLinks = [];
    allInvoiceLines = [];
    mockDetectMatchMismatch.mockClear();
    mockDetectMatchMismatch.mockResolvedValue(undefined);
    storage = buildMockStorage();
    mockDb = buildMockDb();
    svc = createPurchasingService(mockDb, storage);
  });

  it("closes cleanly when no invoices are linked to the PO", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [];

    const result = await svc.close(1, "user-1", "all good");
    expect(result).toEqual({ id: 1, status: "closed" });
    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalled();
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });

  it("closes cleanly when linked invoices have all lines 'matched'", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "matched" },
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "matched" },
    ];

    const result = await svc.close(1, "user-1", "all matched");
    expect(result).toEqual({ id: 1, status: "closed" });
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });

  it("closes cleanly when linked invoices have lines 'pending'", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "pending" },
    ];

    const result = await svc.close(1, "user-1", "pending is ok");
    expect(result).toEqual({ id: 1, status: "closed" });
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });

  it("closes cleanly with mixed 'matched' and 'pending' lines", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "matched" },
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "pending" },
    ];

    const result = await svc.close(1, "user-1", "mixed ok");
    expect(result).toEqual({ id: 1, status: "closed" });
  });

  it("throws 409 when invoice line has qty_mismatch", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_mismatch" },
    ];

    await expect(svc.close(1, "user-1")).rejects.toThrow(PurchasingError);
    await expect(svc.close(1, "user-1")).rejects.toThrow(/3-way match discrepancy/i);
  });

  it("throws 409 with correct error message naming invoice and line count", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_mismatch" },
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "cost_mismatch" },
    ];

    try {
      await svc.close(1, "user-1");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PurchasingError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("INV-001");
      expect(err.message).toContain("2 lines");
      expect(err.message).toContain("close-short");
    }
  });

  it("names multiple invoices in the error message", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }, { vendorInvoiceId: 11 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_mismatch" },
      { invoiceId: 11, invoiceNumber: "INV-002", matchStatus: "cost_mismatch" },
    ];

    try {
      await svc.close(1, "user-1");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PurchasingError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("INV-001");
      expect(err.message).toContain("INV-002");
      expect(err.message).toContain("Invoices"); // plural
    }
  });

  it("calls detectMatchMismatch on each linked invoice before throwing", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }, { vendorInvoiceId: 11 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_mismatch" },
    ];

    try {
      await svc.close(1, "user-1");
      expect.unreachable("should have thrown");
    } catch {
      // expected
    }

    // detectMatchMismatch should be called once per unique invoice
    expect(mockDetectMatchMismatch).toHaveBeenCalledTimes(2);
    expect(mockDetectMatchMismatch).toHaveBeenCalledWith(10);
    expect(mockDetectMatchMismatch).toHaveBeenCalledWith(11);
  });

  it("does not call detectMatchMismatch when no mismatches found", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "matched" },
    ];

    await svc.close(1, "user-1", "ok");
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });

  it("closeShort still works regardless of match status (no gate)", async () => {
    storage.getPurchaseOrderById.mockResolvedValue({ id: 1, status: "partially_received" });
    storage.getPurchaseOrderLines.mockResolvedValue([
      { id: 100, status: "open", orderQty: 10, receivedQty: 5, cancelledQty: 0 },
    ]);

    const result = await svc.closeShort(1, "vendor short-shipped", "user-1");
    expect(result).toEqual({ id: 1, status: "closed" });
    // closeShort does not check 3-way match — no db.select calls for poLinks
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });
});
