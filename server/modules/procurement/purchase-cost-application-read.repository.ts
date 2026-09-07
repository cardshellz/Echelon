import { sql } from "drizzle-orm";
import { purchaseCostApplicationReadSchema, type PurchaseCostApplicationRead } from "./purchase-cost-application-read.service";
import { dateValues, moneyValues, readRows, PURCHASE_WORKSPACE_LINE_LIMIT, type Transaction } from "./purchase-workspace-read";

const COST_REVISION_HISTORY_LIMIT = 1_000;

export async function readPurchaseCostApplications(tx: Transaction, purchaseOrderId: number): Promise<PurchaseCostApplicationRead> {
  const [revisions, applications, lotChanges, contributions, reportingEvents] = [
    await readRows(tx, sql`
      SELECT revision.id, revision.purchase_order_line_id AS "purchaseOrderLineId", revision.inbound_shipment_line_id AS "shipmentLineId",
        shipment.inbound_shipment_id AS "shipmentId", revision.component, revision.revision, revision.fingerprint, revision.contract, revision.source_evidence AS "sourceEvidence",
        revision.recorded_by AS "recordedBy", revision.recorded_at AS "recordedAt"
      FROM procurement.cost_source_revisions revision
      JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
      LEFT JOIN procurement.inbound_shipment_lines shipment ON shipment.id=revision.inbound_shipment_line_id
      WHERE line.purchase_order_id=${purchaseOrderId}
      ORDER BY revision.purchase_order_line_id, revision.component, revision.inbound_shipment_line_id, revision.revision DESC
      LIMIT ${COST_REVISION_HISTORY_LIMIT + 1}
    `, "cost source revision history", COST_REVISION_HISTORY_LIMIT),
    await readRows(tx, sql`
      SELECT application.id, application.source_revision_id AS "sourceRevisionId", application.status,
        application.evidence->'result' AS result, application.recorded_by AS "recordedBy", application.recorded_at AS "recordedAt"
      FROM inventory.cost_applications application
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id
      JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
      WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY application.id DESC LIMIT ${COST_REVISION_HISTORY_LIMIT + 1}
    `, "cost application history", COST_REVISION_HISTORY_LIMIT),
    await readRows(tx, sql`
      SELECT change.application_id AS "applicationId", change.inventory_lot_id AS "lotId", change.before_state AS before, change.after_state AS after,
        lot.lot_number AS "lotNumber", lot.product_variant_id AS "variantId", lot.warehouse_location_id AS "locationId", lot.qty_on_hand AS "currentOnHandUnits",
        origin.receiving_line_id AS "receivingLineId", origin.purchase_order_line_id AS "originalPurchaseOrderLineId"
      FROM inventory.cost_application_lots change
      JOIN inventory.cost_applications application ON application.id=change.application_id
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id
      JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
      LEFT JOIN inventory.inventory_lots lot ON lot.id=change.inventory_lot_id
      LEFT JOIN inventory.lot_cost_origins origin ON origin.inventory_lot_id=change.inventory_lot_id
      WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY change.application_id DESC, change.inventory_lot_id
      LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "cost application lot snapshots", PURCHASE_WORKSPACE_LINE_LIMIT),
    await readRows(tx, sql`
      SELECT edge.id, edge.source_lot_id AS "sourceLotId", edge.output_lot_id AS "outputLotId", edge.source_qty AS "sourceQty", edge.output_qty AS "outputQty",
        edge.output_start_qty AS "outputStartQty", edge.operation_kind AS "operationKind", edge.operation_key AS "operationKey"
      FROM inventory.lot_cost_contributions edge
      WHERE EXISTS (SELECT 1 FROM inventory.cost_application_lots change
        JOIN inventory.cost_applications application ON application.id=change.application_id
        JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id
        JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
        WHERE change.inventory_lot_id=edge.output_lot_id AND line.purchase_order_id=${purchaseOrderId})
      ORDER BY edge.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
    `, "applied lot contribution history", PURCHASE_WORKSPACE_LINE_LIMIT),
    await readRows(tx, sql`
      SELECT event.id, event.application_id AS "applicationId", event.contract_version AS "contractVersion", event.recorded_at AS "recordedAt",
        event.payload->'sourceRevisionId' AS "sourceRevisionId", event.payload->'sourceFingerprint' AS "sourceFingerprint",
        event.payload->'component' AS component, event.payload->'currency' AS currency, event.payload->'cogsDeltaCents' AS "cogsDeltaCents",
        event.payload->'contractVersion' AS "payloadContractVersion",
        CASE WHEN jsonb_typeof(event.payload->'changes')='array' THEN jsonb_array_length(event.payload->'changes') ELSE NULL END AS "changeCount"
      FROM inventory.cost_reporting_events event
      JOIN inventory.cost_applications application ON application.id=event.application_id
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id
      JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
      WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY event.id DESC LIMIT ${COST_REVISION_HISTORY_LIMIT + 1}
    `, "internal cost reporting events", COST_REVISION_HISTORY_LIMIT),
  ] as const;
  return purchaseCostApplicationReadSchema.parse({
    revisions: revisions.map((row) => dateValues(moneyValues(row, ["id"]), ["recordedAt"])),
    applications: applications.map((row) => dateValues(moneyValues(row, ["id", "sourceRevisionId"]), ["recordedAt"])),
    lotChanges: lotChanges.map((row) => moneyValues(row, ["applicationId"])),
    contributions: contributions.map((row) => moneyValues(row, ["id"])),
    reportingEvents: reportingEvents.map((row) => dateValues(moneyValues(row, ["id", "applicationId"]), ["recordedAt"])),
  });
}
