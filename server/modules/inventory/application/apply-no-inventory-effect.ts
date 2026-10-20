import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import { proveNoInventoryEffect } from "../domain/no-inventory-effect";
import { readNoInventoryEffectEvidence } from "../infrastructure/no-inventory-effect.repository";
import { costFingerprint, costInteger, CostEvidenceError, lockInventoryCostGraph,
  type CostEvidenceTransaction, type RecordedCostRevision } from "../infrastructure/cost-evidence.repository";
import type { CostRevisionApplicationResult } from "./apply-cost-revision";

/** The caller holds the graph lock in the same transaction as source approval.
 * Completion records evidence only. It never enters an allocator, revalues a
 * lot, posts COGS, or compensates historical balances. */
export async function applyNoInventoryEffect(
  tx: CostEvidenceTransaction, revision: RecordedCostRevision, actorId: string, now: Date,
): Promise<CostRevisionApplicationResult> {
  if (!actorId?.trim() || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CostEvidenceError("COST_AUDIT_IDENTITY_REQUIRED", "Cost application requires an actor and valid clock.");
  }
  await lockInventoryCostGraph(tx);
  const source = costSourceRevisionSchema.parse(revision.contract);
  const evidence = (await readNoInventoryEffectEvidence(tx, [source.scope.purchaseOrderLineId])).get(source.scope.purchaseOrderLineId);
  const { proof, issues } = proveNoInventoryEffect(source, evidence);
  const identity = { costAllocationVersion: 4, sourceRevisionId: revision.id, lotIds: [], graph: [], targets: [],
    issues, noInventoryEffectEvidence: evidence ?? null, ...(proof ? { inventoryEffectProof: proof } : {}) };
  const planFingerprint = costFingerprint(identity);
  const previous = (await tx.execute(sql`SELECT application.id,application.status,application.evidence,event.payload AS reporting_payload
    FROM inventory.cost_applications application LEFT JOIN inventory.cost_reporting_events event ON event.application_id=application.id
    WHERE application.source_revision_id=${revision.id} ORDER BY application.id DESC LIMIT 1`)).rows[0];
  const result: CostRevisionApplicationResult = {
    applicationId: 0, status: proof ? "applied" : "review_required", lotsUpdated: 0, cogsRowsUpdated: 0,
    totalCogsDeltaCents: 0, issues, replayed: false, ...(proof ? { inventoryEffectProof: proof } : {}),
  };
  const event = previous?.reporting_payload;
  const reportingMatches = !proof || event?.sourceRevisionId === revision.id && event?.sourceFingerprint === source.fingerprint
    && event?.component === source.component && event?.currency === source.currency && event?.cogsDeltaCents === 0
    && canonicalJson(event?.changes ?? null) === "[]" && canonicalJson(event?.inventoryEffectProof ?? null) === canonicalJson(proof);
  if (previous?.evidence?.planFingerprint === planFingerprint && previous.status === result.status
    && reportingMatches && canonicalJson({ ...previous.evidence.result, applicationId: 0, replayed: false }) === canonicalJson(result)) {
    return { ...result, applicationId: costInteger(previous.id, "applicationId", 1), replayed: true };
  }
  const key = costFingerprint({ planFingerprint, priorApplicationId: previous?.id ?? null });
  const inserted = await tx.execute(sql`INSERT INTO inventory.cost_applications
    (application_key,source_revision_id,status,evidence,recorded_by,recorded_at)
    VALUES(${key},${revision.id},${result.status},${canonicalJson({ ...identity, planFingerprint, result })}::jsonb,${actorId},${now}) RETURNING id`);
  result.applicationId = costInteger(inserted.rows[0]?.id, "applicationId", 1);
  if (proof) await tx.execute(sql`INSERT INTO inventory.cost_reporting_events(application_id,contract_version,payload,recorded_at)
    VALUES(${result.applicationId},1,${canonicalJson({
      contractVersion: 1, currency: source.currency, sourceRevisionId: revision.id, sourceFingerprint: source.fingerprint,
      component: source.component, changes: [], cogsDeltaCents: 0, inventoryEffectProof: proof, actorId, recordedAt: now.toISOString(),
    })}::jsonb,${now})`);
  return result;
}
