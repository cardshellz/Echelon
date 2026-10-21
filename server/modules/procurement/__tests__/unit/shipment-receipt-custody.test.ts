import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { computeShipmentReceiptCustodyCoverage, summarizeShipmentReceiptCustodyCoverage, assertShipmentCustodyAdmission,
  type ShipmentReceiptCustodyEvidence, type ShipmentCustodyObservationEvidence, type ShipmentCustodyAcceptanceEvidence } from "../../domain/shipment-receipt-custody";
import { readShipmentReceiptCustodyCoverage } from "../../shipment-receipt-custody.repository";
import { ShipmentReceiptCoverageError } from "../../receiving-shipment-coverage";

function observation(changes: Partial<ShipmentCustodyObservationEvidence> = {}): ShipmentCustodyObservationEvidence {
  return { id: 90, receivingOrderId: 60, receivingLineId: 70, purchaseOrderId: 10, inboundShipmentId: 40, receiptStatus: "closed",
    purchaseOrderLineId: 20, inboundShipmentLineId: 30, productId: 100, unitsPerVariant: 100,
    observedQty: 2, awaitingReceiptQty: 0, receivedQty: 0, returnedQty: 0, version: 0,
    sourceReceivingOrderId: 60, sourcePurchaseOrderLineId: 20, sourceShipmentLineId: 30, sourceProductId: 100,
    sourceUnitsPerVariant: 100, sourceReceivedQty: 8, purchaseProductId: 100, ...changes };
}
function acceptance(changes: Partial<ShipmentCustodyAcceptanceEvidence> = {}): ShipmentCustodyAcceptanceEvidence {
  return { id: 91, observationId: 90, observationQty: 2, receivingOrderId: 61, receivingLineId: 71,
    acceptedVariantQty: 2, unitsPerVariant: 100, status: "awaiting_receipt", receiptStatus: "draft",
    receiptPurchaseOrderId: 10, receiptShipmentId: 40, lineReceivingOrderId: 61, linePurchaseOrderLineId: 20,
    lineShipmentLineId: 30, lineUnitsPerVariant: 100, lineReceivedQty: 2, ...changes };
}
function evidence(changes: Partial<ShipmentReceiptCustodyEvidence> = {}): ShipmentReceiptCustodyEvidence {
  return { purchaseOrderId: 10, inboundShipmentId: 40,
    shipmentLines: [{ id: 30, purchaseOrderId: 10, purchaseOrderLineId: 20, qtyShipped: 1_000 }],
    receivingLines: [{ id: 70, receivingOrderId: 60, purchaseOrderId: 10, inboundShipmentId: 40,
      purchaseOrderLineId: 20, inboundShipmentLineId: 30, unitsPerVariantSnapshot: 100,
      receivedQty: 8, reversedQty: 0, receiptStatus: "closed" }],
    postedReceipts: [], reversals: [], custodyObservations: [observation()], custodyAcceptances: [], ...changes };
}
function summarize(input = evidence()) {
  return summarizeShipmentReceiptCustodyCoverage(input.shipmentLines, computeShipmentReceiptCustodyCoverage(input));
}
function admit(input: ShipmentReceiptCustodyEvidence, quantity: number, lineId = 72, receiptId = 62) {
  return assertShipmentCustodyAdmission({ receivingOrderId: receiptId, shipmentLines: input.shipmentLines,
    coverage: computeShipmentReceiptCustodyCoverage(input), receivingLines: [{ id: lineId, inboundShipmentLineId: 30,
      receivedQty: quantity, unitsPerVariantSnapshot: 100 }] });
}

describe("shipment receipt custody coverage", () => {
  it("separates eight accepted cases from two held cases without presenting either as fresh arrivals", () => {
    expect(summarize()).toMatchObject({ totalExpectedBaseQty: 1_000, totalReceivedBaseQty: 800,
      totalCustodyBaseQty: 200, totalHeldBaseQty: 200, totalReturnedBaseQty: 0, totalRemainingBaseQty: 0, custodyReceiptIds: [60] });
  });
  it("accounts for an all-held receipt with no posted stock", () => {
    expect(summarize(evidence({ receivingLines: [], custodyObservations: [observation({ observedQty: 10, sourceReceivedQty: 0 })] })))
      .toMatchObject({ totalReceivedBaseQty: 0, totalCustodyBaseQty: 1_000, totalHeldBaseQty: 1_000, totalRemainingBaseQty: 0 });
  });
  it("preserves a real undelivered remainder after a partial arrival", () => {
    const input = evidence(); input.receivingLines = [{ ...input.receivingLines[0], receivedQty: 6 }];
    input.custodyObservations = [observation({ sourceReceivedQty: 6 })];
    expect(summarize(input)).toMatchObject({ totalReceivedBaseQty: 600, totalCustodyBaseQty: 200, totalRemainingBaseQty: 200 });
    expect(() => admit(input, 2)).not.toThrow();
    expect(() => admit(input, 3)).toThrow(ShipmentReceiptCoverageError);
  });
  it("keeps physically returned goods accounted against the original shipment", () => {
    expect(summarize(evidence({ custodyObservations: [observation({ returnedQty: 2, version: 1 })] })))
      .toMatchObject({ totalReceivedBaseQty: 800, totalCustodyBaseQty: 200, totalHeldBaseQty: 0, totalReturnedBaseQty: 200, totalRemainingBaseQty: 0 });
  });
  it("retains custody during pending acceptance and credits only its exact receipt line at close", () => {
    const input = evidence({ custodyObservations: [observation({ awaitingReceiptQty: 2, version: 1 })], custodyAcceptances: [acceptance()] });
    expect(summarize(input)).toMatchObject({ totalCustodyBaseQty: 200, totalHeldBaseQty: 200, totalRemainingBaseQty: 0 });
    expect(() => admit(input, 2, 71, 61)).not.toThrow();
    expect(() => admit(input, 2)).toThrow(ShipmentReceiptCoverageError);
    expect(() => admit(input, 1, 71, 61)).toThrow(/acceptance quantity changed/);
  });
  it("does not count cancelled acceptance as received stock or release its reservation", () => {
    const input = evidence({ custodyObservations: [observation({ version: 2 })],
      custodyAcceptances: [acceptance({ status: "cancelled", lineReceivedQty: 0 })] });
    expect(summarize(input)).toMatchObject({ totalCustodyBaseQty: 200, totalRemainingBaseQty: 0 });
    expect(() => admit(input, 2, 71, 61)).toThrow(ShipmentReceiptCoverageError);
  });
  it("replaces accepted custody with actual posted stock exactly once", () => {
    const input = evidence({ custodyObservations: [observation({ receivedQty: 2, version: 2 })],
      custodyAcceptances: [acceptance({ status: "received", receiptStatus: "closed" })] });
    input.receivingLines = [...input.receivingLines, { ...input.receivingLines[0], id: 71, receivingOrderId: 61, receivedQty: 2 }];
    expect(summarize(input)).toMatchObject({ totalReceivedBaseQty: 1_000, totalCustodyBaseQty: 0, totalHeldBaseQty: 0,
      totalReturnedBaseQty: 0, totalRemainingBaseQty: 0, custodyReceiptIds: [] });
    // A stale ordinary draft must not use the now-zero custody balance to
    // over-receive goods already posted by the reviewed acceptance.
    expect(() => admit(input, 2)).toThrow(ShipmentReceiptCoverageError);
  });
  it("preserves over-delivered physical evidence while permitting only reviewed custody acceptance", () => {
    const input = evidence({ custodyObservations: [observation({ observedQty: 3, awaitingReceiptQty: 3, version: 1 })],
      custodyAcceptances: [acceptance({ observationQty: 3, acceptedVariantQty: 3, lineReceivedQty: 3 })] });
    expect(summarize(input)).toMatchObject({ totalExpectedBaseQty: 1_000, totalReceivedBaseQty: 800,
      totalCustodyBaseQty: 300, totalRemainingBaseQty: 0, totalExcessBaseQty: 100 });
    expect(() => admit(input, 1)).toThrow(ShipmentReceiptCoverageError);
    expect(() => admit(input, 3, 71, 61)).not.toThrow();
  });
  it("preserves a different line's fresh remainder alongside exact source-line excess", () => {
    const input = evidence({ custodyObservations: [observation({ observedQty: 3 })] });
    input.shipmentLines = [...input.shipmentLines, { id: 31, purchaseOrderId: 10, purchaseOrderLineId: 21, qtyShipped: 400 }];
    const totals = summarize(input);
    expect(totals).toMatchObject({ totalExpectedBaseQty: 1_400, totalReceivedBaseQty: 800,
      totalCustodyBaseQty: 300, totalRemainingBaseQty: 400, totalExcessBaseQty: 100 });
    expect(totals.remainingBaseQtyByLine).toEqual(new Map([[30, 0], [31, 400]]));
    expect(totals.totalReceivedBaseQty + totals.totalCustodyBaseQty + totals.totalRemainingBaseQty)
      .toBe(totals.totalExpectedBaseQty + totals.totalExcessBaseQty);
  });
  it("preserves exact receipt reversal coverage without rewriting earlier custody disposition", () => {
    const input = evidence({ custodyObservations: [observation({ receivedQty: 2, version: 2 })],
      custodyAcceptances: [acceptance({ status: "received", receiptStatus: "closed" })],
      reversals: [{ id: 80, receivingLineId: 71, receivingOrderId: 61, qty: 1, baseUnitsReversed: 100 }] });
    input.receivingLines = [...input.receivingLines, { ...input.receivingLines[0], id: 71, receivingOrderId: 61, receivedQty: 2, reversedQty: 1 }];
    expect(summarize(input)).toMatchObject({ totalReceivedBaseQty: 900, totalCustodyBaseQty: 0, totalRemainingBaseQty: 100 });
  });
  it("guards old drafts while the original accepted source count is still unposted", () => {
    const input = evidence({ receivingLines: [], custodyObservations: [observation({ receiptStatus: "open" })] });
    expect(() => admit(input, 2)).toThrow(ShipmentReceiptCoverageError);
    expect(() => admit(input, 8, 70, 60)).not.toThrow();
  });
  it("never treats over-receipt confirmation as custody approval", () => {
    expect(() => admit(evidence(), 10)).toThrow(/resolve their custody explicitly/);
    expect(() => admit(evidence({ custodyObservations: [] }), 10)).not.toThrow();
  });
  it("cannot assign an unidentified package count to a piece quantity", () => {
    const input = evidence({ custodyObservations: [observation({ receivingLineId: null, productId: null,
      unitsPerVariant: null, purchaseOrderLineId: null, inboundShipmentLineId: null })] });
    expect(summarize(input)).toMatchObject({ totalReceivedBaseQty: 800, totalCustodyBaseQty: 0, totalRemainingBaseQty: 200 });
  });
  it.each([
    { purchaseOrderId: 11 }, { inboundShipmentId: 41 }, { purchaseOrderLineId: 21 }, { inboundShipmentLineId: 31 },
    { sourceReceivingOrderId: 61 }, { sourceShipmentLineId: 31 }, { sourcePurchaseOrderLineId: 21 }, { sourceProductId: 101 },
    { purchaseProductId: 101 }, { sourceUnitsPerVariant: 50 }, { unitsPerVariant: null }, { sourceReceivedQty: -1 },
    { receiptStatus: "cancelled" }, { observedQty: 0 }, { returnedQty: 3 }, { receivedQty: 1 }, { awaitingReceiptQty: 1 },
  ])("fails closed for contradictory custody evidence %j", changes => {
    expect(() => summarize(evidence({ custodyObservations: [observation(changes)] }))).toThrow(ShipmentReceiptCoverageError);
  });
  it("rejects duplicate custody identities and unsafe exact quantities", () => {
    expect(() => summarize(evidence({ custodyObservations: [observation(), observation()] }))).toThrow(/duplicated/);
    expect(() => summarize(evidence({ custodyObservations: [observation(), observation({ id: 92 })] }))).toThrow(/duplicate an original/);
    expect(() => summarize(evidence({ custodyObservations: [observation({ observedQty: 2_147_483_647,
      unitsPerVariant: 2_147_483_647, sourceUnitsPerVariant: 2_147_483_647 })] }))).toThrow(/exact range/);
  });
  it.each([
    { observationId: 99 }, { lineReceivingOrderId: 62 }, { receiptPurchaseOrderId: 11 }, { receiptShipmentId: 41 },
    { linePurchaseOrderLineId: 21 }, { lineShipmentLineId: 31 }, { lineUnitsPerVariant: 50 }, { lineReceivedQty: 1 },
    { acceptedVariantQty: 1 }, { receiptStatus: "closed" },
  ])("rejects invalid acceptance evidence %j", changes => {
    expect(() => summarize(evidence({ custodyObservations: [observation({ awaitingReceiptQty: 2, version: 1 })],
      custodyAcceptances: [acceptance(changes)] }))).toThrow(ShipmentReceiptCoverageError);
  });
  it("does not mutate its evidence", () => {
    const input = evidence(); const original = structuredClone(input); summarize(input); expect(input).toEqual(original);
  });
});

describe("single-snapshot custody coverage loader", () => {
  const input = evidence();
  const scope = { purchaseOrderId: input.purchaseOrderId, inboundShipmentId: input.inboundShipmentId, shipmentLines: input.shipmentLines };
  const snapshot = { receivingLines: input.receivingLines, postedReceipts: input.postedReceipts, reversals: input.reversals,
    custodyObservations: input.custodyObservations, custodyAcceptances: input.custodyAcceptances };
  it("reads bounded posted and custody evidence in one statement without live catalog units", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [snapshot] });
    expect((await readShipmentReceiptCustodyCoverage({ execute }, scope)).lines.get(30))
      .toEqual({ receivedBaseQty: 800, custodyBaseQty: 200, heldBaseQty: 200, returnedBaseQty: 0, custodyReceiptIds: [60] });
    expect(execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("procurement.receiving_quarantine_acceptances");
    expect(query.sql).toContain("procurement.po_receipts");
    expect(query.sql).toContain("procurement.receipt_reversals");
    expect(query.sql).not.toMatch(/catalog|FOR UPDATE/i);
    expect(query.params.filter(value => value === 10_001)).toHaveLength(5);
  });
  it("fails closed for missing snapshots, malformed arrays and truncated evidence", async () => {
    for (const rows of [[], [null], [{ ...snapshot, custodyObservations: undefined }],
      [{ ...snapshot, custodyObservations: Array(10_001).fill(observation()) }]]) {
      await expect(readShipmentReceiptCustodyCoverage({ execute: vi.fn().mockResolvedValue({ rows }) }, scope)).rejects.toThrow(ShipmentReceiptCoverageError);
    }
  });
  it("propagates infrastructure errors and validates source identity before reading", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("database unavailable"));
    await expect(readShipmentReceiptCustodyCoverage({ execute }, scope)).rejects.toThrow("database unavailable");
    execute.mockClear();
    await expect(readShipmentReceiptCustodyCoverage({ execute }, { ...scope, purchaseOrderId: 0 })).rejects.toThrow(ShipmentReceiptCoverageError);
    expect(execute).not.toHaveBeenCalled();
  });
});
