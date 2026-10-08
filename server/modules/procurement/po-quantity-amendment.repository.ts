import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  poApprovalTiers, poEvents, poExceptions, poReceipts, poRevisions, poStatusHistory,
  purchaseOrders, purchaseOrderLines, purchasingRecommendationPoHandoffs,
  vendorInvoiceLines, vendorInvoicePoLinks, vendorInvoices,
} from "@shared/schema/procurement.schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { warehouseSettings } from "@shared/schema/inventory.schema";
import { z } from "zod";
import type { PurchaseApprovalSnapshot } from "./purchase-order-approval.policy";
import { readPurchaseApprovalActor } from "../identity/infrastructure/purchase-approval-access.repository";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { recomputePurchaseOrderInvoiceMatchesInTransaction } from "./ap-ledger.service";
import { computePayloadHash } from "./po-exceptions.service";
import { PoQuantityAmendmentError, type AmendmentPlan } from "./po-quantity-amendment.policy";
import type { db } from "../../db";

export type AmendmentDatabase = Pick<typeof db, "transaction">;
export type AmendmentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Cost owners acquire this graph lock first; header/line locks serialize the
 * amendment with receipts, lifecycle transitions and competing amendments. */
export async function readQuantityAmendmentSource(tx: AmendmentTransaction, purchaseOrderId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const [header] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).for("update");
  if (!header) throw new PoQuantityAmendmentError("Purchase order not found.", "PO_AMENDMENT_NOT_FOUND", 404);
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)).orderBy(asc(purchaseOrderLines.id)).for("update");
  const handoffs = await tx.select().from(purchasingRecommendationPoHandoffs).where(eq(purchasingRecommendationPoHandoffs.purchaseOrderId, purchaseOrderId)).for("share");
  const links = await tx.select().from(vendorInvoicePoLinks).where(eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId)).orderBy(asc(vendorInvoicePoLinks.id)).for("share");
  const invoiceIds = [...new Set(links.map((link) => link.vendorInvoiceId))].sort((a, b) => a - b);
  const invoices = invoiceIds.length ? await tx.select().from(vendorInvoices).where(inArray(vendorInvoices.id, invoiceIds)).orderBy(asc(vendorInvoices.id)).for("update") : [];
  const activeIds = invoices.filter((invoice) => invoice.status !== "voided").map((invoice) => invoice.id);
  const allInvoiceLines = activeIds.length ? await tx.select().from(vendorInvoiceLines).where(inArray(vendorInvoiceLines.vendorInvoiceId, activeIds)).orderBy(asc(vendorInvoiceLines.id)).for("update") : [];
  const lineIds = new Set(lines.map((line) => line.id));
  const invoiceLines = allInvoiceLines.filter((line) => line.purchaseOrderLineId === null || lineIds.has(line.purchaseOrderLineId));
  const receipts = await tx.select().from(poReceipts).where(eq(poReceipts.purchaseOrderId, purchaseOrderId)).orderBy(asc(poReceipts.id));
  const exceptions = await tx.select().from(poExceptions).where(and(eq(poExceptions.poId, purchaseOrderId), eq(poExceptions.kind, "match_mismatch"))).orderBy(asc(poExceptions.id)).for("update");
  const settingsRows = await tx.select({ requireApproval: warehouseSettings.requireApproval }).from(warehouseSettings).where(eq(warehouseSettings.warehouseCode, "DEFAULT")).limit(1).for("share");
  const fallback = settingsRows.length ? settingsRows : await tx.select({ requireApproval: warehouseSettings.requireApproval }).from(warehouseSettings).limit(1).for("share");
  // Mirrors the procurement setting owner and schema DEFAULT false. Disabling
  // ordinary PO approval never disables this feature's administrator gate.
  const requireApproval = fallback.length ? z.boolean().parse(fallback[0].requireApproval) : false;
  const approvalTiers = await tx.select().from(poApprovalTiers).where(eq(poApprovalTiers.active, 1)).orderBy(asc(poApprovalTiers.id)).for("share");
  const facts = { header, lines, invoices, invoiceLines, recommendationOwned: handoffs.length > 0 };
  // Full row versions cover price metadata, counters, invoice void/payment changes,
  // receipt evidence and variance approvals. No client amount is authoritative.
  const sourceVersion = createHash("sha256").update(canonicalJson({ facts, actor, links, handoffs, receipts, exceptions, requireApproval, approvalTiers })).digest("hex");
  return { facts, actor, sourceVersion, exceptions, requireApproval, approvalTiers };
}

export async function persistQuantityAmendment(
  tx: AmendmentTransaction,
  source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>,
  plan: AmendmentPlan,
  actorId: string,
  commandKey: string,
  approvedAt: Date,
  approvalEvidence: PurchaseApprovalSnapshot,
) {
  const { header, lines } = source.facts;
  const revisionNumber = (header.revisionNumber ?? 0) + 1;
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber > 2_147_483_647) throw new PoQuantityAmendmentError("The revision limit has been reached.", "PO_AMENDMENT_REVISION_LIMIT");
  for (const change of plan.patches) {
    const before = lines.find((line) => line.id === change.id)!;
    await tx.update(purchaseOrderLines).set({
      ...change.patch,
      fullyReceivedDate: change.patch.status === "received" ? before.fullyReceivedDate ?? approvedAt : null,
      // Keep the original quote reference/dates as document provenance. The
      // event records both quote shapes and the admin's explicit price treatment.
      updatedAt: sql`GREATEST(${approvedAt}::timestamp, ${before.updatedAt}::timestamp + interval '1 millisecond')`,
    }).where(and(eq(purchaseOrderLines.id, change.id), eq(purchaseOrderLines.purchaseOrderId, header.id)));
    await tx.insert(poRevisions).values({
      purchaseOrderId: header.id, revisionNumber, changedBy: actorId, changeType: "qty_changed", fieldChanged: "orderQty",
      oldValue: String(before.orderQty), newValue: String(change.patch.orderQty), lineId: change.id, notes: plan.preview.reason, createdAt: approvedAt,
    });
  }
  const statusChanged = header.status !== plan.preview.afterStatus;
  const [afterHeader] = await tx.update(purchaseOrders).set({
    subtotalCents: plan.subtotalCents, totalCents: plan.preview.afterTotalCents, revisionNumber,
    approvalTierId: approvalEvidence.tier?.id ?? null, approvedBy: actorId, approvedAt, approvalNotes: plan.preview.reason,
    receivedLineCount: plan.receivedLineCount,
    status: plan.preview.afterStatus,
    physicalStatus: plan.preview.afterStatus === "received" ? "received" : plan.preview.afterStatus === "partially_received" ? "receiving" : header.physicalStatus,
    updatedBy: actorId, updatedAt: sql`GREATEST(${approvedAt}::timestamp, ${header.updatedAt}::timestamp + interval '1 millisecond')`,
  }).where(eq(purchaseOrders.id, header.id)).returning();
  await tx.insert(poStatusHistory).values({
    purchaseOrderId: header.id, fromStatus: header.status, toStatus: plan.preview.afterStatus,
    changedBy: actorId, changedAt: approvedAt, revisionNumber,
    notes: `Admin approved quantity correction (revision ${revisionNumber})${statusChanged ? "; receiving status recalculated" : ""}: ${plan.preview.reason}`,
  });
  const match = await recomputePurchaseOrderInvoiceMatchesInTransaction(header.id, tx, actorId, approvedAt);
  const superseded = source.exceptions.filter((exception) => exception.status !== "dismissed");
  // Dismiss (never resolve) old match evidence. A previously accepted variance
  // must not authorize this revision, including a later return to old quantities.
  if (superseded.length) await tx.update(poExceptions).set({
    status: "dismissed", dismissedBy: actorId, dismissedAt: approvedAt,
    dismissNote: `Superseded by admin-approved quantity revision ${revisionNumber}.`, updatedAt: approvedAt,
  }).where(and(eq(poExceptions.poId, header.id), eq(poExceptions.kind, "match_mismatch"), ne(poExceptions.status, "dismissed")));
  for (const invoiceId of match.activeInvoiceIds) {
    const issues = match.results.filter((line) => line.vendorInvoiceId === invoiceId && line.matchStatus !== "matched");
    if (!issues.length && !match.invoicesWithoutMappedLines.includes(invoiceId)) continue;
    const invoiceNumber = match.invoiceNumbersById.get(invoiceId) ?? `#${invoiceId}`;
    const statuses = [...new Set(issues.map((line) => line.matchStatus))];
    const payload = {
      invoiceId, invoiceNumber, revisionNumber, sourceVersion: 1, sourceFingerprint: match.sourceFingerprint,
      mismatchedLineCount: issues.length, mismatchedLineIds: issues.map((line) => line.id).sort((a, b) => a - b), matchStatuses: statuses,
      unmappedInvoice: match.invoicesWithoutMappedLines.includes(invoiceId),
    };
    await tx.insert(poExceptions).values({
      poId: header.id, kind: "match_mismatch", severity: "warn", status: "open", payload,
      payloadHash: computePayloadHash(header.id, "match_mismatch", payload),
      title: `3-way match discrepancy — Invoice ${invoiceNumber}`.slice(0, 120),
      message: `Quantity revision ${revisionNumber} leaves ${issues.length} invoice line issue(s): ${statuses.join(", ") || "unmapped invoice"}. Review the current invoice evidence.`,
      detectedBy: "system", detectedAt: approvedAt, updatedAt: approvedAt,
    });
  }
  const afterLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, header.id)).orderBy(asc(purchaseOrderLines.id));
  const [event] = await tx.insert(poEvents).values({
    poId: header.id, eventType: "quantity_amendment_approved", actorType: "user", actorId, createdAt: approvedAt,
    payloadJson: {
      contractVersion: 1, commandKey, revisionNumber, reason: plan.preview.reason, approvedAt: approvedAt.toISOString(),
      approvalEvidence: source.actor, approval_authority: approvalEvidence, reviewedSourceVersion: source.sourceVersion,
      preview: plan.preview, before: { header, lines }, after: { header: afterHeader, lines: afterLines },
      supersededMatchExceptions: superseded, resultingMatchSourceFingerprint: match.sourceFingerprint,
    },
  }).returning({ id: poEvents.id });
  return { purchaseOrderId: header.id, revisionNumber, auditEventId: event.id, preview: plan.preview };
}
