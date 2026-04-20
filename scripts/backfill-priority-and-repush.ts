/**
 * Backfill member plan info + sort_rank + re-push to ShipStation
 * for all active (non-shipped, non-cancelled) orders.
 *
 * Run with:
 *   heroku run -a <app> npx tsx scripts/backfill-priority-and-repush.ts
 *
 * Or locally:
 *   npx tsx scripts/backfill-priority-and-repush.ts
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { computeSortRank } from "../server/modules/orders/sort-rank";
import { createShipStationService } from "../server/modules/oms/shipstation.service";

async function main() {
  console.log("[Backfill] Starting priority + ShipStation refresh...");

  // 1. Backfill member_plan_name + member_plan_color on wms.orders
  console.log("[Backfill] Step 1: stamping plan info on wms.orders from active memberships...");
  const planResult: any = await db.execute(sql`
    UPDATE wms.orders o
    SET member_plan_name = p.name,
        member_plan_color = p.primary_color,
        updated_at = NOW()
    FROM membership.members m
    JOIN membership.member_subscriptions ms ON ms.member_id = m.id AND ms.status = 'active'
    JOIN membership.plans p ON p.id = ms.plan_id
    WHERE o.customer_email = m.email
      AND o.member_plan_name IS NULL
      AND o.warehouse_status NOT IN ('shipped', 'cancelled', 'ready_to_ship')
    RETURNING o.id
  `);
  console.log(`[Backfill] Stamped plan info on ${planResult?.rows?.length ?? 0} orders`);

  // 2. Also stamp plan info on oms.oms_orders so future re-syncs carry it
  const omsPlanResult: any = await db.execute(sql`
    UPDATE oms.oms_orders o
    SET member_plan_name = p.name,
        member_plan_color = p.primary_color,
        updated_at = NOW()
    FROM membership.members m
    JOIN membership.member_subscriptions ms ON ms.member_id = m.id AND ms.status = 'active'
    JOIN membership.plans p ON p.id = ms.plan_id
    WHERE o.customer_email = m.email
      AND o.member_plan_name IS NULL
      AND o.status NOT IN ('shipped', 'cancelled')
    RETURNING o.id
  `);
  console.log(`[Backfill] Stamped plan info on ${omsPlanResult?.rows?.length ?? 0} OMS rows`);

  // 3. Recompute priority for ALL active orders from scratch.
  //    base = shipping_service_level tier (100/300/500)
  //    + plan_priority_modifier (0 if no member)
  //    Skips bumped (>=9999) and held (-1) overrides.
  console.log("[Backfill] Step 3: recomputing priority for all active orders from scratch...");
  const priorityResult: any = await db.execute(sql`
    UPDATE wms.orders o
    SET priority = CASE
          WHEN COALESCE(oms.shipping_service_level, 'standard') = 'overnight' THEN 500
          WHEN COALESCE(oms.shipping_service_level, 'standard') = 'expedited' THEN 300
          ELSE 100
        END + COALESCE(p.priority_modifier, 0),
        updated_at = NOW()
    FROM oms.oms_orders oms
    LEFT JOIN membership.plans p ON p.name = oms.member_plan_name
    WHERE (
            (o.source = 'oms'     AND o.oms_fulfillment_order_id = oms.id::text)
         OR (o.source = 'shopify' AND o.source_table_id = oms.id::text)
          )
      AND o.priority < 9999
      AND o.warehouse_status IN ('ready', 'in_progress')
    RETURNING o.id
  `);
  console.log(`[Backfill] Recomputed priority on ${priorityResult?.rows?.length ?? 0} orders`);

  // 4. Recompute sort_rank for all orders in pick queue
  console.log("[Backfill] Step 4: recomputing sort_rank for all active orders...");
  const activeRows: any = await db.execute(sql`
    SELECT id, priority, on_hold, sla_due_at, order_placed_at, created_at
    FROM wms.orders
    WHERE warehouse_status IN ('ready', 'in_progress')
  `);
  let rankUpdated = 0;
  for (const row of activeRows.rows ?? []) {
    const rank = computeSortRank({
      priority: row.priority,
      onHold: row.on_hold,
      slaDueAt: row.sla_due_at,
      orderPlacedAt: row.order_placed_at || row.created_at,
    });
    await db.execute(sql`UPDATE wms.orders SET sort_rank = ${rank} WHERE id = ${row.id}`);
    rankUpdated++;
  }
  console.log(`[Backfill] Updated sort_rank on ${rankUpdated} orders`);

  // 5. Re-push all active orders to ShipStation so customField1 gets sort_rank
  //    and customField2 gets the combined oms_order_id|channel format.
  console.log("[Backfill] Step 5: re-pushing active orders to ShipStation...");
  const shipStation = createShipStationService(db);
  if (!shipStation.isConfigured()) {
    console.warn("[Backfill] ShipStation not configured, skipping re-push");
    return;
  }

  const orders: any = await db.execute(sql`
    SELECT oms.*
    FROM oms.oms_orders oms
    WHERE oms.status NOT IN ('shipped', 'cancelled')
      AND oms.shipstation_order_id IS NOT NULL
    ORDER BY oms.id ASC
  `);
  console.log(`[Backfill] Re-pushing ${orders.rows?.length ?? 0} orders to ShipStation...`);

  let success = 0;
  let failed = 0;
  for (const row of orders.rows ?? []) {
    try {
      // Load line items for this OMS order
      const lines: any = await db.execute(sql`
        SELECT * FROM oms.oms_order_lines WHERE order_id = ${row.id}
      `);
      const fullOrder = { ...row, lines: lines.rows ?? [] };
      await shipStation.pushOrder(fullOrder as any);
      success++;
      if (success % 25 === 0) console.log(`[Backfill]   ...${success} pushed`);
      // Rate limit \u2014 ShipStation allows ~40 req/min
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      console.warn(`[Backfill] Failed to push OMS order ${row.id}: ${err.message}`);
      failed++;
    }
  }
  console.log(`[Backfill] Done: ${success} pushed, ${failed} failed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[Backfill] Fatal:", err);
  process.exit(1);
});
