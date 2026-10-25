import { sql } from "drizzle-orm";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { readOriginRepairGraphEvidence } from "./cost-origin-repair.repository";
import { readPurchaseCostSources } from "./purchase-cost-source.repository";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { readShipmentSourceCapacities } from "./shipment-source-capacity";

const MAX_DEPENDENCY_ROWS = 10_000;
const MAX_GRAPH_RECORDS = 100_000;
type Row = Record<string, unknown>;
function bounded(rows: Row[]): Row[] {
  if (rows.length > MAX_DEPENDENCY_ROWS)
    throw new PoQuantityAmendmentError(
      "This PO exceeds the complete dependency review limit. No partial edit was saved.",
      "PO_AMENDMENT_DEPENDENCY_LIMIT",
    );
  return rows;
}

/** Called under the shared cost-graph lock. Include complete shared shipments:
 * changing one value allocation can revalue lines belonging to another PO. */
export async function readPoAmendmentDependencies(
  tx: AmendmentTransaction,
  lineIds: number[],
) {
  const shipments = bounded(
    (
      await tx.execute(sql`SELECT s.* FROM procurement.inbound_shipments s
    WHERE s.status <> 'cancelled' AND EXISTS(SELECT 1 FROM procurement.inbound_shipment_lines l
      WHERE l.inbound_shipment_id=s.id AND l.purchase_order_line_id=ANY(${sql.param(lineIds)}::int[]))
    ORDER BY s.id LIMIT ${MAX_DEPENDENCY_ROWS + 1} FOR UPDATE`)
    ).rows,
  );
  const shipmentIds = shipments.map((row) =>
    costInteger(row.id, "shipmentId", 1),
  );
  const shipmentLines = bounded(
    (
      await tx.execute(sql`SELECT * FROM procurement.inbound_shipment_lines
    WHERE inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) ORDER BY id LIMIT ${MAX_DEPENDENCY_ROWS + 1} FOR UPDATE`)
    ).rows,
  );
  const costs = bounded(
    (
      await tx.execute(sql`SELECT * FROM procurement.inbound_freight_costs
    WHERE inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) ORDER BY id LIMIT ${MAX_DEPENDENCY_ROWS + 1} FOR UPDATE`)
    ).rows,
  );
  const allocations = bounded(
    (
      await tx.execute(sql`SELECT a.* FROM procurement.inbound_freight_allocations a
    JOIN procurement.inbound_shipment_lines l ON l.id=a.inbound_shipment_line_id
    WHERE l.inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) ORDER BY a.id LIMIT ${MAX_DEPENDENCY_ROWS + 1}`)
    ).rows,
  );
  const snapshots = bounded(
    (
      await tx.execute(sql`SELECT s.* FROM procurement.landed_cost_snapshots s
    JOIN procurement.inbound_shipment_lines l ON l.id=s.inbound_shipment_line_id
    WHERE l.inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) ORDER BY s.id LIMIT ${MAX_DEPENDENCY_ROWS + 1}`)
    ).rows,
  );
  const affectedLineIds = [
    ...new Set([
      ...lineIds,
      ...shipmentLines
        .filter((row) => row.purchase_order_line_id != null)
        .map((row) =>
          costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1),
        ),
    ]),
  ].sort((a, b) => a - b);
  const sources = await readPurchaseCostSources(tx, affectedLineIds);
  const evidence = [];
  let graphRecords = 0;
  for (const id of affectedLineIds) {
    const graph = await readOriginRepairGraphEvidence(tx, id);
    graphRecords += Object.values(graph).reduce(
      (count, rows) => count + rows.length,
      0,
    );
    if (graphRecords > MAX_GRAPH_RECORDS)
      throw new PoQuantityAmendmentError(
        "The complete cost history exceeds the supported review size. No partial edit was saved.",
        "PO_AMENDMENT_DEPENDENCY_LIMIT",
      );
    evidence.push({ id, source: sources.get(id) ?? null, graph });
  }
  const purchaseOrderIds = [
    ...new Set(
      [...sources.values()].map((source) =>
        costInteger(
          source.purchaseOrderLine.purchase_order_id,
          "purchaseOrderId",
          1,
        ),
      ),
    ),
  ];
  const capacity = purchaseOrderIds.length
    ? await readShipmentSourceCapacities(tx, {
        purchaseOrderIds,
        purchaseOrderLineIds: [...sources.keys()],
      })
    : null;
  const shipmentCapacity = [...sources.keys()]
    .sort((a, b) => a - b)
    .map((lineId) => {
      const current = capacity?.capacities.get(lineId),
        error = capacity?.reviewRequired.get(lineId);
      const ineligible =
        error?.details.code === "SHIPMENT_LINE_SOURCE_INELIGIBLE";
      return {
        lineId,
        remainingPieces: current?.remainingQty ?? (ineligible ? 0 : null),
        reviewReason: error && !ineligible ? error.message : null,
      };
    });
  const approvals = bounded(
    (
      await tx.execute(sql`SELECT * FROM inventory.cost_reconciliation_approvals
    WHERE purchase_order_line_id=ANY(${sql.param(affectedLineIds)}::int[]) OR inbound_shipment_line_id IN
    (SELECT id FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]))
    ORDER BY id LIMIT ${MAX_DEPENDENCY_ROWS + 1}`)
    ).rows,
  );
  const postings = bounded(
    (
      await tx.execute(sql`SELECT * FROM inventory.cost_reconciliation_postings
    WHERE purchase_order_line_id=ANY(${sql.param(affectedLineIds)}::int[]) OR inbound_shipment_line_id IN
    (SELECT id FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]))
    ORDER BY id LIMIT ${MAX_DEPENDENCY_ROWS + 1}`)
    ).rows,
  );
  return {
    shipments,
    shipmentLines,
    costs,
    allocations,
    snapshots,
    evidence,
    approvals,
    postings,
    shipmentCapacity,
  };
}
export type PoAmendmentDependencies = Awaited<
  ReturnType<typeof readPoAmendmentDependencies>
>;
