import { readShipmentCostExceptions } from "./shipment-cost-exception.repository";
import { readReconciliationLedger } from "../inventory/infrastructure/cost-reconciliation.repository";
import { isCostReconciliationPosted } from "@shared/procurement/cost-posting-status";
import { costIssueSchema } from "@shared/procurement/cost-source-contracts";
import { sql } from "drizzle-orm";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
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
        application.evidence->'result' AS result, application.evidence->'noInventoryEffectEvidence' AS "noInventoryEffectEvidence", application.recorded_by AS "recordedBy", application.recorded_at AS "recordedAt"
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
        event.payload->'historicalCostAdjustments' AS "historicalCostAdjustments",
        event.payload->'unresolvedQuantities' AS "unresolvedQuantities",
        event.payload->'inventoryEffectProof' AS "inventoryEffectProof",
        CASE WHEN jsonb_typeof(event.payload->'changes')='array' THEN jsonb_array_length(event.payload->'changes') ELSE NULL END AS "changeCount"
      FROM inventory.cost_reporting_events event
      JOIN inventory.cost_applications application ON application.id=event.application_id
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id
      JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
      WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY event.id DESC LIMIT ${COST_REVISION_HISTORY_LIMIT + 1}
    `, "internal cost reporting events", COST_REVISION_HISTORY_LIMIT),
  ] as const;
  const shipmentLineIds = [...new Set(revisions.flatMap((revision) => revision.component === "landed" && typeof revision.shipmentLineId === "number" ? [revision.shipmentLineId] : []))];
  const postings = revisions.length === 0 ? [] : await readRows(tx, sql`
    SELECT posting.id, posting.approval_id AS "approvalId", posting.application_id AS "applicationId",
      posting.source_revision_id AS "sourceRevisionId", posting.destination, posting.before_mills AS "beforeMills",
      posting.after_mills AS "afterMills", posting.delta_mills AS "deltaMills", approval.actor_name AS "actorName",
      approval.reason, posting.recorded_at AS "recordedAt"
    FROM inventory.cost_reconciliation_postings posting
    JOIN inventory.cost_reconciliation_approvals approval ON approval.id=posting.approval_id
    JOIN procurement.cost_source_revisions revision ON revision.id=posting.source_revision_id
    JOIN procurement.purchase_order_lines line ON line.id=revision.purchase_order_line_id
    WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY posting.id
    LIMIT ${COST_REVISION_HISTORY_LIMIT + 1}
  `, "historical cost reconciliation postings", COST_REVISION_HISTORY_LIMIT);
  const data = purchaseCostApplicationReadSchema.parse({
    revisions: revisions.map((row) => dateValues(moneyValues(row, ["id"]), ["recordedAt"])),
    applications: applications.map((row) => dateValues(moneyValues(row, ["id", "sourceRevisionId"]), ["recordedAt"])),
    lotChanges: lotChanges.map((row) => moneyValues(row, ["applicationId"])),
    contributions: contributions.map((row) => moneyValues(row, ["id"])),
    reconciliationPostings: postings.map((row) => dateValues(moneyValues(row,
      ["id", "approvalId", "applicationId", "sourceRevisionId", "beforeMills", "afterMills", "deltaMills"]), ["recordedAt"])),
    reportingEvents: reportingEvents.map((row) => dateValues(moneyValues(row, ["id", "applicationId"]), ["recordedAt"])),
  });
  // The workspace owns a read-only repeatable-read transaction. The canonical
  // exception reader checks the live source fingerprint before trusting approval.
  const reviews = await readShipmentCostExceptions(tx, shipmentLineIds);
  data.currentResolutions = [];
  const supplierLineIds = [...new Set(data.revisions.filter(row => row.component !== "landed").map(row => row.purchaseOrderLineId))];
  const supplier = await readPurchaseCostStatus(tx, supplierLineIds);
  for (const line of supplier.lines) for (const component of line.components) {
    if (component.status !== "applied" || !component.historicalPosting || !component.sourceRevisionId || !component.applicationId) continue;
    const revision = data.revisions.find(row => row.id === component.sourceRevisionId);
    if (!revision) continue;
    const ledger = await readReconciliationLedger(tx, { purchaseOrderLineId: line.purchaseOrderLineId, component: component.component });
    const currentPostings = (data.reconciliationPostings ?? []).filter(posting => Object.values(ledger.lastIds).includes(posting.id));
    if (!currentPostings.length) continue;
    data.currentResolutions.push({ sourceRevisionId: revision.id, sourceFingerprint: revision.fingerprint, applicationId: component.applicationId,
      currency: "USD", destination: component.historicalPosting.destination, postedMills: component.historicalPosting.amountMills, postings: currentPostings });
  }
  for (const lineId of shipmentLineIds) {
    const revision = data.revisions.filter((row) => row.shipmentLineId === lineId && row.component === "landed")
      .sort((left, right) => right.revision - left.revision || right.id - left.id)[0];
    const application = data.applications.filter((row) => row.sourceRevisionId === revision.id).sort((left, right) => right.id - left.id)[0];
    const issues = costIssueSchema.array().safeParse((application?.result as { issues?: unknown } | null)?.issues);
    const review = reviews.get(lineId);
    if (!application || !issues.success || !isCostReconciliationPosted(issues.data, review)) continue;
    const state = review!.reconciliation!;
    const ledger = await readReconciliationLedger(tx, lineId);
    const currentPostings = (data.reconciliationPostings ?? []).filter((posting) => Object.values(ledger.lastIds).includes(posting.id));
    if (!state.destination || currentPostings.length === 0) continue;
    data.currentResolutions.push({
      sourceRevisionId: revision.id, sourceFingerprint: revision.fingerprint, applicationId: application.id,
      currency: "USD", destination: state.destination, postedMills: state.postedMills, postings: currentPostings,
    });
  }
  return data;
}
