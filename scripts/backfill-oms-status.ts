/**
 * Backfill OMS order statuses from WMS shipment data.
 *
 * Finds oms_orders stuck in "confirmed" and checks if the corresponding
 * WMS order has been shipped. Updates OMS to match.
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/backfill-oms-status.ts [--dry-run] [--limit=500]
 */

import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1], 10) : 500;

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set EXTERNAL_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log(`[Backfill] Starting OMS status backfill (limit: ${LIMIT}, dry_run: ${DRY_RUN})`);

  // Find stuck OMS orders with their matching WMS order
  const result = await pool.query(`
    SELECT 
      oms.id as oms_id,
      oms.external_order_id,
      oms.status as oms_status,
      wms.id as wms_id,
      wms.warehouse_status as wms_status,
      wms.completed_at
    FROM oms_orders oms
    LEFT JOIN orders wms ON wms.shopify_order_id = oms.external_order_id
    WHERE oms.status IN ('confirmed', 'pending')
      AND oms.ordered_at < NOW() - INTERVAL '1 hour'
    ORDER BY oms.ordered_at
    LIMIT $1
  `, [LIMIT]);

  const rows = result.rows;
  console.log(`[Backfill] Found ${rows.length} stuck OMS orders`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const { oms_id, external_order_id, wms_id, wms_status, completed_at, tracking_number } = row;

      if (!wms_id) {
        // No WMS order exists — skip
        skipped++;
        continue;
      }

      if (wms_status === "shipped" || wms_status === "completed") {
        if (DRY_RUN) {
          console.log(`[Backfill][DRY] Would update OMS ${oms_id} (${external_order_id}) → shipped (WMS ${wms_id})`);
        } else {
          await pool.query(`
            UPDATE oms_orders SET
              status = 'shipped',
              fulfillment_status = 'fulfilled',
              tracking_number = $2,
              shipped_at = COALESCE($3, NOW()),
              updated_at = NOW()
            WHERE id = $1
          `, [oms_id, tracking_number, completed_at]);

          await pool.query(`
            UPDATE oms_order_lines SET
              fulfillment_status = 'fulfilled'
            WHERE order_id = $1
          `, [oms_id]);

          await pool.query(`
            INSERT INTO oms_order_events (order_id, event_type, details)
            VALUES ($1, 'shipped', $2::jsonb)
          `, [oms_id, JSON.stringify({
            source: "backfill",
            tracking_number,
            wms_order_id: wms_id,
            completed_at,
          })]);

          console.log(`[Backfill] Updated OMS ${oms_id} (${external_order_id}) → shipped`);
        }
        updated++;
      } else if (wms_status === "cancelled") {
        if (DRY_RUN) {
          console.log(`[Backfill][DRY] Would update OMS ${oms_id} (${external_order_id}) → cancelled`);
        } else {
          await pool.query(`
            UPDATE oms_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1
          `, [oms_id]);

          await pool.query(`
            INSERT INTO oms_order_events (order_id, event_type, details)
            VALUES ($1, 'cancelled', $2::jsonb)
          `, [oms_id, JSON.stringify({ source: "backfill", wms_order_id: wms_id })]);

          console.log(`[Backfill] Updated OMS ${oms_id} (${external_order_id}) → cancelled`);
        }
        updated++;
      } else {
        // WMS order still in progress — leave OMS as-is
        skipped++;
      }
    } catch (err: any) {
      console.error(`[Backfill] Error processing OMS ${row.oms_id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[Backfill] Complete: ${updated} updated, ${skipped} skipped, ${errors} errors`);
  await pool.end();
}

main().catch((err) => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
