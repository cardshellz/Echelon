/**
 * Repair orders falsely marked 'cancelled' in OMS/WMS by the dedup→reconcile
 * cascade (2026-06-15 root cause, part 2).
 *
 * Causal chain: the boot-time "duplicate shipment cleanup" cancelled a shipped
 * split → reconcile-v2 saw a 'cancelled' shipment → stamped
 * oms_orders.status='cancelled' + a 'cancelled_via_shipstation' event. The order
 * then disappears from the active OMS view while the channel still shows it paid
 * & fulfilled. These are the "lost order" symptoms (#57921).
 *
 * The shipment side is restored by repair-cancelled-shipped-shipments.ts; this
 * script clears the bogus 'cancelled' STATUS on the order (WMS warehouse_status
 * and OMS status), setting it to the true fulfillment state derived from the
 * now-restored shipment coverage.
 *
 * HARD GUARD — only orders where the channel proves the customer did NOT cancel:
 *   - oms_orders.status = 'cancelled'
 *   - oms_orders.cancelled_at IS NULL          (no real cancellation timestamp)
 *   - oms_orders.financial_status = 'paid'     (not refunded/voided)
 *   - has a shipped/returned/lost shipment      (physically shipped)
 *   - NO cancel/refund event other than the internal 'cancelled_via_shipstation'
 *     (excludes any genuine customer cancel — held for manual review)
 *
 * SAFETY: DRY RUN by default (--execute to write); eligibility re-derived live;
 * idempotent; per-order transactions. DB-only — no channel/engine calls.
 *
 * Usage:
 *   npx tsx scripts/repair-bug-cancelled-orders.ts            # dry run
 *   npx tsx scripts/repair-bug-cancelled-orders.ts --execute  # apply
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../server/db";

interface Args { execute: boolean }
function parseArgs(argv: string[]): Args {
  return { execute: argv.includes("--execute") };
}

// Live-derived target population + per-order owed-units (from restored shipments).
const TARGET_QUERY = sql`
  SELECT
    o.id AS wms_id,
    o.order_number,
    o.warehouse_status,
    om.id AS oms_id,
    om.status AS oms_status,
    om.financial_status,
    om.fulfillment_status,
    (
      SELECT COALESCE(SUM(GREATEST(oi.quantity - COALESCE(s.shipped_qty, 0), 0)), 0)::int
      FROM wms.order_items oi
      LEFT JOIN (
        SELECT osi.order_item_id, SUM(osi.qty)::int AS shipped_qty
        FROM wms.outbound_shipment_items osi
        JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
        WHERE os.status IN ('shipped', 'returned', 'lost')
        GROUP BY osi.order_item_id
      ) s ON s.order_item_id = oi.id
      WHERE oi.order_id = o.id
        AND COALESCE(oi.requires_shipping, 1) <> 0
        AND oi.status <> 'cancelled'
        AND oi.quantity > 0
    ) AS owed_units
  FROM wms.orders o
  JOIN oms.oms_orders om ON om.id::text = o.oms_fulfillment_order_id
  WHERE om.status = 'cancelled'
    AND om.cancelled_at IS NULL
    AND om.financial_status = 'paid'
    AND EXISTS (
      SELECT 1 FROM wms.outbound_shipments sh
      WHERE sh.order_id = o.id AND sh.status IN ('shipped', 'returned', 'lost')
    )
    AND NOT EXISTS (
      SELECT 1 FROM oms.oms_order_events e
      WHERE e.order_id = om.id
        AND (e.event_type ILIKE '%cancel%' OR e.event_type ILIKE '%refund%')
        AND e.event_type <> 'cancelled_via_shipstation'
    )
  ORDER BY o.order_number
`;

async function main(): Promise<void> {
  const { execute } = parseArgs(process.argv.slice(2));
  console.log(`=== Repair bug-cancelled orders (dedup→cascade) — ${execute ? "EXECUTE" : "DRY RUN"} ===`);
  console.log("DB-only. " + (execute ? "Writing in per-order transactions." : "No writes."));
  console.log("");

  const res: any = await db.execute(TARGET_QUERY);
  const rows: any[] = res.rows ?? [];
  console.log(`Eligible (OMS bug-cancelled, channel says paid+fulfilled, no customer cancel): ${rows.length}`);
  console.log("");

  // For visibility: how many genuine cancels are being EXCLUDED for manual review.
  const excluded: any = await db.execute(sql`
    SELECT o.order_number, om.status, om.cancelled_at, om.financial_status
    FROM wms.orders o
    JOIN oms.oms_orders om ON om.id::text = o.oms_fulfillment_order_id
    WHERE om.status IN ('cancelled','refunded')
      AND EXISTS (SELECT 1 FROM wms.outbound_shipments sh WHERE sh.order_id=o.id AND sh.status IN ('shipped','returned','lost'))
      AND (
        om.cancelled_at IS NOT NULL OR om.financial_status <> 'paid'
        OR EXISTS (SELECT 1 FROM oms.oms_order_events e WHERE e.order_id=om.id
                   AND (e.event_type ILIKE '%cancel%' OR e.event_type ILIKE '%refund%')
                   AND e.event_type <> 'cancelled_via_shipstation')
      )
    ORDER BY o.order_number`);
  if ((excluded.rows ?? []).length) {
    console.log(`EXCLUDED — possible genuine cancel/refund (manual review, NOT touched): ${excluded.rows.length}`);
    for (const r of excluded.rows) console.log(`  ${r.order_number}: oms=${r.status} cancelledAt=${r.cancelled_at} financial=${r.financial_status}`);
    console.log("");
  }

  let fixed = 0, errors = 0;
  for (const r of rows) {
    const wmsId = Number(r.wms_id);
    const omsId = Number(r.oms_id);
    const owed = Number(r.owed_units);
    const target = owed === 0 ? "shipped" : "partially_shipped";
    const omsFulfill = target === "shipped" ? "fulfilled" : "partial";

    if (!execute) {
      console.log(`  [dry] ${r.order_number}: wms ${r.warehouse_status} → ${target}; oms ${r.oms_status} → ${target} (owed=${owed})`);
      continue;
    }
    try {
      await db.transaction(async (tx: any) => {
        const now = new Date();
        // WMS: force-clear the bogus cancelled status to the true fulfillment state.
        await tx.execute(sql`
          UPDATE wms.orders
          SET warehouse_status = ${target}, updated_at = ${now}
          WHERE id = ${wmsId} AND warehouse_status = 'cancelled'
        `);
        // OMS order status (guarded to the bug-cancelled state).
        await tx.execute(sql`
          UPDATE oms.oms_orders
          SET status = ${target}, fulfillment_status = ${omsFulfill}, updated_at = ${now}
          WHERE id = ${omsId} AND status = 'cancelled' AND cancelled_at IS NULL
        `);
        // OMS line fulfillment_status from shipped-shipment quantities.
        await tx.execute(sql`
          WITH shipped_by_line AS (
            SELECT wi.oms_order_line_id AS oms_order_line_id, SUM(COALESCE(si.qty, 0))::int AS shipped_qty
            FROM wms.outbound_shipment_items si
            JOIN wms.outbound_shipments os ON os.id = si.shipment_id
            JOIN wms.order_items wi ON wi.id = si.order_item_id
            WHERE os.order_id = ${wmsId}
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
          FROM line_status WHERE ol.id = line_status.oms_order_line_id
        `);
        // Audit.
        try {
          await tx.execute(sql`
            INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
            VALUES (${omsId}, 'uncancelled_bug_cascade',
              ${JSON.stringify({ wmsOrderId: wmsId, from: "cancelled", to: target, reason: "dedup_cascade_false_cancel", owedUnits: owed })}::jsonb,
              ${now})
          `);
        } catch (e: any) { console.warn(`  ! audit failed for OMS ${omsId}: ${e?.message ?? e}`); }
        fixed++;
        console.log(`  [fix] ${r.order_number}: wms → ${target}; oms → ${target}`);
      });
    } catch (e: any) {
      errors++;
      console.error(`  ! ${r.order_number} failed: ${e?.message ?? e}`);
    }
  }

  console.log("");
  console.log(execute ? `Done. orders fixed=${fixed}, errors=${errors}. Re-run dry-run to confirm empty.`
                      : `DRY RUN complete — no writes. Re-run with --execute to apply.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("repair-bug-cancelled-orders.ts: fatal error");
  console.error(err);
  process.exit(2);
});
