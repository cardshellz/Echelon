import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { CostIssue, CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import {
  reconciliationDestinationSchema,
  reconciliationHistorySchema,
  reconciliationPostingSchema,
  reconciliationRecordSchema,
  type ReconciliationBalance,
  type ReconciliationPosting,
} from "@shared/procurement/cost-reconciliation";
import { reconciliationDeltas } from "../domain/cost-reconciliation";
import {
  costInteger,
  CostEvidenceError,
  type CostEvidenceTransaction,
  type RecordedCostRevision,
} from "./cost-evidence.repository";

const approvalSchema = z.object({
  id: z.number().int().positive().safe(),
  destination: reconciliationDestinationSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  actorName: z.string(),
  reason: z.string(),
});
type Approval = z.infer<typeof approvalSchema>;
export interface ReconciliationLedger {
  approval: Approval | null;
  balances: ReconciliationBalance;
  lastIds: Partial<Record<Approval["destination"], number>>;
}
export type ReconciliationScope = number | { purchaseOrderLineId: number; component: "product" | "packaging" };
export function reconciliationScope(source: CostSourceRevision): ReconciliationScope {
  return source.scope.kind === "shipment_line" ? source.scope.inboundShipmentLineId
    : { purchaseOrderLineId: source.scope.purchaseOrderLineId, component: z.enum(["product", "packaging"]).parse(source.component) };
}
function scopePredicate(scope: ReconciliationScope) {
  return typeof scope === "number" ? sql`inbound_shipment_line_id=${scope}`
    : sql`purchase_order_line_id=${scope.purchaseOrderLineId} AND component=${scope.component}`;
}
export async function readReconciliationLedger(
  tx: CostEvidenceTransaction,
  lineId: ReconciliationScope,
): Promise<ReconciliationLedger> {
  const approvals = await tx.execute(sql`SELECT id,destination,evidence_fingerprint,actor_name,reason
    FROM inventory.cost_reconciliation_approvals WHERE ${scopePredicate(lineId)} ORDER BY id DESC LIMIT 1`);
  const postings = await tx.execute(sql`SELECT DISTINCT ON(destination) id,destination,after_mills
    FROM inventory.cost_reconciliation_postings WHERE ${scopePredicate(lineId)} ORDER BY destination,id DESC`);
  const row = approvals.rows[0];
  const approval = row
    ? approvalSchema.parse({
        id: costInteger(row.id, "approvalId", 1),
        destination: row.destination,
        fingerprint: row.evidence_fingerprint,
        actorName: row.actor_name,
        reason: row.reason,
      })
    : null;
  const balances: ReconciliationBalance = { historical_cogs: 0, inventory_variance: 0 };
  const lastIds: ReconciliationLedger["lastIds"] = {};
  for (const posting of postings.rows) {
    const destination = reconciliationDestinationSchema.parse(posting.destination);
    balances[destination] = costInteger(posting.after_mills, "reconciliationBalance");
    lastIds[destination] = costInteger(posting.id, "postingId", 1);
  }
  return { approval, balances, lastIds };
}

export async function readReconciliationRecords(
  tx: CostEvidenceTransaction,
  source: CostSourceRevision,
  issues: CostIssue[],
) {
  const ids = issues.flatMap((issue) => (issue.unresolvedQuantity ? [issue.unresolvedQuantity.inventoryLotId] : []));
  const missingOrigin = issues.some((issue) => issue.code === "COST_HISTORICAL_LINEAGE_MISSING");
  const rows =
    await tx.execute(sql`SELECT lot.id,lot.lot_number,lot.qty_received,lot.qty_on_hand,lot.receiving_order_id,
      (SELECT CASE WHEN COUNT(*)=1 THEN MIN(line.id) END FROM procurement.receiving_lines line WHERE line.receiving_order_id=lot.receiving_order_id
        AND line.purchase_order_line_id=lot.po_line_id AND line.product_variant_id=lot.product_variant_id) AS receipt_line_id,
      EXISTS(SELECT 1 FROM oms.order_item_costs c WHERE c.inventory_lot_id=lot.id) AS has_cogs,
      EXISTS(SELECT 1 FROM inventory.order_line_costs c WHERE c.lot_id=lot.id) AS has_legacy_cogs,
      (COALESCE(lot.qty_reserved,0)<>0 OR COALESCE(lot.qty_picked,0)<>0) AS has_physical_commitments,
      EXISTS(SELECT 1 FROM inventory.lot_cost_contributions c WHERE c.source_lot_id=lot.id OR c.output_lot_id=lot.id) AS has_contribution,
      COALESCE(lot.landed_total_cost_mills,lot.landed_cost_mills::bigint*lot.qty_received) AS existing_landed_mills
    FROM inventory.inventory_lots lot WHERE
      (${missingOrigin} AND lot.po_line_id=${source.scope.purchaseOrderLineId}
        AND (${source.scope.kind === "purchase_order_line"} OR lot.inbound_shipment_id=${source.scope.kind === "shipment_line" ? source.scope.inboundShipmentId : null})
        AND NOT EXISTS(SELECT 1 FROM inventory.lot_cost_origins o WHERE o.inventory_lot_id=lot.id))
      OR lot.id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY lot.id LIMIT 1001`);
  if (rows.rows.length > 1000)
    throw new CostEvidenceError("COST_RECONCILIATION_LIMIT", "This history needs a bounded reconciliation.");
  return rows.rows.map((row) => ({
    record: reconciliationRecordSchema.parse({
      lotId: costInteger(row.id, "lotId", 1),
      lotNumber: row.lot_number,
      originalQuantity: costInteger(row.qty_received, "originalQuantity"),
      onHandQuantity: costInteger(row.qty_on_hand, "onHandQuantity"),
      receiptId: row.receiving_order_id == null ? null : costInteger(row.receiving_order_id, "receiptId", 1),
      receiptLineId: row.receipt_line_id == null ? null : costInteger(row.receipt_line_id, "receiptLineId", 1),
      quantityWithoutHistory:
        issues.find((issue) => issue.unresolvedQuantity?.inventoryLotId === Number(row.id))?.unresolvedQuantity
          ?.quantity ?? null,
      explanation: missingOrigin
        ? row.receipt_line_id == null
          ? "No unique receipt line identifies this lot's cost history. Its downstream destination is unrecorded; approval posts an expense without inventing a sale."
          : "The receipt line exists, but its costing link and the depleted stock's downstream destination are unrecorded. Approval posts an expense without inventing a sale."
        : "The original quantity has a recorded historical gap. Known stock and sold-order costs have their own allocations.",
    }),
    hasCogs: row.has_cogs === true,
    hasContribution: row.has_contribution === true,
    hasLegacyCogs: row.has_legacy_cogs === true,
    hasPhysicalCommitments: row.has_physical_commitments === true,
    existingLandedMills: costInteger(row.existing_landed_mills ?? 0, "existingLandedMills"),
  }));
}
export async function hasReconciliationRoots(
  tx: CostEvidenceTransaction,
  source: CostSourceRevision,
): Promise<boolean> {
  const roots = await tx.execute(
    sql`SELECT inventory_lot_id FROM inventory.lot_cost_origins WHERE purchase_order_line_id=${source.scope.purchaseOrderLineId}
      AND (${source.scope.kind === "purchase_order_line"} OR inbound_shipment_line_id=${source.scope.kind === "shipment_line" ? source.scope.inboundShipmentLineId : null}) LIMIT 1`,
  );
  return roots.rows.length > 0;
}
export interface CostReconciliationPlan {
  ledger: ReconciliationLedger;
  targets: ReconciliationBalance;
  identity: { approvalId: number; historicalAmountMills: number; evidenceFingerprint: string };
  matches: boolean;
}
export async function postCostReconciliation(
  tx: CostEvidenceTransaction,
  plan: CostReconciliationPlan,
  revision: RecordedCostRevision,
  applicationId: number,
  actorId: string,
  now: Date,
): Promise<ReconciliationPosting[]> {
  const scope = revision.contract.scope;
  if (!plan.ledger.approval)
    throw new CostEvidenceError("COST_RECONCILIATION_SCOPE", "A component reconciliation approval is required.");
  const changes = reconciliationDeltas(plan.ledger.balances, plan.targets);
  const destination = plan.ledger.approval.destination;
  if (!changes.length && !plan.ledger.lastIds[destination])
    changes.push({ destination, beforeMills: 0, afterMills: 0, deltaMills: 0 });
  const result: ReconciliationPosting[] = [];
  for (const change of changes) {
    const prior = plan.ledger.lastIds[change.destination] ?? null;
    const inserted = await tx.execute(sql`INSERT INTO inventory.cost_reconciliation_postings
      (inbound_shipment_line_id,purchase_order_line_id,component,approval_id,source_revision_id,application_id,previous_posting_id,destination,currency,
       before_mills,after_mills,delta_mills,unassigned_delta_mills,actor_id,recorded_at)
      VALUES(${scope.kind === "shipment_line" ? scope.inboundShipmentLineId : null},${scope.kind === "purchase_order_line" ? scope.purchaseOrderLineId : null},${revision.contract.component},${plan.ledger.approval.id},${revision.id},${applicationId},${prior},${change.destination},'USD',
        ${change.beforeMills},${change.afterMills},${change.deltaMills},${-change.deltaMills},${actorId},${now}) RETURNING id`);
    result.push(
      reconciliationPostingSchema.parse({
        id: costInteger(inserted.rows[0]?.id, "postingId", 1),
        approvalId: plan.ledger.approval.id,
        ...change,
      }),
    );
  }
  return result;
}

export async function recordReconciliationApproval(
  tx: CostEvidenceTransaction,
  input: {
    lineId: ReconciliationScope;
    revisionId: number;
    applicationId: number;
    fingerprint: string;
    destination: Approval["destination"];
    actorId: string;
    actorName: string;
    reason: string;
    now: Date;
    evidence: unknown;
  },
) {
  const scope = input.lineId;
  await tx.execute(sql`INSERT INTO inventory.cost_reconciliation_approvals(inbound_shipment_line_id,purchase_order_line_id,component,source_revision_id,application_id,
    evidence_fingerprint,destination,actor_id,actor_name,reason,recorded_at,evidence)
    VALUES(${typeof scope === "number" ? scope : null},${typeof scope === "number" ? null : scope.purchaseOrderLineId},${typeof scope === "number" ? "landed" : scope.component},${input.revisionId},${input.applicationId},${input.fingerprint},${input.destination},${input.actorId},${input.actorName},${input.reason},${input.now},${canonicalJson(input.evidence)}::jsonb)`);
}
export async function readReconciliationHistory(tx: CostEvidenceTransaction, lineId: ReconciliationScope) {
  const predicate = typeof lineId === "number" ? sql`p.inbound_shipment_line_id=${lineId}`
    : sql`p.purchase_order_line_id=${lineId.purchaseOrderLineId} AND p.component=${lineId.component}`;
  const rows =
    await tx.execute(sql`SELECT p.id,p.destination,p.before_mills,p.after_mills,p.delta_mills,p.recorded_at,a.actor_name,a.reason
    FROM inventory.cost_reconciliation_postings p JOIN inventory.cost_reconciliation_approvals a ON a.id=p.approval_id
    WHERE ${predicate} ORDER BY p.id DESC LIMIT 50`);
  return rows.rows.map((row) =>
    reconciliationHistorySchema.parse({
      id: costInteger(row.id, "postingId", 1),
      destination: row.destination,
      beforeMills: costInteger(row.before_mills, "beforeMills"),
      afterMills: costInteger(row.after_mills, "afterMills"),
      deltaMills: costInteger(row.delta_mills, "deltaMills", -Number.MAX_SAFE_INTEGER),
      actorName: row.actor_name,
      reason: row.reason,
      recordedAt: new Date(row.recorded_at as string | Date).toISOString(),
    }),
  );
}
