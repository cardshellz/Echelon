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
  console.log('🔍 INVESTIGATING CLR BARCODE MISMATCH\n');
  console.log('=' .repeat(80));

  // ============================================================================
  // 1. CLR Product Variants - Source of Truth for Barcodes
  // ============================================================================
  console.log('\n1️⃣  CLR PRODUCT VARIANTS (source of truth for barcodes):');
  console.log('─'.repeat(80));
  const variantsResult = await pool.query(`
    SELECT
      id,
      sku,
      name,
      barcode AS variant_barcode,
      hierarchy_level,
      units_per_variant
    FROM product_variants
    WHERE sku LIKE 'SHLZ-TOP-55PT-CLR%'
    ORDER BY hierarchy_level, sku
  `);
  const variants = variantsResult.rows;
  console.table(variants);

  // ============================================================================
  // 2. CLR Product Locations - What Scanner Uses
  // ============================================================================
  console.log('\n2️⃣  CLR PRODUCT LOCATIONS (what scanner uses):');
  console.log('─'.repeat(80));
  const locationsResult = await pool.query(`
    SELECT
      id,
      sku,
      location,
      barcode AS location_barcode,
      is_primary,
      status
    FROM product_locations
    WHERE sku LIKE 'SHLZ-TOP-55PT-CLR%'
    ORDER BY sku, location
  `);
  const locations = locationsResult.rows;
  console.table(locations);

  // ============================================================================
  // 3. BARCODE MISMATCH CHECK - Compare Variant vs Location Barcodes
  // ============================================================================
  console.log('\n3️⃣  BARCODE MISMATCH ANALYSIS:');
  console.log('─'.repeat(80));
  const mismatchResult = await pool.query(`
    SELECT
      pv.sku,
      pv.name,
      pv.barcode AS correct_variant_barcode,
      pl.location,
      pl.barcode AS location_barcode,
      CASE
        WHEN pv.barcode = pl.barcode THEN '✅ MATCH'
        WHEN pv.barcode IS NULL AND pl.barcode IS NULL THEN '⚠️  BOTH NULL'
        WHEN pv.barcode IS NULL THEN '⚠️  VARIANT NULL'
        WHEN pl.barcode IS NULL THEN '⚠️  LOCATION NULL'
        ELSE '❌ MISMATCH!'
      END as status
    FROM product_locations pl
    JOIN product_variants pv ON pv.sku = pl.sku
    WHERE pl.sku LIKE 'SHLZ-TOP-55PT-CLR%'
    ORDER BY pl.sku, pl.location
  `);
  const mismatches = mismatchResult.rows;
  console.table(mismatches);

  // ============================================================================
  // 4. Cross-Check: Which Variant Has Location's Barcode?
  // ============================================================================
  console.log('\n4️⃣  CROSS-CHECK: If location barcode is wrong, which variant does it belong to?');
  console.log('─'.repeat(80));

  const p25Location = locations.find(l => l.sku === 'SHLZ-TOP-55PT-CLR-P25' && l.is_primary === 1);
  const c800Location = locations.find(l => l.sku === 'SHLZ-TOP-55PT-CLR-C800' && l.is_primary === 1);

  if (p25Location) {
    console.log(`\n📦 P25 (Pack) Location Barcode: ${p25Location.location_barcode || 'NULL'}`);

    const whoOwnsP25Barcode = await pool.query(`
      SELECT sku, name, barcode, units_per_variant
      FROM product_variants
      WHERE barcode = $1
    `, [p25Location.location_barcode]);

    if (whoOwnsP25Barcode.rows.length > 0) {
      console.log('   ⚠️  This barcode actually belongs to:');
      console.table(whoOwnsP25Barcode.rows);
    }
  }

  if (c800Location) {
    console.log(`\n📦 C800 (Case) Location Barcode: ${c800Location.location_barcode || 'NULL'}`);

    if (c800Location.location_barcode) {
      const whoOwnsC800Barcode = await pool.query(`
        SELECT sku, name, barcode, units_per_variant
        FROM product_variants
        WHERE barcode = $1
      `, [c800Location.location_barcode]);

      if (whoOwnsC800Barcode.rows.length > 0) {
        console.log('   ⚠️  This barcode actually belongs to:');
        console.table(whoOwnsC800Barcode.rows);
      }
    } else {
      console.log('   ✅ Location barcode is NULL (correct - matches variant)');
    }
  }

  // ============================================================================
  // 5. Order Items Check
  // ============================================================================
  console.log('\n5️⃣  ORDER ITEMS with CLR SKUs in picking queue:');
  console.log('─'.repeat(80));
  const orderItemsResult = await pool.query(`
    SELECT
      oi.id,
      oi.sku,
      oi.name,
      oi.barcode AS order_item_barcode,
      oi.location,
      oi.quantity,
      o.order_number,
      o.warehouse_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.sku LIKE 'SHLZ-TOP-55PT-CLR%'
      AND o.warehouse_status IN ('ready', 'picking')
    ORDER BY oi.sku, oi.id
  `);
  const orderItems = orderItemsResult.rows;

  if (orderItems.length > 0) {
    console.table(orderItems);
  } else {
    console.log('   (No CLR items in current picking queue)');
  }

  // ============================================================================
  // Summary & Fix
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('📊 SUMMARY & FIX:\n');

  const p25Variant = variants.find(v => v.sku === 'SHLZ-TOP-55PT-CLR-P25');
  const c800Variant = variants.find(v => v.sku === 'SHLZ-TOP-55PT-CLR-C800');

  console.log('CORRECT BARCODES (from product_variants):');
  console.log(`  P25 (Pack of 25):  ${p25Variant?.variant_barcode || 'NULL'}`);
  console.log(`  C800 (Case of 800): ${c800Variant?.variant_barcode || 'NULL'}`);

  console.log('\nCURRENT PRODUCT_LOCATIONS BARCODES:');
  if (p25Location) {
    console.log(`  P25 at ${p25Location.location}: ${p25Location.location_barcode || 'NULL'}`);

    if (p25Location.location_barcode !== p25Variant?.variant_barcode) {
      console.log('  ❌ WRONG! This should be:', p25Variant?.variant_barcode);
    }
  }
  if (c800Location) {
    console.log(`  C800 at ${c800Location.location}: ${c800Location.location_barcode || 'NULL'}`);

    if (c800Location.location_barcode !== c800Variant?.variant_barcode) {
      console.log('  ❌ WRONG! This should be:', c800Variant?.variant_barcode);
    }
  }

  console.log('\n' + '='.repeat(80));

  await pool.end();
})().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
