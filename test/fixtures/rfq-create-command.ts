import type { RfqCreateIntent, RfqCreateReceipt } from "../../shared/procurement/rfq-create-command";

export const rfqCreateIntent: RfqCreateIntent = { operation: "create_batch", rfqId: null, payload: {
  requestNote: null, responseDueDate: null,
  lines: [{ recommendationLineId: 901, vendorId: 2, vendorProductId: 20, requestedPieces: 100 }],
} };
export function rfqCreateReceipt(intent: RfqCreateIntent, idempotencyKey: string, actorId = "operator-a"): RfqCreateReceipt {
  const vendors = [...new Set(intent.payload.lines.map(line => line.vendorId))];
  return { version: 1, actorId, idempotencyKey, intent, result: { reused: false,
    rfqs: vendors.map((vendorId, index) => ({ id: 902 + index, rfqNumber: `RFQ-TEST-${902 + index}`, vendorId,
      idempotencyKey, requestHash: "a".repeat(64), createdBy: actorId, requestNote: intent.payload.requestNote ?? null,
      responseDueDate: intent.payload.responseDueDate ?? null })),
    lines: intent.payload.lines.map((line, index) => ({ id: 903 + index, rfqId: 902 + vendors.indexOf(line.vendorId),
      recommendationLineId: line.recommendationLineId, vendorProductId: line.vendorProductId ?? 20,
      requestedPieces: line.requestedPieces, quantityOverrideReason: line.quantityOverrideReason ?? null,
      allocationOverrideApprovedBy: line.allocationOverrideApproved ? actorId : null })),
  } };
}
