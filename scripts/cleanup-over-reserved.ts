/**
 * Cleanup truly over-reserved inventory levels.
 * 
 * Finds bins where reserved_qty > (variant_qty + picked_qty) and releases
 * the excess reservation. Also cleans up orphaned zero-qty rows.
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/cleanup-over-reserved.ts [--dry-run]
 */

import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set EXTERNAL_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log(`[Cleanup] Starting over-reserved cleanup (dry_run: ${DRY_RUN})`);

  const result = await pool.query(`
    SELECT 
      il.id as level_id,
      il.product_variant_id,
      il.warehouse_location_id,
      pv.sku,
      pv.name as variant_name,
      wl.code as bin_code,
      il.variant_qty,
      il.reserved_qty,
      il.picked_qty,
      il.reserved_qty - (il.variant_qty + il.picked_qty) as excess_reserved
    FROM inventory_levels il
    JOIN product_variants pv ON pv.id = il.product_variant_id
    LEFT JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
    WHERE il.reserved_qty > (il.variant_qty + il.picked_qty)
    ORDER BY (il.reserved_qty - (il.variant_qty + il.picked_qty)) DESC
  `);

  const rows = result.rows;
  console.log(`[Cleanup] Found ${rows.length} truly over-reserved bins`);

  let fixed = 0;
  let errors = 0;

  for (const row of rows) {
    const { level_id, product_variant_id, warehouse_location_id, sku, bin_code,
            variant_qty, reserved_qty, picked_qty, excess_reserved } = row;

    try {
      if (DRY_RUN) {
        console.log(
          `[Cleanup][DRY] ${sku} at ${bin_code}: qty=${variant_qty}, reserved=${reserved_qty}, ` +
          `picked=${picked_qty}, excess=${excess_reserved}`
        );
      } else {
        // Release the excess reservation
        await pool.query(`
          UPDATE inventory_levels
          SET reserved_qty = reserved_qty - $1, updated_at = NOW()
          WHERE id = $2
        `, [excess_reserved, level_id]);

        // Log the release transaction
        await pool.query(`
          INSERT INTO inventory_transactions (
            product_variant_id, to_location_id, transaction_type,
            variant_qty_delta, variant_qty_before, variant_qty_after,
            source_state, target_state, reference_type, notes
          ) VALUES ($1, $2, 'unreserve', 0, $3, $3, 'committed', 'on_hand', 'cleanup', $4)
        `, [
          product_variant_id,
          warehouse_location_id,
          variant_qty,
          `Cleanup: released ${excess_reserved} excess reserved (reserved=${reserved_qty} > qty+picked=${Number(variant_qty) + Number(picked_qty)})`,
        ]);

        console.log(
          `[Cleanup] ${sku} at ${bin_code}: released ${excess_reserved} excess reserved ` +
          `(was ${reserved_qty}, now ${Number(reserved_qty) - Number(excess_reserved)})`
        );
      }
      fixed++;
    } catch (err: any) {
      console.error(`[Cleanup] Error processing ${sku} at ${bin_code}: ${err.message}`);
      errors++;
    }
  }

  // Clean up orphaned zero-qty rows
  if (!DRY_RUN) {
    const orphanResult = await pool.query(`
      DELETE FROM inventory_levels
      WHERE variant_qty = 0 AND reserved_qty = 0 AND picked_qty = 0 
        AND COALESCE(packed_qty, 0) = 0 AND COALESCE(backorder_qty, 0) = 0
      RETURNING id
    `);
    console.log(`[Cleanup] Deleted ${orphanResult.rowCount} orphaned zero-qty rows`);
  }

  console.log(`[Cleanup] Complete: ${fixed} bins fixed, ${errors} errors`);
  await pool.end();
}

main().catch((err) => {
  console.error("[Cleanup] Fatal error:", err);
  process.exit(1);
});
