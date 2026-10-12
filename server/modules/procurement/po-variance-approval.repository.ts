import { z } from "zod";
import { readInvoiceBillingSource } from "./invoice-quantity-correction.repository";
import { eq } from "drizzle-orm";
import { auditEvents, poEvents, poExceptions, poStatusHistory } from "@shared/schema";
import type { PoVarianceContext } from "@shared/procurement/po-variance-approval";
import type { PurchaseApprovalSnapshot } from "./purchase-order-approval.policy";
import { readQuantityAmendmentSource, type AmendmentTransaction } from "./po-quantity-amendment.repository";
import { PoVarianceApprovalError } from "./po-variance-approval.policy";
export async function readPoVarianceSource(tx: AmendmentTransaction, id: number, actorId: string) {
  const [scope] = await tx.select({ poId: poExceptions.poId }).from(poExceptions).where(eq(poExceptions.id, id));
  if (!scope) throw new PoVarianceApprovalError("Exception not found.", "PO_VARIANCE_NOT_FOUND", 404);
  // Use the same graph/header/identity/invoice/exception lock order as corrections and closing.
  const source = await readQuantityAmendmentSource(tx, scope.poId, actorId);
  const exception = source.exceptions.find(row => row.id === id);
  if (!exception) throw new PoVarianceApprovalError("Only financial match exceptions use this approval.", "PO_VARIANCE_STATE_INVALID");
  const payload = z.object({ invoiceId: z.number().int().positive() }).safeParse(exception.payload);
  const target = payload.success ? source.facts.invoiceLines.find(row => row.vendorInvoiceId === payload.data.invoiceId) : null;
  if (!target) throw new PoVarianceApprovalError("Map every invoice line to its PO before accepting a financial variance.", "PO_VARIANCE_MAPPING_REQUIRED");
  return { source: await readInvoiceBillingSource(tx, source, target.id), exception };

}
export async function persistPoVarianceApproval(tx: AmendmentTransaction, loaded: Awaited<ReturnType<typeof readPoVarianceSource>>,
  context: PoVarianceContext, reason: string, key: string, approval: PurchaseApprovalSnapshot, at: Date) {
  const actorId = approval.actor.userId, { exception, source } = loaded;
  const [after] = await tx.update(poExceptions).set({ status: "resolved", resolvedBy: actorId, resolvedAt: at, updatedAt: at, resolutionNote: reason })
    .where(eq(poExceptions.id, exception.id)).returning();
  if (!after) throw new PoVarianceApprovalError("The reviewed exception could not be updated.", "PO_VARIANCE_UPDATE_FAILED");
  const evidence = { commandKey: key, reason, approvalConfirmed: true, reviewedSourceVersion: context.sourceVersion,
    sourceFingerprint: context.sourceFingerprint, approvalEvidence: approval, review: context, before: exception, after };
  const [audit] = await tx.insert(auditEvents).values({ timestamp: at, level: "AUDIT", actor: actorId,
    action: "procurement.invoice.variance_approved", target: `po-exception:${exception.id}`,
    changes: { before: exception, after }, context: evidence }).returning({ id: auditEvents.id });
  await tx.insert(poEvents).values({ poId: exception.poId, eventType: "match_variance_approved", actorType: "user", actorId, createdAt: at,
    payloadJson: { contractVersion: 1, auditEventId: audit.id, ...evidence } });
  await tx.insert(poStatusHistory).values({ purchaseOrderId: exception.poId, fromStatus: source.facts.header.status, toStatus: source.facts.header.status,
    changedBy: actorId, changedAt: at, notes: `Administrator accepted current invoice variance: ${reason}` });
  return { exceptionId: exception.id, auditEventId: audit.id, context };
}
