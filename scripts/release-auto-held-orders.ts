/**
 * One-time recovery from the (now removed) reservation-shortfall auto-hold
 * (P0.1c, live 2026-07-02 → 2026-07-06).
 *
 * The guard set order-level `on_hold = 1` whenever ANY line failed to reserve
 * (oversold, stale channel mapping, or not-yet-modeled preorder), skipped the
 * engine push, and nothing ever released the hold. Manually releasing a hold
 * didn't push either — the hold-release engine sync only touches shipments
 * that already have an engine ref. So there are TWO stranded populations:
 *
 *   Phase 1 — still auto-held orders. DISCRIMINATOR: both auto-hold writers
 *   set only `on_hold`, never `held_at`; the manual hold button always sets
 *   `held_at`. So `on_hold = 1 AND held_at IS NULL` selects exactly the
 *   auto-held orders. Released here, then pushed. Manual holds are untouched.
 *
 *   Phase 2 — active, NOT-held orders whose shipments never reached the
 *   engine (e.g. holds manually released before this fix deployed). Pushed
 *   as-is; nothing is released.
 *
 * Both phases push via the shared release-path helper
 * (reserveAndPushAfterHoldRelease); push failures enqueue the durable
 * ShipStation retry row. The script passes no reservation service — the
 * ready-but-unreserved reconciler sweep re-reserves released orders within
 * ~15 minutes (it no longer holds on shortfall). Orders whose OMS order is
 * cancelled/refunded are excluded from both phases.
 *
 * The phase-1 report lists each order's shortfall SKUs (from
 * oms_order_events) — skim before applying: a SKU that is NOT genuinely out
 * of stock usually means a stale Shopify variant mapping (see
 * scripts/relink-shopify-variant-ids.ts).
 *
 * SAFETY: DRY-RUN by default (no writes).
 *
 *   npx tsx scripts/release-auto-held-orders.ts                 # dry-run report
 *   npx tsx scripts/release-auto-held-orders.ts --limit=1000    # dry-run, wider sample
 *   npx tsx scripts/release-auto-held-orders.ts --apply         # release + push
 *
 * On Heroku:
 *   heroku run -a cardshellz-echelon -- npx tsx scripts/release-auto-held-orders.ts --apply
 *
 * Verify after apply: re-run without --apply (expect zero rows in both
 * phases), check the Orders page hold count, and ShipStation's
 * awaiting-shipment count.
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

// Mirror of the reconciler's guard: never touch an order whose OMS order is
// final — releasing/pushing those would resurrect cancelled work.
const OMS_NOT_FINAL = sql`
  NOT EXISTS (
    SELECT 1 FROM oms.oms_orders oo
    WHERE (
        (w.source = 'oms' AND w.oms_fulfillment_order_id = oo.id::text)
        OR (w.source_table_id = oo.id::text)
      )
      AND (
        oo.status IN ('cancelled', 'shipped', 'refunded')
        OR oo.financial_status = 'refunded'
      )
  )
`;

const HAS_UNPUSHED_SHIPMENT = sql`
  EXISTS (
    SELECT 1 FROM wms.outbound_shipments os
    WHERE os.order_id = w.id
      AND os.status IN ('planned', 'queued')
      AND os.engine_order_ref IS NULL
      AND os.shipstation_order_id IS NULL
      AND COALESCE(os.held, false) = false
      AND COALESCE(os.requires_review, false) = false
  )
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.apply ? "APPLY" : "DRY-RUN";

  // ─── Phase 1: auto-held orders (on_hold = 1 AND held_at IS NULL) ─────────
  console.log(`[ReleaseAutoHolds] ${mode} — phase 1: auto-held orders...`);
  const held: any = await db.execute(sql`
    SELECT w.id, w.order_number, w.warehouse_status, w.created_at,
           (
             SELECT COALESCE(string_agg(DISTINCT f->>'sku', ', '), '')
             FROM oms.oms_order_events e
             CROSS JOIN LATERAL jsonb_array_elements(e.details->'failed') AS f
             WHERE e.event_type IN ('reservation_shortfall_hold', 'reservation_shortfall')
               AND jsonb_typeof(e.details->'failed') = 'array'
               AND (e.details->>'wmsOrderId')::bigint = w.id
           ) AS shortfall_skus,
           ${HAS_UNPUSHED_SHIPMENT} AS has_unpushed_shipment
    FROM wms.orders w
    WHERE w.on_hold = 1
      AND w.held_at IS NULL
      AND w.warehouse_status IN ('pending', 'ready')
      AND ${OMS_NOT_FINAL}
    ORDER BY w.created_at ASC
    LIMIT ${opts.limit}
  `);
  const heldRows = held?.rows ?? [];

  if (heldRows.length === 0) {
    console.log("[ReleaseAutoHolds] No auto-held orders found.");
  } else {
    console.log(`[ReleaseAutoHolds] Found ${heldRows.length} auto-held order(s):\n`);
    for (const r of heldRows) {
      console.log(
        `  #${r.order_number ?? r.id} (wms ${r.id}, ${r.warehouse_status}, created ${r.created_at})` +
          `${r.has_unpushed_shipment ? " [never pushed]" : ""}` +
          `${r.shortfall_skus ? ` shortfall: ${r.shortfall_skus}` : ""}`,
      );
    }
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

  // ─── Phase 2: active, not-held orders whose shipments never got pushed ───
  // (e.g. auto-holds manually released before the release-path fix deployed)
  console.log(`\n[ReleaseAutoHolds] ${mode} — phase 2: released-but-never-pushed orders...`);
  const stranded: any = await db.execute(sql`
    SELECT w.id, w.order_number, w.warehouse_status, w.created_at
    FROM wms.orders w
    WHERE w.on_hold = 0
      AND w.warehouse_status IN ('ready', 'in_progress')
      AND ${HAS_UNPUSHED_SHIPMENT}
      AND ${OMS_NOT_FINAL}
    ORDER BY w.created_at ASC
    LIMIT ${opts.limit}
  `);
  const strandedRows = stranded?.rows ?? [];

  if (strandedRows.length === 0) {
    console.log("[ReleaseAutoHolds] No released-but-never-pushed orders found.");
  } else {
    console.log(`[ReleaseAutoHolds] Found ${strandedRows.length} order(s) with never-pushed shipments:\n`);
    for (const r of strandedRows) {
      console.log(`  #${r.order_number ?? r.id} (wms ${r.id}, ${r.warehouse_status}, created ${r.created_at})`);
    }
  }

  if (!opts.apply) {
    console.log(`\n[ReleaseAutoHolds] DRY-RUN complete. Re-run with --apply to release + push.`);
    return;
  }

  if (heldRows.length === 0 && strandedRows.length === 0) {
    console.log("\n[ReleaseAutoHolds] Nothing to do.");
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

  for (const r of heldRows) {
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

  if (shipStation.isConfigured()) {
    for (const r of strandedRows) {
      const orderId = Number(r.id);
      try {
        const result = await reserveAndPushAfterHoldRelease(db, services, orderId, "ReleaseAutoHolds:phase2");
        pushed += result.pushed;
        pushFailed += result.failed;
      } catch (err: any) {
        console.error(`[ReleaseAutoHolds] Phase-2 push failed for order ${orderId}: ${err?.message}`);
      }
    }
  }

  console.log(
    `\n[ReleaseAutoHolds] APPLY complete: released ${released}/${heldRows.length} auto-held order(s), ` +
      `pushed ${pushed} shipment(s) across ${heldRows.length + strandedRows.length} order(s)` +
      (pushFailed > 0 ? `, ${pushFailed} push(es) failed (durable retry queued)` : "") +
      ". Re-run without --apply to verify both phases return zero.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ReleaseAutoHolds] Fatal:", err);
    process.exit(1);
  });
