ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS inventory_strategy varchar(30);

UPDATE catalog.products
SET inventory_strategy = 'physical_fungible'
WHERE inventory_strategy IS NULL;

UPDATE catalog.products p
SET inventory_strategy = 'recipe_managed'
WHERE EXISTS (
  SELECT 1
  FROM inventory.build_recipes br
  WHERE br.output_product_id = p.id
);

ALTER TABLE catalog.products
  ALTER COLUMN inventory_strategy SET DEFAULT 'physical_fungible',
  ALTER COLUMN inventory_strategy SET NOT NULL;

ALTER TABLE catalog.products
  DROP CONSTRAINT IF EXISTS products_inventory_strategy_chk;

ALTER TABLE catalog.products
  ADD CONSTRAINT products_inventory_strategy_chk
  CHECK (inventory_strategy IN ('physical_fungible', 'recipe_managed', 'physical_only'));
