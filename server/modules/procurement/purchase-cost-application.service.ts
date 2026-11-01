import { sql } from "drizzle-orm";
import { costFingerprint } from "../inventory/infrastructure/cost-evidence-values";
import { refreshReceiptProvisional } from "../inventory/application/refresh-receipt-provisional";
import { recordReceiptProvisionalAudit } from "./receipt-invoice-costs.repository";
import { recordCostRevision } from "./cost-source-revision.repository";
export { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { readPurchaseCostSource } from "./purchase-cost-source.repository";
import { resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import { costInteger, lockInventoryCostGraph, type CostEvidenceTransaction, type RecordedCostRevision } from "../inventory/infrastructure/cost-evidence.repository";
import { applyCostRevision, type CostApplicationOptions, type CostComponentWriter, type CostRevisionApplicationResult } from "../inventory/application/apply-cost-revision";

/** Source decisions are shared with status reads. Only this command records
 * the resolved revision under the inventory cost graph lock. */
export async function recordPurchaseCostRevisions(
  tx: CostEvidenceTransaction, purchaseOrderLineId: number, actorId: string, now: Date,
): Promise<RecordedCostRevision[]> {
  await lockInventoryCostGraph(tx);
  const source = await readPurchaseCostSource(tx, purchaseOrderLineId);
  if (!source) return [];
  const revisions: RecordedCostRevision[] = [];
  for (const input of resolvePurchaseCostSource(source)) revisions.push(await recordCostRevision(tx, input, actorId, now, source));
  return revisions;
}

export async function reconcilePurchaseCostEvidence(
  tx: CostEvidenceTransaction, purchaseOrderLineId: number, writer: CostComponentWriter, actorId: string, now: Date,
  options: CostApplicationOptions = {},
): Promise<{ lotsUpdated: number; cogsRowsUpdated: number; totalCogsDeltaCents: number; costApplications: CostRevisionApplicationResult[]; costSources: RecordedCostRevision[] }> {
  const revisions = await recordPurchaseCostRevisions(tx, purchaseOrderLineId, actorId, now);
  const applications: CostRevisionApplicationResult[] = [];
  for (const revision of revisions) applications.push(await applyCostRevision(tx, revision, writer, actorId, now, options));
  if (revisions.some(row => row.contract.receiptCostSegments)) await refreshReceiptCostProvisionalForLine(tx, purchaseOrderLineId, actorId, now);
  return { lotsUpdated: applications.reduce((sum, result) => sum + result.lotsUpdated, 0),
    cogsRowsUpdated: applications.reduce((sum, result) => sum + result.cogsRowsUpdated, 0),
    totalCogsDeltaCents: costInteger(applications.reduce((sum, result) => sum + BigInt(result.totalCogsDeltaCents), BigInt(0)).toString(), "totalCogsDeltaCents", -Number.MAX_SAFE_INTEGER), costApplications: applications, costSources: revisions };
}

/** Refresh only opted-in receipt sources, after the current owners finish. */
export async function refreshReceiptCostProvisionalForLine(tx: CostEvidenceTransaction, lineId: number, actorId: string, at: Date) {
  const source = await readPurchaseCostSource(tx, lineId);
  if (!source?.receiptCosting) return;
  const selected = resolvePurchaseCostSource(source);
  const current = (await tx.execute(sql`SELECT revision.component,revision.fingerprint,
    (SELECT status FROM inventory.cost_applications app WHERE app.source_revision_id=revision.id ORDER BY app.id DESC LIMIT 1) AS status
    FROM procurement.cost_source_revisions revision WHERE revision.purchase_order_line_id=${lineId}
      AND revision.inbound_shipment_line_id IS NULL AND revision.component IN ('product','packaging')
      AND NOT EXISTS(SELECT 1 FROM procurement.cost_source_revisions newer WHERE newer.purchase_order_line_id=revision.purchase_order_line_id
        AND newer.inbound_shipment_line_id IS NULL AND newer.component=revision.component AND newer.revision>revision.revision)`)).rows;
  const applied=selected.length===2&&selected.every(input=>current.some(row=>row.component===input.component&&row.status==="applied"
    && row.fingerprint===costFingerprint({input,sourceEvidence:source})));
  const changes = await refreshReceiptProvisional(tx,lineId,selected,applied);
  await recordReceiptProvisionalAudit(tx,lineId,changes,applied,actorId,at);
}
