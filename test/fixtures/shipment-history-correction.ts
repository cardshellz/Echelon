import type { ShipmentHistoryContext, ShipmentHistoryInput } from "../../shared/procurement/shipment-history-correction";

export function historyContext(): ShipmentHistoryContext {
  return {
    shipmentId: 42, shipmentNumber: "TEST-SHIP-42", sourceVersion: "a".repeat(64), canApprove: true, blockedReason: null,
    current: { status: "booked", departedOn: null, deliveredOn: null },
    lines: [{ id: 201, sku: "TEST-SLEEVES", pieces: 100000, purchaseOrderId: 17, poNumber: "TEST-PO-17", purchaseOrderLineId: 101,
      orderedPieces: 200000, receivedPieces: 200000, postedReceiptPieces: 300000, otherShippedPieces: 0, otherPlannedPieces: 0 }],
    receipts: [{ id: 31, number: "TEST-RECEIPT-31", lineId: 301, purchaseOrderLineId: 101, handledUnits: 10,
      piecesPerUnit: null, postedPieces: 200000, shipmentId: null, shipmentLineId: null }],
    charges: [{ currency: "USD", cents: 165191 }], issues: ["Receipt postings disagree with the PO counter. The receipt has no shipment link."],
    events: [{ status: "booked", recordedAt: "2026-03-19T19:03:50.635Z", notes: "Shipment booked" }], approvals: [],
  };
}
export const historyInput = (sourceVersion = "a".repeat(64)): ShipmentHistoryInput => ({
  sourceVersion, status: "delivered", departedOn: "2026-03-12", deliveredOn: "2026-03-19",
  reason: "Packing list and signed delivery record reviewed by administrator.", evidenceConfirmed: true,
});
