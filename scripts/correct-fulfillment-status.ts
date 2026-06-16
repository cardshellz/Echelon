/**
 * One-time corrective sweep for the fulfillment-status bug surfaced by the
 * 2026-06-15 reconciliation (scripts/reconcile-line-fulfillments-dryrun.ts).
 *
 * Two independent populations, two different actions:
 *
 *   PHASE A — short-ship coverage correction (auto-fix):
 *     Orders stored warehouse_status='shipped' whose line-item evidence proves
 *     units are still owed (a cancelled shipment left units un-shipped). The
 *     223 #57921/#58110-family orders. Re-run the now-guarded
 *     recomputeOrderStatusFromShipments → 'partially_shipped', then derive OMS
 *     status the same way the SHIP_NOTIFY path does. Durable: the derivation
 *     fix means it won't revert.
 *
 *   PHASE B — cancelled-but-shipped (flag only, NO status change):
 *     Orders stored warehouse_status='cancelled' that nonetheless have shipped
 *     line-item evidence (units physically left). "Truth wins + review" — the
 *     operator decides reship vs refund vs recall. We set requires_review on
 *     the shipped shipment(s) and write an audit event; we do NOT auto-flip
 *     a cancelled order, because the cancel may be intentional.
 *
 * SAFETY:
 *   - DRY RUN by default. Pass --execute to write. --limit caps per phase.
 *   - Eligibility is RE-DERIVED live from current DB state every run (never
 *     trusts the stale report), so it is safe to re-run; idempotent (recompute
 *     and the guarded OMS update are no-ops once corrected).
 *   - Each order is corrected inside its own transaction.
 *   - OMS writes are guarded: never overwrite a cancelled/refunded OMS order.
 *
 * Usage:
 *   npx tsx scripts/correct-fulfillment-status.ts            # dry run
 *   npx tsx scripts/correct-fulfillment-status.ts --execute  # apply
 *   npx tsx scripts/correct-fulfillment-status.ts --execute --limit=50
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { recomputeOrderStatusFromShipments } from "../server/modules/orders/shipment-rollup";
import { deriveOmsFromWms } from "../shared/enums/order-status";

interface Args { execute: boolean; limit?: number }
function parseArgs(argv: string[]): Args {
  let execute = false;
  let limit: number | undefined;
  for (const a of argv) {
    if (a === "--execute") execute = true;
    const m = /^--limit=(\d+)$/.exec(a);
    if (m) { limit = Number(m[1]); if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer"); }
  }
  return { execute, limit };
}

// Per-order shipped-qty coverage, shared by both phases.
//   owed_units         = Σ over shippable, non-cancelled lines of (ordered − shipped), floored at 0
//   lines_with_evidence = # lines with any shipped-shipment qty (proves we have line data)
const COVERAGE_CTE = sql`
  cov AS (
    SELECT
      oi.order_id,
      COALESCE(SUM(GREATEST(oi.quantity - COALESCE(s.shipped_qty, 0), 0))
        FILTER (WHERE oi.requires_shipping <> 0 AND oi.status <> 'cancelled' AND oi.quantity > 0), 0)::int AS owed_units,
      COUNT(*) FILTER (WHERE COALESCE(s.shipped_qty, 0) > 0)::int AS lines_with_evidence
    FROM wms.order_items oi
    LEFT JOIN (
      SELECT osi.order_item_id, SUM(osi.qty)::int AS shipped_qty
      FROM wms.outbound_shipment_items osi
      JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      WHERE os.status IN ('shipped', 'returned', 'lost')
      GROUP BY osi.order_item_id
    ) s ON s.order_item_id = oi.id
    GROUP BY oi.order_id
  )
`;

// Update OMS order + line fulfillment to match a corrected WMS warehouse_status.
// Mirrors the canonical SHIP_NOTIFY path (server/index.ts ~1305-1344); the
// service-internal helper is a closure and not importable. Guarded: never
// touches a cancelled/refunded OMS order.
async function updateOmsDerived(tx: any, omsId: number, warehouseStatus: string, now: Date): Promise<string> {
  const omsStatus = deriveOmsFromWms(warehouseStatus as any) ?? "shipped";
  const fulfillmentStatus = omsStatus === "partially_shipped" ? "partial" : "fulfilled";

  const upd: any = await tx.execute(sql`
    UPDATE oms.oms_orders SET
      status = ${omsStatus},
      fulfillment_status = ${fulfillmentStatus},
      updated_at = ${now}
    WHERE id = ${omsId}
      AND status NOT IN ('cancelled', 'refunded')
      AND status IS DISTINCT FROM ${omsStatus}
    RETURNING id
  `);

  // Per-line OMS fulfillment_status from shipped-shipment quantities.
  await tx.execute(sql`
    WITH shipped_by_line AS (
      SELECT wi.oms_order_line_id AS oms_order_line_id, SUM(COALESCE(si.qty, 0))::int AS shipped_qty
      FROM wms.outbound_shipment_items si
      JOIN wms.outbound_shipments os ON os.id = si.shipment_id
      JOIN wms.order_items wi ON wi.id = si.order_item_id
      WHERE os.order_id = (SELECT id FROM wms.orders WHERE oms_fulfillment_order_id = ${String(omsId)} LIMIT 1)
        AND os.status IN ('shipped', 'returned', 'lost')
        AND wi.oms_order_line_id IS NOT NULL
      GROUP BY wi.oms_order_line_id
    ),
    line_status AS (
      SELECT ol.id AS oms_order_line_id,
        CASE
          WHEN COALESCE(s.shipped_qty, 0) >= COALESCE(ol.quantity, 0) THEN 'fulfilled'
          WHEN COALESCE(s.shipped_qty, 0) > 0 THEN 'partial'
          ELSE 'unfulfilled'
        END AS next_status
      FROM oms.oms_order_lines ol
      LEFT JOIN shipped_by_line s ON s.oms_order_line_id = ol.id
      WHERE ol.order_id = ${omsId}
    )
    UPDATE oms.oms_order_lines ol
    SET fulfillment_status = line_status.next_status, updated_at = ${now}
    FROM line_status
    WHERE ol.id = line_status.oms_order_line_id
  `);

  return upd?.rows?.length ? omsStatus : `${omsStatus} (oms terminal/no-op)`;
}

async function auditEvent(tx: any, omsId: number, eventType: string, details: Record<string, unknown>, now: Date): Promise<void> {
  try {
    await tx.execute(sql`
      INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
      VALUES (${omsId}, ${eventType}, ${JSON.stringify(details)}::jsonb, ${now})
    `);
  } catch (e: any) {
    console.warn(`  ! audit insert failed for OMS ${omsId} (${eventType}): ${e?.message ?? e}`);
  }
}

async function main(): Promise<void> {
  const { execute, limit } = parseArgs(process.argv.slice(2));
  const mode = execute ? "EXECUTE" : "DRY RUN";
  console.log(`=== Corrective fulfillment-status sweep — ${mode} ===`);
  console.log(execute ? "Writing changes inside per-order transactions." : "No writes. Pass --execute to apply.");
  console.log("");

  const limitCond = limit ? sql`LIMIT ${limit}` : sql``;

  // ── PHASE A: short-ship coverage correction ──
  const phaseA: any = await db.execute(sql`
    WITH ${COVERAGE_CTE}
    SELECT o.id, o.order_number, o.source, o.warehouse_status, o.oms_fulfillment_order_id,
           cov.owed_units, cov.lines_with_evidence
    FROM wms.orders o
    JOIN cov ON cov.order_id = o.id
    WHERE o.warehouse_status = 'shipped'
      AND cov.owed_units > 0
      AND cov.lines_with_evidence > 0
    ORDER BY o.id
    ${limitCond}
  `);
  const aRows: any[] = phaseA.rows ?? [];
  console.log(`PHASE A — short-ship coverage correction (shipped → partially_shipped): ${aRows.length} orders`);

  let aCorrected = 0, aOmsUpdated = 0, aSkipped = 0;
  for (const r of aRows) {
    const wmsOrderId = Number(r.id);
    const omsRaw = r.oms_fulfillment_order_id;
    const omsId = typeof omsRaw === "string" && /^[0-9]+$/.test(omsRaw) ? Number(omsRaw) : null;
    if (!execute) {
      console.log(`  [dry] ${r.order_number} (wms ${wmsOrderId}, oms ${omsId ?? "—"}, ${r.source}) owed=${r.owed_units} → partially_shipped`);
      continue;
    }
    try {
      await db.transaction(async (tx: any) => {
        const now = new Date();
        const rollup = await recomputeOrderStatusFromShipments(tx, wmsOrderId, { now });
        if (!rollup.changed || rollup.warehouseStatus !== "partially_shipped") {
          aSkipped++;
          console.log(`  [skip] ${r.order_number}: recompute → ${rollup.warehouseStatus} (changed=${rollup.changed})`);
          return;
        }
        aCorrected++;
        let omsResult = "no oms link";
        if (omsId !== null) {
          omsResult = await updateOmsDerived(tx, omsId, rollup.warehouseStatus, now);
          aOmsUpdated++;
          await auditEvent(tx, omsId, "fulfillment_status_corrected", {
            wmsOrderId, from: "shipped", to: "partially_shipped",
            reason: "line_coverage_correction", owedUnits: Number(r.owed_units),
          }, now);
        }
        console.log(`  [fix] ${r.order_number}: wms shipped → partially_shipped; oms → ${omsResult}`);
      });
    } catch (e: any) {
      console.error(`  ! ${r.order_number} (wms ${wmsOrderId}) failed: ${e?.message ?? e}`);
    }
  }
  console.log(`PHASE A result: corrected=${aCorrected}, oms updated=${aOmsUpdated}, skipped=${aSkipped}`);
  console.log("");

  // ── PHASE B: cancelled-but-shipped review flags ──
  const phaseB: any = await db.execute(sql`
    WITH ${COVERAGE_CTE}
    SELECT o.id, o.order_number, o.source, o.warehouse_status, o.oms_fulfillment_order_id,
           cov.lines_with_evidence
    FROM wms.orders o
    JOIN cov ON cov.order_id = o.id
    WHERE o.warehouse_status = 'cancelled'
      AND cov.lines_with_evidence > 0
    ORDER BY o.id
    ${limitCond}
  `);
  const bRows: any[] = phaseB.rows ?? [];
  console.log(`PHASE B — cancelled-but-shipped review flags (NO status change): ${bRows.length} orders`);

  let bFlagged = 0;
  for (const r of bRows) {
    const wmsOrderId = Number(r.id);
    const omsRaw = r.oms_fulfillment_order_id;
    const omsId = typeof omsRaw === "string" && /^[0-9]+$/.test(omsRaw) ? Number(omsRaw) : null;
    if (!execute) {
      console.log(`  [dry] ${r.order_number} (wms ${wmsOrderId}, oms ${omsId ?? "—"}, ${r.source}) → flag shipped shipments for review`);
      continue;
    }
    try {
      await db.transaction(async (tx: any) => {
        const now = new Date();
        const flagged: any = await tx.execute(sql`
          UPDATE wms.outbound_shipments
          SET requires_review = true,
              review_reason = COALESCE(review_reason, 'cancelled_but_shipped'),
              updated_at = ${now}
          WHERE order_id = ${wmsOrderId}
            AND status IN ('shipped', 'returned', 'lost')
            AND requires_review = false
          RETURNING id
        `);
        const n = flagged?.rows?.length ?? 0;
        bFlagged += n > 0 ? 1 : 0;
        if (omsId !== null) {
          await auditEvent(tx, omsId, "cancelled_but_shipped_review", {
            wmsOrderId, shipmentsFlagged: n, reason: "physical_shipment_on_cancelled_order",
          }, now);
        }
        console.log(`  [flag] ${r.order_number}: ${n} shipped shipment(s) flagged for review`);
      });
    } catch (e: any) {
      console.error(`  ! ${r.order_number} (wms ${wmsOrderId}) failed: ${e?.message ?? e}`);
    }
  }
  console.log(`PHASE B result: orders newly flagged=${bFlagged}`);
  console.log("");

  console.log(execute
    ? "Done. Re-run without --execute to confirm the populations are now empty (idempotent)."
    : "DRY RUN complete — no rows written. Re-run with --execute to apply.");
  process.exit(0);
}

main().catch((err) => {
  console.error("correct-fulfillment-status.ts: fatal error");
  console.error(err);
  process.exit(2);
});
