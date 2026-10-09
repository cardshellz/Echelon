import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditEvents } from "@shared/schema";
import { poEvents, poStatusHistory, purchaseOrderLines, vendorInvoiceLines } from "@shared/schema/procurement.schema";
import type { InvoiceQuantityPreview } from "@shared/procurement/invoice-quantity-correction";
import { readQuantityAmendmentSource, type AmendmentTransaction } from "./po-quantity-amendment.repository";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { recomputePurchaseOrderInvoiceMatchesInTransaction } from "./ap-ledger.service";
import { replacePurchaseOrderMatchExceptions } from "./purchase-order-match-exceptions.repository";

export async function readInvoiceQuantitySource(tx: AmendmentTransaction, lineId: number, actorId: string) {
  // Discover the scope, then re-read the exact line under the established graph,
  // PO, invoice and identity locks. This lookup never authorizes a write.
  const [identity] = await tx.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
    .from(vendorInvoiceLines).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, vendorInvoiceLines.purchaseOrderLineId))
    .where(eq(vendorInvoiceLines.id, lineId));
  if (!identity) throw new InvoiceQuantityCorrectionError("This invoice line needs a linked PO before its quantity can be corrected.", "INVOICE_QUANTITY_LINK_MISSING");
  const source = await readQuantityAmendmentSource(tx, identity.purchaseOrderId, actorId);
  if (!source.facts.invoiceLines.some((line) => line.id === lineId)) throw new InvoiceQuantityCorrectionError("The invoice link changed or the invoice was voided. Reload it before correcting quantity.", "INVOICE_QUANTITY_STALE");
  return source;
}
export function invoiceQuantityCorrectionTime(source: Awaited<ReturnType<typeof readInvoiceQuantitySource>>, now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invoice correction clock is invalid.");
  const versionTimes = source.facts.invoiceLines.map((line) => z.date().parse(line.updatedAt).getTime());
  return new Date(Math.max(z.date().parse(now).getTime(), ...versionTimes.map((value) => value + 1)));
}
export async function persistInvoiceQuantityCorrection(
  tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readInvoiceQuantitySource>>,
  preview: InvoiceQuantityPreview, actorId: string, commandKey: string, reason: string, at: Date,
) {
  const before = source.facts.invoiceLines.find((line) => line.id === preview.invoiceLineId)!;
  const [updated] = await tx.update(vendorInvoiceLines).set({ qtyInvoiced: preview.afterQuantity, updatedAt: at })
    .where(and(eq(vendorInvoiceLines.id, before.id), eq(vendorInvoiceLines.vendorInvoiceId, before.vendorInvoiceId), eq(vendorInvoiceLines.purchaseOrderLineId, before.purchaseOrderLineId!)))
    .returning();
  if (!updated) throw new InvoiceQuantityCorrectionError("The locked invoice line could not be updated.", "INVOICE_QUANTITY_UPDATE_FAILED");
  const match = await recomputePurchaseOrderInvoiceMatchesInTransaction(source.facts.header.id, tx, actorId, at);
  const superseded = await replacePurchaseOrderMatchExceptions({ tx, purchaseOrderId: source.facts.header.id, exceptions: source.exceptions, match,
    actorId, at, supersessionNote: "Superseded by an admin-approved invoice quantity correction.", messagePrefix: "Invoice quantity correction", quantityCorrectionInvoiceLineId: before.id });
  const [after] = await tx.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.id, before.id));
  if (!after) throw new InvoiceQuantityCorrectionError("The corrected invoice line could not be verified for its audit record.", "INVOICE_QUANTITY_UPDATE_FAILED");
  const [audit] = await tx.insert(auditEvents).values({
    timestamp: at, level: "AUDIT", actor: actorId, action: "procurement.invoice.quantity_corrected", target: `invoice-line:${before.id}`,
    changes: { before, after }, context: { commandKey, reason, preview, approvalAuthority: source.actor, reviewedSourceVersion: source.sourceVersion,
      supersededMatchExceptions: superseded, resultingMatchSourceFingerprint: match.sourceFingerprint },
  }).returning({ id: auditEvents.id });
  await tx.insert(poEvents).values({ poId: source.facts.header.id, eventType: "invoice_quantity_corrected", actorType: "user", actorId, createdAt: at,
    payloadJson: { auditEventId: audit.id, commandKey, invoiceId: before.vendorInvoiceId, invoiceLineId: before.id, reason, preview,
      contractVersion: 1, before, after, approvalAuthority: source.actor, approvalConfirmed: true, reviewedSourceVersion: source.sourceVersion,
      supersededMatchExceptions: superseded, resultingMatchSourceFingerprint: match.sourceFingerprint } });
  await tx.insert(poStatusHistory).values({ purchaseOrderId: source.facts.header.id, fromStatus: source.facts.header.status, toStatus: source.facts.header.status,
    changedBy: actorId, changedAt: at, revisionNumber: source.facts.header.revisionNumber,
    notes: `Admin corrected invoice #${before.vendorInvoiceId}, line ${before.lineNumber}: ${before.qtyInvoiced} → ${after.qtyInvoiced} pieces. Billed amount and stock unchanged. ${reason}` });
  return { invoiceLineId: before.id, auditEventId: audit.id, preview };
}
