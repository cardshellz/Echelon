import { sql } from "drizzle-orm";

const MAX_DATABASE_INTEGER = 2_147_483_647;

export type PostedReceiptUnitEvidence = {
  receivingLineId: number;
  receivingOrderId: number;
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  qtyReceived: number;
};

export type ReceivingUnitSnapshotInput = {
  receivingLineId: number;
  receivingOrderId: number;
  purchaseOrderLineId: number | null;
  purchaseOrderId: number | null;
  receivedQty: number;
  unitsPerVariantSnapshot: number | null | undefined;
  receiptStatus: string;
  postedReceipts: readonly PostedReceiptUnitEvidence[];
};

export class ReceivingUnitSnapshotError extends Error {
  readonly statusCode = 409;
  readonly details: { code: "RECEIVING_UNIT_SNAPSHOT_REVIEW_REQUIRED"; receivingLineId: number; reason: string };

  constructor(receivingLineId: number, reason: string) {
    super(`Receiving line ${receivingLineId} needs its recorded receive units reviewed: ${reason}. Confirm its original pack size and posting before retrying; current catalog units cannot reinterpret this receipt.`);
    this.name = "ReceivingUnitSnapshotError";
    this.details = { code: "RECEIVING_UNIT_SNAPSHOT_REVIEW_REQUIRED", receivingLineId, reason };
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_DATABASE_INTEGER;
}

/** The only legacy fallback is exact, immutable PO posting evidence. No live
 * catalog lookup or historical-row mutation belongs in this resolver. */
export function resolveReceivingUnitSnapshot(input: ReceivingUnitSnapshotInput): number {
  const reject = (reason: string): never => { throw new ReceivingUnitSnapshotError(input.receivingLineId, reason); };
  if (!Number.isInteger(input.receivedQty) || input.receivedQty < 0 || input.receivedQty > MAX_DATABASE_INTEGER) reject("recorded received quantity is invalid");
  if (input.postedReceipts.length > 1) reject("more than one PO posting refers to this receiving line");
  const posting = input.postedReceipts[0];
  if (posting && (
    posting.receivingLineId !== input.receivingLineId || posting.receivingOrderId !== input.receivingOrderId ||
    posting.purchaseOrderLineId !== input.purchaseOrderLineId || posting.purchaseOrderId !== input.purchaseOrderId ||
    !Number.isInteger(posting.qtyReceived) || posting.qtyReceived < 0 || posting.qtyReceived > MAX_DATABASE_INTEGER
  )) reject("the PO posting does not prove this line's source and quantity");

  if (input.unitsPerVariantSnapshot != null) {
    if (!positiveInteger(input.unitsPerVariantSnapshot)) reject("the frozen units per variant are invalid");
    const baseQty = input.receivedQty * input.unitsPerVariantSnapshot;
    if (!Number.isSafeInteger(baseQty) || baseQty > MAX_DATABASE_INTEGER) reject("recorded base quantity exceeds the supported range");
    if (posting && posting.qtyReceived !== baseQty) reject("the frozen pack size disagrees with the original PO posting");
    return input.unitsPerVariantSnapshot;
  }

  if (input.receiptStatus !== "closed" || !posting || input.receivedQty === 0 || posting.qtyReceived === 0) {
    reject("no frozen pack size or exact closed-receipt posting is available");
  }
  const factor = posting.qtyReceived / input.receivedQty;
  if (!positiveInteger(factor)) reject("the original posting is not an exact whole-unit conversion");
  return factor;
}

export async function readPostedReceiptUnitEvidence(
  executor: { execute(query: unknown): Promise<{ rows: unknown[] }> },
  receivingLineId: number,
): Promise<PostedReceiptUnitEvidence[]> {
  const result = await executor.execute(sql`
    SELECT receiving_line_id AS "receivingLineId", receiving_order_id AS "receivingOrderId",
           purchase_order_line_id AS "purchaseOrderLineId", purchase_order_id AS "purchaseOrderId",
           qty_received AS "qtyReceived"
    FROM procurement.po_receipts
    WHERE receiving_line_id = ${receivingLineId}
    ORDER BY id LIMIT 2
  `);
  if (!Array.isArray(result.rows)) throw new Error("Receipt unit evidence query returned an invalid result");
  return result.rows as PostedReceiptUnitEvidence[];
}
