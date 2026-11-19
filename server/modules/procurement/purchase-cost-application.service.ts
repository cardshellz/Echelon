import {
  costFingerprint,
  costInteger,
  lockInventoryCostGraph,
  applyCostRevision,
  refreshReceiptProvisional,
  readLatestCostApplicationStatuses,
  type CostApplicationOptions,
  type CostComponentWriter,
  type CostEvidenceTransaction,
  type CostRevisionApplicationResult,
  type RecordedCostRevision,
} from "../inventory/cost-application-public";
import { recordReceiptProvisionalAudit } from "./receipt-invoice-costs.repository";
import { recordCostRevision } from "./cost-source-revision.repository";
export { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { readPurchaseCostSource } from "./purchase-cost-source.repository";
import { resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import { readLatestSupplierCostRevisions } from "./cost-source-evidence-public";

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
  // Invalidated mappings deliberately have no allocatable segments. Their
  // current stock must still lose the confirmed flag when an invoice is voided
  // or disputed, while the cost owner retains its last posted amounts.
  if (revisions.some(row => row.contract.receiptCostSegments
    || row.contract.issue?.code === "RECEIPT_INVOICE_ALLOCATION_REVIEW")) {
    await refreshReceiptCostProvisionalForLine(tx, purchaseOrderLineId, actorId, now);
  }
  return { lotsUpdated: applications.reduce((sum, result) => sum + result.lotsUpdated, 0),
    cogsRowsUpdated: applications.reduce((sum, result) => sum + result.cogsRowsUpdated, 0),
    totalCogsDeltaCents: costInteger(applications.reduce((sum, result) => sum + BigInt(result.totalCogsDeltaCents), BigInt(0)).toString(), "totalCogsDeltaCents", -Number.MAX_SAFE_INTEGER), costApplications: applications, costSources: revisions };
}

/** Refresh only opted-in receipt sources, after the current owners finish. */
export async function refreshReceiptCostProvisionalForLine(tx: CostEvidenceTransaction, lineId: number, actorId: string, at: Date) {
  const source = await readPurchaseCostSource(tx, lineId);
  if (!source?.receiptCosting) return;
  const selected = resolvePurchaseCostSource(source);
  const latestRevisions = await readLatestSupplierCostRevisions(tx, lineId);
  const statusByRevisionId = await readLatestCostApplicationStatuses(
    tx,
    latestRevisions.map((r) => r.sourceRevisionId),
  );
  const current = latestRevisions.map((row) => ({
    component: row.component,
    fingerprint: row.fingerprint,
    status: statusByRevisionId.get(row.sourceRevisionId) ?? null,
  }));
  const applied = selected.length === 2 && selected.every(input => current.some(row => row.component === input.component && row.status === "applied"
    && row.fingerprint === costFingerprint({ input, sourceEvidence: source })));
  const changes = await refreshReceiptProvisional(tx, lineId, selected, applied);
  await recordReceiptProvisionalAudit(tx, lineId, changes, applied, actorId, at);
}
