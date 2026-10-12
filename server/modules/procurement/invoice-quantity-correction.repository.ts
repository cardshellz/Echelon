import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditEvents } from "@shared/schema";
import { poEvents, poStatusHistory, purchaseOrderLines, vendorInvoiceLines, vendorInvoices, vendorInvoicePoLinks, apPaymentAllocations, apPayments } from "@shared/schema/procurement.schema";
import { centsToMills, millsToCents } from "@shared/utils/money";
import type { InvoiceQuantityPreview } from "@shared/procurement/invoice-quantity-correction";
import { readQuantityAmendmentSource, type AmendmentTransaction } from "./po-quantity-amendment.repository";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { recalculateCorrectedInvoiceFinancialsInTransaction, recomputePurchaseOrderInvoiceMatchesInTransaction } from "./ap-ledger.service";
import { replacePurchaseOrderMatchExceptions } from "./purchase-order-match-exceptions.repository";

import type { PurchaseApprovalSnapshot } from "./purchase-order-approval.policy";

export async function readInvoiceQuantitySource(tx: AmendmentTransaction, lineId: number, actorId: string) {
  // Discover the scope, then re-read the exact line under the established graph,
  // PO, invoice and identity locks. This lookup never authorizes a write.
  const [identity] = await tx.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
    .from(vendorInvoiceLines).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, vendorInvoiceLines.purchaseOrderLineId))
    .where(eq(vendorInvoiceLines.id, lineId));
  if (!identity) throw new InvoiceQuantityCorrectionError("This invoice line needs a linked PO before its quantity can be corrected.", "INVOICE_QUANTITY_LINK_MISSING");
  const source = await readQuantityAmendmentSource(tx, identity.purchaseOrderId, actorId);
  return readInvoiceBillingSource(tx, source, lineId);
}
/** Complete document and allocation evidence, shared by correction and variance approval. */
export async function readInvoiceBillingSource(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>, lineId: number) {
  if (!source.facts.invoiceLines.some((line) => line.id === lineId)) throw new InvoiceQuantityCorrectionError("The invoice link changed or the invoice was voided. Reload it before correcting quantity.", "INVOICE_QUANTITY_STALE");
  const target = source.facts.invoiceLines.find(line => line.id === lineId)!;
  const allInvoiceLines = await tx.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.vendorInvoiceId, target.vendorInvoiceId)).orderBy(vendorInvoiceLines.id).for("update");
  const allocations = await tx.select({ allocation: apPaymentAllocations, payment: apPayments }).from(apPaymentAllocations)
    .innerJoin(apPayments, eq(apPayments.id, apPaymentAllocations.apPaymentId))
    .where(eq(apPaymentAllocations.vendorInvoiceId, target.vendorInvoiceId)).orderBy(apPaymentAllocations.id).for("share");
  const invoicePoLinks = await tx.select().from(vendorInvoicePoLinks).where(eq(vendorInvoicePoLinks.vendorInvoiceId, target.vendorInvoiceId)).orderBy(vendorInvoicePoLinks.id).for("share");
  const billing = { purchaseOrderIds: invoicePoLinks.map(row => row.purchaseOrderId), invoiceId: target.vendorInvoiceId, allInvoiceLines,
    allocations: allocations.map(row => ({ invoiceId: row.allocation.vendorInvoiceId, amountCents: row.allocation.appliedAmountCents, paymentStatus: row.payment.status, currency: row.payment.currency })) };
  return { ...source, facts: { ...source.facts, billing },
    sourceVersion: createHash("sha256").update(canonicalJson({ sourceVersion: source.sourceVersion, allInvoiceLines, allocations, invoicePoLinks })).digest("hex") };
}
export function invoiceQuantityCorrectionTime(source: Awaited<ReturnType<typeof readInvoiceQuantitySource>>, now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invoice correction clock is invalid.");
  const versionTimes = source.facts.invoiceLines.map((line) => z.date().parse(line.updatedAt).getTime());
  return new Date(Math.max(z.date().parse(now).getTime(), ...versionTimes.map((value) => value + 1)));
}
export async function persistInvoiceQuantityCorrection(
  tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readInvoiceQuantitySource>>,
  preview: InvoiceQuantityPreview, actorId: string, commandKey: string, reason: string, at: Date,
  approvalEvidence: PurchaseApprovalSnapshot, closedPurchaseOrderConfirmed: boolean,
) {
  const before = source.facts.invoiceLines.find((line) => line.id === preview.invoiceLineId)!;
  const explicitCorrection = preview.afterLineAmountCents !== undefined && preview.afterUnitCostMills !== undefined;
  const moneyChanged = explicitCorrection && (preview.afterLineAmountCents !== before.lineTotalCents || preview.afterUnitCostMills !== (before.unitCostMills ?? centsToMills(before.unitCostCents)));
  const [updated] = await tx.update(vendorInvoiceLines).set({ qtyInvoiced: preview.afterQuantity, updatedAt: at,
    ...(moneyChanged ? { lineTotalCents: preview.afterLineAmountCents, unitCostMills: preview.afterUnitCostMills,
      unitCostCents: millsToCents(preview.afterUnitCostMills!), costComponentEvidence: null } : {}),
  })
    .where(and(eq(vendorInvoiceLines.id, before.id), eq(vendorInvoiceLines.vendorInvoiceId, before.vendorInvoiceId), eq(vendorInvoiceLines.purchaseOrderLineId, before.purchaseOrderLineId!)))
    .returning();
  if (!updated) throw new InvoiceQuantityCorrectionError("The locked invoice line could not be updated.", "INVOICE_QUANTITY_UPDATE_FAILED");
  if (moneyChanged) await recalculateCorrectedInvoiceFinancialsInTransaction(before.vendorInvoiceId, tx, actorId, at);
  const [afterInvoice] = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.id, before.vendorInvoiceId));
  const beforeInvoice = source.facts.invoices.find(invoice => invoice.id === before.vendorInvoiceId)!;
  if (!afterInvoice || afterInvoice.invoicedAmountCents !== (preview.afterInvoiceAmountCents ?? preview.invoiceAmountCents)
    || afterInvoice.balanceCents !== (preview.afterBalanceCents ?? preview.balanceCents)
    || afterInvoice.paidAmountCents !== preview.paidAmountCents || afterInvoice.status !== preview.afterInvoiceStatus) throw new InvoiceQuantityCorrectionError("The corrected invoice totals do not match the reviewed amounts.", "INVOICE_CORRECTION_FINANCIAL_MISMATCH");
  const match = await recomputePurchaseOrderInvoiceMatchesInTransaction(source.facts.header.id, tx, actorId, at);
  const superseded = await replacePurchaseOrderMatchExceptions({ tx, purchaseOrderId: source.facts.header.id, exceptions: source.exceptions, match,
    actorId, at, supersessionNote: "Superseded by an admin-approved invoice quantity correction.", messagePrefix: "Invoice quantity correction", quantityCorrectionInvoiceLineId: before.id });
  const [after] = await tx.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.id, before.id));
  if (!after) throw new InvoiceQuantityCorrectionError("The corrected invoice line could not be verified for its audit record.", "INVOICE_QUANTITY_UPDATE_FAILED");
  const [audit] = await tx.insert(auditEvents).values({
    timestamp: at, level: "AUDIT", actor: actorId, action: moneyChanged ? "procurement.invoice.line_corrected" : "procurement.invoice.quantity_corrected", target: `invoice-line:${before.id}`,
    changes: { before, after, ...(moneyChanged ? { beforeInvoice, afterInvoice } : {}) }, context: { commandKey, reason, preview, approvalAuthority: source.actor, approvalEvidence, closedPurchaseOrderConfirmed, reviewedSourceVersion: source.sourceVersion,
      supersededMatchExceptions: superseded, resultingMatchSourceFingerprint: match.sourceFingerprint },
  }).returning({ id: auditEvents.id });
  await tx.insert(poEvents).values({ poId: source.facts.header.id, eventType: moneyChanged ? "invoice_line_corrected" : "invoice_quantity_corrected", actorType: "user", actorId, createdAt: at,
    payloadJson: { auditEventId: audit.id, commandKey, invoiceId: before.vendorInvoiceId, invoiceLineId: before.id, reason, preview,
      contractVersion: 1, before, after, ...(moneyChanged ? { beforeInvoice, afterInvoice } : {}), approvalAuthority: source.actor, approvalEvidence, closedPurchaseOrderConfirmed, approvalConfirmed: true, reviewedSourceVersion: source.sourceVersion,
      supersededMatchExceptions: superseded, resultingMatchSourceFingerprint: match.sourceFingerprint } });
  await tx.insert(poStatusHistory).values({ purchaseOrderId: source.facts.header.id, fromStatus: source.facts.header.status, toStatus: source.facts.header.status,
    changedBy: actorId, changedAt: at, revisionNumber: source.facts.header.revisionNumber,
    notes: `Admin corrected invoice #${before.vendorInvoiceId}, line ${before.lineNumber}: ${before.qtyInvoiced} → ${after.qtyInvoiced} pieces. ${moneyChanged ? `Line amount ${before.lineTotalCents} → ${after.lineTotalCents} cents; invoice balance ${beforeInvoice.balanceCents} → ${afterInvoice.balanceCents} cents. Payments and stock unchanged.` : "Billed amount and stock unchanged."} ${reason}` });
  return { invoiceLineId: before.id, auditEventId: audit.id, preview };
}
