import type {
  QuantityCorrectionContext,
  QuantityCorrectionSummary,
} from "../../shared/procurement/receipt-shipment-quantity-correction";
export const correctionSummary: QuantityCorrectionSummary = {
  shipmentPieces: { before: 200, after: 2000 },
  receipts: [
    {
      receiptId: 31,
      receiptNumber: "TEST-RECEIPT-31",
      receiptLineId: 32,
      receivedUnits: 2,
      receivedPieces: 200,
      piecesPerUnit: 100,
      unitWasRecorded: true,
      afterPieces: 2000,
      afterPiecesPerUnit: 1000,
    },
  ],
  poReceivedPieces: { before: 200, after: 2000 },
  poRemainingPieces: { before: 1800, after: 0 },
  shipmentChargeCents: { before: 5000, after: 5000 },
  allocatedChargeCents: { before: 5000, after: 5000 },
  chargePerPiece: { before: "0.250000", after: "0.025000" },
  landedCostCents: { before: 7000, after: 25000 },
  landedCostPerPiece: { before: "0.350000", after: "0.125000" },
  stockUnitChange: 0,
  costResults: [
    {
      component: "landed",
      shipmentId: 42,
      status: "applied",
      lotsUpdated: 2,
      orderCostsUpdated: 1,
      orderCostDeltaCents: 125,
      issues: [],
    },
  ],
  historicalCost: {
    eligible: false,
    requiresDecision: false,
    blockedReason: null,
    beforeMills: 0,
    afterMills: 0,
    destination: null,
  },
};
export const correctionInput = {
  sourceVersion: "a".repeat(64),
  shippedPieces: 2000,
  receipts: [{ receiptLineId: 32, receivedPieces: 2000 }],
  historicalCostDestination: null,
  reason: "Verified original packing slip",
  evidenceConfirmed: true as const,
  previewVersion: "b".repeat(64),
};
export function correctionContext(posted = false): QuantityCorrectionContext {
  return {
    shipmentLineId: 1,
    shipmentId: 42,
    shipmentNumber: "TEST-SHIP-42",
    shipmentStatus: "closed",
    sku: "TEST-SKU",
    productName: "Test product",
    purchaseOrderId: 17,
    purchaseOrderNumber: "TEST-PO-17",
    orderedPieces: 2000,
    shippedPieces: posted ? 2000 : 200,
    receipts: [
      {
        receiptId: 31,
        receiptNumber: "TEST-RECEIPT-31",
        receiptLineId: 32,
        receivedUnits: 2,
        receivedPieces: posted ? 2000 : 200,
        piecesPerUnit: posted ? 1000 : 100,
        unitWasRecorded: true,
      },
    ],
    sourceVersion: (posted ? "c" : "a").repeat(64),
    canApprove: true,
    blockedReason: null,
    history: posted
      ? [
          {
            id: 1,
            approvedBy: "Test Administrator",
            approvedAt: "2026-09-01T12:00:00.000Z",
            sourceVersion: "a".repeat(64),
            reason: correctionInput.reason,
            summary: correctionSummary,
          },
        ]
      : [],
  };
}
