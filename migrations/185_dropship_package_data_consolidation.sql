-- Dropship package data consolidation (spec: dropship-package-data-consolidation).
--
-- catalog.product_variants becomes the single source of truth for intrinsic
-- physical facts: weight, dims, ships-in-own-container, max units per package.
-- dropship.dropship_package_profiles keeps only channel-specific fulfillment
-- defaults (carrier/service/box). shipping.variant_shipping_attrs keeps only
-- rider/void behavior. Quote snapshots gain a warnings column so packaging
-- degradation is visible to ops without blocking order acceptance.

-- 1. New canonical columns on catalog.product_variants.

ALTER TABLE catalog.product_variants
  ADD COLUMN IF NOT EXISTS ships_in_own_container boolean NOT NULL DEFAULT false;

ALTER TABLE catalog.product_variants
  ADD COLUMN IF NOT EXISTS max_units_per_package integer;

-- 1a. Unit round-trip fix: dims/weight become numeric(10,2) so inch/pound
--     values round-trip exactly (6.00in = 152.40mm; 1lb = 453.59g). Integer
--     storage truncated 152.4mm to 152, which displayed back as 5.984in.

ALTER TABLE catalog.product_variants
  ALTER COLUMN weight_grams TYPE numeric(10,2) USING weight_grams::numeric(10,2),
  ALTER COLUMN length_mm TYPE numeric(10,2) USING length_mm::numeric(10,2),
  ALTER COLUMN width_mm TYPE numeric(10,2) USING width_mm::numeric(10,2),
  ALTER COLUMN height_mm TYPE numeric(10,2) USING height_mm::numeric(10,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'catalog.product_variants'::regclass
      AND conname = 'product_variants_max_units_per_package_chk'
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_max_units_per_package_chk
      CHECK (max_units_per_package IS NULL OR max_units_per_package > 0);
  END IF;
END $$;

-- 2. Backfill from dropship.dropship_package_profiles. Variant wins on
--    conflict: only fill values the variant row is missing.

UPDATE catalog.product_variants pv
SET weight_grams = pp.weight_grams
FROM dropship.dropship_package_profiles pp
WHERE pp.product_variant_id = pv.id
  AND (pv.weight_grams IS NULL OR pv.weight_grams <= 0)
  AND pp.weight_grams > 0;

UPDATE catalog.product_variants pv
SET length_mm = pp.length_mm
FROM dropship.dropship_package_profiles pp
WHERE pp.product_variant_id = pv.id
  AND (pv.length_mm IS NULL OR pv.length_mm <= 0)
  AND pp.length_mm > 0;

UPDATE catalog.product_variants pv
SET width_mm = pp.width_mm
FROM dropship.dropship_package_profiles pp
WHERE pp.product_variant_id = pv.id
  AND (pv.width_mm IS NULL OR pv.width_mm <= 0)
  AND pp.width_mm > 0;

UPDATE catalog.product_variants pv
SET height_mm = pp.height_mm
FROM dropship.dropship_package_profiles pp
WHERE pp.product_variant_id = pv.id
  AND (pv.height_mm IS NULL OR pv.height_mm <= 0)
  AND pp.height_mm > 0;

UPDATE catalog.product_variants pv
SET ships_in_own_container = true
FROM dropship.dropship_package_profiles pp
WHERE pp.product_variant_id = pv.id
  AND pv.ships_in_own_container = false
  AND pp.ship_alone = true;

UPDATE catalog.product_variants pv
SET max_units_per_package = pp.max_units_per_package
FROM dropship.dropship_package_profiles pp
WHERE pp.product_variant_id = pv.id
  AND pv.max_units_per_package IS NULL
  AND pp.max_units_per_package IS NOT NULL
  AND pp.max_units_per_package > 0;

-- 3. Backfill SIOC from shipping.variant_shipping_attrs where the variant
--    still has the default.

UPDATE catalog.product_variants pv
SET ships_in_own_container = true
FROM shipping.variant_shipping_attrs attrs
WHERE attrs.product_variant_id = pv.id
  AND pv.ships_in_own_container = false
  AND attrs.ships_in_own_container = true;

-- 4. Quote snapshot warnings (structured packaging degradation signals).

ALTER TABLE dropship.dropship_shipping_quote_snapshots
  ADD COLUMN IF NOT EXISTS warnings jsonb;

-- 5. Drop the duplicated physical-fact columns.

ALTER TABLE dropship.dropship_package_profiles
  DROP COLUMN IF EXISTS weight_grams,
  DROP COLUMN IF EXISTS length_mm,
  DROP COLUMN IF EXISTS width_mm,
  DROP COLUMN IF EXISTS height_mm,
  DROP COLUMN IF EXISTS ship_alone,
  DROP COLUMN IF EXISTS max_units_per_package;

ALTER TABLE shipping.variant_shipping_attrs
  DROP COLUMN IF EXISTS ships_in_own_container;
