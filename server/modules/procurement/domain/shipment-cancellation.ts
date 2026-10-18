import { z } from "zod";

export const SHIPMENT_CANCELLATION_REASON_MAX_LENGTH = 10_000;

export const shipmentCancellationEvidenceSchema = z.object({
  receivingHistory: z.boolean(),
  inventoryHistory: z.boolean(),
  finalizedCostHistory: z.boolean(),
  invoiceHistory: z.boolean(),
}).strict();

export type ShipmentCancellationEvidence = z.infer<typeof shipmentCancellationEvidenceSchema>;
export type ShipmentCancellationBlocker = keyof ShipmentCancellationEvidence;

/** Cancellation releases shipment commitments. Retained physical or financial
 * evidence must instead remain attached to an active completion/correction path.
 * Zero balances, voided invoices and reversed receipts do not erase history. */
export function shipmentCancellationBlockers(evidence: ShipmentCancellationEvidence): ShipmentCancellationBlocker[] {
  const blockers: ShipmentCancellationBlocker[] = [];
  if (evidence.receivingHistory) blockers.push("receivingHistory");
  if (evidence.inventoryHistory) blockers.push("inventoryHistory");
  if (evidence.finalizedCostHistory) blockers.push("finalizedCostHistory");
  if (evidence.invoiceHistory) blockers.push("invoiceHistory");
  return blockers;
}
