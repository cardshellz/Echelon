import { sql } from "drizzle-orm";
import { shipmentCostWorkflowIdSchema, shipmentCostReviewSchema, type ShipmentCostReview } from "@shared/procurement/shipment-cost-workflow";
import type { PoShipmentCostSummaryDatabase } from "./po-shipment-cost-summary.repository";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { dateValues } from "./purchase-workspace-read";
import { readShipmentCostPostingEvidence } from "./shipment-cost-posting-read.repository";
import type { ShipmentExceptionReader } from "./shipment-cost-exception.repository";

/** One read-only snapshot of the current source revision and its last application.
 * Both applied and review outcomes survive navigation, reload and lost responses. */
export async function readShipmentCostReview(db: PoShipmentCostSummaryDatabase, shipmentId: number): Promise<ShipmentCostReview | null> {
  shipmentCostWorkflowIdSchema.parse(shipmentId);
  return db.transaction(tx => readShipmentCostReviewInTransaction(tx, shipmentId), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Allows health and other projections to share the same repeatable-read snapshot. */
export async function readShipmentCostReviewInTransaction(tx: ShipmentExceptionReader, shipmentId: number): Promise<ShipmentCostReview | null> {
  shipmentCostWorkflowIdSchema.parse(shipmentId);
  const shipment = await tx.execute(sql`SELECT id FROM procurement.inbound_shipments WHERE id=${shipmentId}`);
  if (!shipment.rows.length) return null;
  const result = await tx.execute(sql`SELECT line.id,line.sku,revision.contract,
    application.id AS application_id,application.status,application.recorded_at,application.evidence->'result' AS result
    FROM procurement.inbound_shipment_lines line
    LEFT JOIN LATERAL (SELECT id,contract FROM procurement.cost_source_revisions revision
      WHERE revision.inbound_shipment_line_id=line.id AND revision.component='landed'
      ORDER BY revision.revision DESC,revision.id DESC LIMIT 1) revision ON true
    LEFT JOIN LATERAL (SELECT id,status,recorded_at,evidence FROM inventory.cost_applications application
      WHERE application.source_revision_id=revision.id ORDER BY application.id DESC LIMIT 1) application ON true
    WHERE line.inbound_shipment_id=${shipmentId} ORDER BY line.id`);
  const { exceptions, sourceIssues } = await readShipmentCostPostingEvidence(tx, result.rows.map(row => ({
    lineId: costInteger(row.id, "line.id", 1), shipmentId, contract: row.contract,
  })));
  return shipmentCostReviewSchema.parse({ shipmentId, lines: result.rows.map(row => {
    const outcome = row.result as Record<string, unknown> | null;
    return {
      lineId: costInteger(row.id, "line.id", 1), sku: row.sku == null ? null : String(row.sku),
      sourceIssue: sourceIssues.get(costInteger(row.id, "line.id", 1)) ?? null,
      exceptionReview: exceptions.get(costInteger(row.id, "line.id", 1)) ?? null,
      application: row.application_id == null ? null : {
        id: costInteger(row.application_id, "application.id", 1),
        recordedAt: dateValues({ recordedAt: row.recorded_at }, ["recordedAt"]).recordedAt,
        status: row.status, lotsUpdated: outcome?.lotsUpdated, cogsRowsUpdated: outcome?.cogsRowsUpdated,
        issues: outcome?.issues,
      },
    };
  }) });
}
