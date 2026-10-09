import { and, eq, ne } from "drizzle-orm";
import { poExceptions } from "@shared/schema/procurement.schema";
import { computePayloadHash } from "./po-exceptions.service";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import type { PurchaseOrderInvoiceMatchTransactionResult } from "./ap-ledger.service";

/** Old variance decisions never authorize changed quantity evidence. Both PO and
 * invoice correction owners replace the evidence inside their own transaction. */
export async function replacePurchaseOrderMatchExceptions(input: {
  tx: AmendmentTransaction; purchaseOrderId: number;
  exceptions: Array<typeof poExceptions.$inferSelect>;
  match: PurchaseOrderInvoiceMatchTransactionResult;
  actorId: string; at: Date; supersessionNote: string; messagePrefix: string;
  revisionNumber?: number; quantityCorrectionInvoiceLineId?: number;
}) {
  const { tx, purchaseOrderId, match, actorId, at } = input;
  const superseded = input.exceptions.filter((exception) => exception.status !== "dismissed");
  if (superseded.length) await tx.update(poExceptions).set({
    status: "dismissed", dismissedBy: actorId, dismissedAt: at, dismissNote: input.supersessionNote, updatedAt: at,
  }).where(and(eq(poExceptions.poId, purchaseOrderId), eq(poExceptions.kind, "match_mismatch"), ne(poExceptions.status, "dismissed")));
  for (const invoiceId of match.activeInvoiceIds) {
    const issues = match.results.filter((line) => line.vendorInvoiceId === invoiceId && line.matchStatus !== "matched");
    if (!issues.length && !match.invoicesWithoutMappedLines.includes(invoiceId)) continue;
    const invoiceNumber = match.invoiceNumbersById.get(invoiceId) ?? `#${invoiceId}`;
    const statuses = [...new Set(issues.map((line) => line.matchStatus))];
    const payload = {
      invoiceId, invoiceNumber, ...(input.revisionNumber === undefined ? {} : { revisionNumber: input.revisionNumber }),
      ...(input.quantityCorrectionInvoiceLineId === undefined ? {} : { quantityCorrectionInvoiceLineId: input.quantityCorrectionInvoiceLineId }),
      sourceVersion: 1, sourceFingerprint: match.sourceFingerprint,
      mismatchedLineCount: issues.length, mismatchedLineIds: issues.map((line) => line.id).sort((a, b) => a - b), matchStatuses: statuses,
      unmappedInvoice: match.invoicesWithoutMappedLines.includes(invoiceId),
    };
    await tx.insert(poExceptions).values({
      poId: purchaseOrderId, kind: "match_mismatch", severity: "warn", status: "open", payload,
      payloadHash: computePayloadHash(purchaseOrderId, "match_mismatch", payload),
      title: `3-way match discrepancy — Invoice ${invoiceNumber}`.slice(0, 120),
      message: `${input.messagePrefix} leaves ${issues.length} invoice line issue(s): ${statuses.join(", ") || "unmapped invoice"}. Review the current invoice evidence.`,
      detectedBy: "system", detectedAt: at, updatedAt: at,
    });
  }
  return superseded;
}
