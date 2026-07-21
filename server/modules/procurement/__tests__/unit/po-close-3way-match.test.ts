import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  purchaseOrderLines,
  purchaseOrders,
  poExceptions,
  vendorInvoiceLines,
  vendorInvoicePoLinks,
  vendorInvoices,
} from "@shared/schema";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for PR 2 — 3-way match gate at PO close.
//
// Covers:
//   1. close() succeeds when no invoices are linked to the PO.
//   2. close() succeeds when linked invoices have all lines 'matched'.
//   3. close() throws 409 while any linked invoice line remains 'pending'.
//   4. close() throws 409 when any linked invoice line has a mismatch status
//      (e.g. qty_discrepancy, price_discrepancy).
//   5. close() calls detectMatchMismatch() on each blocked invoice after
//      throwing, so exceptions are freshly raised on the PO.
//   6. closeShort() still works regardless of match status (no gate).
// ─────────────────────────────────────────────────────────────────────────────

// Mock detectMatchMismatch from po-exceptions.service
const mockDetectMatchMismatch = vi.fn().mockResolvedValue(undefined);
const mockRecomputePurchaseOrderInvoiceMatches = vi.fn();
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: (...args: any[]) => mockDetectMatchMismatch(...args),
}));
vi.mock("../../ap-ledger.service", () => ({
  recomputePoFinancialAggregates: vi.fn(),
  recomputePurchaseOrderInvoiceMatchesInTransaction: (...args: any[]) =>
    mockRecomputePurchaseOrderInvoiceMatches(...args),
}));

let allPoLinks: any[] = [];
let allInvoiceLines: any[] = [];
let resolvedMatchExceptions: any[] = [];
let lockedPo: any;

function buildMockDb() {
  const insertedRows: any[] = [];
  const updateCalls: Array<{ table: unknown; patch: any }> = [];
  const lockCalls: Array<{ table: unknown; mode: string }> = [];
  const rowsFor = (table: unknown): any[] => {
    if (table === purchaseOrders) return [lockedPo];
    if (table === vendorInvoicePoLinks) return allPoLinks;
    if (table === vendorInvoiceLines) {
      return allInvoiceLines.filter((line) => line.matchStatus !== "matched");
    }
    if (table === vendorInvoices) {
      return [...new Map(allInvoiceLines.map((line) => [
        line.invoiceId,
        { id: line.invoiceId, invoiceNumber: line.invoiceNumber },
      ])).values()];
    }
    if (table === purchaseOrderLines) return [];
    if (table === poExceptions) return resolvedMatchExceptions;
    return [];
  };
  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      const chain: any = {
        from: vi.fn((value: unknown) => {
          table = value;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        for: vi.fn(async (mode: string) => {
          lockCalls.push({ table, mode });
          return rowsFor(table);
        }),
        then: (resolve: any, reject: any) => Promise.resolve(rowsFor(table)).then(resolve, reject),
      };
      return chain;
    }),
    insertedRows,
    updateCalls,
    lockCalls,
    insert: vi.fn().mockReturnValue({
      values: vi.fn((row: any) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    }),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: any) => {
        updateCalls.push({ table, patch });
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ ...lockedPo, ...patch }]),
          })),
        };
      }),
    })),
  };
  const db: any = {
    ...tx,
    transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return db;
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
    resolvedMatchExceptions = [];
    lockedPo = poReceived;
    mockDetectMatchMismatch.mockClear();
    mockDetectMatchMismatch.mockResolvedValue(undefined);
    mockRecomputePurchaseOrderInvoiceMatches.mockReset();
    mockRecomputePurchaseOrderInvoiceMatches.mockImplementation(async () => {
      const activeInvoiceIds = [...new Set(
        allPoLinks.map((link) => Number(link.vendorInvoiceId)),
      )].sort((left, right) => left - right);
      return {
        purchaseOrderId: 1,
        purchaseOrderLineIds: [...new Set(
          allInvoiceLines.map((line, index) => Number(line.purchaseOrderLineId ?? index + 100)),
        )],
        activeInvoiceIds,
        invoiceNumbersById: new Map(allInvoiceLines.map((line) => [
          Number(line.invoiceId),
          String(line.invoiceNumber),
        ])),
        sourceFingerprint: "current-match-source-fingerprint",
        results: allInvoiceLines.map((line, index) => ({
          id: Number(line.id ?? index + 1),
          vendorInvoiceId: Number(line.invoiceId),
          purchaseOrderLineId: Number(line.purchaseOrderLineId ?? index + 100),
          qtyReceived: Number(line.qtyReceived ?? 0),
          matchStatus: line.matchStatus,
        })),
        invoicesWithoutMappedLines: activeInvoiceIds.filter((invoiceId) =>
          !allInvoiceLines.some((line) => Number(line.invoiceId) === invoiceId),
        ),
      };
    });
    storage = buildMockStorage();
    mockDb = buildMockDb();
    svc = createPurchasingService(mockDb, storage);
  });

  it("closes cleanly when no invoices are linked to the PO", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [];

    const result = await svc.close(1, "user-1", "all good");
    expect(result).toMatchObject({ id: 1, status: "closed" });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.lockCalls).toContainEqual({ table: purchaseOrders, mode: "update" });
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
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
    expect(result).toMatchObject({ id: 1, status: "closed" });
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });

  it("replays approved invoice cost for each locked PO line before close commits", async () => {
    const reconcileApprovedInvoiceCost = vi.fn().mockResolvedValue(undefined);
    svc = createPurchasingService(mockDb, storage, { reconcileApprovedInvoiceCost });
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [{
      id: 70,
      invoiceId: 10,
      invoiceNumber: "INV-001",
      purchaseOrderLineId: 44,
      matchStatus: "matched",
    }];

    await svc.close(1, "user-1", "all matched");

    expect(reconcileApprovedInvoiceCost).toHaveBeenCalledWith(
      44,
      expect.anything(),
      "user-1",
    );
  });

  it("blocks close when a linked invoice line is still pending", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "pending" },
    ];

    await expect(svc.close(1, "user-1", "pending is unresolved")).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "PO_CLOSE_3WAY_MATCH_BLOCKED",
        purchaseOrderId: 1,
        invoiceIds: [10],
        statusCounts: { pending: 1 },
      },
    });
  });

  it("blocks close with mixed matched and pending lines", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "matched" },
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "pending" },
    ];

    await expect(svc.close(1, "user-1", "mixed is unresolved")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ statusCounts: { pending: 1 } }),
    });
  });

  it("throws 409 when invoice line has qty_discrepancy", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_discrepancy" },
    ];

    await expect(svc.close(1, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_CLOSE_3WAY_MATCH_BLOCKED" }),
    });
  });

  it("closes when an exact current price variance was resolved with a note", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [{
      invoiceId: 10,
      invoiceNumber: "INV-001",
      matchStatus: "price_discrepancy",
    }];
    resolvedMatchExceptions = [{
      payload: {
        invoiceId: 10,
        sourceVersion: 1,
        sourceFingerprint: "current-match-source-fingerprint",
      },
    }];

    const result = await svc.close(1, "user-1", "approved price variance");

    expect(result).toMatchObject({ id: 1, status: "closed" });
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });

  it("blocks a previously resolved variance after its source facts change", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [{
      invoiceId: 10,
      invoiceNumber: "INV-001",
      matchStatus: "qty_discrepancy",
    }];
    resolvedMatchExceptions = [{
      payload: {
        invoiceId: 10,
        sourceVersion: 1,
        sourceFingerprint: "stale-match-source-fingerprint",
      },
    }];

    await expect(svc.close(1, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "PO_CLOSE_3WAY_MATCH_BLOCKED",
        invoiceIds: [10],
      }),
    });
    expect(mockDetectMatchMismatch).toHaveBeenCalledWith(10);
  });

  it("never accepts a missing PO-line mapping", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [{
      invoiceId: 10,
      invoiceNumber: "INV-001",
      matchStatus: "po_line_missing",
    }];
    resolvedMatchExceptions = [{
      payload: {
        invoiceId: 10,
        sourceVersion: 1,
        sourceFingerprint: "current-match-source-fingerprint",
      },
    }];

    await expect(svc.close(1, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        statusCounts: { po_line_missing: 1 },
      }),
    });
  });

  it("throws 409 with correct error message naming invoice and line count", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_discrepancy" },
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "price_discrepancy" },
    ];

    try {
      await svc.close(1, "user-1");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PurchasingError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("INV-001");
      expect(err.message).toContain("2 unresolved invoice lines");
      expect(err.message).toContain("resolve or accept current variances");
    }
  });

  it("names multiple invoices in the error message", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }, { vendorInvoiceId: 11 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_discrepancy" },
      { invoiceId: 11, invoiceNumber: "INV-002", matchStatus: "price_discrepancy" },
    ];

    try {
      await svc.close(1, "user-1");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PurchasingError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("INV-001");
      expect(err.message).toContain("INV-002");
      expect(err.message).toContain("invoices");
    }
  });

  it("calls detectMatchMismatch only for blocked invoices after rollback", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }, { vendorInvoiceId: 11 }];
    allInvoiceLines = [
      { invoiceId: 10, invoiceNumber: "INV-001", matchStatus: "qty_discrepancy" },
      { invoiceId: 11, invoiceNumber: "INV-002", matchStatus: "matched" },
    ];

    try {
      await svc.close(1, "user-1");
      expect.unreachable("should have thrown");
    } catch {
      // expected
    }

    expect(mockDetectMatchMismatch).toHaveBeenCalledTimes(1);
    expect(mockDetectMatchMismatch).toHaveBeenCalledWith(10);
  });

  it("blocks close when a linked active invoice has no PO-mapped lines", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(poReceived);
    allPoLinks = [{ vendorInvoiceId: 10 }];
    allInvoiceLines = [];

    await expect(svc.close(1, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        invoiceIds: [10],
        statusCounts: { unmapped_invoice: 1 },
      }),
    });
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
    lockedPo = { id: 1, status: "partially_received" };
    storage.getPurchaseOrderById.mockResolvedValue(lockedPo);
    storage.getPurchaseOrderLines.mockResolvedValue([
      { id: 100, status: "open", orderQty: 10, receivedQty: 5, cancelledQty: 0 },
    ]);

    const result = await svc.closeShort(1, "vendor short-shipped", "user-1");
    expect(result).toMatchObject({ id: 1, status: "closed" });
    // closeShort does not check 3-way match — no db.select calls for poLinks
    expect(mockDetectMatchMismatch).not.toHaveBeenCalled();
  });
});
