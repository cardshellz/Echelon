ALTER TABLE catalog.product_variants
  ADD COLUMN IF NOT EXISTS uom_type varchar(20);

UPDATE catalog.product_variants
SET uom_type = CASE
  WHEN is_base_unit = true
    AND units_per_variant = 1
    AND hierarchy_level = 1
    AND parent_variant_id IS NULL THEN 'each'
  WHEN hierarchy_level >= 4 THEN 'skid'
  WHEN hierarchy_level = 3 THEN 'case'
  WHEN hierarchy_level = 2 THEN 'inner_pack'
  ELSE 'pack'
END
WHERE uom_type IS NULL;

ALTER TABLE catalog.product_variants
  ALTER COLUMN uom_type SET DEFAULT 'pack',
  ALTER COLUMN uom_type SET NOT NULL;

ALTER TABLE catalog.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_uom_type_chk;

ALTER TABLE catalog.product_variants
  ADD CONSTRAINT product_variants_uom_type_chk
  CHECK (uom_type IN ('each', 'pack', 'inner_pack', 'case', 'skid'));

ALTER TABLE catalog.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_each_invariants_chk;

ALTER TABLE catalog.product_variants
  ADD CONSTRAINT product_variants_each_invariants_chk
  CHECK (
    uom_type <> 'each'
    OR (
      units_per_variant = 1
      AND hierarchy_level = 1
      AND parent_variant_id IS NULL
      AND is_base_unit = true
    )
  );