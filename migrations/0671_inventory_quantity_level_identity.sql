-- Pre-activation hardening for the canonical quantity ledger.
--
-- The ledger and claim repositories address one inventory level by the exact
-- (product_variant_id, warehouse_location_id) identity.  Historically this
-- invariant was installed by server startup DDL only.  Make it migration-owned
-- so every database built or upgraded from migrations has the same authority
-- contract before quantity_ledger_opening can be created.
--
-- This migration does not rewrite quantities or activate canonical inventory.
-- If legacy data already contains duplicate cells, it fails closed and leaves
-- those rows untouched for an explicit, audited repair.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory.inventory_levels
    GROUP BY product_variant_id, warehouse_location_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'INVENTORY_LEVEL_IDENTITY_DUPLICATE',
      DETAIL = 'inventory.inventory_levels contains more than one row for an exact product variant and warehouse location.',
      HINT = 'Run the read-only inventory cutover census and repair duplicate cells through an explicitly approved inventory command before retrying.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_levels_variant_location
  ON inventory.inventory_levels(product_variant_id, warehouse_location_id);
