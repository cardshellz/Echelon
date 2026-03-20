/**
 * One-time script: Fix orphaned order items that have no reservation.
 * 
 * After deploying the ATP-gated reservation logic, run this to:
 * 1. Find all pending order items with no reserve transaction
 * 2. For each, call the reservation service to create the reservation
 * 3. Report results
 * 
 * Usage: node scripts/fix-orphaned-reservations.cjs [--dry-run]
 */
const fs = require('fs');
const path = require('path');

// Load .env if it exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0 && !line.startsWith('#')) {
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1).trim();
      if (key && val) process.env[key] = val;
    }
  }
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`[fix-orphaned-reservations] ${dryRun ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log('');

  // Step 1: Find ALL unreserved pending order items (not just EG-SLV-PF-P100)
  const { rows: orphans } = await pool.query(`
    SELECT 
      oi.id AS order_item_id,
      oi.order_id,
      oi.sku,
      oi.quantity,
      pv.id AS variant_id,
      pv.product_id,
      pv.units_per_variant
    FROM order_items oi
    JOIN product_variants pv ON pv.sku = oi.sku
    WHERE oi.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM inventory_transactions it 
        WHERE it.order_item_id = oi.id 
          AND it.transaction_type = 'reserve'
      )
    ORDER BY oi.sku, oi.order_id
  `);

  console.log(`Found ${orphans.length} unreserved pending order items:`);
  
  // Group by SKU for summary
  const bySku = {};
  for (const o of orphans) {
    if (!bySku[o.sku]) bySku[o.sku] = { count: 0, totalQty: 0 };
    bySku[o.sku].count++;
    bySku[o.sku].totalQty += o.quantity;
  }
  for (const [sku, info] of Object.entries(bySku)) {
    console.log(`  ${sku}: ${info.count} items, ${info.totalQty} total units`);
  }
  console.log('');

  if (dryRun) {
    console.log('[DRY RUN] Would process these items. Run without --dry-run to execute.');
    await pool.end();
    return;
  }

  // Step 2: For each orphan, compute ATP and reserve
  let totalReserved = 0;
  let totalShortfall = 0;
  let totalSkipped = 0;

  // Cache ATP by product to avoid redundant queries within same product
  const atpCache = {};

  for (const orphan of orphans) {
    const { order_item_id, order_id, sku, quantity, variant_id, product_id, units_per_variant } = orphan;

    // Get ATP for this product (cached)
    if (!atpCache[product_id]) {
      const { rows: atpRows } = await pool.query(`
        SELECT 
          COALESCE(SUM(il.variant_qty * pv2.units_per_variant), 0) AS on_hand,
          COALESCE(SUM(il.reserved_qty * pv2.units_per_variant), 0) AS reserved,
          COALESCE(SUM(il.picked_qty * pv2.units_per_variant), 0) AS picked,
          COALESCE(SUM(COALESCE(il.packed_qty, 0) * pv2.units_per_variant), 0) AS packed
        FROM inventory_levels il
        JOIN product_variants pv2 ON il.product_variant_id = pv2.id
        WHERE pv2.product_id = $1
      `, [product_id]);
      
      const r = atpRows[0];
      atpCache[product_id] = {
        base: Number(r.on_hand) - Number(r.reserved) - Number(r.picked) - Number(r.packed),
        consumed: 0, // Track how much we've consumed in this run
      };
    }

    const atpInfo = atpCache[product_id];
    const remainingBase = atpInfo.base - atpInfo.consumed;
    const atpUnits = Math.floor(remainingBase / units_per_variant);

    const toReserve = Math.min(quantity, Math.max(0, atpUnits));
    const shortfall = quantity - toReserve;

    if (toReserve === 0) {
      console.log(`  SKIP order #${order_id} item #${order_item_id} ${sku} x${quantity} (ATP=0)`);
      totalSkipped++;
      continue;
    }

    // Find the variant's assigned bin
    const { rows: assignments } = await pool.query(`
      SELECT warehouse_location_id 
      FROM product_locations 
      WHERE product_variant_id = $1 AND status = 'active'
      ORDER BY is_primary DESC
      LIMIT 1
    `, [variant_id]);

    if (assignments.length === 0) {
      console.log(`  SKIP order #${order_id} item #${order_item_id} ${sku} — no assigned bin`);
      totalSkipped++;
      continue;
    }

    const warehouseLocationId = assignments[0].warehouse_location_id;

    // Upsert inventory_levels row
    await pool.query(`
      INSERT INTO inventory_levels (warehouse_location_id, product_variant_id, variant_qty, reserved_qty, picked_qty, packed_qty, backorder_qty)
      VALUES ($1, $2, 0, 0, 0, 0, 0)
      ON CONFLICT DO NOTHING
    `, [warehouseLocationId, variant_id]);

    // Increment reserved_qty
    await pool.query(`
      UPDATE inventory_levels 
      SET reserved_qty = reserved_qty + $1, updated_at = NOW()
      WHERE product_variant_id = $2 AND warehouse_location_id = $3
    `, [toReserve, variant_id, warehouseLocationId]);

    // Log transaction
    await pool.query(`
      INSERT INTO inventory_transactions (
        product_variant_id, to_location_id, transaction_type,
        variant_qty_delta, source_state, target_state,
        order_id, order_item_id, reference_type, reference_id,
        notes, user_id
      ) VALUES ($1, $2, 'reserve', 0, 'on_hand', 'committed', $3, $4, 'order', $5, $6, $7)
    `, [
      variant_id,
      warehouseLocationId,
      order_id,
      order_item_id,
      String(order_id),
      `Backfill reservation: ${toReserve} of ${quantity} units (orphan fix)`,
      'engineer@cardshellz.com',
    ]);

    // Track consumed ATP
    atpInfo.consumed += toReserve * units_per_variant;

    totalReserved += toReserve;
    totalShortfall += shortfall;

    const status = shortfall > 0 ? 'PARTIAL' : 'OK';
    console.log(`  ${status} order #${order_id} item #${order_item_id} ${sku}: reserved ${toReserve}/${quantity}${shortfall > 0 ? ` (shortfall: ${shortfall})` : ''}`);
  }

  console.log('');
  console.log(`Done. Reserved: ${totalReserved} units, Shortfall: ${totalShortfall} units, Skipped: ${totalSkipped} items`);
  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
