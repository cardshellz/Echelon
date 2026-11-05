import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  supplierHeaderContextSchema, supplierHeaderApprovalSchema, supplierHeaderPreviewSchema,
  type SupplierHeaderTarget, type SupplierHeaderPreview,
} from "@shared/procurement/supplier-header-costs";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { costInteger, costFingerprint, lockInventoryCostGraph, CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { readSupplierHeaderSources, supplierHeaderTargetKey, headerReviewRecord } from "./supplier-header-cost-source.repository";
import { proposedSupplierHeaderEntries, allocateSupplierHeader } from "./domain/supplier-header-costs";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

export async function readSupplierHeaderHistory(tx: AmendmentTransaction, target: SupplierHeaderTarget) {
  const rows = (await tx.execute(sql`SELECT * FROM procurement.supplier_header_cost_reviews
    WHERE purchase_order_id=${target.kind === "purchase_order" ? target.id : null}
      OR vendor_invoice_id=${target.kind === "invoice" ? target.id : null} ORDER BY id DESC LIMIT 1001`)).rows;
  if (rows.length > 1000) throw new CostEvidenceError("SUPPLIER_HEADER_HISTORY_LIMIT", "The complete supplier header history exceeds 1000 approvals.");
  const records = rows.map(headerReviewRecord);
  const ids = records.map(row => row.id);
  const events = ids.length ? (await tx.execute(sql`SELECT DISTINCT ON ((payload_json->>'headerReviewId')) payload_json
    FROM procurement.po_events WHERE event_type='supplier_header_costs_approved'
      AND payload_json->>'headerReviewId'=ANY(${sql.param(ids.map(String))}::text[])
    ORDER BY payload_json->>'headerReviewId',id`)).rows : [];
  return records.map(row => {
    const event = events.find(event => costInteger(z.record(z.string(), z.unknown()).parse(event.payload_json).headerReviewId, "header approval link", 1) === row.id);
    if (!event && row.purchaseOrderIds.length) throw new CostEvidenceError("SUPPLIER_HEADER_HISTORY_MISSING", "The original supplier header approval is missing its linked purchase history.");
    const preview = event ? supplierHeaderPreviewSchema.parse(z.record(z.string(), z.unknown()).parse(event.payload_json).preview)
      : supplierHeaderPreviewSchema.parse({ target: row.target, sourceVersion: row.sourceVersion, previewVersion: row.previewVersion,
        before: row.before, after: row.after, impact: { lots: [], orderCosts: [], historicalCosts: [], applications: [] }, inventoryValues: [], issues: [] });
    if (preview.previewVersion !== row.previewVersion) throw new CostEvidenceError("SUPPLIER_HEADER_HISTORY_MISMATCH", "The linked supplier header approval does not match its immutable review.");
    return supplierHeaderApprovalSchema.parse({ reviewId: row.id, actorName: row.actorName, approvedAt: row.approvedAt, reason: row.reason, preview });
  });
}

/** Lock graph, original document and dependencies before reading current IAM.
 * Session role labels cannot authorize this monetary classification. */
export async function readSupplierHeaderReviewSource(tx: AmendmentTransaction, target: SupplierHeaderTarget, actorId: string) {
  await lockInventoryCostGraph(tx);
  const document = (await tx.execute(target.kind === "purchase_order"
    ? sql`SELECT * FROM procurement.purchase_orders WHERE id=${target.id} FOR UPDATE`
    : sql`SELECT * FROM procurement.vendor_invoices WHERE id=${target.id} FOR UPDATE`)).rows[0];
  if (!document) throw new CostEvidenceError("SUPPLIER_HEADER_SOURCE_MISSING", "The original supplier document is missing.");
  const selection = (await readSupplierHeaderSources(tx, [target], true)).get(supplierHeaderTargetKey(target))!;
  const lines = selection.source.lines;
  const lineIds = [...new Set(lines.filter(row => row.kind === "product").map(row => row.purchaseOrderLineId!))].sort((a, b) => a - b);
  const linkedLineIds = [...new Set(lines.flatMap(row => row.purchaseOrderLineId === null ? [] : [row.purchaseOrderLineId]))];
  const shipmentIds = [...new Set(lines.flatMap(row => row.inboundShipmentId === null ? [] : [row.inboundShipmentId]))].sort((a, b) => a - b);
  const dependencies = await readPoAmendmentDependencies(tx, lineIds, { shipmentIds });
  const linkedPurchases = (await tx.execute(sql`SELECT DISTINCT purchase_order_id AS id FROM procurement.purchase_order_lines
    WHERE id=ANY(${sql.param(linkedLineIds)}::int[])
    UNION SELECT DISTINCT po.purchase_order_id AS id FROM procurement.inbound_shipment_lines shipment_line
    JOIN procurement.purchase_order_lines po ON po.id=shipment_line.purchase_order_line_id
    WHERE shipment_line.inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) ORDER BY id`)).rows;
  const purchaseOrderIds = target.kind === "purchase_order" ? [target.id] : linkedPurchases.map(row => costInteger(row.id, "linked header PO", 1));
  const actor = await readPurchaseApprovalActor(tx, actorId), actorName = await readPurchaseApproverName(tx, actorId);
  const sourceVersion = costFingerprint({ contract: 1, target, document, source: selection.source, current: selection.current,
    dependencies, purchaseOrderIds, actor });
  const blockedReason = selection.source.issues?.[0] ?? (!lines.length ? "Restore the original document's lines before assigning its header amounts."
    : target.kind === "invoice" && !["approved", "partially_paid", "paid"].includes(String(document.status)) ? "Approve this supplier invoice before applying its header costs."
      : ["voided", "cancelled"].includes(String(document.status)) ? "A cancelled or voided document cannot provide current supplier costs." : null);
  const currentMatchesSource = selection.current !== null && selection.issue === null;
  const proposed = currentMatchesSource ? selection.current!.evidence.entries : proposedSupplierHeaderEntries(selection.source);
  let proposedShares: ReturnType<typeof allocateSupplierHeader> = [], proposedIssue: string | null = null;
  try { proposedShares = allocateSupplierHeader(selection.source, proposed); }
  catch (error) { if (!(error instanceof CostEvidenceError)) throw error; proposedIssue = error.message; }
  const context = supplierHeaderContextSchema.parse({ source: selection.source, sourceVersion,
    current: selection.current?.evidence ?? null, proposed, currentMatchesSource, proposedShares, proposedIssue,
    canApprove: hasQuantityAmendmentAuthority(actor) && blockedReason === null,
    blockedReason, approvals: await readSupplierHeaderHistory(tx, target),
  });
  return { target, document, selection, lineIds, shipmentIds, purchaseOrderIds, dependencies, actor, actorName, sourceVersion, context };
}

export async function insertSupplierHeaderReview(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readSupplierHeaderReviewSource>>, input: {
  entries: unknown; sourceFingerprint: string; before: unknown; after: unknown; actorId: string; reason: string;
  at: Date; commandKey: string; previewVersion: string;
}) {
  const rows = (await tx.execute(sql`INSERT INTO procurement.supplier_header_cost_reviews
    (purchase_order_id,vendor_invoice_id,source_fingerprint,source_version,entries_json,before_json,after_json,purchase_order_ids,
      actor_id,actor_name,reason,approved_at,command_key,preview_version)
    VALUES(${source.target.kind === "purchase_order" ? source.target.id : null},${source.target.kind === "invoice" ? source.target.id : null},
      ${input.sourceFingerprint},${source.sourceVersion},${canonicalJson(input.entries)}::jsonb,${canonicalJson(input.before)}::jsonb,
      ${canonicalJson(input.after)}::jsonb,${sql.param(source.purchaseOrderIds)}::int[],${input.actorId},${source.actorName},${input.reason},
      ${input.at},${input.commandKey},${input.previewVersion}) RETURNING id`)).rows;
  if (rows.length !== 1) throw new Error("Supplier header review was not retained.");
  return costInteger(rows[0].id, "header review", 1);
}

export async function recordSupplierHeaderEffect(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readSupplierHeaderReviewSource>>, input: {
  reviewId: number; preview: SupplierHeaderPreview; actorId: string; reason: string; at: Date; commandKey: string;
}) {
  const payload = { headerReviewId: input.reviewId, actorName: source.actorName, approvedAt: input.at.toISOString(),
    reason: input.reason, commandKey: input.commandKey, preview: input.preview };
  const events = (await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
    SELECT id,'supplier_header_costs_approved','user',${input.actorId},${canonicalJson(payload)}::jsonb,${input.at}::timestamp
    FROM procurement.purchase_orders WHERE id=ANY(${sql.param(source.purchaseOrderIds)}::int[]) RETURNING id`)).rows;
  if (events.length !== source.purchaseOrderIds.length) throw new Error("Supplier header approval lost a linked purchase history.");
  await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${input.at},'AUDIT',${input.actorId},'procurement.supplier_header_costs.approved',${supplierHeaderTargetKey(source.target)},
      ${canonicalJson({ before: input.preview.before, after: input.preview.after })}::jsonb,${canonicalJson(payload)}::jsonb)`);
}
