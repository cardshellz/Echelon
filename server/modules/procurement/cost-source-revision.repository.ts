import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import { CostEvidenceError, costFingerprint, costInteger, lockInventoryCostGraph,
  type CostEvidenceTransaction, type CostRevisionInput, type RecordedCostRevision } from "../inventory/infrastructure/cost-evidence.repository";

export async function recordCostRevision(
  tx: CostEvidenceTransaction,
  input: CostRevisionInput,
  actorId: string,
  now: Date,
  sourceEvidence: unknown = null,
): Promise<RecordedCostRevision> {
  if (!actorId.trim() || !Number.isFinite(now.getTime())) throw new CostEvidenceError("COST_AUDIT_IDENTITY_REQUIRED", "Cost evidence requires an actor and a valid timestamp.");
  await lockInventoryCostGraph(tx);
  const fingerprint = costFingerprint({ input, sourceEvidence });
  const shipmentLineId = input.scope.kind === "shipment_line" ? input.scope.inboundShipmentLineId : null;
  const existing = await tx.execute(sql`
    SELECT id, contract, fingerprint FROM procurement.cost_source_revisions
    WHERE purchase_order_line_id = ${input.scope.purchaseOrderLineId}
      AND inbound_shipment_line_id IS NOT DISTINCT FROM ${shipmentLineId}
      AND component = ${input.component} ORDER BY revision DESC LIMIT 1
  `);
  if (existing.rows[0]?.fingerprint === fingerprint) {
    return { id: costInteger(existing.rows[0].id, "revision.id", 1), contract: costSourceRevisionSchema.parse(existing.rows[0].contract) };
  }
  const sequence = await tx.execute(sql`
    SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM procurement.cost_source_revisions
    WHERE purchase_order_line_id = ${input.scope.purchaseOrderLineId}
      AND inbound_shipment_line_id IS NOT DISTINCT FROM ${shipmentLineId} AND component = ${input.component}
  `);
  const contract = costSourceRevisionSchema.parse({ ...input, revision: costInteger(sequence.rows[0]?.revision, "revision", 1), fingerprint });
  const result = await tx.execute(sql`
    INSERT INTO procurement.cost_source_revisions
      (purchase_order_line_id,inbound_shipment_line_id,component,revision,fingerprint,contract,source_evidence,recorded_by,recorded_at)
    VALUES (${input.scope.purchaseOrderLineId},${shipmentLineId},${input.component},${contract.revision},${fingerprint},
      ${canonicalJson(contract)}::jsonb,${canonicalJson(sourceEvidence)}::jsonb,${actorId},${now}) RETURNING id
  `);
  return { id: costInteger(result.rows[0]?.id, "revision.id", 1), contract };
}
