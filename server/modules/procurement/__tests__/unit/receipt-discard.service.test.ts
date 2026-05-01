import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReceivingService, ReceivingError } from "../../../../modules/procurement/receiving.service";

// ─────────────────────────────────────────────────────────────────────────────
// discardDraftReceivingOrder — unit tests
//
// Covers:
//   1. 409 when status != 'draft'
//   2. 409 when any line has receivedQty > 0
//   3. delete cascades lines + order in one transaction
//   4. po_status_history row written when receipt is linked to a PO
//
// All tests use in-memory mocks — no DB I/O.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the raw SQL text from a Drizzle sql`...` tagged-template object.
 * Drizzle stores the query as { queryChunks: Array<{ value: string[] } | Param> }.
 * We join the string-value chunks to get a human-readable form for assertions.
 */
function sqlToStr(query: any): string {
  if (Array.isArray(query?.queryChunks)) {
    return query.queryChunks
      .map((c: any) => (Array.isArray(c.value) ? c.value.join("") : ""))
      .join(" ")
      .toLowerCase();
  }
  return String(query?.sql ?? query ?? "").toLowerCase();
}

function makeTx(poRows: any[] = []) {
  return {
    execute: vi.fn().mockImplementation(async (query: any) => {
      // For the SELECT on purchase_orders we return the supplied rows;
      // all other executes (DELETE + INSERT) return empty.
      return { rows: poRows };
    }),
  };
}

function makeDb(tx: ReturnType<typeof makeTx>) {
  return {
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(tx)),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

function makeStorage(order: any, lines: any[] = []) {
  return {
    getReceivingOrderById: vi.fn().mockResolvedValue(order),
    getReceivingLines: vi.fn().mockResolvedValue(lines),
    // Other storage methods required by ReceivingService constructor but not
    // exercised by discard — satisfy the interface cheaply.
    updateReceivingOrder: vi.fn(),
    updateReceivingLine: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getVendorById: vi.fn(),
    getProductVariantBySku: vi.fn(),
    getProductVariantById: vi.fn(),
    getProductVariantsByProductId: vi.fn(),
    getAllProductVariants: vi.fn(),
    getAllProducts: vi.fn(),
    getProductBySku: vi.fn(),
    createProduct: vi.fn(),
    createProductVariant: vi.fn(),
    getAllWarehouseLocations: vi.fn(),
    getAllProductLocations: vi.fn(),
    getSetting: vi.fn(),
    getReceivingLineById: vi.fn(),
    getPurchaseOrderLineById: vi.fn(),
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("ReceivingService.discardDraftReceivingOrder", () => {
  describe("(1) 409 when status is not 'draft'", () => {
    it.each([
      ["open"],
      ["receiving"],
      ["closed"],
      ["cancelled"],
    ])("throws 409 when status = '%s'", async (status) => {
      const order = { id: 1, status, purchaseOrderId: null, receiptNumber: "RCV-20260501-001" };
      const tx = makeTx();
      const db = makeDb(tx);
      const storage = makeStorage(order, []);
      const service = new ReceivingService(db, {} as any, {} as any, storage);

      await expect(service.discardDraftReceivingOrder(1, "user-1")).rejects.toMatchObject({
        message: "Cannot discard a started receipt",
        statusCode: 409,
      });

      // Must not enter the transaction
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe("(2) 409 when any line has receivedQty > 0", () => {
    it("throws 409 when one line has receivedQty = 5", async () => {
      const order = { id: 2, status: "draft", purchaseOrderId: null, receiptNumber: "RCV-20260501-002" };
      const lines = [
        { id: 10, receivedQty: 0 },
        { id: 11, receivedQty: 5 }, // Has received quantity
      ];
      const tx = makeTx();
      const db = makeDb(tx);
      const storage = makeStorage(order, lines);
      const service = new ReceivingService(db, {} as any, {} as any, storage);

      await expect(service.discardDraftReceivingOrder(2, "user-1")).rejects.toMatchObject({
        message: "Receipt has received quantities; cannot discard",
        statusCode: 409,
      });

      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("allows discard when all lines have receivedQty = 0 or null", async () => {
      const order = { id: 3, status: "draft", purchaseOrderId: null, receiptNumber: "RCV-20260501-003" };
      const lines = [
        { id: 20, receivedQty: 0 },
        { id: 21, receivedQty: null },
      ];
      const tx = makeTx();
      const db = makeDb(tx);
      const storage = makeStorage(order, lines);
      const service = new ReceivingService(db, {} as any, {} as any, storage);

      await expect(service.discardDraftReceivingOrder(3, "user-1")).resolves.toBeUndefined();
    });
  });

  describe("(3) delete cascades lines + order in a single transaction", () => {
    it("calls DELETE for lines then DELETE for order within one transaction", async () => {
      const order = {
        id: 4,
        status: "draft",
        purchaseOrderId: null,
        receiptNumber: "RCV-20260501-004",
      };
      const lines = [{ id: 30, receivedQty: 0 }];

      // Track execute call arguments so we can verify the DELETE order
      const executeCalls: string[] = [];
      const tx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          executeCalls.push(sqlToStr(q));
          return { rows: [] };
        }),
      };
      const db = {
        transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)),
        execute: vi.fn(),
      } as any;
      const storage = makeStorage(order, lines);
      const service = new ReceivingService(db, {} as any, {} as any, storage);

      await service.discardDraftReceivingOrder(4, "user-1");

      // Transaction must have been opened exactly once
      expect(db.transaction).toHaveBeenCalledTimes(1);

      // Lines deleted first, then order
      const lineDeleteIdx = executeCalls.findIndex((s) => s.includes("receiving_lines"));
      const orderDeleteIdx = executeCalls.findIndex((s) => s.includes("receiving_orders"));
      expect(lineDeleteIdx).toBeGreaterThanOrEqual(0);
      expect(orderDeleteIdx).toBeGreaterThan(lineDeleteIdx);
    });
  });

  describe("(4) po_status_history row written when receipt is linked to a PO", () => {
    it("inserts a po_status_history row when purchaseOrderId is set", async () => {
      const order = {
        id: 5,
        status: "draft",
        purchaseOrderId: 99,
        receiptNumber: "RCV-20260501-005",
      };
      const lines: any[] = [];

      const insertCalls: string[] = [];
      const selectRows = [{ physical_status: "acknowledged", status: "acknowledged" }];

      let selectCallCount = 0;
      const tx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const queryStr = sqlToStr(q);
          if (queryStr.includes("select")) {
            selectCallCount++;
            return { rows: selectRows };
          }
          if (queryStr.includes("insert")) {
            insertCalls.push(queryStr);
          }
          return { rows: [] };
        }),
      };
      const db = {
        transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)),
        execute: vi.fn(),
      } as any;
      const storage = makeStorage(order, lines);
      const service = new ReceivingService(db, {} as any, {} as any, storage);

      await service.discardDraftReceivingOrder(5, "user-audit");

      // A SELECT on purchase_orders must have been issued (to read physicalStatus)
      expect(selectCallCount).toBeGreaterThanOrEqual(1);

      // An INSERT into po_status_history must have been issued
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);
      expect(insertCalls[0]).toContain("po_status_history");
    });

    it("skips po_status_history insert when no PO is linked", async () => {
      const order = {
        id: 6,
        status: "draft",
        purchaseOrderId: null, // No PO
        receiptNumber: "RCV-20260501-006",
      };
      const lines: any[] = [];

      const insertCalls: string[] = [];
      const tx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const queryStr = sqlToStr(q);
          if (queryStr.includes("insert")) {
            insertCalls.push(queryStr);
          }
          return { rows: [] };
        }),
      };
      const db = {
        transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)),
        execute: vi.fn(),
      } as any;
      const storage = makeStorage(order, lines);
      const service = new ReceivingService(db, {} as any, {} as any, storage);

      await service.discardDraftReceivingOrder(6, "user-1");

      // No INSERT should have been made
      expect(insertCalls.length).toBe(0);
    });
  });
});
