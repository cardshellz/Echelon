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
  return { lotsUpdated: applications.reduce((sum, result) => sum + result.lotsUpdated, 0),
    cogsRowsUpdated: applications.reduce((sum, result) => sum + result.cogsRowsUpdated, 0),
    totalCogsDeltaCents: costInteger(applications.reduce((sum, result) => sum + BigInt(result.totalCogsDeltaCents), BigInt(0)).toString(), "totalCogsDeltaCents", -Number.MAX_SAFE_INTEGER), costApplications: applications, costSources: revisions };
}
