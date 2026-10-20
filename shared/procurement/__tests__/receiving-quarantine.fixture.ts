import type { ReceivingQuarantineCommandResult, ReceivingQuarantineObservation } from "../receiving-quarantine";
import type { CustodyAction } from "../receiving-quarantine-command";
export const custodyTestIntake = { kind: "unidentified", quantity: 2, unitLabel: "box", description: "Unexpected cartons", observedSku: null,
  condition: "unexpected", holdingLocationId: 3, reason: "Inspected delivery", evidenceReference: "photo:42" } as const;
export function custodyTestResult(command: CustodyAction, resourceId: number, input: Record<string, unknown>, actorId: string): ReceivingQuarantineCommandResult {
  const capability = { allowed: true, reason: null };
  const at = "2026-10-19T12:00:00.000Z";
  const observation: ReceivingQuarantineObservation = { id: command === "intake" ? 9 : resourceId, receivingOrderId: command === "intake" ? resourceId : 7,
    receivingLineId: null, warehouseId: 1, holdingLocationId: Number(input.holdingLocationId ?? 3), holdingLocationLabel: "HOLD", productId: null,
    productVariantId: null, unitsPerVariant: null, purchaseOrderLineId: null, inboundShipmentLineId: null, description: String(input.description ?? "Held cartons"),
    observedSku: input.observedSku as string | null ?? null, unitLabel: String(input.unitLabel ?? "box"), condition: (input.condition ?? "unexpected") as "unexpected",
    observedQty: Number(input.quantity ?? 5), unallocatedQty: Number(input.quantity ?? 5), awaitingReceiptQty: 0, receivedQty: 0, returnedQty: 0,
    physicalHeldQty: Number(input.quantity ?? 5), version: 0, reason: String(input.reason), evidenceReference: String(input.evidenceReference ?? "photo:42"),
    actorId, recordedAt: at, canPrepareAcceptance: capability, canReturn: capability, acceptances: [], dispositions: [] };
  if (command === "intake" && input.kind === "receipt_line") Object.assign(observation, { receivingLineId: input.receivingLineId, productId: 10, productVariantId: 2,
    unitsPerVariant: 10, observedQty: input.heldQty, unallocatedQty: input.heldQty, physicalHeldQty: input.heldQty });
  if (command === "intake") return { observation, acceptance: null };
  observation.version = Number(input.expectedVersion) + 1;
  const quantity = Number(input.observationQty ?? 2);
  const kind = command === "prepare-acceptance" ? "prepare_acceptance" : command === "cancel-acceptance" ? "cancel_acceptance" : "return";
  const acceptance = command === "return" ? null : { id: Number(input.acceptanceId ?? 61), observationQty: quantity, receivingOrderId: Number(input.targetReceivingOrderId ?? 7), receiptNumber: "RCV-7", receivingLineId: 70,
    productVariantId: Number(input.productVariantId ?? 2), unitsPerVariant: Number(input.expectedUnitsPerVariant ?? 10), acceptedVariantQty: Number(input.acceptedVariantQty ?? 2),
    status: command === "cancel-acceptance" ? "cancelled" as const : "awaiting_receipt" as const, createdAt: at, canCancel: capability };
  if (acceptance) observation.acceptances.push(acceptance);
  if (command === "prepare-acceptance") { observation.awaitingReceiptQty = quantity; observation.unallocatedQty -= quantity; }
  if (command === "return") { observation.returnedQty = quantity; observation.physicalHeldQty -= quantity; observation.unallocatedQty -= quantity; }
  observation.dispositions.push({ id: 1, kind, observationQty: quantity, actorId, recordedAt: at, reason: String(input.reason),
    evidenceReference: command === "return" ? String(input.evidenceReference) : null, acceptanceId: acceptance?.id ?? null });
  return { observation, acceptance };
}
