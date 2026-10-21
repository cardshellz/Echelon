import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertPoDirectCustodyAdmission, inspectPoDirectCustodyEvidence, PoDirectCustodySourceError,
  type PoDirectCustodyObservation, type PoDirectCustodyAcceptance, type PoDirectCustodyEvidence,
  type PoDirectReceiptLine, type PoDirectUnidentifiedAcceptance } from "../../domain/po-direct-receipt-custody";
import { assertPoDirectReceiptCustodyAdmission, readPoDirectCustodySources } from "../../po-direct-receipt-custody.repository";

function observation(changes: Partial<PoDirectCustodyObservation> = {}): PoDirectCustodyObservation {
  return { id: 90, receivingOrderId: 60, receivingLineId: 70, purchaseOrderId: 10, inboundShipmentId: null,
    receiptStatus: "closed", purchaseOrderLineId: 20, inboundShipmentLineId: null, productId: 100,
    productVariantId: 200, unitsPerVariant: 100, observedQty: 2, awaitingReceiptQty: 0, receivedQty: 0,
    returnedQty: 0, version: 0, sourceReceivingOrderId: 60, sourcePurchaseOrderLineId: 20, sourceShipmentLineId: null,
    sourceProductId: 100, sourceProductVariantId: 200, sourceUnitsPerVariant: 100, sourceReceivedQty: 8,
    purchaseLineOrderId: 10, purchaseProductId: 100, shipmentLineOrderId: null,
    shipmentLinePurchaseOrderId: null, shipmentLinePurchaseLineId: null, ...changes };
}
function acceptance(changes: Partial<PoDirectCustodyAcceptance> = {}): PoDirectCustodyAcceptance {
  return { id: 91, observationId: 90, observationQty: 2, receivingOrderId: 61, receivingLineId: 71,
    productId: 100, productVariantId: 200, unitsPerVariant: 100, acceptedVariantQty: 2, status: "awaiting_receipt",
    receiptStatus: "draft", receiptPurchaseOrderId: 10, receiptShipmentId: null, lineReceivingOrderId: 61,
    linePurchaseOrderLineId: 20, lineShipmentLineId: null, lineProductId: 100, lineProductVariantId: 200,
    lineUnitsPerVariant: 100, lineReceivedQty: 2, ...changes };
}
function evidence(changes: Partial<PoDirectCustodyEvidence> = {}): PoDirectCustodyEvidence {
  return { purchaseOrderId: 10, observations: [observation()], acceptances: [], unidentifiedAcceptances: [], ...changes };
}
function unidentifiedAcceptance(changes: Partial<PoDirectUnidentifiedAcceptance> = {}): PoDirectUnidentifiedAcceptance {
  return { ...acceptance({ id: 95, observationId: 94 }), observationReceivingOrderId: 64, observationReceivingLineId: null,
    observationProductId: null, observationProductVariantId: null, observationUnitsPerVariant: null,
    observationPurchaseOrderLineId: null, observationShipmentLineId: null,
    observationObservedQty: 2, observationAwaitingReceiptQty: 2, observationReceivedQty: 0, observationReturnedQty: 0,
    observationVersion: 1, observationWarehouseId: 1, sourceReceiptWarehouseId: 1, receiptWarehouseId: 1,
    sourceReceiptStatus: "closed",
    targetPurchaseOrderId: 10, targetPurchaseProductId: 100, ...changes };
}
function line(changes: Partial<PoDirectReceiptLine> = {}): PoDirectReceiptLine {
  return { id: 72, purchaseOrderLineId: 20, inboundShipmentLineId: null, productId: 100,
    productVariantId: 200, receivedQty: 2, unitsPerVariantSnapshot: 100, ...changes };
}
function admit(input = evidence(), receivingLine = line(), receiptId = 62) {
  assertPoDirectCustodyAdmission(input, { receivingOrderId: receiptId, lines: [receivingLine] });
}
function awaiting() {
  return evidence({ observations: [observation({ awaitingReceiptQty: 2, version: 1 })], acceptances: [acceptance()] });
}
function shipmentObservation() {
  return observation({ inboundShipmentId: 40, inboundShipmentLineId: 30, sourceShipmentLineId: 30,
    shipmentLineOrderId: 40, shipmentLinePurchaseOrderId: 10, shipmentLinePurchaseLineId: 20 });
}

describe("PO-direct custody source admission", () => {
  it("blocks an ordinary PO-direct row from replacing held shipment goods", () => {
    const input = evidence({ observations: [shipmentObservation()] });
    expect(() => admit(input)).toThrow(PoDirectCustodySourceError);
    try { admit(input); } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, details: { code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED",
        purchaseOrderId: 10, purchaseOrderLineIds: [20], custodyReceiptIds: [60] } });
    }
  });
  it("blocks the same bypass when the original custody was PO-direct", () => {
    expect(() => admit()).toThrow(/no unambiguous original custody count/);
  });
  it("preserves unrelated purchase lines and zero-count rows", () => {
    expect(() => admit(evidence(), line({ purchaseOrderLineId: 21 }))).not.toThrow();
    // Normal receiving owns legacy field resolution for unrelated sources.
    expect(() => admit(evidence(), line({ purchaseOrderLineId: 21, productId: null }))).not.toThrow();
    expect(() => admit(evidence(), line({ receivedQty: 0 }))).not.toThrow();
    expect(() => admit(evidence({ observations: [] }))).not.toThrow();
  });
  it("allows only the original receipt's frozen accepted count", () => {
    const input = evidence({ observations: [observation({ receiptStatus: "open" })] });
    expect(() => admit(input, line({ id: 70, receivedQty: 8 }), 60)).not.toThrow();
    expect(() => admit(input, line({ id: 70, receivedQty: 9 }), 60)).toThrow(PoDirectCustodySourceError);
    expect(() => admit(input, line({ id: 70, receivedQty: 8 }), 62)).toThrow(PoDirectCustodySourceError);
    expect(() => admit(evidence(), line({ id: 70, receivedQty: 8 }), 60)).toThrow(PoDirectCustodySourceError);
  });
  it("does not let a second observation self-authorize a different draft's accepted count", () => {
    const input = evidence({ observations: [shipmentObservation(), observation({ id: 92,
      receivingOrderId: 62, receivingLineId: 72, sourceReceivingOrderId: 62, sourceReceivedQty: 2, receiptStatus: "open" })] });
    expect(() => admit(input)).toThrow(PoDirectCustodySourceError);
    expect(inspectPoDirectCustodyEvidence(input).sources).toEqual(new Map([[20, [60, 62]]]));
  });
  it("allows an exact prepared PO-direct acceptance despite multiple observations", () => {
    const input = awaiting();
    input.observations = [...input.observations, observation({ id: 92, receivingLineId: 73 })];
    expect(() => admit(input, line({ id: 71 }), 61)).not.toThrow();
  });
  it("preserves exact pieces when the approved acceptance uses a different receive pack", () => {
    const input = awaiting();
    input.acceptances = [acceptance({ productVariantId: 201, lineProductVariantId: 201,
      unitsPerVariant: 1, lineUnitsPerVariant: 1, acceptedVariantQty: 200, lineReceivedQty: 200 })];
    expect(() => admit(input, line({ id: 71, productVariantId: 201, receivedQty: 200, unitsPerVariantSnapshot: 1 }), 61)).not.toThrow();
  });
  it.each([
    { id: 72 }, { receivedQty: 1 }, { productId: 101 }, { productVariantId: 201 }, { unitsPerVariantSnapshot: 1 },
  ])("does not borrow a prepared acceptance with changed line evidence %j", (changes) => {
    expect(() => admit(awaiting(), line({ id: 71, ...changes }), 61)).toThrow(PoDirectCustodySourceError);
  });
  it("does not treat shipment-origin acceptance as PO-direct source proof", () => {
    const input = evidence({ observations: [{ ...shipmentObservation(), awaitingReceiptQty: 2, version: 1 }],
      acceptances: [acceptance({ receiptShipmentId: 40, lineShipmentLineId: 30 })] });
    expect(() => admit(input, line({ id: 71 }), 61)).toThrow(PoDirectCustodySourceError);
  });
  it("does not release a source restriction after the goods are physically returned", () => {
    expect(() => admit(evidence({ observations: [observation({ returnedQty: 2, version: 1 })] }))).toThrow(PoDirectCustodySourceError);
  });
  it("does not release a source restriction after the approved acceptance closes", () => {
    const input = evidence({ observations: [observation({ receivedQty: 2, version: 2 })],
      acceptances: [acceptance({ status: "received", receiptStatus: "closed" })] });
    expect(() => admit(input)).toThrow(PoDirectCustodySourceError);
    expect(() => admit(input, line({ id: 71 }), 61)).toThrow(PoDirectCustodySourceError);
  });
  it("does not authorize a cancelled acceptance", () => {
    const input = evidence({ observations: [observation({ version: 2 })],
      acceptances: [acceptance({ status: "cancelled", lineReceivedQty: 0 })] });
    expect(() => admit(input, line({ id: 71 }), 61)).toThrow(PoDirectCustodySourceError);
  });
  it.each([
    { sourceReceivingOrderId: 61 }, { sourcePurchaseOrderLineId: 21 }, { purchaseOrderId: 11 },
    { purchaseLineOrderId: 11 }, { sourceProductId: 101 }, { purchaseProductId: 101 },
    { sourceUnitsPerVariant: 1 }, { sourceProductVariantId: 201 }, { receiptStatus: "cancelled" },
    { observedQty: 0 }, { awaitingReceiptQty: 3 }, { sourceReceivedQty: -1 },
  ])("fails closed on contradictory original source evidence %j", (changes) => {
    expect(() => inspectPoDirectCustodyEvidence(evidence({ observations: [observation(changes)] }))).toThrow(PoDirectCustodySourceError);
  });
  it.each([
    { linePurchaseOrderLineId: 21 }, { lineReceivingOrderId: 60 }, { receiptPurchaseOrderId: 11 },
    { lineProductVariantId: 201 }, { lineUnitsPerVariant: 1 }, { lineReceivedQty: 1 },
    { observationQty: 1 }, { receiptStatus: "closed" }, { productId: 101 },
  ])("fails closed on contradictory acceptance evidence %j", (changes) => {
    const input = awaiting(); input.acceptances = [acceptance(changes)];
    expect(() => inspectPoDirectCustodyEvidence(input)).toThrow(PoDirectCustodySourceError);
  });
  it("requires matching acceptance evidence for received and awaiting counters", () => {
    for (const changes of [{ receivedQty: 2 }, { awaitingReceiptQty: 2 }]) {
      expect(() => inspectPoDirectCustodyEvidence(evidence({ observations: [observation(changes)] }))).toThrow(/counters/);
    }
  });
  it("rejects duplicate observation, original line and acceptance identities", () => {
    for (const rows of [[observation(), observation()], [observation(), observation({ id: 92 })]]) {
      expect(() => inspectPoDirectCustodyEvidence(evidence({ observations: rows }))).toThrow(PoDirectCustodySourceError);
    }
    const input = awaiting(); input.acceptances = [acceptance(), acceptance({ id: 92 })];
    expect(() => inspectPoDirectCustodyEvidence(input)).toThrow(PoDirectCustodySourceError);
  });
  it("does not mutate input evidence", () => {
    const input = awaiting(); const before = structuredClone(input);
    admit(input, line({ id: 71 }), 61);
    expect(input).toEqual(before);
  });
  it("preserves an explicitly approved unidentified-package acceptance beside separate known custody", () => {
    const input = evidence({ unidentifiedAcceptances: [unidentifiedAcceptance()] });
    expect(() => admit(input, line({ id: 71 }), 61)).not.toThrow();
    expect(() => admit(input)).toThrow(PoDirectCustodySourceError);
    // Unknown package counts never become a new PO-line amount or source link.
    expect(inspectPoDirectCustodyEvidence(input).sources).toEqual(new Map([[20, [60]]]));
  });
  it("uses only the approved frozen conversion for an unidentified package", () => {
    const input = evidence({ unidentifiedAcceptances: [unidentifiedAcceptance({ observationQty: 1,
      acceptedVariantQty: 7, lineReceivedQty: 7 })] });
    expect(() => admit(input, line({ id: 71, receivedQty: 7 }), 61)).not.toThrow();
    expect(() => admit(input, line({ id: 71, receivedQty: 2 }), 61)).toThrow(PoDirectCustodySourceError);
    expect(() => admit(input, line({ id: 71, receivedQty: 7 }), 62)).toThrow(PoDirectCustodySourceError);
  });
  it.each([
    { observationReceivingLineId: 70 }, { observationProductId: 100 }, { observationUnitsPerVariant: 100 },
    { observationPurchaseOrderLineId: 20 }, { observationShipmentLineId: 30 }, { status: "received" },
    { receiptShipmentId: 40 }, { targetPurchaseOrderId: 11 }, { targetPurchaseProductId: 101 },
    { lineReceivedQty: 1 }, { lineUnitsPerVariant: 1 }, { receiptWarehouseId: 2 }, { sourceReceiptWarehouseId: 2 },
    { observationAwaitingReceiptQty: 1 }, { observationReturnedQty: 2 }, { sourceReceiptStatus: "cancelled" }, { sourceReceiptStatus: null },
  ])("rejects contradictory unidentified-package approval %j", (changes) => {
    const input = evidence({ unidentifiedAcceptances: [unidentifiedAcceptance(changes)] });
    expect(() => admit(input, line({ id: 71 }), 61)).toThrow(PoDirectCustodySourceError);
  });
  it("does not allow several target lines to reuse more unknown custody than was prepared", () => {
    const input = evidence({ unidentifiedAcceptances: [unidentifiedAcceptance(), unidentifiedAcceptance({ id: 96, receivingLineId: 73 })] });
    expect(() => inspectPoDirectCustodyEvidence(input)).toThrow(/exceed their recorded custody/);
  });
});

describe("PO-direct custody repository", () => {
  it("reads one bounded coherent observation and acceptance snapshot", async () => {
    const input = evidence();
    const execute = vi.fn().mockResolvedValue({ rows: [input] });
    expect(await readPoDirectCustodySources({ execute }, 10)).toEqual(new Map([[20, [60]]]));
    expect(execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([10, 10, 10_001, 10_001, null, 10_001]);
    expect(query.sql).toContain("receiving_quarantine_observations");
    expect(query.sql).toContain("receiving_quarantine_acceptances");
    expect(query.sql).toContain("OR rl.purchase_order_line_id");
  });
  it("passes exact prepared acceptance through the same repository snapshot", async () => {
    const input = awaiting();
    const execute = vi.fn().mockResolvedValue({ rows: [input] });
    await expect(assertPoDirectReceiptCustodyAdmission({ execute }, { purchaseOrderId: 10,
      receivingOrderId: 61, lines: [line({ id: 71 })] })).resolves.toBeUndefined();
  });
  it.each([
    { name: "missing snapshot", rows: [] }, { name: "null snapshot", rows: [null] }, { name: "missing fields", rows: [{}] },
    { name: "invalid collection", rows: [{ ...evidence(), acceptances: null }] },
    { name: "contradictory product", rows: [{ ...evidence(), observations: [observation({ productId: null })] }] },
    { name: "row limit", rows: [{ ...evidence(), observations: Array.from({ length: 10_001 }, () => observation()) }] },
  ])("fails closed on $name", async ({ rows }) => {
    const execute = vi.fn().mockResolvedValue({ rows });
    await expect(readPoDirectCustodySources({ execute }, 10)).rejects.toBeInstanceOf(PoDirectCustodySourceError);
  });
  it("limits unknown-package exceptions to exact prepared lines on the closing receipt", async () => {
    const input = evidence({ unidentifiedAcceptances: [unidentifiedAcceptance()] });
    const execute = vi.fn().mockResolvedValue({ rows: [input] });
    await expect(assertPoDirectReceiptCustodyAdmission({ execute }, { purchaseOrderId: 10,
      receivingOrderId: 61, lines: [line({ id: 71 })] })).resolves.toBeUndefined();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([10, 10, 10_001, 10_001, 61, 10_001]);
    expect(query.sql).toContain("a.status='awaiting_receipt' AND q.product_id IS NULL");
  });
  it("preserves infrastructure failures and rejects invalid purchase identity before querying", async () => {
    const failure = new Error("connection unavailable");
    const execute = vi.fn().mockRejectedValue(failure);
    await expect(readPoDirectCustodySources({ execute }, 10)).rejects.toBe(failure);
    execute.mockClear();
    await expect(readPoDirectCustodySources({ execute }, 0)).rejects.toBeInstanceOf(PoDirectCustodySourceError);
    expect(execute).not.toHaveBeenCalled();
  });
});
