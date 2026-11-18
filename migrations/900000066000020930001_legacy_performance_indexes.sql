-- Four indexes that production has only because the legacy schema fallback in
-- server/db.ts created them. No tracked migration declared them, so a database
-- built from migrations alone would not have them. The fallback block is
-- retired in the same change (REFACTOR-PLAN P4.1).
--
-- Every statement is IF NOT EXISTS: in production all four already exist with
-- these definitions, so this migration changes nothing there.
--
-- idx_inventory_levels_pv_wl is deliberately not declared. It has the same
-- columns as the unique index idx_inventory_levels_variant_location
-- (0671_inventory_quantity_level_identity.sql).

CREATE INDEX IF NOT EXISTS idx_picking_logs_sku
  ON wms.picking_logs (sku);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product_variant_id
  ON inventory.inventory_transactions (product_variant_id);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_order_id
  ON inventory.inventory_transactions (order_id);

CREATE INDEX IF NOT EXISTS idx_orders_source_table_id
  ON wms.orders (source_table_id);
