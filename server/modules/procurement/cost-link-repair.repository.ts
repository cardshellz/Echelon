import { sql } from "drizzle-orm";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import {
  costFingerprint,
  costInteger as integer,
  CostEvidenceError,
} from "../inventory/infrastructure/cost-evidence.repository";
import type { CostLinkHistory, CostLinkRoot } from "./domain/cost-link-repair";
import type { QuantityCorrectionSource } from "./receipt-shipment-quantity-correction.repository";
import type { QuantityCorrectionPlan } from "./domain/receipt-shipment-quantity-correction";
import { lotCostTotals } from "../inventory/domain/lot-cost";

const MAX_LOTS = 10_000,
  MAX_RECORDS = 100_000;
type Row = Record<string, unknown>;
function bounded(rows: Row[], max: number, name: string) {
  if (rows.length > max)
    throw new CostEvidenceError(
      "COST_LINK_HISTORY_LIMIT",
      `The complete ${name} exceeds the repair limit. No partial history can be approved.`,
    );
  return rows;
}
const nullableId = (value: unknown) =>
  value == null ? null : integer(value, "history identifier", 1);

/** Read under the caller's graph fence and source locks. Include candidate lots,
 * transactions, count decisions and every existing financial destination in the
 * preview version, including candidates without any current source-cost link. */
export async function readCostLinkHistory(
  tx: CostEvidenceTransaction,
  source: QuantityCorrectionSource,
  plan: QuantityCorrectionPlan,
) {
  const lineIds = plan.receipts.map((row) => row.id);
  const receiptMoves = bounded(
    (
      await tx.execute(sql`SELECT t.*,t.created_at::text AS event_time FROM inventory.inventory_transactions t
    WHERE receiving_line_id=ANY(${sql.param(lineIds)}::int[]) AND transaction_type='receipt' AND voided_at IS NULL ORDER BY id FOR UPDATE`)
    ).rows,
    MAX_LOTS,
    "receipt transactions",
  );
  const variants = [
    ...new Set(
      receiptMoves.map((row) =>
        integer(row.product_variant_id, "receipt variant", 1),
      ),
    ),
  ];
  const lots = bounded(
    (
      await tx.execute(sql`WITH RECURSIVE scoped(id) AS (
    SELECT l.id FROM inventory.inventory_lots l JOIN catalog.product_variants v ON v.id=l.product_variant_id
    WHERE v.product_id IN (SELECT product_id FROM catalog.product_variants WHERE id=ANY(${sql.param(variants)}::int[]))
    UNION SELECT edge.output_lot_id FROM inventory.lot_cost_contributions edge JOIN scoped ON scoped.id=edge.source_lot_id
  ) SELECT l.*,l.created_at::text AS event_time,v.sku,v.product_id,v.units_per_variant
    FROM inventory.inventory_lots l JOIN catalog.product_variants v ON v.id=l.product_variant_id
    JOIN scoped ON scoped.id=l.id
    ORDER BY l.id LIMIT ${MAX_LOTS + 1} FOR UPDATE OF l,v`)
    ).rows,
    MAX_LOTS,
    "product lots",
  );
  const productIds = [
    ...new Set(lots.map((row) => integer(row.product_id, "product", 1))),
  ];
  const lotIds = lots.map((row) => integer(row.id, "lot", 1));
  // Count approval can be changed by a separate owner. Hold its evidence stable
  // while the preview or approval reads the matching stock movements.
  bounded(
    (
      await tx.execute(sql`SELECT item.id FROM inventory.cycle_count_items item
    JOIN catalog.product_variants v ON v.id=item.product_variant_id
    WHERE v.product_id=ANY(${sql.param(productIds)}::int[]) ORDER BY item.id LIMIT ${MAX_RECORDS + 1} FOR SHARE OF item`)
    ).rows,
    MAX_RECORDS,
    "count approvals",
  );
  const movements = bounded(
    (
      await tx.execute(sql`SELECT t.*,t.created_at::text AS event_time,v.product_id,
    CASE WHEN t.cycle_count_id IS NULL THEN false ELSE EXISTS(SELECT 1 FROM inventory.cycle_count_items item
      WHERE item.cycle_count_id=t.cycle_count_id AND item.product_variant_id=t.product_variant_id
      AND item.warehouse_location_id=COALESCE(t.from_location_id,t.to_location_id) AND item.status='approved'
      AND item.variance_qty=t.variant_qty_delta AND item.approved_by IS NOT NULL AND item.approved_at IS NOT NULL
      AND (item.adjustment_transaction_id IS NULL OR item.adjustment_transaction_id=t.id)) END AS count_approved,
    (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM inventory.cycle_count_items item WHERE item.cycle_count_id=t.cycle_count_id) AS count_evidence
    FROM inventory.inventory_transactions t JOIN catalog.product_variants v ON v.id=t.product_variant_id
    WHERE v.product_id=ANY(${sql.param(productIds)}::int[]) AND t.order_id IS NULL
    ORDER BY t.id LIMIT ${MAX_RECORDS + 1} FOR UPDATE OF t`)
    ).rows,
    MAX_RECORDS,
    "physical movements",
  );
  const edges = bounded(
    (
      await tx.execute(sql`SELECT * FROM inventory.lot_cost_contributions WHERE source_lot_id=ANY(${sql.param(lotIds)}::int[])
    OR output_lot_id=ANY(${sql.param(lotIds)}::int[]) ORDER BY id LIMIT ${MAX_RECORDS + 1}`)
    ).rows,
    MAX_RECORDS,
    "existing cost links",
  );
  const orders = bounded(
    (
      await tx.execute(sql`SELECT * FROM oms.order_item_costs WHERE inventory_lot_id=ANY(${sql.param(lotIds)}::int[])
    ORDER BY id LIMIT ${MAX_RECORDS + 1} FOR UPDATE`)
    ).rows,
    MAX_RECORDS,
    "order cost records",
  );
  const origins = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM inventory.effective_lot_cost_origins WHERE inventory_lot_id=ANY(${sql.param(lotIds)}::int[]) ORDER BY inventory_lot_id`,
      )
    ).rows,
    MAX_LOTS,
    "origins",
  );
  const allocations = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id=ANY(${sql.param(lotIds)}::int[]) ORDER BY id LIMIT ${MAX_RECORDS + 1}`,
      )
    ).rows,
    MAX_RECORDS,
    "cost custody",
  );
  const roots: CostLinkRoot[] = [];
  const shipmentLine = source.evidence.shipmentLines.find(
    (row) => row.id === source.facts.shipmentLineId,
  )!;
  for (const receipt of plan.receipts) {
    const candidates = receiptMoves.filter(
      (row) => Number(row.receiving_line_id) === receipt.id,
    );
    if (candidates.length !== 1)
      throw new CostEvidenceError(
        "COST_LINK_RECEIPT_AMBIGUOUS",
        `${receipt.receiptNumber} needs one original receipt movement with its lot recorded before automatic cost-link repair.`,
      );
    const movement = candidates[0];
    const lot = lots.find((row) => row.id === movement.inventory_lot_id);
    if (
      !lot ||
      Number(lot.qty_received) !== receipt.receivedUnits ||
      Number(movement.variant_qty_delta) !== receipt.receivedUnits ||
      Number(lot.receiving_order_id) !== receipt.receiptId ||
      Number(lot.po_line_id) !== Number(shipmentLine.purchase_order_line_id) ||
      Number(lot.product_variant_id) !== receipt.variantId ||
      Number(movement.product_variant_id) !== receipt.variantId ||
      Number(lot.warehouse_location_id) !== Number(movement.to_location_id)
    ) {
      throw new CostEvidenceError(
        "COST_LINK_RECEIPT_CONFLICT",
        `${receipt.receiptNumber}: the original movement and lot do not agree. No cost source was inferred.`,
      );
    }
    if (edges.some((edge) => edge.output_lot_id === lot.id))
      throw new CostEvidenceError(
        "COST_LINK_ROOT_CONFLICT",
        "The receipt lot already has a transformation source.",
      );
    roots.push({
      lotId: integer(lot.id, "root lot", 1),
      receiptLineId: receipt.id,
      piecesPerUnit: receipt.afterPiecesPerUnit,
    });
  }
  const history: CostLinkHistory = {
    lots: lots.map((row) => ({
      id: integer(row.id, "lot", 1),
      number: String(row.lot_number),
      variantId: integer(row.product_variant_id, "variant", 1),
      productId: integer(row.product_id, "product", 1),
      locationId: integer(row.warehouse_location_id, "location", 1),
      received: integer(row.qty_received, "received"),
      onHand: integer(row.qty_on_hand, "on hand"),
      createdAt: String(row.event_time),
      sku: String(row.sku),
      catalogPieces: integer(row.units_per_variant, "catalog pieces", 1),
    })),
    movements: movements.map((row) => ({
      id: integer(row.id, "movement", 1),
      kind: String(row.transaction_type),
      variantId: integer(row.product_variant_id, "variant", 1),
      productId: integer(row.product_id, "product", 1),
      lotId: nullableId(row.inventory_lot_id),
      quantity: integer(
        row.variant_qty_delta,
        "movement quantity",
        -2_147_483_647,
      ),
      from: nullableId(row.from_location_id),
      to: nullableId(row.to_location_id),
      occurredAt: String(row.event_time),
      countId: nullableId(row.cycle_count_id),
      countApproved: row.count_approved === true,
      receiptLineId: nullableId(row.receiving_line_id),
      voided: row.voided_at != null,
      notes: String(row.notes ?? ""),
    })),
    edges: edges.map((row) => ({
      source: integer(row.source_lot_id, "source", 1),
      output: integer(row.output_lot_id, "output", 1),
      sourceUnits: integer(row.source_qty, "source quantity", 1),
      outputUnits: integer(row.output_qty, "output quantity", 1),
      outputStart: integer(row.output_start_qty, "output interval"),
      key: String(row.operation_key),
    })),
    originLotIds: origins.map((row) =>
      integer(row.inventory_lot_id, "origin", 1),
    ),
    orderQuantities: orders.map((row) => ({
      lotId: integer(row.inventory_lot_id, "order lot", 1),
      quantity: integer(row.qty, "order quantity", -2_147_483_647),
    })),
  };
  return {
    history,
    roots,
    lots,
    orders,
    evidenceVersion: costFingerprint({
      receiptMoves,
      lots,
      movements,
      edges,
      orders,
      origins,
      allocations,
    }),
    evidence: {
      receiptMoves,
      lots,
      movements,
      edges,
      orders,
      origins,
      allocations,
    },
  };
}

export function costLinkLotSnapshot(lots: Row[], orders: Row[], ids: number[]) {
  return lots
    .filter((row) => ids.includes(Number(row.id)))
    .map((row) => {
      const totals = lotCostTotals(row).totals;
      const costs = orders.filter((cost) => cost.inventory_lot_id === row.id);
      return {
        lotId: integer(row.id, "lot", 1),
        lotNumber: String(row.lot_number),
        sku: String(row.sku),
        onHandUnits: integer(row.qty_on_hand, "on hand"),
        productMills: integer(totals.poMills.toString(), "product mills"),
        packagingMills: integer(
          totals.packagingMills.toString(),
          "packaging mills",
        ),
        shipmentMills: integer(totals.landedMills.toString(), "shipment mills"),
        orderCostCents: integer(
          costs
            .reduce(
              (sum, cost) =>
                sum +
                BigInt(
                  integer(
                    cost.total_cost_cents,
                    "order cost",
                    -Number.MAX_SAFE_INTEGER,
                  ),
                ),
              BigInt(0),
            )
            .toString(),
          "order costs",
          -Number.MAX_SAFE_INTEGER,
        ),
        linkedOrderRows: costs.length,
      };
    });
}

export async function readCostLinkLotSnapshot(
  tx: CostEvidenceTransaction,
  ids: number[],
) {
  const lots = (
    await tx.execute(
      sql`SELECT l.*,v.sku FROM inventory.inventory_lots l JOIN catalog.product_variants v ON v.id=l.product_variant_id WHERE l.id=ANY(${sql.param(ids)}::int[]) ORDER BY l.id`,
    )
  ).rows;
  const orders = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM oms.order_item_costs WHERE inventory_lot_id=ANY(${sql.param(ids)}::int[]) ORDER BY id LIMIT ${MAX_RECORDS + 1}`,
      )
    ).rows,
    MAX_RECORDS,
    "order costs",
  );
  return costLinkLotSnapshot(lots, orders, ids);
}
