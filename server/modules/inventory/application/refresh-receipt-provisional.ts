import { sql } from "drizzle-orm";
import { receiptSegmentCost } from "@shared/procurement/receipt-cost-segments";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import {
  CostEvidenceError,
  costInteger,
  type CostEvidenceTransaction,
  type CostRevisionInput,
} from "../infrastructure/cost-evidence.repository";
import { readLatestCostApplicationStatuses } from "../cost-application-public";
import { readLatestLandedCostRevisions } from "../../procurement/cost-source-evidence-public";

/** Inventory owns this derived flag. Supplier coverage is evaluated per frozen
 * root; mixed transfers/repacking inherit any provisional input. Clearing also
 * requires the receipt's separate shipment charge to have been confirmed/applied. */
export async function refreshReceiptProvisional(
  tx: CostEvidenceTransaction,
  lineId: number,
  selected: readonly CostRevisionInput[],
  supplierApplied: boolean,
) {
  const roots = (
    await tx.execute(sql`SELECT * FROM inventory.effective_lot_cost_origins
    WHERE purchase_order_line_id=${lineId} ORDER BY inventory_lot_id LIMIT 10001`)
  ).rows;
  if (roots.length > 10000)
    throw new CostEvidenceError(
      "COST_APPLICATION_LIMIT",
      "The complete provisional cost graph exceeds its supported size.",
    );
  if (!roots.length) return [];
  const rootIds = roots.map((row) =>
    costInteger(row.inventory_lot_id, "root lot", 1),
  );
  const lots = (
    await tx.execute(sql`WITH RECURSIVE graph(id) AS (
    SELECT unnest(${sql.param(rootIds)}::int[]) UNION
    SELECT edge.output_lot_id FROM inventory.lot_cost_contributions edge JOIN graph ON edge.source_lot_id=graph.id
  ) SELECT lot.id,lot.cost_provisional FROM inventory.inventory_lots lot JOIN graph ON graph.id=lot.id ORDER BY lot.id LIMIT 10001`)
  ).rows;
  if (lots.length > 10000)
    throw new CostEvidenceError(
      "COST_APPLICATION_LIMIT",
      "The complete provisional cost graph exceeds its supported size.",
    );
  const lotIds = lots.map((row) => costInteger(row.id, "lot id", 1));
  const edges = (
    await tx.execute(sql`SELECT edge.source_lot_id,edge.output_lot_id,parent.cost_provisional
    FROM inventory.lot_cost_contributions edge LEFT JOIN inventory.inventory_lots parent ON parent.id=edge.source_lot_id
    WHERE edge.output_lot_id=ANY(${sql.param(lotIds)}::int[]) ORDER BY edge.id LIMIT 100001`)
  ).rows;
  if (edges.length > 100000)
    throw new CostEvidenceError(
      "COST_APPLICATION_LIMIT",
      "The complete provisional contribution set exceeds its supported size.",
    );
  const shipmentIds = [
    ...new Set(
      roots
        .filter((row) => row.inbound_shipment_line_id != null)
        .map((row) =>
          costInteger(row.inbound_shipment_line_id, "shipment line", 1),
        ),
    ),
  ];
  const landedRevisions = await readLatestLandedCostRevisions(tx, shipmentIds);
  const landedStatuses = await readLatestCostApplicationStatuses(
    tx,
    landedRevisions.map((r) => r.sourceRevisionId),
  );
  const freight = landedRevisions.map((row) => ({
    inbound_shipment_line_id: row.inbound_shipment_line_id,
    contract: row.contract,
    status: landedStatuses.get(row.sourceRevisionId) ?? null,
  }));
  const states = new Map<number, boolean>();
  for (const root of roots) {
    const pieces = costInteger(
      (
        BigInt(String(root.received_variant_qty)) *
        BigInt(String(root.units_per_variant_snapshot))
      ).toString(),
      "received pieces",
      1,
    );
    const supplierConfirmed =
      supplierApplied &&
      selected.length === 2 &&
      selected.every(
        (source) =>
          source.receiptCostSegments &&
          receiptSegmentCost(
            source.receiptCostSegments,
            costInteger(root.purchase_start_base_piece, "receipt offset"),
            pieces,
            Number(root.receiving_line_id),
          ).provisionalPieces === 0,
      );
    const shipment = freight.find(
      (row) =>
        Number(row.inbound_shipment_line_id) ===
        Number(root.inbound_shipment_line_id),
    );
    const contract = costSourceRevisionSchema.safeParse(shipment?.contract);
    const freightConfirmed =
      root.inbound_shipment_line_id == null ||
      (shipment?.status === "applied" &&
        contract.success &&
        contract.data.evidence === "confirmed" &&
        contract.data.currency === "USD" &&
        contract.data.issue === null);
    states.set(
      Number(root.inventory_lot_id),
      !supplierConfirmed || !freightConfirmed,
    );
  }
  // A failed cost application cannot clear any provisional flag. Retain that
  // truthful pending state without turning financial input into a graph repair.
  if (!supplierApplied) for (const id of lotIds) states.set(id, true);
  const parentsByOutput = new Map<number, typeof edges>();
  for (const edge of edges) {
    const id = Number(edge.output_lot_id);
    const parents = parentsByOutput.get(id) ?? [];
    parents.push(edge);
    parentsByOutput.set(id, parents);
  }
  const pending = new Set(lotIds.filter((id) => !states.has(id)));
  while (pending.size) {
    let advanced = false;
    for (const id of pending) {
      const parents = parentsByOutput.get(id) ?? [];
      if (
        !parents.length ||
        parents.some((edge) => pending.has(Number(edge.source_lot_id)))
      )
        continue;
      states.set(
        id,
        parents.some(
          (edge) =>
            states.get(Number(edge.source_lot_id)) ??
            edge.cost_provisional !== 0,
        ),
      );
      pending.delete(id);
      advanced = true;
    }
    if (!advanced)
      throw new CostEvidenceError(
        "COST_GRAPH_INCOMPLETE",
        "The provisional cost status cannot prove all transfer/repacking inputs.",
      );
  }
  const changes = lots.flatMap((row) => {
    const next = states.get(Number(row.id)) ? 1 : 0;
    return row.cost_provisional === next
      ? []
      : [{ lotId: Number(row.id), before: row.cost_provisional, after: next }];
  });
  for (const change of changes)
    await tx.execute(
      sql`UPDATE inventory.inventory_lots SET cost_provisional=${change.after} WHERE id=${change.lotId}`,
    );
  return changes;
}
