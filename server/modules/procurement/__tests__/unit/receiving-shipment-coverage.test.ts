import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  computeClosedShipmentReceivedBaseQtyByLine,
  readClosedShipmentReceivedBaseQtyByLine,
  ShipmentReceiptCoverageError,
  type ClosedShipmentReceivingLine,
  type ShipmentReceiptCoverageEvidence,
  type ShipmentReceiptCoverageReversal,
  type ShipmentReceiptCoverageSourceLine,
} from "../../receiving-shipment-coverage";
import { ReceivingUnitSnapshotError, type PostedReceiptUnitEvidence } from "../../receiving-unit-snapshot";

const source = (overrides: Partial<ShipmentReceiptCoverageSourceLine> = {}): ShipmentReceiptCoverageSourceLine => ({
  id: 30, purchaseOrderId: 10, purchaseOrderLineId: 20, qtyShipped: 501, ...overrides,
});
const receipt = (overrides: Partial<ClosedShipmentReceivingLine> = {}): ClosedShipmentReceivingLine => ({
  id: 70, receivingOrderId: 60, purchaseOrderId: 10, inboundShipmentId: 40,
  purchaseOrderLineId: 20, inboundShipmentLineId: 30, unitsPerVariantSnapshot: 1,
  receivedQty: 501, reversedQty: 0, receiptStatus: "closed", ...overrides,
});
const posting = (overrides: Partial<PostedReceiptUnitEvidence> = {}): PostedReceiptUnitEvidence => ({
  receivingLineId: 70, receivingOrderId: 60, purchaseOrderId: 10, purchaseOrderLineId: 20, qtyReceived: 501, ...overrides,
});
const reversal = (overrides: Partial<ShipmentReceiptCoverageReversal> = {}): ShipmentReceiptCoverageReversal => ({
  id: 80, receivingLineId: 70, receivingOrderId: 60, qty: 1, baseUnitsReversed: 1, ...overrides,
});
function evidence(overrides: Partial<ShipmentReceiptCoverageEvidence> = {}): ShipmentReceiptCoverageEvidence {
  return { purchaseOrderId: 10, inboundShipmentId: 40, shipmentLines: [source()], receivingLines: [receipt()], postedReceipts: [], reversals: [], ...overrides };
}
function compute(overrides: Partial<ShipmentReceiptCoverageEvidence> = {}) {
  return computeClosedShipmentReceivedBaseQtyByLine(evidence(overrides));
}

describe("closed shipment receipt coverage", () => {
  it("preserves 501 received pieces without rounding to cartons", () => {
    expect([...compute()]).toEqual([[30, 501]]);
  });
  it("scales a frozen 50-piece pack exactly once", () => {
    expect(compute({ receivingLines: [receipt({ receivedQty: 10, unitsPerVariantSnapshot: 50 })] }).get(30)).toBe(500);
  });
  it("does not distribute receipt quantity across two lines for the same PO line", () => {
    const result = compute({ shipmentLines: [source({ qtyShipped: 100 }), source({ id: 31, qtyShipped: 200 })],
      receivingLines: [receipt({ inboundShipmentLineId: 31, receivedQty: 150 })] });
    expect([...result]).toEqual([[31, 150]]);
  });
  it("sums multiple exact receipt configurations only into their shared shipment line", () => {
    expect(compute({ receivingLines: [
      receipt({ receivedQty: 10, unitsPerVariantSnapshot: 50 }),
      receipt({ id: 71, receivingOrderId: 61, receivedQty: 1 }),
    ] }).get(30)).toBe(501);
  });
  it("counts new closed physical evidence while post-commit PO reconciliation is missing", () => {
    expect(compute({ postedReceipts: [] }).get(30)).toBe(501);
  });
  it("validates a present PO posting against a frozen factor", () => {
    expect(compute({ postedReceipts: [posting()] }).get(30)).toBe(501);
    expect(() => compute({ postedReceipts: [posting({ qtyReceived: 500 })] })).toThrow(ReceivingUnitSnapshotError);
  });
  it("supports legacy evidence only with one possible shipment line and its immutable PO posting", () => {
    expect(compute({ receivingLines: [receipt({ inboundShipmentLineId: null, unitsPerVariantSnapshot: null, receivedQty: 10 })],
      postedReceipts: [posting({ qtyReceived: 500 })] }).get(30)).toBe(500);
  });
  it("can use proven posting ownership when the legacy receipt header PO is absent", () => {
    expect(compute({ receivingLines: [receipt({ purchaseOrderId: null, inboundShipmentLineId: null, unitsPerVariantSnapshot: null, receivedQty: 10 })],
      postedReceipts: [posting({ qtyReceived: 500 })] }).get(30)).toBe(500);
  });
  it("rejects a legacy receipt where the same PO line has two shipment lines", () => {
    expect(() => compute({ shipmentLines: [source(), source({ id: 31 })],
      receivingLines: [receipt({ inboundShipmentLineId: null })], postedReceipts: [posting()] })).toThrow(/cannot be attributed/);
  });
  it("rejects a legacy receipt with no original PO posting even when only one source is possible", () => {
    expect(() => compute({ receivingLines: [receipt({ inboundShipmentLineId: null })] })).toThrow(/original PO posting/);
  });
  it("rejects a legacy nonintegral posting ratio", () => {
    expect(() => compute({ receivingLines: [receipt({ inboundShipmentLineId: null, unitsPerVariantSnapshot: null, receivedQty: 10 })],
      postedReceipts: [posting()] })).toThrow(ReceivingUnitSnapshotError);
  });
  it("nets exact reversal snapshots and reconciles their variant tally", () => {
    expect(compute({ receivingLines: [receipt({ receivedQty: 10, reversedQty: 3, unitsPerVariantSnapshot: 50 })],
      reversals: [reversal({ qty: 1, baseUnitsReversed: 50 }), reversal({ id: 81, qty: 2, baseUnitsReversed: 100 })] }).get(30)).toBe(350);
  });
  it("nets fully reversed receipts to zero without deleting their source", () => {
    expect([...compute({ receivingLines: [receipt({ reversedQty: 501 })], reversals: [reversal({ qty: 501, baseUnitsReversed: 501 })] })]).toEqual([[30, 0]]);
  });
  it("nets legacy reversals with the posting-proven frozen factor", () => {
    expect(compute({ receivingLines: [receipt({ inboundShipmentLineId: null, unitsPerVariantSnapshot: null, receivedQty: 10, reversedQty: 2 })],
      postedReceipts: [posting({ qtyReceived: 500 })], reversals: [reversal({ qty: 2, baseUnitsReversed: 100 })] }).get(30)).toBe(400);
  });
  it.each([
    { baseUnitsReversed: null }, { baseUnitsReversed: 0 }, { baseUnitsReversed: 2 },
    { receivingOrderId: 61 }, { qty: 0 }, { qty: -1 },
  ])("rejects contradictory reversal evidence %j", (changes) => {
    expect(() => compute({ receivingLines: [receipt({ reversedQty: 1 })], reversals: [reversal(changes)] })).toThrow(ShipmentReceiptCoverageError);
  });
  it("rejects missing reversal postings rather than reconstructing them from the counter", () => {
    expect(() => compute({ receivingLines: [receipt({ reversedQty: 1 })] })).toThrow(/reversal postings/);
  });
  it("rejects reversal postings absent from the receiving counter", () => {
    expect(() => compute({ reversals: [reversal()] })).toThrow(/reversal postings/);
  });
  it.each([
    { purchaseOrderId: 11 }, { inboundShipmentId: 41 }, { purchaseOrderLineId: 21 },
    { purchaseOrderLineId: null }, { inboundShipmentLineId: 31 }, { receiptStatus: "cancelled" },
    { receivedQty: -1 }, { receivedQty: 1.5 }, { reversedQty: 502 },
  ])("rejects invalid or conflicting receipt evidence %j", (changes) => {
    expect(() => compute({ receivingLines: [receipt(changes)] })).toThrow(ShipmentReceiptCoverageError);
  });
  it("rejects duplicate receiving, reversal and PO posting identities", () => {
    expect(() => compute({ receivingLines: [receipt(), receipt()] })).toThrow(/duplicated/);
    expect(() => compute({ reversals: [reversal(), reversal()] })).toThrow(/duplicated/);
    expect(() => compute({ postedReceipts: [posting(), posting()] })).toThrow(ReceivingUnitSnapshotError);
  });
  it("rejects orphaned posting and reversal evidence", () => {
    expect(() => compute({ postedReceipts: [posting({ receivingLineId: 71 })] })).toThrow(/no matching receiving line/);
    expect(() => compute({ reversals: [reversal({ receivingLineId: 71 })] })).toThrow(/no matching receiving line/);
  });
  it("retains zero-post legacy recovery without inventing a factor or source link", () => {
    expect([...compute({ receivingLines: [receipt({ receivedQty: 0, unitsPerVariantSnapshot: null, inboundShipmentLineId: null, purchaseOrderLineId: null })] })]).toEqual([]);
  });
  it("does not suppress a zero-quantity line carrying inconsistent reversal history", () => {
    expect(() => compute({ receivingLines: [receipt({ receivedQty: 0 })], reversals: [reversal()] })).toThrow();
  });
  it("returns actual authorized over-receipt evidence without silently clamping it", () => {
    expect(compute({ shipmentLines: [source({ qtyShipped: 500 })] }).get(30)).toBe(501);
  });
  it("does not mutate source or receipt history inputs", () => {
    const input = evidence({ postedReceipts: [posting()] });
    const before = structuredClone(input);
    computeClosedShipmentReceivedBaseQtyByLine(input);
    expect(input).toEqual(before);
  });
  it("reports actionable review details", () => {
    try { compute({ receivingLines: [receipt({ inboundShipmentLineId: 31 })] }); throw new Error("expected failure"); }
    catch (error) { expect(error).toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED", receivingLineId: 70 } }); }
  });
});

describe("closed shipment coverage evidence loader", () => {
  const scope = { purchaseOrderId: 10, inboundShipmentId: 40, shipmentLines: [source()] };
  it("loads bounded header, posting and reversal facts without reading catalog units", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [receipt()] })
      .mockResolvedValueOnce({ rows: [posting()] }).mockResolvedValueOnce({ rows: [] });
    expect([...(await readClosedShipmentReceivedBaseQtyByLine({ execute }, scope))]).toEqual([[30, 501]]);
    const dialect = new PgDialect();
    const queries = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
    expect(queries).toHaveLength(3);
    expect(queries[0].sql).toContain('rl.inbound_shipment_line_id AS "inboundShipmentLineId"');
    expect(queries[0].sql).toContain('rl.units_per_variant_snapshot AS "unitsPerVariantSnapshot"');
    expect(queries[1].sql).toContain("procurement.po_receipts");
    expect(queries[2].sql).toContain("base_units_reversed");
    expect(queries.map((query) => query.sql).join(" ")).not.toMatch(/catalog|FOR UPDATE/i);
    for (const query of queries) expect(query.params).toContain(10_001);
  });
  it("returns empty coverage when no closed receipt exists", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    expect([...(await readClosedShipmentReceivedBaseQtyByLine({ execute }, scope))]).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("rejects incomplete result shapes and excessive evidence instead of silently truncating", async () => {
    for (const rows of [undefined, Array(10_001).fill(receipt())]) {
      const execute = vi.fn().mockResolvedValue({ rows });
      await expect(readClosedShipmentReceivedBaseQtyByLine({ execute }, scope)).rejects.toThrow(ShipmentReceiptCoverageError);
    }
  });
  it("propagates a database read failure without presenting empty success", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("database unavailable"));
    await expect(readClosedShipmentReceivedBaseQtyByLine({ execute }, scope)).rejects.toThrow("database unavailable");
  });
  it("rejects invalid IDs and duplicate source identities before any query", async () => {
    const execute = vi.fn();
    await expect(readClosedShipmentReceivedBaseQtyByLine({ execute }, { ...scope, purchaseOrderId: 0 })).rejects.toThrow(ShipmentReceiptCoverageError);
    await expect(readClosedShipmentReceivedBaseQtyByLine({ execute }, { ...scope, shipmentLines: [source(), source()] })).rejects.toThrow(ShipmentReceiptCoverageError);
    expect(execute).not.toHaveBeenCalled();
  });
});
