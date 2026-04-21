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
import { createOmsService } from "../server/modules/oms/oms.service";

async function main() {
  console.log("[Backfill] Starting priority + ShipStation refresh...");

  // 1. Backfill member_plan_name + member_plan_color on wms.orders
  console.log("[Backfill] Step 1: stamping plan info on wms.orders from active memberships...");
  const planResult: any = await db.execute(sql`
    UPDATE wms.orders o
    SET member_plan_name = p.name,
        member_plan_color = p.primary_color
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
        END + COALESCE(p.priority_modifier, 0)
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

  // 4a. Backfill channel_ship_by_date on eBay orders from raw_payload.
  //     eBay order payload carries fulfillmentStartInstructions[0].shippingStep.shipByDate.
  //     Without this, historical eBay orders have no platform deadline and fall back
  //     to the generic channel-default SLA.
  console.log("[Backfill] Step 4a: extracting eBay shipByDate from raw_payload...");
  const ebayCandidates: any = await db.execute(sql`
    SELECT oms.id, oms.raw_payload
    FROM oms.oms_orders oms
    INNER JOIN channels c ON c.id = oms.channel_id
    WHERE oms.channel_ship_by_date IS NULL
      AND oms.raw_payload IS NOT NULL
      AND oms.status NOT IN ('cancelled')
      AND LOWER(c.provider) = 'ebay'
  `);
  let ebayStamped = 0;
  for (const row of ebayCandidates.rows ?? []) {
    try {
      const raw = typeof row.raw_payload === "string" ? JSON.parse(row.raw_payload) : row.raw_payload;
      const shipByRaw = raw?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipByDate;
      if (!shipByRaw) continue;
      const shipBy = new Date(shipByRaw);
      if (isNaN(shipBy.getTime())) continue;
      await db.execute(sql`
        UPDATE oms.oms_orders
        SET channel_ship_by_date = ${shipBy.toISOString()}
        WHERE id = ${row.id}
      `);
      ebayStamped++;
    } catch {
      // skip malformed payload
    }
  }
  console.log(`[Backfill] Stamped channel_ship_by_date on ${ebayStamped} eBay orders`);

  // 4b. Mirror channel_ship_by_date from oms → wms for any active WMS row
  //     that doesn't have one yet.
  const mirrorResult: any = await db.execute(sql`
    UPDATE wms.orders w
    SET channel_ship_by_date = oms.channel_ship_by_date
    FROM oms.oms_orders oms
    WHERE (
            (w.source = 'oms'     AND w.oms_fulfillment_order_id = oms.id::text)
         OR (w.source = 'shopify' AND w.source_table_id = oms.id::text)
          )
      AND oms.channel_ship_by_date IS NOT NULL
      AND w.channel_ship_by_date IS NULL
      AND w.warehouse_status NOT IN ('shipped', 'cancelled')
    RETURNING w.id
  `);
  console.log(`[Backfill] Mirrored channel_ship_by_date onto ${mirrorResult?.rows?.length ?? 0} WMS rows`);

  // 4c. Recompute sort_rank for all active orders, now using channel_ship_by_date.
  console.log("[Backfill] Step 4c: recomputing sort_rank for all active orders...");
  const activeRows: any = await db.execute(sql`
    SELECT id, priority, on_hold, channel_ship_by_date, sla_due_at, order_placed_at, created_at
    FROM wms.orders
    WHERE warehouse_status IN ('ready', 'in_progress')
  `);
  let rankUpdated = 0;
  for (const row of activeRows.rows ?? []) {
    // Prefer channel_ship_by_date over generic sla_due_at for the SLA slot
    const slaValue = row.channel_ship_by_date || row.sla_due_at;
    const rank = computeSortRank({
      priority: row.priority,
      onHold: row.on_hold,
      slaDueAt: slaValue,
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

  const omsService = createOmsService(db);
  const idRows: any = await db.execute(sql`
    SELECT oms.id
    FROM oms.oms_orders oms
    WHERE oms.status NOT IN ('shipped', 'cancelled')
      AND oms.shipstation_order_id IS NOT NULL
    ORDER BY oms.id ASC
  `);
  console.log(`[Backfill] Re-pushing ${idRows.rows?.length ?? 0} orders to ShipStation...`);

  let success = 0;
  let failed = 0;
  for (const idRow of idRows.rows ?? []) {
    try {
      // Load via OMS service — gives us camelCase object + mapped lines
      const fullOrder = await omsService.getOrderById(idRow.id);
      if (!fullOrder) {
        failed++;
        continue;
      }
      await shipStation.pushOrder(fullOrder);
      success++;
      if (success % 25 === 0) console.log(`[Backfill]   ...${success} pushed`);
      // Rate limit \u2014 ShipStation allows ~40 req/min
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      console.warn(`[Backfill] Failed to push OMS order ${idRow.id}: ${err.message}`);
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
