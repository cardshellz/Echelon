const pkg = require('pg');
const { Pool } = pkg;
require('dotenv').config();

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
const useSSL = process.env.EXTERNAL_DATABASE_URL || process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  console.log('🔧 FIXING CLR BARCODE MISMATCH\n');
  console.log('=' .repeat(80));

  // ============================================================================
  // BEFORE: Show current state
  // ============================================================================
  console.log('\n📋 BEFORE FIX:');
  console.log('─'.repeat(80));

  const beforeLocations = await pool.query(`
    SELECT
      pv.sku,
      pv.barcode AS correct_variant_barcode,
      pl.id AS location_id,
      pl.location,
      pl.barcode AS current_location_barcode,
      CASE
        WHEN pv.barcode = pl.barcode THEN '✅ MATCH'
        WHEN pv.barcode IS NULL AND pl.barcode IS NULL THEN 'BOTH NULL'
        ELSE '❌ MISMATCH'
      END as match_status
    FROM product_locations pl
    JOIN product_variants pv ON pv.sku = pl.sku
    WHERE pl.sku IN ('SHLZ-TOP-55PT-CLR-P25', 'SHLZ-TOP-55PT-CLR-C800')
      AND pl.is_primary = 1
    ORDER BY pl.sku
  `);
  console.table(beforeLocations.rows);

  const beforeOrderItems = await pool.query(`
    SELECT
      oi.id,
      oi.sku,
      oi.barcode,
      o.order_number,
      CASE
        WHEN oi.barcode = '13359263' THEN '✅ CORRECT (P25 pack)'
        WHEN oi.barcode = '13392031' THEN '❌ WRONG (C800 case)'
        ELSE '⚠️  OTHER'
      END as barcode_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.sku = 'SHLZ-TOP-55PT-CLR-P25'
      AND o.warehouse_status IN ('ready', 'picking')
    ORDER BY oi.id
  `);
  console.log('\nOrder Items (CLR-P25 in picking queue):');
  console.table(beforeOrderItems.rows);

  // ============================================================================
  // FIX 1: Update P25 product_locations
  // ============================================================================
  console.log('\n🔧 FIX 1: Updating P25 location barcode...');

  const fix1Result = await pool.query(`
    UPDATE product_locations
    SET barcode = '13359263'
    WHERE sku = 'SHLZ-TOP-55PT-CLR-P25'
      AND location = 'E-01'
      AND barcode = '13392031'
    RETURNING id, sku, location, barcode
  `);

  if (fix1Result.rowCount > 0) {
    console.log(`✅ Updated ${fix1Result.rowCount} product_location record(s)`);
    console.table(fix1Result.rows);
  } else {
    console.log('⚠️  No rows updated (already fixed or no matching records)');
  }

  // ============================================================================
  // FIX 2: Update C800 product_locations
  // ============================================================================
  console.log('\n🔧 FIX 2: Updating C800 location barcode...');

  const fix2Result = await pool.query(`
    UPDATE product_locations
    SET barcode = '13392031'
    WHERE sku = 'SHLZ-TOP-55PT-CLR-C800'
      AND location = 'H-03'
      AND barcode IS NULL
    RETURNING id, sku, location, barcode
  `);

  if (fix2Result.rowCount > 0) {
    console.log(`✅ Updated ${fix2Result.rowCount} product_location record(s)`);
    console.table(fix2Result.rows);
  } else {
    console.log('⚠️  No rows updated (already fixed or no matching records)');
  }

  // ============================================================================
  // FIX 3: Update existing order_items
  // ============================================================================
  console.log('\n🔧 FIX 3: Updating order_items in picking queue...');

  const fix3Result = await pool.query(`
    UPDATE order_items oi
    SET barcode = '13359263'
    FROM orders o
    WHERE oi.order_id = o.id
      AND oi.sku = 'SHLZ-TOP-55PT-CLR-P25'
      AND oi.barcode = '13392031'
      AND o.warehouse_status IN ('ready', 'picking')
    RETURNING oi.id, oi.sku, oi.barcode, o.order_number
  `);

  if (fix3Result.rowCount > 0) {
    console.log(`✅ Updated ${fix3Result.rowCount} order_item record(s)`);
    console.table(fix3Result.rows);
  } else {
    console.log('⚠️  No rows updated (already fixed or no matching records)');
  }

  // ============================================================================
  // AFTER: Verify the fix
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('📋 AFTER FIX:');
  console.log('─'.repeat(80));

  const afterLocations = await pool.query(`
    SELECT
      pv.sku,
      pv.barcode AS correct_variant_barcode,
      pl.id AS location_id,
      pl.location,
      pl.barcode AS current_location_barcode,
      CASE
        WHEN pv.barcode = pl.barcode THEN '✅ MATCH'
        WHEN pv.barcode IS NULL AND pl.barcode IS NULL THEN 'BOTH NULL'
        ELSE '❌ MISMATCH'
      END as match_status
    FROM product_locations pl
    JOIN product_variants pv ON pv.sku = pl.sku
    WHERE pl.sku IN ('SHLZ-TOP-55PT-CLR-P25', 'SHLZ-TOP-55PT-CLR-C800')
      AND pl.is_primary = 1
    ORDER BY pl.sku
  `);
  console.table(afterLocations.rows);

  const afterOrderItems = await pool.query(`
    SELECT
      oi.id,
      oi.sku,
      oi.barcode,
      o.order_number,
      CASE
        WHEN oi.barcode = '13359263' THEN '✅ CORRECT (P25 pack)'
        WHEN oi.barcode = '13392031' THEN '❌ WRONG (C800 case)'
        ELSE '⚠️  OTHER'
      END as barcode_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.sku = 'SHLZ-TOP-55PT-CLR-P25'
      AND o.warehouse_status IN ('ready', 'picking')
    ORDER BY oi.id
  `);
  console.log('\nOrder Items (CLR-P25 in picking queue):');
  console.table(afterOrderItems.rows);

  // ============================================================================
  // Summary
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('✅ FIX COMPLETE\n');
  console.log('Summary:');
  console.log('  - Product locations now have correct barcodes');
  console.log('  - P25 (Pack of 25) → barcode 13359263');
  console.log('  - C800 (Case of 800) → barcode 13392031');
  console.log('  - Existing order items in picking queue updated');
  console.log('\n🎯 Scanner will now show correct pack barcode for P25 orders!');
  console.log('=' .repeat(80));

  await pool.end();
})().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
