import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().safe();
export const PURCHASE_RECEIPT_SUPPLY_EVIDENCE_LIMIT = 10_000;

/** Captured planning evidence, not an instruction to reconcile or change receipts. */
export const purchaseReceiptSupplyEvidenceSchema = z.object({
  version: z.literal(1),
  lines: z.array(z.object({
    purchaseOrderId: id,
    purchaseOrderNumber: z.string().min(1),
    purchaseOrderLineId: id,
    orderedPieces: quantity,
    cancelledPieces: quantity,
    poReceivedPieces: quantity,
    postedReceivedPieces: quantity,
    closedGrossReceivedPieces: quantity.nullable(),
    closedReceivedPieces: quantity.nullable(),
    remainingPieces: quantity,
    receivingLineIds: z.array(id).max(PURCHASE_RECEIPT_SUPPLY_EVIDENCE_LIMIT),
    reviewIssues: z.array(z.string().min(1)).max(PURCHASE_RECEIPT_SUPPLY_EVIDENCE_LIMIT),
  }).strict()).max(PURCHASE_RECEIPT_SUPPLY_EVIDENCE_LIMIT),
}).strict().superRefine((capture, context) => {
  const ids = new Set<number>();
  capture.lines.forEach((line, index) => {
    if (ids.has(line.purchaseOrderLineId)) context.addIssue({ code: "custom", path: ["lines", index], message: "Duplicate purchase line receipt evidence" });
    ids.add(line.purchaseOrderLineId);
    if (line.reviewIssues.length > 0) return;
    const gross = line.closedGrossReceivedPieces;
    const net = line.closedReceivedPieces;
    if (gross === null || net === null || net > gross || line.poReceivedPieces !== line.postedReceivedPieces || line.postedReceivedPieces > net
      || line.cancelledPieces > line.orderedPieces || net > line.orderedPieces - line.cancelledPieces
      || line.remainingPieces !== line.orderedPieces - line.cancelledPieces - net) {
      context.addIssue({ code: "custom", path: ["lines", index], message: "Resolved receipt evidence does not reconcile to the remaining ordered pieces" });
    }
  });
});

export type PurchaseReceiptSupplyEvidence = z.infer<typeof purchaseReceiptSupplyEvidenceSchema>;


/** Absence is not proof of zero physical receipts. Old immutable recommendation
 * captures remain readable but cannot newly authorize unattended sourcing. */
export function inspectPurchaseReceiptSupplyCapture(raw: unknown, onOrderPieces: unknown): {
  evidence: PurchaseReceiptSupplyEvidence | null;
  reviewRequired: boolean;
  unresolvedPieces: number | null;
  detail: string | null;
} {
  const parsed = purchaseReceiptSupplyEvidenceSchema.safeParse(raw);
  if (!parsed.success || typeof onOrderPieces !== "number" || !Number.isSafeInteger(onOrderPieces) || onOrderPieces < 0
    || parsed.data.lines.reduce((sum, line) => sum + BigInt(line.remainingPieces), BigInt(0)) !== BigInt(onOrderPieces)) {
    return { evidence: null, reviewRequired: true, unresolvedPieces: null,
      detail: "The recommendation has no complete receipt-aware supply capture matching its open commitment. Review a newly generated recommendation before unattended drafting; existing RFQs remain unchanged." };
  }
  const unresolved = parsed.data.lines.filter((line) => line.reviewIssues.length > 0);
  return { evidence: parsed.data, reviewRequired: unresolved.length > 0,
    unresolvedPieces: Number(unresolved.reduce((sum, line) => sum + BigInt(line.remainingPieces), BigInt(0))),
    detail: unresolved.length === 0 ? null : unresolved.slice(0, 3).map((line) => `${line.purchaseOrderNumber} line ${line.purchaseOrderLineId}: ${line.reviewIssues.join(" ")}`).join(" ") };
}
