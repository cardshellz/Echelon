import type { CostEvidenceTransaction } from "./cost-evidence.repository";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { lotCostFollowUpQuerySchema, lotCostFollowUpReportSchema } from "@shared/inventory/lot-cost-follow-up";
import { costFingerprint, costInteger, CostEvidenceError, } from "./cost-evidence-values";

export interface LotCostFollowUp {
  inventoryLotId: number;
  relatedLotId?: number;
  operationKey: string;
  issueCode: "COST_HISTORICAL_BASIS_MISSING" | "COST_SOURCE_UNRESOLVED" | "COST_RETURN_SOURCE_MISSING";
  evidence: Record<string, unknown>;
  actor: string;
  occurredAt: Date;
}

/** Called in the physical owner's transaction. An unavailable accounting fact
 * may defer costing only if this durable evidence succeeds with the stock post.
 * Reconciliation consumes these facts through the existing cost application;
 * it never repeats their physical operation.
 */
export async function recordLotCostFollowUp(tx: CostEvidenceTransaction, input: LotCostFollowUp): Promise<void> {
  costInteger(input.inventoryLotId, "inventoryLotId", 1);
  if (input.relatedLotId !== undefined) costInteger(input.relatedLotId, "relatedLotId", 1);
  if (!input.operationKey.trim() || !input.actor.trim() || !Number.isFinite(input.occurredAt.getTime())) {
    throw new CostEvidenceError("COST_AUDIT_IDENTITY_REQUIRED", "Deferred costing requires an audited operation.");
  }
  const fingerprint = costFingerprint(input.evidence);
  const result = await tx.execute(sql`
    INSERT INTO inventory.lot_cost_follow_ups
      (inventory_lot_id,related_lot_id,operation_key,issue_code,evidence,fingerprint,recorded_by,recorded_at)
    VALUES (${input.inventoryLotId},${input.relatedLotId ?? null},${input.operationKey},${input.issueCode},
      ${canonicalJson(input.evidence)}::jsonb,${fingerprint},${input.actor},${input.occurredAt})
    ON CONFLICT DO NOTHING RETURNING id
  `);
  if (result.rows.length === 0) {
    const existing = await tx.execute(sql`SELECT fingerprint FROM inventory.lot_cost_follow_ups
      WHERE inventory_lot_id=${input.inventoryLotId} AND related_lot_id IS NOT DISTINCT FROM ${input.relatedLotId ?? null}
        AND operation_key=${input.operationKey} AND issue_code=${input.issueCode}`);
    if (existing.rows[0]?.fingerprint !== fingerprint) {
      throw new CostEvidenceError("COST_FOLLOW_UP_REPLAY_CONFLICT", "Deferred costing replay differs from its recorded evidence.");
    }
  }
}

export async function readLotCostFollowUps(tx: CostEvidenceTransaction, rawInput: { afterId?: number; limit?: number } = {}) {
  const input = lotCostFollowUpQuerySchema.parse(rawInput);
  const result = await tx.execute(sql`SELECT request.*,attempt.application_id,attempt.state FROM inventory.lot_cost_follow_ups request
    LEFT JOIN LATERAL (SELECT application_id,state FROM inventory.lot_cost_follow_up_attempts
      WHERE follow_up_id=request.id ORDER BY id DESC LIMIT 1) attempt ON true
    WHERE request.id>${input.afterId} ORDER BY request.id LIMIT ${input.limit}`);
  const items = result.rows.map((row) => ({ id: costInteger(row.id,"followUp.id",1),
    inventoryLotId: costInteger(row.inventory_lot_id,"followUp.lotId",1),
    relatedLotId: row.related_lot_id == null ? null : costInteger(row.related_lot_id,"followUp.relatedLotId",1),
    operationKey: row.operation_key,issueCode: row.issue_code,evidence: row.evidence,state: row.state ?? "review_required",
    applicationId: row.application_id == null ? null : costInteger(row.application_id,"applicationId",1),
    recordedBy: row.recorded_by,recordedAt: recordedTime(row.recorded_at) }));
  return lotCostFollowUpReportSchema.parse({ items,nextAfterId: items.length === input.limit ? items[items.length-1].id : null });
}

function recordedTime(value: unknown): string {
  // The pg driver may return timestamptz as a Date or its configured text
  // representation. Adapt it here; the outbound contract always uses ISO UTC.
  const timestamp = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!timestamp || !Number.isFinite(timestamp.getTime())) {
    throw new CostEvidenceError("COST_AUDIT_TIME_INVALID", "Deferred costing has an invalid recorded timestamp.");
  }
  return timestamp.toISOString();
}
