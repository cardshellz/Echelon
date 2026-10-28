import { shipmentCostReadPageSchema } from "./shipment-cost-read-scope";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { sql } from "drizzle-orm";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
import type { PurchaseCostStatusSnapshotReader } from "./purchase-cost-status-snapshot.repository";
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
export async function readShipmentCostReviewInTransaction(tx: ShipmentExceptionReader, shipmentId: number,
  supplierSnapshot?: PurchaseCostStatusSnapshotReader): Promise<ShipmentCostReview | null> {
  shipmentCostWorkflowIdSchema.parse(shipmentId);
  const shipment = await tx.execute(sql`SELECT id FROM procurement.inbound_shipments WHERE id=${shipmentId}`);
  if (!shipment.rows.length) return null;
  const result = await tx.execute(sql`SELECT line.id,line.sku,line.purchase_order_line_id,revision.contract,
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
  return projectShipmentCostReview(tx, shipmentId, result.rows, { exceptions, sourceIssues }, supplierSnapshot);
}

async function projectShipmentCostReview(tx: ShipmentExceptionReader, shipmentId: number, rows: Record<string, unknown>[],
  posting: Awaited<ReturnType<typeof readShipmentCostPostingEvidence>>, supplierSnapshot?: PurchaseCostStatusSnapshotReader): Promise<ShipmentCostReview> {
  const { exceptions, sourceIssues } = posting;
  const purchaseLineIds = rows.flatMap(row => row.purchase_order_line_id == null
    ? [] : [costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1)]);
  const supplierCosts = supplierSnapshot ? await supplierSnapshot.read(tx, purchaseLineIds)
    : await readPurchaseCostStatus(tx, purchaseLineIds);
  return shipmentCostReviewSchema.parse({ shipmentId, supplierCosts,
    lines: rows.map(row => {
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

/** The same projection and supplier boundaries for one bounded header page. */
export async function readShipmentCostReviewProjectionsInTransaction<T>(tx: ShipmentExceptionReader, shipmentIds: readonly number[],
  project: (review: ShipmentCostReview) => T, supplierSnapshot?: PurchaseCostStatusSnapshotReader): Promise<Map<number, T>> {
  const ids = [...new Set(shipmentCostReadPageSchema.parse(shipmentIds))];
  if (!ids.length) return new Map();
  const headers = await tx.execute(sql`SELECT id FROM procurement.inbound_shipments WHERE id=ANY(${sql.param(ids)}::int[]) ORDER BY id`);
  const selected = new Set(ids);
  const rowsByShipment = new Map<number, Record<string, unknown>[]>();
  for (const header of headers.rows) {
    const id = costInteger(header.id, "shipmentId", 1);
    if (!selected.has(id) || rowsByShipment.has(id)) throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE", "Current shipment review headers are inconsistent.");
    rowsByShipment.set(id, []);
  }
  if (!rowsByShipment.size) return new Map();
  const result = await tx.execute(sql`SELECT line.inbound_shipment_id AS shipment_id,line.id,line.sku,line.purchase_order_line_id,revision.contract,
    application.id AS application_id,application.status,application.recorded_at,application.evidence->'result' AS result
    FROM procurement.inbound_shipment_lines line
    LEFT JOIN LATERAL (SELECT id,contract FROM procurement.cost_source_revisions revision
      WHERE revision.inbound_shipment_line_id=line.id AND revision.component='landed'
      ORDER BY revision.revision DESC,revision.id DESC LIMIT 1) revision ON true
    LEFT JOIN LATERAL (SELECT id,status,recorded_at,evidence FROM inventory.cost_applications application
      WHERE application.source_revision_id=revision.id ORDER BY application.id DESC LIMIT 1) application ON true
    WHERE line.inbound_shipment_id=ANY(${sql.param([...rowsByShipment.keys()])}::int[]) ORDER BY line.id`);
  for (const row of result.rows) {
    const scoped = rowsByShipment.get(costInteger(row.shipment_id, "shipmentId", 1));
    if (!scoped) throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE", "Current shipment review lines escaped their scope.");
    scoped.push(row);
  }
  const posting = await readShipmentCostPostingEvidence(tx, result.rows.map(row => ({
    lineId: costInteger(row.id, "line.id", 1), shipmentId: costInteger(row.shipment_id, "shipmentId", 1), contract: row.contract,
  })));
  const reviews = new Map<number, T>();
  for (const id of ids) {
    const rows = rowsByShipment.get(id);
    // Project immediately so health pages do not retain every full supplier-lot graph.
    if (rows) reviews.set(id, project(await projectShipmentCostReview(tx, id, rows, posting, supplierSnapshot)));
  }
  return reviews;
}

/** Full review consumers retain the same validated public DTO. */
export async function readShipmentCostReviewsInTransaction(tx: ShipmentExceptionReader, shipmentIds: readonly number[],
  supplierSnapshot?: PurchaseCostStatusSnapshotReader): Promise<Map<number, ShipmentCostReview>> {
  return readShipmentCostReviewProjectionsInTransaction(tx, shipmentIds, review => review, supplierSnapshot);
}
