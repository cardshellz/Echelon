import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  originRepairApprovalSchema,
  type OriginRepairChoices,
  type OriginRepairSummary,
} from "@shared/procurement/cost-origin-repair";
import {
  CostEvidenceError,
  costInteger,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseCostSource } from "./purchase-cost-source.repository";
import type { OriginRepairFacts } from "./domain/cost-origin-repair";

const MAX_REPAIR_LOTS = 10_000;
const MAX_REPAIR_RECORDS = 100_000;
function bounded<T>(rows: T[], maximum: number): T[] {
  if (rows.length > maximum)
    throw new CostEvidenceError(
      "COST_ORIGIN_REPAIR_LIMIT",
      "The complete receipt cost history exceeds the supported repair size. No partial history may be approved.",
    );
  return rows;
}

/** Include every recorded financial destination in the review version. Comparing
 * only aggregate COGS deltas would miss a transfer between two orders with the
 * same net amount. This is evidence capture; the existing cost owner still makes
 * every allocation and posting decision. Call under the inventory graph lock. */
export async function readOriginRepairGraphEvidence(
  tx: CostEvidenceTransaction,
  lineId: number,
) {
  const graph = bounded(
    (
      await tx.execute(sql`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM inventory.inventory_lots WHERE po_line_id=${lineId}
    UNION SELECT edge.output_lot_id FROM inventory.lot_cost_contributions edge JOIN descendants d ON edge.source_lot_id=d.id
  ), scoped AS (SELECT id FROM descendants UNION SELECT edge.source_lot_id FROM inventory.lot_cost_contributions edge JOIN descendants d ON edge.output_lot_id=d.id)
  SELECT lot.* FROM inventory.inventory_lots lot JOIN scoped ON scoped.id=lot.id ORDER BY lot.id LIMIT ${MAX_REPAIR_LOTS + 1}`)
    ).rows,
    MAX_REPAIR_LOTS,
  );
  const ids = graph.map((row) => costInteger(row.id, "graph.lotId", 1));
  const edges = bounded(
    (
      await tx.execute(sql`SELECT * FROM inventory.lot_cost_contributions WHERE source_lot_id=ANY(${sql.param(ids)}::int[])
    OR output_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY id LIMIT ${MAX_REPAIR_RECORDS + 1}`)
    ).rows,
    MAX_REPAIR_RECORDS,
  );
  const cogs = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM oms.order_item_costs WHERE inventory_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY id LIMIT ${MAX_REPAIR_RECORDS + 1}`,
      )
    ).rows,
    MAX_REPAIR_RECORDS,
  );
  const allocations = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY id LIMIT ${MAX_REPAIR_RECORDS + 1}`,
      )
    ).rows,
    MAX_REPAIR_RECORDS,
  );
  const bases = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM inventory.lot_cost_quantity_bases WHERE inventory_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY inventory_lot_id LIMIT ${MAX_REPAIR_LOTS + 1}`,
      )
    ).rows,
    MAX_REPAIR_LOTS,
  );
  const protections = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM inventory.cost_component_protections WHERE inventory_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY inventory_lot_id,component LIMIT ${MAX_REPAIR_RECORDS + 1}`,
      )
    ).rows,
    MAX_REPAIR_RECORDS,
  );
  const mappings = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM inventory.lot_cost_contribution_allocations WHERE contribution_id=ANY(${sql.param(edges.map((row) => String(row.id)))}::bigint[]) ORDER BY contribution_id LIMIT ${MAX_REPAIR_RECORDS + 1}`,
      )
    ).rows,
    MAX_REPAIR_RECORDS,
  );
  const returns = edges.some((row) => row.operation_kind === "return")
    ? bounded(
        (
          await tx.execute(
            sql`SELECT * FROM inventory.return_cost_allocations WHERE returned_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY returned_lot_id LIMIT ${MAX_REPAIR_RECORDS + 1}`,
          )
        ).rows,
        MAX_REPAIR_RECORDS,
      )
    : [];
  const unmappedReversals = cogs.filter(
    (row) => Number(row.qty) < 0 && row.cost_quantity_allocation_id == null,
  );
  const reversals = unmappedReversals.length
    ? bounded(
        (
          await tx.execute(sql`SELECT reversal.*,original.order_item_cost_id AS original_cost_id
    FROM inventory.availability_claim_pick_movements reversal JOIN inventory.availability_claim_pick_movements original ON original.id=reversal.reverses_pick_movement_id
    WHERE reversal.order_item_cost_id=ANY(${sql.param(unmappedReversals.map((row) => costInteger(row.id, "cost.id", 1)))}::int[]) ORDER BY reversal.id LIMIT ${MAX_REPAIR_RECORDS + 1}`)
        ).rows,
        MAX_REPAIR_RECORDS,
      )
    : [];
  const origins = bounded(
    (
      await tx.execute(sql`SELECT origin.*,line.cost_source_kind,line.cost_source_evidence,
    EXISTS(SELECT 1 FROM procurement.receipt_reversals reversal WHERE reversal.receiving_line_id=origin.receiving_line_id) AS reversed
    FROM inventory.effective_lot_cost_origins origin JOIN procurement.receiving_lines line ON line.id=origin.receiving_line_id
    WHERE origin.inventory_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY origin.inventory_lot_id LIMIT ${MAX_REPAIR_LOTS + 1}`)
    ).rows,
    MAX_REPAIR_LOTS,
  );
  return {
    lots: graph,
    edges,
    cogs,
    allocations,
    bases,
    protections,
    mappings,
    returns,
    reversals,
    origins,
  };
}

/** The caller holds the graph lock. Financial writes use the same lock before
 * source rows; no catalog factor or mutable lot balance becomes receipt proof. */
export async function readOriginRepairFacts(
  tx: CostEvidenceTransaction,
  lotId: number,
): Promise<OriginRepairFacts | null> {
  const lots =
    await tx.execute(sql`SELECT lot.*,po.expected_receive_variant_id,po.expected_receive_units_per_variant,
    po.sku,receipt.receipt_number,receipt.status AS receipt_status,receipt.inbound_shipment_id AS receipt_shipment_id,
    EXISTS(SELECT 1 FROM oms.order_item_costs c WHERE c.inventory_lot_id=lot.id) AS has_cogs,
    EXISTS(SELECT 1 FROM inventory.order_line_costs c WHERE c.lot_id=lot.id) AS has_legacy_cogs,
    EXISTS(SELECT 1 FROM inventory.lot_cost_contributions c WHERE c.source_lot_id=lot.id OR c.output_lot_id=lot.id) AS has_contribution,
    EXISTS(SELECT 1 FROM inventory.cost_component_protections c WHERE c.inventory_lot_id=lot.id) AS protected
    FROM inventory.inventory_lots lot
    JOIN procurement.purchase_order_lines po ON po.id=lot.po_line_id
    JOIN procurement.receiving_orders receipt ON receipt.id=lot.receiving_order_id
    WHERE lot.id=${lotId} FOR UPDATE OF po,receipt,lot`);
  const lot = lots.rows[0];
  if (!lot) return null;
  const source = await readPurchaseCostSource(
    tx,
    costInteger(lot.po_line_id, "purchaseOrderLineId", 1),
  );
  const receipts = await tx.execute(sql`SELECT line.*,
    EXISTS(SELECT 1 FROM procurement.receipt_reversals r WHERE r.receiving_line_id=line.id) AS reversed
    FROM procurement.receiving_lines line WHERE line.receiving_order_id=${lot.receiving_order_id}
      AND line.purchase_order_line_id=${lot.po_line_id} AND line.product_variant_id=${lot.product_variant_id} ORDER BY line.id LIMIT ${MAX_REPAIR_LOTS + 1} FOR UPDATE`);
  const shipments =
    await tx.execute(sql`SELECT * FROM procurement.inbound_shipment_lines
    WHERE inbound_shipment_id=${lot.inbound_shipment_id} AND purchase_order_line_id=${lot.po_line_id} ORDER BY id LIMIT ${MAX_REPAIR_LOTS + 1} FOR UPDATE`);
  const origins = await tx.execute(
    sql`SELECT * FROM inventory.effective_lot_cost_origins WHERE purchase_order_line_id=${lot.po_line_id} ORDER BY purchase_start_base_piece,inventory_lot_id LIMIT ${MAX_REPAIR_LOTS + 1}`,
  );
  const siblings =
    await tx.execute(sql`SELECT id,qty_received,product_variant_id FROM inventory.inventory_lots
    WHERE receiving_order_id=${lot.receiving_order_id} AND po_line_id=${lot.po_line_id} AND product_variant_id=${lot.product_variant_id} ORDER BY id LIMIT ${MAX_REPAIR_LOTS + 1}`);
  const repairs = await tx.execute(
    sql`SELECT * FROM inventory.cost_origin_repairs WHERE inventory_lot_id=${lotId}`,
  );
  const repair = repairs.rows[0];
  return {
    lot,
    source,
    receipts: bounded(receipts.rows, MAX_REPAIR_LOTS),
    shipments: bounded(shipments.rows, MAX_REPAIR_LOTS),
    origins: bounded(origins.rows, MAX_REPAIR_LOTS),
    siblings: bounded(siblings.rows, MAX_REPAIR_LOTS),
    approval: repair
      ? originRepairApprovalSchema.parse({
          id: costInteger(repair.id, "repairId", 1),
          actorName: repair.actor_name,
          reason: repair.reason,
          recordedAt: new Date(repair.recorded_at).toISOString(),
          destination: repair.evidence.choices.destination,
          summary: repair.evidence.summary,
        })
      : null,
  };
}

export async function restoreReceiptCostFields(
  tx: CostEvidenceTransaction,
  facts: OriginRepairFacts,
  unitsPerCase: number,
  actorId: string,
  now: Date,
) {
  const line = facts.receipts[0];
  await tx.execute(sql`UPDATE procurement.receiving_lines SET units_per_variant_snapshot=${unitsPerCase},
    inbound_shipment_line_id=${facts.shipments[0].id},cost_source_kind='purchase_order_line',
    cost_source_evidence=${canonicalJson({ kind: "administrator_origin_repair", actorId, recordedAt: now.toISOString(), before: line })}::jsonb
    WHERE id=${line.id}`);
}
export async function recordOriginRepair(
  tx: CostEvidenceTransaction,
  input: {
    facts: OriginRepairFacts;
    sourceVersion: string;
    choices: OriginRepairChoices;
    summary: OriginRepairSummary;
    actorId: string;
    actorName: string;
    now: Date;
  },
) {
  const { facts, choices, summary } = input;
  await tx.execute(sql`INSERT INTO inventory.cost_origin_repairs
    (inventory_lot_id,receiving_line_id,purchase_order_line_id,source_version,actor_id,actor_name,reason,recorded_at,evidence)
    VALUES(${facts.lot.id},${facts.receipts[0].id},${facts.lot.po_line_id},${input.sourceVersion},${input.actorId},${input.actorName},${choices.reason},${input.now},
      ${canonicalJson({ contractVersion: 1, before: facts, choices, summary })}::jsonb)`);
}
