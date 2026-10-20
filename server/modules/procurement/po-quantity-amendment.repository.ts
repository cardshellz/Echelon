import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  poApprovalTiers, poEvents, poExceptions, poReceipts, poRevisions, poStatusHistory,
  purchaseOrders, purchaseOrderLines, purchasingRecommendationPoHandoffs,
  vendorInvoiceLines, vendorInvoicePoLinks, vendorInvoices,
} from "@shared/schema/procurement.schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { warehouseSettings } from "@shared/schema/inventory.schema";
import { readProcurementSettings } from "./procurement-settings.repository";
import type { PurchaseApprovalSnapshot } from "./purchase-order-approval.policy";
import { readPurchaseApprovalActor } from "../identity/infrastructure/purchase-approval-access.repository";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { recomputePurchaseOrderInvoiceMatchesInTransaction } from "./ap-ledger.service";
import { replacePurchaseOrderMatchExceptions } from "./purchase-order-match-exceptions.repository";
import { PoQuantityAmendmentError, type AmendmentPlan } from "./po-quantity-amendment.policy";
import type { db } from "../../db";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { replacePurchaseOrderQuantityExceptions } from "./purchase-order-quantity-exceptions.repository";
import { poAmendmentHistorySchema } from "@shared/procurement/po-quantity-amendment";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";

// Changes to reviewed behavior invalidate uncommitted previews; committed receipts still replay.
const PO_LINE_REVIEW_VERSION = 3;

export type AmendmentDatabase = Pick<typeof db, "transaction">;
export type AmendmentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function readPoAmendmentHistory(tx: AmendmentTransaction, purchaseOrderId: number, beforeId: number | null) {
  const result = await tx.execute(sql`SELECT event.id,event.actor_id,event.created_at,event.payload_json,
      COALESCE(actor.username,event.actor_id) AS actor_name
    FROM procurement.po_events event LEFT JOIN identity.users actor ON actor.id=event.actor_id
    WHERE event.po_id=${purchaseOrderId} AND event.event_type IN ('line_amendment_approved','quantity_amendment_approved')
      AND (${beforeId}::bigint IS NULL OR event.id < ${beforeId}::bigint)
    ORDER BY event.id DESC LIMIT 21`);
  return poAmendmentHistorySchema.parse({ entries: result.rows.slice(0,20).map(row => {
    const payload = row.payload_json as { revisionNumber?: unknown; preview?: unknown; approvedAt?: unknown };
    return { id: costInteger(row.id, "approval event id", 1), actorId: row.actor_id, actorName: row.actor_name, approvedAt: payload.approvedAt,
      revisionNumber: payload.revisionNumber, preview: payload.preview };
  }), nextCursor: result.rows.length > 20 ? costInteger(result.rows[19].id, "approval event cursor", 1) : null });
}

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
  const exceptions = await tx.select().from(poExceptions).where(and(eq(poExceptions.poId, purchaseOrderId), inArray(poExceptions.kind, ["match_mismatch", "qty_short", "qty_over"]))).orderBy(asc(poExceptions.id)).for("update");
  const dependencies = await readPoAmendmentDependencies(tx, lines.filter(line => line.lineType === "product").map(line => line.id));
  // Row locks do not cover newly inserted tiers or a new DEFAULT settings row.
  // Freeze policy creation as well as edits until this short command finishes.
  await tx.execute(sql`LOCK TABLE ${warehouseSettings}, ${poApprovalTiers} IN SHARE MODE`);
  const policy = (await readProcurementSettings(tx, "share")).settings;
  const requireApproval = policy.requireApproval;
  const approvalTiers = await tx.select().from(poApprovalTiers).where(eq(poApprovalTiers.active, 1)).orderBy(asc(poApprovalTiers.id)).for("share");
  const facts = { header, lines, invoices, invoiceLines, recommendationOwned: handoffs.length > 0 };
  // Full row versions cover price metadata, counters, invoice void/payment changes,
  // receipt evidence and variance approvals. No client amount is authoritative.
  const sourceVersion = createHash("sha256").update(canonicalJson({ reviewVersion: PO_LINE_REVIEW_VERSION, facts, actor, links, handoffs, receipts, exceptions, dependencies, requireApproval, procurementPolicyRevision: policy.revision, approvalTiers })).digest("hex");
  return { facts, actor, sourceVersion, exceptions, dependencies, requireApproval, approvalTiers };
}

export async function persistQuantityAmendment(
  tx: AmendmentTransaction,
  source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>,
  plan: AmendmentPlan,
  actorId: string,
  approvedAt: Date,
  approvalEvidence: PurchaseApprovalSnapshot,
) {
  const { header, lines } = source.facts;
  const lineEdit = plan.preview.lines.some(line => ["edit_line", "edit_charge"].includes(line.priceTreatment));
  const actionName = lineEdit ? "PO edit" : "quantity correction";
  const revisionNumber = (header.revisionNumber ?? 0) + 1;
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber > 2_147_483_647) throw new PoQuantityAmendmentError("The revision limit has been reached.", "PO_AMENDMENT_REVISION_LIMIT");
  for (const change of plan.patches) {
    const before = lines.find((line) => line.id === change.id)!;
    const [updated] = await tx.update(purchaseOrderLines).set({
      ...change.patch,
      fullyReceivedDate: plan.preview.closedPurchaseOrder ? before.fullyReceivedDate : change.patch.status === "received" ? before.fullyReceivedDate ?? approvedAt : null,
      // Keep the original quote reference/dates as document provenance. The
      // event records both quote shapes and the admin's explicit price treatment.
      updatedAt: sql`GREATEST(${approvedAt}::timestamp, ${before.updatedAt}::timestamp + interval '1 millisecond')`,
    }).where(and(eq(purchaseOrderLines.id, change.id), eq(purchaseOrderLines.purchaseOrderId, header.id))).returning({ id: purchaseOrderLines.id });
    if (!updated) throw new PoQuantityAmendmentError("The locked PO line could not be updated.", "PO_AMENDMENT_UPDATE_FAILED");
    const changedFields = Object.keys(change.patch) as (keyof typeof change.patch)[];
    for (const field of changedFields) {
      const newValue = change.patch[field];
      if (newValue === undefined || before[field] === newValue) continue;
      await tx.insert(poRevisions).values({
        purchaseOrderId: header.id, revisionNumber, changedBy: actorId,
        changeType: field === "orderQty" ? "qty_changed" : field === "status" ? "status_changed" : "price_changed", fieldChanged: field,
        oldValue: before[field] === null ? null : String(before[field]), newValue: newValue === null ? null : String(newValue),
        lineId: change.id, notes: plan.preview.reason, createdAt: approvedAt,
      });
    }
  }
  const statusChanged = header.status !== plan.preview.afterStatus;
  const [afterHeader] = await tx.update(purchaseOrders).set({
    subtotalCents: plan.subtotalCents, totalCents: plan.preview.afterTotalCents, revisionNumber,
    approvalTierId: approvalEvidence.tier?.id ?? null, approvedBy: actorId, approvedAt, approvalNotes: plan.preview.reason,
    receivedLineCount: plan.receivedLineCount,
    status: plan.preview.afterStatus,
    physicalStatus: plan.preview.closedPurchaseOrder ? header.physicalStatus : plan.preview.afterStatus === "received" ? "received" : plan.preview.afterStatus === "partially_received" ? "receiving" : header.physicalStatus,
    updatedBy: actorId, updatedAt: sql`GREATEST(${approvedAt}::timestamp, ${header.updatedAt}::timestamp + interval '1 millisecond')`,
  }).where(eq(purchaseOrders.id, header.id)).returning();
  if (!afterHeader) throw new PoQuantityAmendmentError("The locked PO could not be updated.", "PO_AMENDMENT_UPDATE_FAILED");
  await tx.insert(poStatusHistory).values({
    purchaseOrderId: header.id, fromStatus: header.status, toStatus: plan.preview.afterStatus,
    changedBy: actorId, changedAt: approvedAt, revisionNumber,
    notes: `Admin approved ${actionName} (revision ${revisionNumber})${statusChanged ? "; receiving status recalculated" : ""}: ${plan.preview.reason}`,
  });
  const match = await recomputePurchaseOrderInvoiceMatchesInTransaction(header.id, tx, actorId, approvedAt);
  const superseded = await replacePurchaseOrderMatchExceptions({ tx, purchaseOrderId: header.id, exceptions: source.exceptions.filter(row => row.kind === "match_mismatch"), match,
    actorId, at: approvedAt, supersessionNote: `Superseded by admin-approved ${actionName}, revision ${revisionNumber}.`,
    messagePrefix: `PO revision ${revisionNumber}`, revisionNumber });
  const afterLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, header.id)).orderBy(asc(purchaseOrderLines.id));
  const quantityExceptions = await replacePurchaseOrderQuantityExceptions(tx, source.exceptions, plan, actorId, approvedAt);
  return { revisionNumber, afterHeader, afterLines, superseded, quantityExceptions, resultingMatchSourceFingerprint: match.sourceFingerprint };
}

/** Record the reviewed downstream outcome only after every owner succeeds. */
export async function recordQuantityAmendmentResult(tx: AmendmentTransaction,
  source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>, plan: AmendmentPlan,
  saved: Awaited<ReturnType<typeof persistQuantityAmendment>>, actorId: string, commandKey: string,
  approvedAt: Date, approvalEvidence: PurchaseApprovalSnapshot) {
  const { header, lines } = source.facts;
  const { revisionNumber, afterHeader, afterLines } = saved;
  const lineEdit = plan.preview.lines.some(line => ["edit_line", "edit_charge"].includes(line.priceTreatment));
  const [event] = await tx.insert(poEvents).values({
    poId: header.id, eventType: lineEdit ? "line_amendment_approved" : "quantity_amendment_approved", actorType: "user", actorId, createdAt: approvedAt,
    payloadJson: {
      contractVersion: 1, commandKey, revisionNumber, reason: plan.preview.reason, approvedAt: approvedAt.toISOString(),
      approvalEvidence: source.actor, approval_authority: approvalEvidence, reviewedSourceVersion: source.sourceVersion,
      closedPurchaseOrderConfirmed: plan.preview.closedPurchaseOrder === true,
      preview: plan.preview, before: { header, lines }, after: { header: afterHeader, lines: afterLines },
      supersededMatchExceptions: saved.superseded, quantityExceptions: saved.quantityExceptions, resultingMatchSourceFingerprint: saved.resultingMatchSourceFingerprint,
    },
  }).returning({ id: poEvents.id });
  return { purchaseOrderId: header.id, revisionNumber, auditEventId: event.id, preview: plan.preview };
}
