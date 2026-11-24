import { z } from "zod";
import { resolveReceivingUnitSnapshot, type PostedReceiptUnitEvidence } from "./receiving-unit-snapshot";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
export const PURCHASE_RECEIPT_EVIDENCE_LIMIT = 10_000;
export const purchaseReceiptEvidenceSchema = z.object({
  lines: z.array(z.object({ id, purchaseOrderId: id })).max(PURCHASE_RECEIPT_EVIDENCE_LIMIT),
  shipments: z.array(z.object({ id, shipmentId: id, purchaseOrderId: id.nullable(), purchaseOrderLineId: id.nullable() })).max(PURCHASE_RECEIPT_EVIDENCE_LIMIT),
  receipts: z.array(z.object({
    id, receivingOrderId: id, purchaseOrderId: id.nullable(), purchaseOrderLineId: id.nullable(), shipmentId: id.nullable(), shipmentLineId: id.nullable(),
    received: quantity, reversed: quantity, units: z.number().int().nullable(), status: z.literal("closed"),
  })).max(PURCHASE_RECEIPT_EVIDENCE_LIMIT),
  postings: z.array(z.object({ receivingLineId: id, receivingOrderId: id, purchaseOrderId: id, purchaseOrderLineId: id, qtyReceived: quantity })).max(PURCHASE_RECEIPT_EVIDENCE_LIMIT),
  reversals: z.array(z.object({ id, receivingLineId: id, receivingOrderId: id, qty: quantity.positive(), baseUnitsReversed: quantity.positive().nullable() })).max(PURCHASE_RECEIPT_EVIDENCE_LIMIT),
});
export type PurchaseReceiptEvidence = z.infer<typeof purchaseReceiptEvidenceSchema>;
export type PurchaseReceiptQuantities = {
  byLine: Map<number, number>;
  grossByLine: Map<number, number>;
  // Only exact original PO postings, net of their proven reversals, support the
  // mirrored PO counter. Newly closed unposted receipts never fill history gaps.
  postedNetByLine: Map<number, number>;
  byShipmentLine: Map<number, number>;
  issues: Map<number, string[]>;
  unlinkedPurchaseIds: Set<number>;
};

function indexed<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) { const id = key(row); const group = result.get(id) ?? []; group.push(row); result.set(id, group); }
  return result;
}
function exactSum(values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + BigInt(value), BigInt(0));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Recorded receipt quantities exceed the exact supported range.");
  return Number(result);
}

/** Closed physical quantities use frozen receipt units and exact original
 * posting/reversal identities. Current catalog packs never reinterpret history. */
export function resolvePurchaseReceiptQuantities(input: PurchaseReceiptEvidence): PurchaseReceiptQuantities {
  const data = purchaseReceiptEvidenceSchema.parse(input);
  for (const rows of [data.lines, data.shipments, data.receipts, data.reversals]) {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Duplicate purchase receipt evidence identities require review.");
  }
  const postings = indexed(data.postings, (row) => row.receivingLineId);
  const reversals = indexed(data.reversals, (row) => row.receivingLineId);
  const sourceLines = new Map(data.lines.map((line) => [line.id, line]));
  const shipmentLines = new Map(data.shipments.map((line) => [line.id, line]));
  const shipmentCandidates = new Map<string, PurchaseReceiptEvidence["shipments"][number][]>();
  for (const shipment of data.shipments) { const key = `${shipment.shipmentId}:${shipment.purchaseOrderLineId}`; const candidates = shipmentCandidates.get(key) ?? []; candidates.push(shipment); shipmentCandidates.set(key, candidates); }
  const postedNetByLine = new Map<number, number>(); const grossByLine = new Map<number, number>(); const byLine = new Map<number, number>(); const byShipmentLine = new Map<number, number>(); const issues = new Map<number, string[]>(); const unlinkedPurchaseIds = new Set<number>();
  for (const row of data.receipts) {
    if (row.received === 0 && row.reversed === 0 && !postings.has(row.id) && !reversals.has(row.id)) continue;
    if (row.purchaseOrderLineId === null) { if (row.purchaseOrderId !== null) unlinkedPurchaseIds.add(row.purchaseOrderId); continue; }
    const line = sourceLines.get(row.purchaseOrderLineId);
    if (!line) continue;
    try {
      if (row.purchaseOrderId !== null && row.purchaseOrderId !== line.purchaseOrderId) throw new Error("Receipt purchase identity conflicts with its exact line.");
      const factor = resolveReceivingUnitSnapshot({ receivingLineId: row.id, receivingOrderId: row.receivingOrderId, purchaseOrderLineId: line.id, purchaseOrderId: line.purchaseOrderId,
        receivedQty: row.received, unitsPerVariantSnapshot: row.units, receiptStatus: row.status, postedReceipts: (postings.get(row.id) ?? []) as PostedReceiptUnitEvidence[] });
      const changes = reversals.get(row.id) ?? [];
      if (row.reversed > row.received || exactSum(changes.map((change) => change.qty)) !== row.reversed || changes.some((change) => change.receivingOrderId !== row.receivingOrderId || change.baseUnitsReversed !== change.qty * factor)) throw new Error("Receipt reversal evidence is incomplete or conflicts with frozen units.");
      const net = row.received * factor - exactSum(changes.map((change) => change.baseUnitsReversed!));
      let shipment: PurchaseReceiptEvidence["shipments"][number] | undefined;
      if (row.shipmentLineId !== null) shipment = shipmentLines.get(row.shipmentLineId);
      else if (row.shipmentId !== null) {
        const candidates = shipmentCandidates.get(`${row.shipmentId}:${line.id}`) ?? [];
        // Same fallback as the receipt owner: exactly one source and original PO posting.
        if (candidates.length === 1 && (postings.get(row.id)?.length ?? 0) === 1) shipment = candidates[0];
      }
      if ((row.shipmentId !== null || row.shipmentLineId !== null) && (!shipment || shipment.purchaseOrderLineId !== line.id || shipment.shipmentId !== row.shipmentId || (shipment.purchaseOrderId !== null && shipment.purchaseOrderId !== line.purchaseOrderId))) throw new Error("Receipt cannot be assigned to one exact shipment line.");
      const grossTotal = exactSum([grossByLine.get(line.id) ?? 0, row.received * factor]);
      const netTotal = exactSum([byLine.get(line.id) ?? 0, net]);
      const postedNetTotal = exactSum([postedNetByLine.get(line.id) ?? 0, postings.get(row.id)?.length === 1 ? net : 0]);
      const shipmentTotal = shipment ? exactSum([byShipmentLine.get(shipment.id) ?? 0, net]) : null;
      grossByLine.set(line.id, grossTotal);
      byLine.set(line.id, netTotal);
      postedNetByLine.set(line.id, postedNetTotal);
      if (shipment && shipmentTotal !== null) byShipmentLine.set(shipment.id, shipmentTotal);
    } catch (error) {
      const group = issues.get(line.id) ?? [];
      group.push(`Receipt ${row.receivingOrderId}: ${error instanceof Error ? error.message : "Recorded units need review."}`); issues.set(line.id, group);
    }
  }
  return { byLine, grossByLine, postedNetByLine, byShipmentLine, issues, unlinkedPurchaseIds };
}


/** PO receipt posting and mirror updates commit atomically. The reversal owner
 * likewise updates physical stock and the mirror together. A larger new
 * unposted physical receipt is not evidence for an older mirrored quantity. */
export function purchaseReceiptMirrorIssue(lineId: number, mirroredPieces: number, evidence: PurchaseReceiptQuantities): string | null {
  const postedNet = evidence.postedNetByLine.get(lineId) ?? 0;
  return mirroredPieces === postedNet ? null
    : `The PO records ${mirroredPieces} received pieces, but exact posted receipt/reversal evidence supports ${postedNet}. Unposted physical receipts cannot resolve missing PO history.`;
}
