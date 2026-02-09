const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const idx = line.indexOf('=');
  if (idx > 0 && !line.startsWith('#')) {
    const key = line.substring(0, idx).trim();
    const val = line.substring(idx + 1).trim();
    if (key && val) process.env[key] = val;
  }
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Find all "ready" orders that don't already have inventory reservations
  const { rows: orders } = await pool.query(`
    SELECT o.id, o.order_number
    FROM orders o
    WHERE o.warehouse_status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM inventory_transactions it
        WHERE it.reference_type = 'reservation'
          AND it.reference_id = o.id::text
      )
    ORDER BY o.id
  `);

  console.log(`Found ${orders.length} ready orders without reservations`);

  let totalReserved = 0;
  let totalFailed = 0;

  for (const order of orders) {
    const { rows: items } = await pool.query(
      `SELECT id, sku, quantity FROM order_items WHERE order_id = $1 AND requires_shipping = 1`,
      [order.id]
    );

    let orderReserved = 0;
    let orderFailed = 0;

    for (const item of items) {
      // Find product variant by SKU
      const { rows: variants } = await pool.query(
        `SELECT id, units_per_variant FROM product_variants WHERE sku = $1 LIMIT 1`,
        [item.sku]
      );

      if (variants.length === 0) {
        console.log(`  [SKIP] ${order.order_number} item ${item.sku}: variant not found`);
        orderFailed++;
        continue;
      }

      const variant = variants[0];
      const unitsNeeded = item.quantity;

      // Find best bin with available stock, ordered by pick_sequence
      const { rows: levels } = await pool.query(`
        SELECT il.id, il.warehouse_location_id, il.variant_qty, il.reserved_qty, il.picked_qty,
               (il.variant_qty - il.reserved_qty - il.picked_qty) as available
        FROM inventory_levels il
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.product_variant_id = $1
          AND (il.variant_qty - il.reserved_qty - il.picked_qty) > 0
        ORDER BY wl.pick_sequence
      `, [variant.id]);

      if (levels.length === 0) {
        console.log(`  [SKIP] ${order.order_number} item ${item.sku}: no available inventory`);
        orderFailed++;
        continue;
      }

      // Prefer a bin with enough stock; fall back to first with any stock
      let chosen = levels.find(l => l.available >= unitsNeeded) || levels[0];
      const toReserve = Math.min(unitsNeeded, chosen.available);

      // Atomically increment reserved_qty
      const { rowCount } = await pool.query(`
        UPDATE inventory_levels
        SET reserved_qty = reserved_qty + $1
        WHERE id = $2
          AND (variant_qty - reserved_qty - picked_qty) >= $1
      `, [toReserve, chosen.id]);

      if (rowCount > 0) {
        // Log transaction
        await pool.query(`
          INSERT INTO inventory_transactions
            (product_variant_id, warehouse_location_id, transaction_type, quantity_change,
             reference_type, reference_id, notes)
          VALUES ($1, $2, 'reserve', $3, 'reservation', $4, $5)
        `, [
          variant.id,
          chosen.warehouse_location_id,
          toReserve,
          String(order.id),
          `Backfill reservation for order ${order.order_number}, item ${item.sku}`
        ]);

        orderReserved++;
        if (toReserve < unitsNeeded) {
          console.log(`  [PARTIAL] ${order.order_number} item ${item.sku}: reserved ${toReserve}/${unitsNeeded}`);
        }
      } else {
        console.log(`  [FAIL] ${order.order_number} item ${item.sku}: concurrent stock change, retry needed`);
        orderFailed++;
      }
    }

    totalReserved += orderReserved;
    totalFailed += orderFailed;

    if (orderReserved > 0 || orderFailed > 0) {
      console.log(`Order ${order.order_number}: ${orderReserved} reserved, ${orderFailed} failed`);
    }
  }

  console.log(`\nDone. ${totalReserved} items reserved, ${totalFailed} items failed across ${orders.length} orders.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
