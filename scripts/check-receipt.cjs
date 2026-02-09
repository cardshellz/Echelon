const fs = require('fs');
const path = require('path');

// Load .env manually
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
const pool = new Pool({
  connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const receiptNumber = process.argv[2] || 'RCV-20260209-001';

  const { rows: lines } = await pool.query(`
    SELECT ro.id as order_id, ro.receipt_number, ro.status as order_status,
           ro.received_line_count, ro.received_total_units,
           rl.id as line_id, rl.sku, rl.product_name, rl.expected_qty, rl.received_qty,
           rl.product_variant_id, rl.putaway_location_id, rl.putaway_complete, rl.status as line_status
    FROM receiving_orders ro
    JOIN receiving_lines rl ON rl.receiving_order_id = ro.id
    WHERE ro.receipt_number = $1
  `, [receiptNumber]);

  if (lines.length === 0) {
    console.log('Receipt not found:', receiptNumber);
    process.exit(1);
  }

  console.log('\n=== RECEIPT ===');
  console.log('Receipt:', lines[0].receipt_number, '| Status:', lines[0].order_status);
  console.log('Received lines:', lines[0].received_line_count, '| Total units:', lines[0].received_total_units);

  console.log('\n=== LINES ===');
  for (const l of lines) {
    console.log(`  Line ${l.line_id}: sku=${l.sku}, receivedQty=${l.received_qty}, productVariantId=${l.product_variant_id}, putawayLocationId=${l.putaway_location_id}, putawayComplete=${l.putaway_complete}, status=${l.line_status}`);
  }

  for (const l of lines) {
    if (l.putaway_location_id && l.product_variant_id) {
      const { rows: inv } = await pool.query(`
        SELECT il.id, il.variant_qty, il.reserved_qty, wl.code as location_code
        FROM inventory_levels il
        JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
        WHERE il.warehouse_location_id = $1 AND il.product_variant_id = $2
      `, [l.putaway_location_id, l.product_variant_id]);
      console.log(`\n  Inventory at location ${l.putaway_location_id} for variant ${l.product_variant_id}:`, inv.length ? JSON.stringify(inv[0]) : 'NONE');
    }
    if (l.putaway_location_id) {
      const { rows: loc } = await pool.query(`SELECT id, code, location_type, bin_type FROM warehouse_locations WHERE id = $1`, [l.putaway_location_id]);
      console.log(`  Location ${l.putaway_location_id}:`, loc[0] ? JSON.stringify(loc[0]) : 'NOT FOUND');
    }
    if (l.product_variant_id) {
      const { rows: pv } = await pool.query(`SELECT id, sku, name, units_per_variant FROM product_variants WHERE id = $1`, [l.product_variant_id]);
      console.log(`  Variant ${l.product_variant_id}:`, pv[0] ? JSON.stringify(pv[0]) : 'NOT FOUND');
    }
  }

  const { rows: txns } = await pool.query(`
    SELECT id, product_variant_id, to_location_id, transaction_type, variant_qty_delta, created_at
    FROM inventory_transactions
    WHERE receiving_order_id = $1
    ORDER BY created_at
  `, [lines[0].order_id]);
  console.log('\n=== TRANSACTIONS ===');
  console.log(txns.length ? JSON.stringify(txns, null, 2) : 'NONE — no inventory transactions were created');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
