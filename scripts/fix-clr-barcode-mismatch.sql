-- Fix CLR Barcode Mismatch
-- Problem: P25 location has C800 case barcode instead of pack barcode
-- Problem: C800 location is missing its case barcode

-- =============================================================================
-- BEFORE: Show current state
-- =============================================================================
SELECT
  'BEFORE FIX' as status,
  pv.sku,
  pv.barcode AS correct_variant_barcode,
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
ORDER BY pl.sku;

-- =============================================================================
-- FIX 1: Update P25 product_locations to use correct PACK barcode
-- =============================================================================
UPDATE product_locations
SET barcode = '13359263'  -- Correct P25 pack barcode
WHERE sku = 'SHLZ-TOP-55PT-CLR-P25'
  AND location = 'E-01'
  AND barcode = '13392031';  -- Currently has wrong case barcode

-- =============================================================================
-- FIX 2: Update C800 product_locations to use CASE barcode
-- =============================================================================
UPDATE product_locations
SET barcode = '13392031'  -- Correct C800 case barcode
WHERE sku = 'SHLZ-TOP-55PT-CLR-C800'
  AND location = 'H-03'
  AND barcode IS NULL;

-- =============================================================================
-- FIX 3: Update existing order_items in picking queue to use correct barcode
-- =============================================================================
UPDATE order_items oi
SET barcode = '13359263'  -- Correct P25 pack barcode
FROM orders o
WHERE oi.order_id = o.id
  AND oi.sku = 'SHLZ-TOP-55PT-CLR-P25'
  AND oi.barcode = '13392031'  -- Currently has wrong case barcode
  AND o.warehouse_status IN ('ready', 'picking');

-- =============================================================================
-- AFTER: Verify the fix
-- =============================================================================
SELECT
  'AFTER FIX' as status,
  pv.sku,
  pv.barcode AS correct_variant_barcode,
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
ORDER BY pl.sku;

-- =============================================================================
-- Verify order_items are fixed
-- =============================================================================
SELECT
  'ORDER ITEMS AFTER FIX' as status,
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
ORDER BY oi.id;
