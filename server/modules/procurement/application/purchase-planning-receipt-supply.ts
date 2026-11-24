import { z } from "zod";
import type { PurchaseInboundScheduleEntry } from "@shared/procurement/purchase-planning-policy";
import { purchaseReceiptSupplyEvidenceSchema, type PurchaseReceiptSupplyEvidence } from "@shared/procurement/purchase-receipt-supply-evidence";
import { resolvePurchaseOrderArrival } from "./purchase-order-arrival";
import { PURCHASE_RECEIPT_EVIDENCE_LIMIT, purchaseReceiptMirrorIssue, resolvePurchaseReceiptQuantities, type PurchaseReceiptEvidence } from "./purchase-receipt-quantity-evidence";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}).nullable();

export const purchasePlanningOpenLinesSchema = z.array(z.object({
  id, purchaseOrderId: id, purchaseOrderNumber: z.string().min(1), productId: id,
  ordered: quantity, received: quantity, cancelled: quantity,
  promisedDate: date, expectedDate: date, confirmedDate: date, purchaseExpectedDate: date,
}).strict()).max(PURCHASE_RECEIPT_EVIDENCE_LIMIT);
export type PurchasePlanningOpenLine = z.infer<typeof purchasePlanningOpenLinesSchema>[number];
export interface PurchasePlanningSupplyPosition {
  on_order_pieces: number;
  open_po_count: number;
  earliest_expected: string | null;
  inbound_schedule: PurchaseInboundScheduleEntry[];
  receipt_supply_evidence: PurchaseReceiptSupplyEvidence;
}

export function emptyPurchasePlanningSupplyPosition(): PurchasePlanningSupplyPosition {
  return { on_order_pieces: 0, open_po_count: 0, earliest_expected: null, inbound_schedule: [], receipt_supply_evidence: { version: 1, lines: [] } };
}

export class PurchasePlanningSupplyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PurchasePlanningSupplyError"; }
}

/** A closed receipt already changed warehouse stock. Use its net frozen base
 * pieces instead of also crediting the lagging PO received counter as inbound.
 * Unknown history retains the old commitment only as explicitly unresolved
 * evidence; it must never authorize unattended drafting or claim coverage. */
export function projectPurchasePlanningSupply(
  rawLines: readonly PurchasePlanningOpenLine[],
  receiptEvidence: Omit<PurchaseReceiptEvidence, "lines">,
): Map<number, PurchasePlanningSupplyPosition> {
  const lines = purchasePlanningOpenLinesSchema.parse(rawLines);
  const physical = resolvePurchaseReceiptQuantities({ ...receiptEvidence, lines });
  const result = new Map<number, PurchasePlanningSupplyPosition>();
  const receiptIds = new Map<number, number[]>();
  const unlinkedReceiptIds = new Map<number, number[]>();
  for (const receipt of receiptEvidence.receipts) {
    const key = receipt.purchaseOrderLineId ?? receipt.purchaseOrderId;
    if (key === null) continue;
    const map = receipt.purchaseOrderLineId === null ? unlinkedReceiptIds : receiptIds;
    const group = map.get(key) ?? []; group.push(receipt.id); map.set(key, group);
  }
  for (const line of lines) {
    const position = result.get(line.productId) ?? emptyPurchasePlanningSupplyPosition();
    const gross = physical.grossByLine.get(line.id) ?? 0;
    const net = physical.byLine.get(line.id) ?? 0;
    const reviewIssues = [...(physical.issues.get(line.id) ?? [])];
    if (physical.unlinkedPurchaseIds.has(line.purchaseOrderId)) reviewIssues.push("A closed receipt on this PO has no exact purchase line; its product allocation is unresolved.");
    const mirrorIssue = purchaseReceiptMirrorIssue(line.id, line.received, physical);
    if (mirrorIssue) reviewIssues.push(mirrorIssue);
    if (line.cancelled > line.ordered || net + line.cancelled > line.ordered) reviewIssues.push("Closed net receipts and cancellations exceed the ordered base quantity.");
    const unresolved = reviewIssues.length > 0;
    const remainingPieces = Math.max(0, line.ordered - line.cancelled - (unresolved ? line.received : net));
    const arrival = resolvePurchaseOrderArrival(line);
    position.receipt_supply_evidence.lines.push({
      purchaseOrderId: line.purchaseOrderId, purchaseOrderNumber: line.purchaseOrderNumber, purchaseOrderLineId: line.id,
      orderedPieces: line.ordered, cancelledPieces: line.cancelled, poReceivedPieces: line.received,
      postedReceivedPieces: physical.postedNetByLine.get(line.id) ?? 0, closedGrossReceivedPieces: unresolved ? null : gross, closedReceivedPieces: unresolved ? null : net, remainingPieces,
      receivingLineIds: [...(receiptIds.get(line.id) ?? []), ...(unlinkedReceiptIds.get(line.purchaseOrderId) ?? [])].sort((a, b) => a - b),
      reviewIssues,
    });
    if (remainingPieces > 0) {
      const total = BigInt(position.on_order_pieces) + BigInt(remainingPieces);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new PurchasePlanningSupplyError("PLANNING_SUPPLY_QUANTITY_OVERFLOW", "Open purchase quantities exceed the exact supported range.");
      position.on_order_pieces = Number(total);
      position.inbound_schedule.push({ purchaseOrderId: line.purchaseOrderId, purchaseOrderNumber: line.purchaseOrderNumber,
        purchaseOrderLineId: line.id, remainingPieces, expectedDate: arrival.date, expectedDateSource: arrival.source });
    }
    result.set(line.productId, position);
  }
  for (const position of result.values()) {
    position.open_po_count = new Set(position.inbound_schedule.map((line) => line.purchaseOrderId)).size;
    position.earliest_expected = position.inbound_schedule.map((line) => line.expectedDate).filter((date): date is string => date !== null).sort()[0] ?? null;
    // Capture a detached validated value; no source rows or history are changed.
    position.receipt_supply_evidence = purchaseReceiptSupplyEvidenceSchema.parse(position.receipt_supply_evidence);
  }
  return result;
}

