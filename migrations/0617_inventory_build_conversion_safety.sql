-- Build recipe classification and immutable catalog conversion snapshots.
--
-- Conversion recipes repackage variants of one catalog product and must
-- preserve base units exactly. Assembly recipes combine different products.
-- Product and UOM snapshots prevent later catalog edits from silently changing
-- the meaning of a released build order.

ALTER TABLE inventory.build_recipes
  ADD COLUMN IF NOT EXISTS recipe_type varchar(20),
  ADD COLUMN IF NOT EXISTS output_product_id integer,
  ADD COLUMN IF NOT EXISTS output_units_per_variant integer;

ALTER TABLE inventory.build_recipe_components
  ADD COLUMN IF NOT EXISTS component_product_id integer,
  ADD COLUMN IF NOT EXISTS component_units_per_variant integer;

ALTER TABLE inventory.build_orders
  ADD COLUMN IF NOT EXISTS recipe_type varchar(20),
  ADD COLUMN IF NOT EXISTS output_product_id integer,
  ADD COLUMN IF NOT EXISTS output_units_per_variant integer;

ALTER TABLE inventory.build_order_components
  ADD COLUMN IF NOT EXISTS component_product_id integer,
  ADD COLUMN IF NOT EXISTS component_units_per_variant integer;

UPDATE inventory.build_recipes recipe
SET output_product_id = variant.product_id,
    output_units_per_variant = variant.units_per_variant
FROM catalog.product_variants variant
WHERE variant.id = recipe.output_variant_id
  AND (
    recipe.output_product_id IS NULL
    OR recipe.output_units_per_variant IS NULL
  );

UPDATE inventory.build_recipe_components component
SET component_product_id = variant.product_id,
    component_units_per_variant = variant.units_per_variant
FROM catalog.product_variants variant
WHERE variant.id = component.component_variant_id
  AND (
    component.component_product_id IS NULL
    OR component.component_units_per_variant IS NULL
  );

WITH recipe_evidence AS (
  SELECT
    recipe.id,
    bool_and(component.component_product_id = recipe.output_product_id) AS same_product,
    SUM(component.qty::bigint * component.component_units_per_variant::bigint)
      = recipe.output_qty::bigint * recipe.output_units_per_variant::bigint AS base_units_conserved
  FROM inventory.build_recipes recipe
  JOIN inventory.build_recipe_components component
    ON component.recipe_id = recipe.id
  GROUP BY recipe.id
)
UPDATE inventory.build_recipes recipe
SET recipe_type = CASE
  WHEN evidence.same_product AND evidence.base_units_conserved THEN 'conversion'
  ELSE 'assembly'
END
FROM recipe_evidence evidence
WHERE evidence.id = recipe.id
  AND recipe.recipe_type IS NULL;

UPDATE inventory.build_recipes
SET recipe_type = 'assembly'
WHERE recipe_type IS NULL;

UPDATE inventory.build_orders build_order
SET recipe_type = recipe.recipe_type,
    output_product_id = recipe.output_product_id,
    output_units_per_variant = recipe.output_units_per_variant
FROM inventory.build_recipes recipe
WHERE recipe.id = build_order.recipe_id
  AND (
    build_order.recipe_type IS NULL
    OR build_order.output_product_id IS NULL
    OR build_order.output_units_per_variant IS NULL
  );

UPDATE inventory.build_order_components order_component
SET component_product_id = recipe_component.component_product_id,
    component_units_per_variant = recipe_component.component_units_per_variant
FROM inventory.build_recipe_components recipe_component
WHERE recipe_component.id = order_component.recipe_component_id
  AND (
    order_component.component_product_id IS NULL
    OR order_component.component_units_per_variant IS NULL
  );
DO $$
DECLARE
  invalid_recipe_count integer;
  invalid_recipe_component_count integer;
  invalid_order_count integer;
  invalid_order_component_count integer;
BEGIN
  SELECT COUNT(*) INTO invalid_recipe_count
  FROM inventory.build_recipes
  WHERE output_product_id IS NULL
     OR output_product_id <= 0
     OR output_units_per_variant IS NULL
     OR output_units_per_variant <= 0;

  SELECT COUNT(*) INTO invalid_recipe_component_count
  FROM inventory.build_recipe_components
  WHERE component_product_id IS NULL
     OR component_product_id <= 0
     OR component_units_per_variant IS NULL
     OR component_units_per_variant <= 0;

  SELECT COUNT(*) INTO invalid_order_count
  FROM inventory.build_orders
  WHERE output_product_id IS NULL
     OR output_product_id <= 0
     OR output_units_per_variant IS NULL
     OR output_units_per_variant <= 0;

  SELECT COUNT(*) INTO invalid_order_component_count
  FROM inventory.build_order_components
  WHERE component_product_id IS NULL
     OR component_product_id <= 0
     OR component_units_per_variant IS NULL
     OR component_units_per_variant <= 0;

  IF invalid_recipe_count > 0
     OR invalid_recipe_component_count > 0
     OR invalid_order_count > 0
     OR invalid_order_component_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Cannot enforce build conversion snapshots because legacy rows have missing or non-positive catalog product/UOM data',
      DETAIL = format(
        'recipes=%s recipe_components=%s orders=%s order_components=%s',
        invalid_recipe_count,
        invalid_recipe_component_count,
        invalid_order_count,
        invalid_order_component_count
      ),
      HINT = 'Repair the referenced catalog product and units_per_variant values, then rerun this migration.';
  END IF;
END
$$;

ALTER TABLE inventory.build_recipes
  ALTER COLUMN recipe_type SET NOT NULL,
  ALTER COLUMN output_product_id SET NOT NULL,
  ALTER COLUMN output_units_per_variant SET NOT NULL;

ALTER TABLE inventory.build_recipe_components
  ALTER COLUMN component_product_id SET NOT NULL,
  ALTER COLUMN component_units_per_variant SET NOT NULL;

ALTER TABLE inventory.build_orders
  ALTER COLUMN recipe_type SET NOT NULL,
  ALTER COLUMN output_product_id SET NOT NULL,
  ALTER COLUMN output_units_per_variant SET NOT NULL;

ALTER TABLE inventory.build_order_components
  ALTER COLUMN component_product_id SET NOT NULL,
  ALTER COLUMN component_units_per_variant SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_recipes_recipe_type_chk'
      AND conrelid = 'inventory.build_recipes'::regclass
  ) THEN
    ALTER TABLE inventory.build_recipes
      ADD CONSTRAINT build_recipes_recipe_type_chk
      CHECK (recipe_type IN ('conversion', 'assembly'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_recipes_snapshot_chk'
      AND conrelid = 'inventory.build_recipes'::regclass
  ) THEN
    ALTER TABLE inventory.build_recipes
      ADD CONSTRAINT build_recipes_snapshot_chk
      CHECK (output_product_id > 0 AND output_units_per_variant > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_recipe_components_snapshot_chk'
      AND conrelid = 'inventory.build_recipe_components'::regclass
  ) THEN
    ALTER TABLE inventory.build_recipe_components
      ADD CONSTRAINT build_recipe_components_snapshot_chk
      CHECK (component_product_id > 0 AND component_units_per_variant > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_orders_recipe_type_chk'
      AND conrelid = 'inventory.build_orders'::regclass
  ) THEN
    ALTER TABLE inventory.build_orders
      ADD CONSTRAINT build_orders_recipe_type_chk
      CHECK (recipe_type IN ('conversion', 'assembly'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_orders_snapshot_chk'
      AND conrelid = 'inventory.build_orders'::regclass
  ) THEN
    ALTER TABLE inventory.build_orders
      ADD CONSTRAINT build_orders_snapshot_chk
      CHECK (output_product_id > 0 AND output_units_per_variant > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_order_components_snapshot_chk'
      AND conrelid = 'inventory.build_order_components'::regclass
  ) THEN
    ALTER TABLE inventory.build_order_components
      ADD CONSTRAINT build_order_components_snapshot_chk
      CHECK (component_product_id > 0 AND component_units_per_variant > 0);
  END IF;
END
$$;
