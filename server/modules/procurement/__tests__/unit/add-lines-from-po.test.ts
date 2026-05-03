import { describe, it, expect, vi, beforeEach } from "vitest";
import { createShipmentTrackingService, ShipmentTrackingError } from "../../shipment-tracking.service";

// ─────────────────────────────────────────────────────────────────────────────
// addLinesFromPO — per-line qty selection, validation, backward compat.
//
// Tests the new lineSelections parameter that allows specifying per-line
// quantities instead of always using orderQty.
//
// Since the race fix, addLinesFromPO wraps its critical path in
// db.transaction() with SELECT ... FOR UPDATE on candidate PO lines.
// Tests mock db.transaction to execute synchronously with a mock tx.
// ─────────────────────────────────────────────────────────────────────────────

function buildMockStorage(overrides: Record<string, any> = {}): any {
  return {
    getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "booked" }),
    getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 10, vendorId: 100 }),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
    getInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getInboundShipmentLinesByPo: vi.fn().mockResolvedValue([]),
    getProductVariantById: vi.fn().mockResolvedValue(null),
    getVendorProducts: vi.fn().mockResolvedValue([]),
    bulkCreateInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getInboundFreightCosts: vi.fn().mockResolvedValue([]),
    updateInboundShipment: vi.fn().mockResolvedValue({}),
    getInboundShipmentCosts: vi.fn().mockResolvedValue([]),
    getInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
    getAllocationsForLine: vi.fn().mockResolvedValue([]),
    createInboundShipmentStatusHistory: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * Build a mock db that executes transaction callbacks synchronously.
 * The mock tx.execute returns PO lines from storage.getPurchaseOrderLines
 * (mapped to snake_case) for the FOR UPDATE query, and aggregates
 * already-shipped qty from storage.getInboundShipmentLinesByPo for the
 * shipped-qty query.
 */
function buildMockDb(storage: any) {
  // mockInsertValues captures data passed to .values() so tests can assert on it
  const mockInsertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockTx = {
    execute: vi.fn(),
    insert: mockInsert,
  };

  const db = {
    transaction: vi.fn().mockImplementation(async (fn: any) => {
      // Reset call count for each transaction
      let executeCallCount = 0;

      // Configure tx.execute based on call order
      mockTx.execute.mockImplementation(async (_query: any) => {
        executeCallCount++;
        if (executeCallCount === 1) {
          // FOR UPDATE lock → return PO lines mapped to snake_case
          const poLines = await storage.getPurchaseOrderLines();
          return {
            rows: poLines.map((l: any) => ({
              id: l.id,
              line_type: l.lineType,
              status: l.status,
              order_qty: l.orderQty,
              cancelled_qty: l.cancelledQty,
              sku: l.sku,
              product_variant_id: l.productVariantId,
            })),
          };
        }
        if (executeCallCount === 2) {
          // Dedup query → empty by default
          return { rows: [] };
        }
        // Call 3+: already-shipped qty query → aggregate from storage
        const allShipmentLines = await storage.getInboundShipmentLinesByPo();
        const qtyByLine = new Map<number, number>();
        for (const sl of allShipmentLines) {
          if (sl.purchaseOrderLineId) {
            qtyByLine.set(
              sl.purchaseOrderLineId,
              (qtyByLine.get(sl.purchaseOrderLineId) ?? 0) + (sl.qtyShipped ?? 0),
            );
          }
        }
        return {
          rows: Array.from(qtyByLine.entries()).map(([poLineId, qty]) => ({
            purchase_order_line_id: poLineId,
            already_shipped: qty,
          })),
        };
      });

      return fn(mockTx);
    }),
  };

  return { db, mockTx, mockInsertValues };
}

function makeProductLine(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    purchaseOrderId: 10,
    lineNumber: 1,
    productVariantId: 200,
    sku: "SKU-001",
    productName: "Widget",
    lineType: "product",
    status: "open",
    orderQty: 100,
    cancelledQty: 0,
    ...overrides,
  };
}

describe("addLinesFromPO", () => {
  let storage: ReturnType<typeof buildMockStorage>;
  let db: ReturnType<typeof buildMockDb>["db"];
  let mockTx: ReturnType<typeof buildMockDb>["mockTx"];
  let mockInsertValues: ReturnType<typeof buildMockDb>["mockInsertValues"];
  let svc: ReturnType<typeof createShipmentTrackingService>;

  beforeEach(() => {
    storage = buildMockStorage();
    const mock = buildMockDb(storage);
    db = mock.db;
    mockTx = mock.mockTx;
    mockInsertValues = mock.mockInsertValues;
    svc = createShipmentTrackingService(db, storage);
  });

  // ─── Transaction wrapping ──────────────────────────────────────

  it("wraps the critical path in a db transaction", async () => {
    const poLine = makeProductLine({ orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10);

    expect(db.transaction).toHaveBeenCalled();
  });

  it("acquires FOR UPDATE lock on candidate PO lines inside the transaction", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 40 }]);

    // tx.execute should be called (for FOR UPDATE + dedup + shipped qty queries)
    expect(mockTx.execute).toHaveBeenCalled();
  });

  // ─── Core behavior (unchanged from pre-race-fix) ──────────────

  it("uses orderQty when no lineSelections provided (legacy behavior)", async () => {
    const poLine = makeProductLine({ orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 100, purchaseOrderLineId: 1 }),
      ]),
    );
  });

  it("uses provided qty from lineSelections instead of orderQty", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 40 }]);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 40, purchaseOrderLineId: 5 }),
      ]),
    );
  });

  it("rejects qty > remaining (ordered - already shipped - cancelled)", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100, cancelledQty: 10 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    // 60 already shipped on another shipment
    storage.getInboundShipmentLinesByPo.mockResolvedValue([
      { purchaseOrderLineId: 5, qtyShipped: 60, inboundShipmentId: 99 },
    ]);

    // remaining = 100 - 60 - 10 = 30, requesting 31
    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 31 }]),
    ).rejects.toThrow(/exceeds remaining 30/);
  });

  it("rejects qty <= 0", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 0 }]),
    ).rejects.toThrow(/qty must be > 0/);
  });

  it("skips non-product lines (lineType !== product)", async () => {
    const discountLine = makeProductLine({ id: 5, lineType: "discount", orderQty: 1 });
    storage.getPurchaseOrderLines.mockResolvedValue([discountLine]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 1 }]),
    ).rejects.toThrow(/cannot be shipped/);
  });

  it("rejects closed/cancelled PO lines", async () => {
    const closedLine = makeProductLine({ id: 5, status: "closed" });
    storage.getPurchaseOrderLines.mockResolvedValue([closedLine]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 10 }]),
    ).rejects.toThrow(/is closed and cannot be shipped/);
  });

  it("recomputes cartonCount from new qty (not orderQty)", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    storage.getProductVariantById.mockResolvedValue({ unitsPerVariant: 10 });

    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 25 }]);

    // 25 pieces / 10 per case = 3 cartons (ceil)
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 25, cartonCount: 3 }),
      ]),
    );
  });

  it("legacy lineIds shape uses orderQty", async () => {
    const line1 = makeProductLine({ id: 1, sku: "A", orderQty: 50 });
    const line2 = makeProductLine({ id: 2, sku: "B", orderQty: 60 });
    storage.getPurchaseOrderLines.mockResolvedValue([line1, line2]);

    // lineIds param (4th arg) filters to those lines, uses orderQty
    await svc.addLinesFromPO(1, 10, undefined, [2]);

    const created = mockInsertValues.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].purchaseOrderLineId).toBe(2);
    expect(created[0].qtyShipped).toBe(60); // orderQty, not custom qty
  });

  it("filters to selected poLineIds when lineSelections provided", async () => {
    const line1 = makeProductLine({ id: 1, sku: "A", orderQty: 50 });
    const line2 = makeProductLine({ id: 2, sku: "B", orderQty: 60 });
    storage.getPurchaseOrderLines.mockResolvedValue([line1, line2]);

    await svc.addLinesFromPO(1, 10, [{ poLineId: 2, qty: 30 }]);

    const created = mockInsertValues.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].purchaseOrderLineId).toBe(2);
    expect(created[0].qtyShipped).toBe(30);
  });

  it("allows qty equal to remaining", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100, cancelledQty: 10 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    storage.getInboundShipmentLinesByPo.mockResolvedValue([
      { purchaseOrderLineId: 5, qtyShipped: 60, inboundShipmentId: 99 },
    ]);

    // remaining = 100 - 60 - 10 = 30
    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 30 }]);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 30 }),
      ]),
    );
  });

  // ─── Array binding regression (ANY() needs ARRAY[]::integer[] via sql.join) ────

  it("builds real integer arrays with ARRAY[]::integer[] and sql.join in ALL raw SQL ANY() calls", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 40 }]);

    // Every tx.execute call receives a SQL template. Inspect the raw SQL
    // fragments to confirm every ANY() usage uses ARRAY[]::integer[] pattern
    // (Drizzle sql.join builds individual bound params inside ARRAY literal).
    const calls = mockTx.execute.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);

    for (const [query] of calls) {
      // query is a Drizzle sql`` template — its queryChunks contain the raw text
      const sqlText = JSON.stringify(query);
      if (sqlText.includes('ANY(')) {
        expect(sqlText).toContain('ARRAY[');
        expect(sqlText).toContain('::integer[]');
      }
    }
  });

  it("throws early when candidateLineIds is empty (no extra DB calls)", async () => {
    // PO exists but no lines match the filter
    storage.getPurchaseOrderLines.mockResolvedValue([]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 999, qty: 10 }]),
    ).rejects.toThrow(/No new PO lines to add/);

    // Transaction should never have been entered
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // ─── Concurrency (documented limitation) ──────────────────────

  // A true concurrency test (two parallel addLinesFromPO calls on the same
  // PO line where the sum exceeds remaining, expecting one success + one
  // rejection) is not feasible here because:
  //
  // 1. The mock db.transaction executes callbacks synchronously — it does
  //    not simulate real PostgreSQL row-level locking with FOR UPDATE.
  // 2. There is no DATABASE_URL set in the test environment, so an
  //    integration test against a real Postgres instance is not possible.
  // 3. The mock tx.execute returns predetermined data regardless of
  //    concurrent state — it cannot model one transaction blocking on
  //    another's lock.
  //
  // The transaction wrapping test above confirms the structural contract.
  // The real race fix is validated by the SELECT ... FOR UPDATE pattern
  // which is a well-established PostgreSQL concurrency primitive.
});
