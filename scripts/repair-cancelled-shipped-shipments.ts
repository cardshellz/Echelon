/**
 * Data repair for the cancelled-after-ship corruption (2026-06-15 root cause).
 *
 * A boot-time "[Data Repair] duplicate shipment cleanup" (server/index.ts,
 * now disabled) cancelled already-SHIPPED split shipments — treating one
 * order's multiple legitimate packages as duplicates. It stamped
 * status='cancelled' with a NULL voided_reason and kept shipped_at + tracking,
 * making the shipped units look un-shipped. 606 shipments; 392 in a 2026-05-30
 * batch; ongoing until the code fix (commit eac1d872) deployed.
 *
 * This script restores those shipments to 'shipped' and recomputes the owning
 * orders' status. It touches OUR DATABASE ONLY — it makes NO ShipStation/engine
 * calls: the packages already physically shipped (tracking exists), so there is
 * nothing to re-push, and re-pushing would recreate the duplicates we are
 * trying to eliminate.
 *
 * TARGET (conservative): status='cancelled' AND shipped_at IS NOT NULL AND
 * tracking_number IS NOT NULL AND voided_reason IS NULL. The null reason is what
 * distinguishes the buggy job's victims from legitimately-reasoned cancels
 * (ss_cancelled / engine_cancelled) — those are listed for manual review, never
 * auto-restored.
 *
 * SAFETY: DRY RUN by default (--execute to write); eligibility re-derived live
 * each run (idempotent / safe to re-run); per-order transactions; OMS update
 * guarded so a customer-cancelled/refunded OMS order is never resurrected
 * (those surface as "truth-wins review").
 *
 * Usage:
 *   npx tsx scripts/repair-cancelled-shipped-shipments.ts            # dry run
 *   npx tsx scripts/repair-cancelled-shipped-shipments.ts --execute  # apply
 *   npx tsx scripts/repair-cancelled-shipped-shipments.ts --execute --limit=100
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

// Buggy-job victims: cancelled, but shipped_at + tracking set, no reason stamped.
// Alias-parameterized because it is used both in a JOIN (needs the shipment
// alias to disambiguate status/tracking_number, which also exist on orders) and
// in a single-table UPDATE (no alias).
const targetWhere = (alias: string) => {
  const p = alias ? sql.raw(`${alias}.`) : sql.raw("");
  return sql`${p}status = 'cancelled' AND ${p}shipped_at IS NOT NULL AND ${p}tracking_number IS NOT NULL AND ${p}voided_reason IS NULL`;
};

async function updateOmsDerived(tx: any, omsId: number, warehouseStatus: string, now: Date): Promise<string> {
  const omsStatus = deriveOmsFromWms(warehouseStatus as any);
  if (!omsStatus) return "no oms transition";
  const fulfillmentStatus = omsStatus === "partially_shipped" ? "partial" : omsStatus === "shipped" ? "fulfilled" : null;

  const upd: any = await tx.execute(sql`
    UPDATE oms.oms_orders SET
      status = ${omsStatus},
      ${fulfillmentStatus ? sql`fulfillment_status = ${fulfillmentStatus},` : sql``}
      updated_at = ${now}
    WHERE id = ${omsId}
      AND status NOT IN ('cancelled', 'refunded')
      AND status IS DISTINCT FROM ${omsStatus}
    RETURNING id
  `);
  if (!upd?.rows?.length) return `${omsStatus} (oms terminal/no-op)`;

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
    FROM line_status WHERE ol.id = line_status.oms_order_line_id
  `);
  return omsStatus;
}

async function main(): Promise<void> {
  const { execute, limit } = parseArgs(process.argv.slice(2));
  console.log(`=== Repair cancelled-after-ship shipments — ${execute ? "EXECUTE" : "DRY RUN"} ===`);
  console.log("DB-only repair (no ShipStation calls). " + (execute ? "Writing in per-order transactions." : "No writes."));
  console.log("");

  // Affected orders + how many target shipments each has + current order status.
  const limitCond = limit ? sql`LIMIT ${limit}` : sql``;
  const orders: any = await db.execute(sql`
    SELECT o.id, o.order_number, o.source, o.warehouse_status, o.oms_fulfillment_order_id,
           COUNT(s.id)::int AS n_to_restore
    FROM wms.orders o
    JOIN wms.outbound_shipments s ON s.order_id = o.id AND ${targetWhere("s")}
    GROUP BY o.id, o.order_number, o.source, o.warehouse_status, o.oms_fulfillment_order_id
    ORDER BY o.id
    ${limitCond}
  `);
  const rows: any[] = orders.rows ?? [];
  const totalShipments = rows.reduce((a, r) => a + Number(r.n_to_restore), 0);

  // Current status distribution of affected orders (shows how many are mis-stated).
  const dist = new Map<string, number>();
  for (const r of rows) dist.set(r.warehouse_status, (dist.get(r.warehouse_status) ?? 0) + 1);

  console.log(`Affected: ${rows.length} orders, ${totalShipments} shipments to restore → 'shipped'.`);
  console.log("Current warehouse_status of affected orders:");
  for (const [k, v] of [...dist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log("");

  // Reasoned-but-shipped cancels — DO NOT auto-restore; list for manual review.
  const reasoned: any = await db.execute(sql`
    SELECT COALESCE(voided_reason,'(null)') reason, COUNT(*)::int n
    FROM wms.outbound_shipments
    WHERE status='cancelled' AND shipped_at IS NOT NULL AND voided_reason IS NOT NULL
    GROUP BY voided_reason ORDER BY n DESC`);
  if ((reasoned.rows ?? []).length) {
    console.log("NOT touched (cancelled-after-ship WITH a reason — manual review):");
    for (const r of reasoned.rows) console.log(`  ${r.reason}: ${r.n}`);
    console.log("");
  }

  if (!execute) {
    console.log("Sample (first 15):");
    for (const r of rows.slice(0, 15)) {
      console.log(`  [dry] ${r.order_number} (wms ${r.id}, ${r.source}) status=${r.warehouse_status} restore ${r.n_to_restore} shipment(s)`);
    }
    console.log(`\nDRY RUN complete — no writes. Re-run with --execute to apply.`);
    process.exit(0);
  }

  let ordersChanged = 0, shipmentsRestored = 0, omsUpdated = 0, omsReview = 0, errors = 0;
  for (const r of rows) {
    const wmsOrderId = Number(r.id);
    const omsRaw = r.oms_fulfillment_order_id;
    const omsId = typeof omsRaw === "string" && /^[0-9]+$/.test(omsRaw) ? Number(omsRaw) : null;
    try {
      await db.transaction(async (tx: any) => {
        const now = new Date();
        const restored: any = await tx.execute(sql`
          UPDATE wms.outbound_shipments
          SET status = 'shipped', cancelled_at = NULL, updated_at = ${now}
          WHERE order_id = ${wmsOrderId} AND ${targetWhere("")}
          RETURNING id
        `);
        const n = restored?.rows?.length ?? 0;
        shipmentsRestored += n;
        if (n === 0) return; // already repaired (idempotent)

        const before = r.warehouse_status;
        const rollup = await recomputeOrderStatusFromShipments(tx, wmsOrderId, { now });
        const statusChanged = rollup.changed && rollup.warehouseStatus !== before;
        if (statusChanged) ordersChanged++;

        let omsNote = "no oms link";
        if (omsId !== null) {
          // Detect the truth-wins-review case before the guarded update.
          const omsRow: any = await tx.execute(sql`SELECT status FROM oms.oms_orders WHERE id = ${omsId} LIMIT 1`);
          const omsCur = omsRow?.rows?.[0]?.status;
          if (omsCur === "cancelled" || omsCur === "refunded") {
            omsReview++;
            omsNote = `oms is '${omsCur}' but shipped — REVIEW (left as-is)`;
          } else {
            omsNote = await updateOmsDerived(tx, omsId, rollup.warehouseStatus, now);
            if (!omsNote.includes("no-op")) omsUpdated++;
          }
        }
        console.log(`  [fix] ${r.order_number}: restored ${n} shipment(s); wms ${before} → ${rollup.warehouseStatus}; oms → ${omsNote}`);
      });
    } catch (e: any) {
      errors++;
      console.error(`  ! ${r.order_number} (wms ${wmsOrderId}) failed: ${e?.message ?? e}`);
    }
  }

  console.log("");
  console.log(`Done. shipments restored=${shipmentsRestored}, order statuses changed=${ordersChanged}, oms updated=${omsUpdated}, oms truth-wins-review=${omsReview}, errors=${errors}`);
  console.log("Re-run without --execute to confirm the target population is now empty (idempotent).");
  process.exit(0);
}

main().catch((err) => {
  console.error("repair-cancelled-shipped-shipments.ts: fatal error");
  console.error(err);
  process.exit(2);
});
