import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../../../db";
import { inventoryTrackingHistorySummarySchema, inventoryTrackingHistoryListSchema, MAX_TRACKING_HISTORY_RECORDS, InventoryTrackingHistoryCapacityError } from "@shared/catalog/inventory-tracking-history";

type Transaction = Pick<typeof db, "execute">;
const snapshotSchema = z.object({ levels: z.string(), lots: z.string(), summary: inventoryTrackingHistorySummarySchema });
export type TrackingStopSnapshot = z.infer<typeof snapshotSchema> & { snapshotHash: string };

/** Caller holds the catalog variant lock. Lock existing stock before reviewing
 * exact evidence; nonzero inserts also take the variant's policy SHARE lock.
 * Keep database JSON as text: parsing bigint money as JS numbers loses cents.
 */
export async function loadTrackingStopSnapshot(tx: Transaction, variantId: number, remainingRecords = MAX_TRACKING_HISTORY_RECORDS): Promise<TrackingStopSnapshot> {
  await tx.execute(sql`SELECT id FROM inventory.inventory_levels WHERE product_variant_id=${variantId} ORDER BY id FOR UPDATE`);
  await tx.execute(sql`SELECT id FROM inventory.inventory_lots WHERE product_variant_id=${variantId} ORDER BY id FOR UPDATE`);
  const count = await tx.execute(sql`SELECT (
    (SELECT count(*) FROM inventory.inventory_levels WHERE product_variant_id=${variantId}
      AND (variant_qty<>0 OR reserved_qty<>0 OR picked_qty<>0 OR packed_qty<>0 OR backorder_qty<>0)) +
    (SELECT count(*) FROM inventory.inventory_lots WHERE product_variant_id=${variantId}
      AND (qty_on_hand<>0 OR qty_reserved<>0 OR qty_picked<>0 OR qty_packed<>0)))::text AS count`);
  const countText = z.string().regex(/^\d+$/).parse(count.rows[0]?.count);
  if (BigInt(countText) > BigInt(remainingRecords)) throw new InventoryTrackingHistoryCapacityError();
  const result = await tx.execute(sql`WITH levels AS (
      SELECT * FROM inventory.inventory_levels WHERE product_variant_id=${variantId}
        AND (variant_qty<>0 OR reserved_qty<>0 OR picked_qty<>0 OR packed_qty<>0 OR backorder_qty<>0)
    ), lots AS (
      SELECT * FROM inventory.inventory_lots WHERE product_variant_id=${variantId}
        AND (qty_on_hand<>0 OR qty_reserved<>0 OR qty_picked<>0 OR qty_packed<>0)
    ) SELECT
      COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM levels l),'[]'::jsonb)::text AS levels,
      COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM lots l),'[]'::jsonb)::text AS lots,
      jsonb_build_object('levelCount',(SELECT count(*) FROM levels),'lotCount',(SELECT count(*) FROM lots),
        'onHand',COALESCE((SELECT sum(variant_qty) FROM levels),0)::text,
        'reserved',COALESCE((SELECT sum(reserved_qty) FROM levels),0)::text,
        'picked',COALESCE((SELECT sum(picked_qty) FROM levels),0)::text,
        'packed',COALESCE((SELECT sum(packed_qty) FROM levels),0)::text,
        'backorder',COALESCE((SELECT sum(backorder_qty) FROM levels),0)::text,
        'lotOnHand',COALESCE((SELECT sum(qty_on_hand) FROM lots),0)::text,
        'lotReserved',COALESCE((SELECT sum(qty_reserved) FROM lots),0)::text,
        'lotPicked',COALESCE((SELECT sum(qty_picked) FROM lots),0)::text,
        'lotPacked',COALESCE((SELECT sum(qty_packed) FROM lots),0)::text,
        'recordedOnHandValueMills',COALESCE((SELECT sum(qty_on_hand::numeric *
          COALESCE(NULLIF(total_unit_cost_mills,0),unit_cost_mills,0)) FROM lots),0)::text) AS summary`);
  const snapshot = snapshotSchema.parse(result.rows[0]);
  return { ...snapshot, snapshotHash: createHash("sha256").update(snapshot.levels).update("\n").update(snapshot.lots).digest("hex") };
}

/** These are live obligations, not old counter values. Never close them by
 * archiving stock. The admission lock prevents a concurrent quantity cutover.
 */
export async function trackingStopOperationalBlockers(tx: Transaction, variantId: number): Promise<string[]> {
  const admission = await tx.execute(sql`SELECT epoch FROM inventory.cutover_admission_fence WHERE singleton_key=true FOR SHARE`);
  if (admission.rows.length !== 1) throw new Error("Inventory tracking stop admission is unavailable");
  const result = await tx.execute(sql`SELECT
    EXISTS(SELECT 1 FROM inventory.quantity_ledger_opening WHERE singleton_key=true) OR EXISTS(SELECT 1 FROM inventory.availability_runtime_authority WHERE authority<>'legacy') AS quantity_ledger,
    EXISTS(SELECT 1 FROM inventory.build_component_reservations r JOIN inventory.inventory_lots l ON l.id=r.inventory_lot_id
      WHERE l.product_variant_id=${variantId} AND r.reserved_qty>r.consumed_qty+r.released_qty) AS build_reservations,
    EXISTS(SELECT 1 FROM inventory.inventory_levels l JOIN warehouse.warehouse_locations w ON w.id=l.warehouse_location_id
      WHERE l.product_variant_id=${variantId} AND w.cycle_count_freeze_id IS NOT NULL) AS frozen_locations,
    EXISTS(SELECT 1 FROM inventory.replen_tasks WHERE (pick_product_variant_id=${variantId} OR source_product_variant_id=${variantId})
      AND status NOT IN ('completed','cancelled')) AS replenishment`);
  if (!result.rows[0]) throw new Error("Inventory tracking stop dependencies are unavailable");
  return Object.entries(result.rows[0]).filter(([, value]) => value === true).map(([code]) => code);
}

/** Called only after a fingerprinted review and dependency checks in the same
 * transaction. Zeros mean no *managed* balance. The immutable snapshot retains
 * the last recorded quantities; no physical shipment, adjustment, COGS, loss,
 * reservation release or lot consumption is fabricated.
 */
export async function retainTrackingStopHistory(tx: Transaction, input: {
  productId: number; variantId: number; actor: string; now: Date; snapshot: TrackingStopSnapshot;
}): Promise<void> {
  const { productId, variantId, actor, now, snapshot } = input;
  await tx.execute(sql`INSERT INTO inventory.tracking_stop_history
      (product_id,product_variant_id,actor,stopped_at,snapshot_hash,levels,lots,summary)
    VALUES(${productId},${variantId},${actor},${now},${snapshot.snapshotHash},
      ${snapshot.levels}::jsonb,${snapshot.lots}::jsonb,${JSON.stringify(snapshot.summary)}::jsonb)`);
  await tx.execute(sql`UPDATE inventory.inventory_levels SET variant_qty=0,reserved_qty=0,picked_qty=0,packed_qty=0,backorder_qty=0,updated_at=${now}
    WHERE product_variant_id=${variantId} AND (variant_qty<>0 OR reserved_qty<>0 OR picked_qty<>0 OR packed_qty<>0 OR backorder_qty<>0)`);
  await tx.execute(sql`UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_reserved=0,qty_picked=0,qty_packed=0,status='tracking_stopped'
    WHERE product_variant_id=${variantId} AND (qty_on_hand<>0 OR qty_reserved<>0 OR qty_picked<>0 OR qty_packed<>0)`);
}

export async function listTrackingStopHistory(tx: Transaction, productId: number, beforeId?: string) {
  const result = await tx.execute(sql`SELECT id::text,product_variant_id AS "variantId",actor,stopped_at::text AS "stoppedAt",summary
    FROM inventory.tracking_stop_history WHERE product_id=${productId} ${beforeId ? sql`AND id<${beforeId}::bigint` : sql``}
    ORDER BY id DESC LIMIT 21`);
  return inventoryTrackingHistoryListSchema.parse({ records: result.rows.slice(0,20), hasMore: result.rows.length>20 });
}

export async function exportTrackingStopHistory(tx: Transaction, productId: number, historyId: string): Promise<string | null> {
  const result = await tx.execute(sql`SELECT to_jsonb(h)::text AS document FROM inventory.tracking_stop_history h
    WHERE product_id=${productId} AND id=${historyId}::bigint`);
  return result.rows.length ? z.string().parse(result.rows[0].document) : null;
}
