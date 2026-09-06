import { describe, expect, it, vi } from "vitest";
import type { PurchaseOrder, PurchaseOrderLine } from "@shared/schema";
import {
  computeShipmentSourceCapacity, lockShipmentSourceCapacity, readShipmentSourceCapacities, getShippablePurchaseOrderLines, ShipmentSourceCapacityError,
  type ShipmentCapacityCommitment, type ShipmentCapacityReceipt, type ShipmentCapacityReversal,
} from "../../shipment-source-capacity";

const header = { id: 10, status: "sent", physicalStatus: "sent" } as PurchaseOrder;
const line = { id: 20, purchaseOrderId: 10, productId: 100, lineType: "product", status: "open", orderQty: 200, cancelledQty: 0, receivedQty: 0 } as PurchaseOrderLine;
function commitment(overrides: Partial<ShipmentCapacityCommitment> = {}): ShipmentCapacityCommitment {
  return { id: 30, inboundShipmentId: 40, purchaseOrderId: 10, purchaseOrderLineId: 20, qtyShipped: 80, shipmentStatus: "delivered", ...overrides };
}
function receipt(overrides: Partial<ShipmentCapacityReceipt> = {}): ShipmentCapacityReceipt {
  return {
    id: 50, purchaseOrderId: 10, purchaseOrderLineId: 20, receivingOrderId: 60, receivingLineId: 70,
    qtyReceived: 50, receiptExists: true, receivingLineExists: true, receivingLinePurchaseOrderLineId: 20,
    receiptLineAllocationCount: 1, receivedVariantQty: 5, reversedVariantQty: 0,
    receiptPurchaseOrderId: 10, inboundShipmentId: null, receiptStatus: "closed", ...overrides,
  };
}
function calculate(overrides: Partial<Parameters<typeof computeShipmentSourceCapacity>[0]> = {}) {
  return computeShipmentSourceCapacity({ purchaseOrder: header, line, commitments: [], receipts: [], reversals: [], ...overrides });
}
function expectReview(fn: () => unknown) {
  expect(fn).toThrow(ShipmentSourceCapacityError);
  try { fn(); } catch (error) {
    expect(error).toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" } });
  }
}

describe("shipment source capacity", () => {
  it("uses base-piece commitments and cancellations, including draft and closed shipments", () => {
    const result = calculate({ line: { ...line, cancelledQty: 10 }, commitments: [
      commitment({ qtyShipped: 40, shipmentStatus: "draft" }),
      commitment({ id: 31, inboundShipmentId: 41, qtyShipped: 30, shipmentStatus: "closed" }),
      commitment({ id: 32, inboundShipmentId: 42, qtyShipped: 200, shipmentStatus: "cancelled" }),
    ] });
    expect(result).toMatchObject({ committedShipmentQty: 70, directReceivedQty: 0, remainingQty: 120 });
  });
  it("accounts for direct receipts separately from a disjoint shipment", () => {
    expect(calculate({ line: { ...line, receivedQty: 50 }, commitments: [commitment()], receipts: [receipt()] }))
      .toMatchObject({ committedShipmentQty: 80, directReceivedQty: 50, remainingQty: 70 });
  });
  it("does not double-count an explicitly shipment-linked receipt", () => {
    expect(calculate({ line: { ...line, receivedQty: 50 }, commitments: [commitment()], receipts: [receipt({ inboundShipmentId: 40 })] }))
      .toMatchObject({ committedShipmentQty: 80, directReceivedQty: 0, remainingQty: 120 });
  });
  it("nets a recorded base-piece reversal without reading live catalog units", () => {
    const reversal: ShipmentCapacityReversal = { receivingLineId: 70, receivingOrderId: 60, qty: 2, baseUnitsReversed: 20 };
    expect(calculate({ line: { ...line, receivedQty: 30 }, receipts: [receipt({ reversedVariantQty: 2 })], reversals: [reversal] }))
      .toMatchObject({ directReceivedQty: 30, remainingQty: 170 });
  });
  it("validates receipt overlap before excluding the current line for an update", () => {
    expect(calculate({ line: { ...line, receivedQty: 50 }, commitments: [commitment()], receipts: [receipt({ inboundShipmentId: 40 })], excludeShipmentLineId: 30 }))
      .toMatchObject({ committedShipmentQty: 0, remainingQty: 200 });
  });
  it("rejects receipt overage against original commitments even when excluding the line", () => {
    expectReview(() => calculate({ line: { ...line, receivedQty: 90 }, commitments: [commitment()], receipts: [receipt({ inboundShipmentId: 40, qtyReceived: 90 })], excludeShipmentLineId: 30 }));
  });
  it("preserves partial-carton pieces without rounding to packs", () => {
    expect(calculate({ line: { ...line, orderQty: 1000, expectedReceiveUnitsPerVariant: 250 }, commitments: [commitment({ qtyShipped: 501 })] }).remainingQty).toBe(499);
  });
  it.each(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"])("does not introduce a new release gate for %s", (status) => {
    expect(calculate({ purchaseOrder: { ...header, status } }).remainingQty).toBe(200);
  });
  it.each(["received", "closed", "cancelled"])("rejects terminal purchase %s", (status) => {
    expect(() => calculate({ purchaseOrder: { ...header, status } })).toThrow(/no longer accepts/);
  });
  it.each(["received", "closed", "cancelled", "unknown"])("rejects ineligible line status %s", (status) => {
    expect(() => calculate({ line: { ...line, status } })).toThrow(/Only open/);
  });
  it("rejects a product line without a product identity", () => expectReview(() => calculate({ line: { ...line, productId: null } })));
  it("rejects non-product rows", () => expect(() => calculate({ line: { ...line, lineType: "fee" } })).toThrow(/product/));
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects malformed stored quantity %s", (orderQty) => {
    expectReview(() => calculate({ line: { ...line, orderQty } }));
  });
  it("rejects received counters without authoritative postings", () => expectReview(() => calculate({ line: { ...line, receivedQty: 1 } })));
  it("blocks unfinished direct receipts with an actionable review error", () => {
    expectReview(() => calculate({ pendingDirectReceivingOrderIds: [60] }));
    expect(() => calculate({ pendingDirectReceivingOrderIds: [60] })).toThrow(/Finish or cancel/);
  });
  it("rejects closed received lines missing their posting even when PO counter is zero", () => expectReview(() => calculate({ unpostedClosedReceivingLineIds: [70] })));
  it.each([null, "cancelled", "unknown"])("does not invent overlap for shipment status %s", (shipmentStatus) => {
    expectReview(() => calculate({ line: { ...line, receivedQty: 50 }, commitments: [commitment({ shipmentStatus })], receipts: [receipt({ inboundShipmentId: 40 })] }));
  });
  it.each([
    { receiptExists: false }, { receivingLineExists: false }, { receiptPurchaseOrderId: 11 },
    { receivingLinePurchaseOrderLineId: 21 }, { receiptStatus: "draft" }, { receiptLineAllocationCount: 2 },
    { receivedVariantQty: 0 }, { reversedVariantQty: 1 },
  ])("rejects contradictory receipt evidence %j", (change) => {
    expectReview(() => calculate({ line: { ...line, receivedQty: 50 }, receipts: [receipt(change)] }));
  });
  it.each([null, 0, -1, 0.5, 60])("rejects unusable reversal base snapshot %s", (baseUnitsReversed) => {
    expectReview(() => calculate({ line: { ...line, receivedQty: 30 }, receipts: [receipt({ reversedVariantQty: 2 })], reversals: [{ receivingLineId: 70, receivingOrderId: 60, qty: 2, baseUnitsReversed }] }));
  });
  it("rejects reversal missing its posting", () => expectReview(() => calculate({ reversals: [{ receivingLineId: 70, receivingOrderId: 60, qty: 2, baseUnitsReversed: 20 }] })));
  it("rejects reversal pointing to another receipt", () => expectReview(() => calculate({ line: { ...line, receivedQty: 30 }, receipts: [receipt({ reversedVariantQty: 2 })], reversals: [{ receivingLineId: 70, receivingOrderId: 61, qty: 2, baseUnitsReversed: 20 }] })));
  it("rejects duplicate shipment identities", () => expectReview(() => calculate({ commitments: [commitment(), commitment()] })));
  it("rejects duplicate receipt identities", () => expectReview(() => calculate({ line: { ...line, receivedQty: 100 }, receipts: [receipt(), receipt()] })));
  it("rejects ownership conflicts", () => expectReview(() => calculate({ commitments: [commitment({ purchaseOrderId: 11 })] })));
  it("rejects missing update exclusion", () => expectReview(() => calculate({ excludeShipmentLineId: 99 })));
  it("rejects already overcommitted history", () => expectReview(() => calculate({ commitments: [commitment({ qtyShipped: 201 })] })));
  it("does not mutate supplied evidence", () => {
    const input = { purchaseOrder: { ...header }, line: { ...line, receivedQty: 50 }, commitments: [commitment()], receipts: [receipt()], reversals: [] };
    const before = structuredClone(input);
    computeShipmentSourceCapacity(input);
    expect(input).toEqual(before);
  });
});

describe("source capacity locking boundary", () => {
  it.each([[], [0], [-1], [1.5], [2_147_483_648], [10, 10]].map((purchaseOrderIds) => ({ purchaseOrderIds })))("rejects invalid IDs $purchaseOrderIds before database work", async ({ purchaseOrderIds }) => {
    const tx = { select: vi.fn(), execute: vi.fn() };
    await expect(lockShipmentSourceCapacity(tx, { purchaseOrderIds, purchaseOrderLineIds: [20] })).rejects.toMatchObject({ statusCode: 400 });
    expect(tx.select).not.toHaveBeenCalled();
  });
  it("locks headers then lines before reading any source evidence", async () => {
    const events: string[] = [];
    let selection = 0;
    const tx = {
      select: () => {
        const current = selection++;
        const chain: any = { from: () => chain, where: () => chain, orderBy: () => { events.push(current === 0 ? "headers ordered" : "lines ordered"); return chain; },
          for: async (mode: string) => { events.push(`${current === 0 ? "headers" : "lines"} ${mode}`); return current === 0 ? [header] : [line]; } };
        return chain;
      },
      execute: vi.fn(async () => { events.push("evidence"); return { rows: [] }; }),
    };
    const result = await lockShipmentSourceCapacity(tx, { purchaseOrderIds: [10], purchaseOrderLineIds: [20] });
    expect(events).toEqual(["headers ordered", "headers update", "lines ordered", "lines update", "evidence", "evidence", "evidence", "evidence", "evidence"]);
    expect(result.get(20)?.remainingQty).toBe(200);
  });
  it("blocks a selected PO when closed receiving activity cannot be attributed to a line", async () => {
    let selections = 0;
    let reads = 0;
    const tx: any = { select: () => {
      const current = selections++;
      const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, for: async () => current === 0 ? [header] : [line] };
      return chain;
    }, execute: vi.fn(async () => ({ rows: ++reads === 5 ? [{ id: 70, purchaseOrderLineId: null, purchaseOrderId: 10 }] : [] })) };
    await expect(lockShipmentSourceCapacity(tx, { purchaseOrderIds: [10], purchaseOrderLineIds: [20] })).rejects.toMatchObject({
      statusCode: 409, details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED", receivingLineIds: [70] },
    });
  });

  it("rejects selected rows whose ownership changed under the header lock", async () => {
    let count = 0;
    const tx: any = { execute: vi.fn(), select: () => {
      const current = count++;
      const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, for: async () => current === 0 ? [header] : [] };
      return chain;
    } };
    await expect(lockShipmentSourceCapacity(tx, { purchaseOrderIds: [10], purchaseOrderLineIds: [20] })).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_SOURCE_OWNERSHIP_CHANGED" } });
    expect(tx.execute).not.toHaveBeenCalled();
  });
});


describe("shipment source read projection", () => {
  it("uses the same math without source row locks and isolates each line review", async () => {
    const otherLine = { ...line, id: 21, receivedQty: 1 };
    let selected = 0;
    const lock = vi.fn();
    const tx: any = {
      select: () => {
        const rows = selected++ === 0 ? [header] : [line, otherLine];
        const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, for: lock,
          then: (resolve: any) => Promise.resolve(rows).then(resolve) };
        return chain;
      },
      execute: vi.fn(async () => ({ rows: [] })),
    };
    const result = await readShipmentSourceCapacities(tx, { purchaseOrderIds: [10], purchaseOrderLineIds: [20, 21] });
    expect(lock).not.toHaveBeenCalled();
    expect(result.capacities.get(20)?.remainingQty).toBe(200);
    expect(result.capacities.has(21)).toBe(false);
    expect(result.reviewRequired.get(21)).toMatchObject({ details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" } });
  });
});


describe("shipment chooser read boundary", () => {
  it("uses a read-only snapshot and preserves direct receipt capacity without source locks", async () => {
    let selected = 0;
    let read = 0;
    const receivedLine = { ...line, receivedQty: 50 };
    const selections = [[{ id: 10 }], [receivedLine, { ...line, id: 21, lineType: "fee" }], [header], [receivedLine]];
    const evidence = [[commitment()], [receipt()], [], [], []];
    const lock = vi.fn();
    const tx: any = {
      select: () => {
        const rows = selections[selected++];
        const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, for: lock,
          then: (resolve: any) => Promise.resolve(rows).then(resolve) };
        return chain;
      },
      execute: vi.fn(async () => ({ rows: evidence[read++] })),
    };
    const db = { transaction: vi.fn(async (fn: any, _options: any) => fn(tx)) };
    const result = await getShippablePurchaseOrderLines(db, 10);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ id: 20, alreadyShippedQty: 80, directReceivedQty: 50, remainingQty: 70 });
    expect(result.reviewRequiredLines).toEqual([]);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(lock).not.toHaveBeenCalled();
  });

  it("observes a direct receipt that closes between pending and missing-posting reads", async () => {
    let selections = 0;
    let receiptClosed = false;
    const tx: any = {
      select: () => {
        const current = selections++;
        const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, for: async () => current === 0 ? [header] : [line] };
        return chain;
      },
      execute: vi.fn(async (query: any) => {
        const text = query.queryChunks.map((chunk: any) => Array.isArray(chunk.value) ? chunk.value.join("") : "").join(" ");
        if (text.includes("ro.status NOT IN")) return { rows: receiptClosed ? [] : [{ id: 60, purchaseOrderId: 10, purchaseOrderLineId: 20 }] };
        if (text.includes("AND ro.status = 'closed'")) {
          // Inventory posting commits after this query's snapshot. Its PO
          // reconciliation must still wait on the source header lock.
          const rows = receiptClosed ? [{ id: 70, purchaseOrderId: 10, purchaseOrderLineId: 20 }] : [];
          receiptClosed = true;
          return { rows };
        }
        return { rows: [] };
      }),
    };
    await expect(lockShipmentSourceCapacity(tx, { purchaseOrderIds: [10], purchaseOrderLineIds: [20] })).rejects.toMatchObject({
      statusCode: 409, details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED", receivingOrderIds: [60] },
    });
    expect(receiptClosed).toBe(true);
  });
});
