ALTER TABLE catalog.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_uom_type_chk;

ALTER TABLE catalog.product_variants
  ADD CONSTRAINT product_variants_uom_type_chk
  CHECK (uom_type IN ('piece', 'each', 'pack', 'inner_pack', 'case', 'skid'));

ALTER TABLE catalog.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_each_invariants_chk;

ALTER TABLE catalog.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_single_unit_uom_invariants_chk;

ALTER TABLE catalog.product_variants
  ADD CONSTRAINT product_variants_single_unit_uom_invariants_chk
  CHECK (
    uom_type NOT IN ('piece', 'each')
    OR (
      units_per_variant = 1
      AND hierarchy_level = 1
      AND parent_variant_id IS NULL
      AND is_base_unit = true
    )
  );