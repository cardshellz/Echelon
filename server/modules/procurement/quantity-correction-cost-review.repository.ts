import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  costIssueSchema,
  costSourceRevisionSchema,
} from "@shared/procurement/cost-source-contracts";
import {
  readReconciliationLedger,
  readReconciliationRecords,
} from "../inventory/infrastructure/cost-reconciliation.repository";
import { type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import {
  summarizeQuantityCorrectionCostReview,
  type QuantityCorrectionCostReview,
} from "./quantity-correction-cost-review";

/** Read the saved cost outcome without attempting an expense posting. Unknown
 * evidence remains unknown; a missing history link never becomes a sale. */
export async function readQuantityCorrectionCostReview(
  tx: CostEvidenceTransaction,
  lineId: number,
): Promise<QuantityCorrectionCostReview> {
  const saved = (
    await tx.execute(sql`
    SELECT revision.contract, application.status, application.evidence->'result'->'issues' AS issues,
      EXISTS(SELECT 1 FROM inventory.effective_lot_cost_origins origin
        WHERE origin.inbound_shipment_line_id=${lineId}) AS has_known_roots
    FROM procurement.cost_source_revisions revision
    LEFT JOIN LATERAL (SELECT status,evidence FROM inventory.cost_applications
      WHERE source_revision_id=revision.id ORDER BY id DESC LIMIT 1) application ON true
    WHERE revision.inbound_shipment_line_id=${lineId} AND revision.component='landed'
    ORDER BY revision.revision DESC LIMIT 1
  `)
  ).rows[0];
  const ledger = await readReconciliationLedger(tx, lineId);
  const source = saved ? costSourceRevisionSchema.parse(saved.contract) : null;
  const issues =
    saved?.issues == null ? null : z.array(costIssueSchema).parse(saved.issues);
  const records =
    source && issues ? await readReconciliationRecords(tx, source, issues) : [];
  return summarizeQuantityCorrectionCostReview({
    source,
    status: saved?.status == null ? null : String(saved.status),
    issues,
    records,
    hasKnownRoots: saved?.has_known_roots === true,
    balances: ledger.balances,
    destination: ledger.approval?.destination ?? null,
  });
}
