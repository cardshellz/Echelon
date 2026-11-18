import { sql } from "drizzle-orm";
import {
  CostEvidenceError,
  costFingerprint,
  costInteger,
  lockInventoryCostGraph,
  type CostEvidenceTransaction,
  type CostRevisionInput,
  type RecordedCostRevision,
} from "./infrastructure/cost-evidence.repository";
import {
  applyCostRevision,
  type CostApplicationOptions,
  type CostComponentWriter,
  type CostRevisionApplicationResult,
} from "./application/apply-cost-revision";
import { refreshReceiptProvisional } from "./application/refresh-receipt-provisional";

export {
  CostEvidenceError,
  costFingerprint,
  costInteger,
  lockInventoryCostGraph,
  applyCostRevision,
  refreshReceiptProvisional,
  type CostEvidenceTransaction,
  type CostRevisionInput,
  type RecordedCostRevision,
  type CostApplicationOptions,
  type CostComponentWriter,
  type CostRevisionApplicationResult,
};

/**
 * Public transaction-aware inventory reader for the latest `inventory.cost_applications`
 * status of each source revision ID. Keeps concrete `inventory.cost_applications` SQL
 * inside the inventory module.
 */
export async function readLatestCostApplicationStatuses(
  tx: CostEvidenceTransaction,
  sourceRevisionIds: readonly number[],
): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(sourceRevisionIds.map((id) => costInteger(id, "sourceRevisionId", 1)))];
  if (uniqueIds.length === 0) return new Map();

  const rows = (
    await tx.execute(sql`
      SELECT DISTINCT ON (app.source_revision_id)
        app.source_revision_id,
        app.status
      FROM inventory.cost_applications app
      WHERE app.source_revision_id = ANY(${sql.param(uniqueIds)}::int[])
      ORDER BY app.source_revision_id, app.id DESC
    `)
  ).rows;

  const statusByRevisionId = new Map<number, string>();
  for (const row of rows) {
    statusByRevisionId.set(
      costInteger(row.source_revision_id, "sourceRevisionId", 1),
      String(row.status),
    );
  }
  return statusByRevisionId;
}
