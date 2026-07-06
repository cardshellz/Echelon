/**
 * One-time release of orders auto-held by the (now removed) reservation
 * shortfall guard (P0.1c, live 2026-07-02 → 2026-07-06).
 *
 * The guard set order-level `on_hold = 1` whenever ANY line failed to reserve
 * (oversold, stale channel mapping, or not-yet-modeled preorder), skipped the
 * engine push, and nothing ever released the hold — so held orders piled up
 * and, once manually released, still never reached ShipStation.
 *
 * DISCRIMINATOR: both auto-hold writers set only `on_hold` — they never set
 * `held_at`. The manual hold button (storage.holdOrder) always sets `held_at`.
 * So `on_hold = 1 AND held_at IS NULL` selects exactly the auto-held orders;
 * anything a human held on purpose is left alone.
 *
 * For each auto-held order, --apply:
 *   1. releases the hold via ordersStorage.releaseHoldOrder (also recomputes
 *      sort_rank, same as the UI release button),
 *   2. pushes its never-pushed shipments to ShipStation via the shared
 *      release-path helper (reserveAndPushAfterHoldRelease). The script passes
 *      no reservation service — re-reserve is skipped here and the
 *      ready-but-unreserved reconciler sweep re-reserves released orders
 *      within ~15 minutes (it no longer holds on shortfall).
 *
 * The dry-run report lists each order with the shortfall SKUs recorded by the
 * sync path (oms_order_events.reservation_shortfall_hold) — skim it before
 * applying: SKUs that are NOT genuinely out of stock usually mean a stale
 * Shopify variant mapping (see scripts/relink-shopify-variant-ids.ts).
 *
 * SAFETY: DRY-RUN by default (no writes).
 *
 *   npx tsx scripts/release-auto-held-orders.ts                 # dry-run report
 *   npx tsx scripts/release-auto-held-orders.ts --limit=200     # dry-run, wider sample
 *   npx tsx scripts/release-auto-held-orders.ts --apply         # release + push
 *
 * On Heroku:
 *   heroku run -a <app> npx tsx scripts/release-auto-held-orders.ts --apply
 *
 * Verify after apply: re-run without --apply (expect zero rows), and check the
 * Orders page hold count + ShipStation awaiting-shipment count.
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { ordersStorage } from "../server/modules/orders";
import { createShipStationService } from "../server/modules/oms/shipstation.service";
import { reserveAndPushAfterHoldRelease } from "../server/modules/orders/release-hold-push";

interface CliOptions {
  apply: boolean;
  limit: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, limit: 500 };
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isInteger(n) && n > 0) opts.limit = n;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[ReleaseAutoHolds] ${opts.apply ? "APPLY" : "DRY-RUN"} — scanning for auto-held orders (on_hold = 1 AND held_at IS NULL)...`,
  );

  const held: any = await db.execute(sql`
    SELECT w.id, w.order_number, w.warehouse_status, w.created_at, w.updated_at,
           (
             SELECT COALESCE(
               string_agg(DISTINCT f->>'sku', ', '),
               ''
             )
             FROM oms.oms_order_events e
             CROSS JOIN LATERAL jsonb_array_elements(e.details->'failed') AS f
             WHERE e.event_type IN ('reservation_shortfall_hold', 'reservation_shortfall')
               AND jsonb_typeof(e.details->'failed') = 'array'
               AND (e.details->>'wmsOrderId')::bigint = w.id
           ) AS shortfall_skus,
           EXISTS (
             SELECT 1 FROM wms.outbound_shipments os
             WHERE os.order_id = w.id
               AND os.status IN ('planned', 'queued')
               AND os.engine_order_ref IS NULL
               AND os.shipstation_order_id IS NULL
           ) AS has_unpushed_shipment
    FROM wms.orders w
    WHERE w.on_hold = 1
      AND w.held_at IS NULL
      AND w.warehouse_status IN ('pending', 'ready')
    ORDER BY w.created_at ASC
    LIMIT ${opts.limit}
  `);

  const rows = held?.rows ?? [];
  if (rows.length === 0) {
    console.log("[ReleaseAutoHolds] No auto-held orders found. Done.");
    return;
  }

  console.log(`[ReleaseAutoHolds] Found ${rows.length} auto-held order(s):\n`);
  for (const r of rows) {
    console.log(
      `  #${r.order_number ?? r.id} (wms ${r.id}, ${r.warehouse_status}, created ${r.created_at})` +
        `${r.has_unpushed_shipment ? " [never pushed]" : ""}` +
        `${r.shortfall_skus ? ` shortfall: ${r.shortfall_skus}` : ""}`,
    );
  }

  // Manually-held orders are untouched; report the count for visibility.
  const manual: any = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM wms.orders
    WHERE on_hold = 1 AND held_at IS NOT NULL
  `);
  const manualCount = manual?.rows?.[0]?.count ?? 0;
  if (manualCount > 0) {
    console.log(`\n[ReleaseAutoHolds] Leaving ${manualCount} manually-held order(s) alone (held_at set).`);
  }

  if (!opts.apply) {
    console.log(`\n[ReleaseAutoHolds] DRY-RUN complete. Re-run with --apply to release + push.`);
    return;
  }

  const shipStation = createShipStationService(db);
  if (!shipStation.isConfigured()) {
    console.warn("[ReleaseAutoHolds] ShipStation is not configured — will release holds but skip pushes.");
  }
  const services = { shipStation };

  let released = 0;
  let pushed = 0;
  let pushFailed = 0;
  for (const r of rows) {
    const orderId = Number(r.id);
    try {
      // Guarded release: only flip rows still matching the auto-held
      // discriminator, so a manual hold placed mid-run is never cleared.
      const guard: any = await db.execute(sql`
        UPDATE wms.orders
        SET on_hold = 0, updated_at = NOW()
        WHERE id = ${orderId} AND on_hold = 1 AND held_at IS NULL
        RETURNING id
      `);
      if ((guard?.rows ?? []).length === 0) {
        console.warn(`[ReleaseAutoHolds] Skipped order ${orderId} — no longer auto-held.`);
        continue;
      }
      released++;
      // Recompute sort rank the same way the UI release does.
      try {
        await ordersStorage.releaseHoldOrder(orderId);
      } catch (err: any) {
        console.warn(`[ReleaseAutoHolds] sort-rank recompute failed for order ${orderId}: ${err?.message}`);
      }
      if (shipStation.isConfigured()) {
        const result = await reserveAndPushAfterHoldRelease(db, services, orderId, "ReleaseAutoHolds");
        pushed += result.pushed;
        pushFailed += result.failed;
      }
    } catch (err: any) {
      console.error(`[ReleaseAutoHolds] Failed for order ${orderId}: ${err?.message}`);
    }
  }

  console.log(
    `\n[ReleaseAutoHolds] APPLY complete: released ${released}/${rows.length} order(s), ` +
      `pushed ${pushed} shipment(s)` +
      (pushFailed > 0 ? `, ${pushFailed} push(es) failed (durable retry queued)` : "") +
      ". Re-run without --apply to verify zero remaining.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ReleaseAutoHolds] Fatal:", err);
    process.exit(1);
  });
