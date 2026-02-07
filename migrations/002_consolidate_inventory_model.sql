-- ============================================================================
-- Migration 002: Consolidate Inventory Model
-- Date: 2026-02-07
-- Description: Remove legacy inventory_items/uom_variants tables, consolidate
--              to products/product_variants as sole inventory model.
--              Wipes all inventory data (levels, transactions, etc.) for fresh start.
--              DOES NOT touch orders, order_items, or picking_logs.
-- ============================================================================

BEGIN;

-- ============================================================================
-- STEP 1: TRUNCATE INVENTORY DATA TABLES
-- Order matters: child tables first (FK dependencies)
-- ============================================================================

-- Cycle counts (child → parent)
TRUNCATE TABLE cycle_count_items CASCADE;
TRUNCATE TABLE cycle_counts CASCADE;

-- Receiving (child → parent)
TRUNCATE TABLE receiving_lines CASCADE;
TRUNCATE TABLE receiving_orders CASCADE;

-- Replenishment
TRUNCATE TABLE replen_tasks CASCADE;
TRUNCATE TABLE replen_rules CASCADE;

-- Channel data (all empty but clear for FK drops)
TRUNCATE TABLE channel_feeds CASCADE;
TRUNCATE TABLE channel_reservations CASCADE;
TRUNCATE TABLE channel_pricing CASCADE;
TRUNCATE TABLE channel_listings CASCADE;
TRUNCATE TABLE channel_variant_overrides CASCADE;
TRUNCATE TABLE channel_asset_overrides CASCADE;

-- Core inventory
TRUNCATE TABLE inventory_transactions CASCADE;
TRUNCATE TABLE inventory_levels CASCADE;

-- ============================================================================
-- STEP 2: DROP FOREIGN KEY CONSTRAINTS REFERENCING LEGACY TABLES
-- Must drop these before we can drop the legacy tables
-- ============================================================================

-- FK constraints referencing inventory_items
ALTER TABLE inventory_levels DROP CONSTRAINT IF EXISTS inventory_levels_inventory_item_id_inventory_items_id_fk;
ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_inventory_item_id_inventory_items_id_fk;
ALTER TABLE channel_reservations DROP CONSTRAINT IF EXISTS channel_reservations_inventory_item_id_inventory_items_id_fk;
ALTER TABLE catalog_products DROP CONSTRAINT IF EXISTS catalog_products_inventory_item_id_inventory_items_id_fk;
ALTER TABLE receiving_lines DROP CONSTRAINT IF EXISTS receiving_lines_inventory_item_id_inventory_items_id_fk;
ALTER TABLE cycle_count_items DROP CONSTRAINT IF EXISTS cycle_count_items_inventory_item_id_inventory_items_id_fk;

-- FK constraints referencing uom_variants
ALTER TABLE uom_variants DROP CONSTRAINT IF EXISTS uom_variants_inventory_item_id_inventory_items_id_fk;
ALTER TABLE inventory_levels DROP CONSTRAINT IF EXISTS inventory_levels_variant_id_uom_variants_id_fk;
ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_variant_id_uom_variants_id_fk;
ALTER TABLE channel_feeds DROP CONSTRAINT IF EXISTS channel_feeds_variant_id_uom_variants_id_fk;
ALTER TABLE channel_pricing DROP CONSTRAINT IF EXISTS channel_pricing_variant_id_uom_variants_id_fk;
ALTER TABLE channel_listings DROP CONSTRAINT IF EXISTS channel_listings_variant_id_uom_variants_id_fk;
ALTER TABLE channel_variant_overrides DROP CONSTRAINT IF EXISTS channel_variant_overrides_variant_id_uom_variants_id_fk;
ALTER TABLE catalog_products DROP CONSTRAINT IF EXISTS catalog_products_uom_variant_id_uom_variants_id_fk;
ALTER TABLE receiving_lines DROP CONSTRAINT IF EXISTS receiving_lines_uom_variant_id_uom_variants_id_fk;
ALTER TABLE replen_rules DROP CONSTRAINT IF EXISTS replen_rules_pick_variant_id_uom_variants_id_fk;
ALTER TABLE replen_rules DROP CONSTRAINT IF EXISTS replen_rules_source_variant_id_uom_variants_id_fk;
ALTER TABLE replen_tasks DROP CONSTRAINT IF EXISTS replen_tasks_source_variant_id_uom_variants_id_fk;
ALTER TABLE replen_tasks DROP CONSTRAINT IF EXISTS replen_tasks_pick_variant_id_uom_variants_id_fk;

-- ============================================================================
-- STEP 3: DROP LEGACY COLUMNS FROM ACTIVE TABLES
-- ============================================================================

-- inventory_levels: remove legacy FKs, keep productVariantId
ALTER TABLE inventory_levels DROP COLUMN IF EXISTS inventory_item_id;
ALTER TABLE inventory_levels DROP COLUMN IF EXISTS variant_id;

-- inventory_transactions: remove legacy FKs and redundant columns
ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS inventory_item_id;
ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS variant_id;
ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS warehouse_location_id; -- legacy duplicate of from/to location
ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS base_qty_delta;        -- legacy base unit tracking
ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS base_qty_before;       -- legacy
ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS base_qty_after;        -- legacy

-- catalog_products: remove legacy FKs
ALTER TABLE catalog_products DROP COLUMN IF EXISTS inventory_item_id;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS uom_variant_id;

-- receiving_lines: remove legacy FKs
ALTER TABLE receiving_lines DROP COLUMN IF EXISTS inventory_item_id;
ALTER TABLE receiving_lines DROP COLUMN IF EXISTS uom_variant_id;

-- cycle_count_items: remove legacy FK
ALTER TABLE cycle_count_items DROP COLUMN IF EXISTS inventory_item_id;

-- channel_feeds: remove legacy variant FK
ALTER TABLE channel_feeds DROP COLUMN IF EXISTS variant_id;

-- channel_pricing: remove legacy variant FK, drop old unique index
DROP INDEX IF EXISTS channel_pricing_channel_variant_idx;
ALTER TABLE channel_pricing DROP COLUMN IF EXISTS variant_id;

-- channel_listings: remove legacy variant FK, drop old unique index
DROP INDEX IF EXISTS channel_listings_channel_variant_idx;
ALTER TABLE channel_listings DROP COLUMN IF EXISTS variant_id;

-- channel_variant_overrides: remove legacy variant FK, drop old unique index
DROP INDEX IF EXISTS channel_variant_overrides_channel_variant_idx;
ALTER TABLE channel_variant_overrides DROP COLUMN IF EXISTS variant_id;

-- channel_reservations: remove legacy inventoryItemId
ALTER TABLE channel_reservations DROP COLUMN IF EXISTS inventory_item_id;
DROP INDEX IF EXISTS channel_reservations_channel_item_idx;

-- replen_rules: remove legacy variant FKs
ALTER TABLE replen_rules DROP COLUMN IF EXISTS pick_variant_id;
ALTER TABLE replen_rules DROP COLUMN IF EXISTS source_variant_id;

-- replen_tasks: remove legacy variant FKs
ALTER TABLE replen_tasks DROP COLUMN IF EXISTS source_variant_id;
ALTER TABLE replen_tasks DROP COLUMN IF EXISTS pick_variant_id;

-- ============================================================================
-- STEP 4: DROP LEGACY TABLES
-- ============================================================================

DROP TABLE IF EXISTS uom_variants CASCADE;
DROP TABLE IF EXISTS inventory_items CASCADE;

-- Also drop the mapping table if it exists
DROP TABLE IF EXISTS uom_to_pv_mapping CASCADE;

-- ============================================================================
-- STEP 5: ADD MISSING COLUMNS TO CONSOLIDATE ON NEW MODEL
-- ============================================================================

-- channel_reservations: add productVariantId (replaces inventoryItemId)
ALTER TABLE channel_reservations ADD COLUMN IF NOT EXISTS product_variant_id INTEGER
  REFERENCES product_variants(id) ON DELETE CASCADE;

-- cycle_count_items: add productVariantId and catalogProductId
ALTER TABLE cycle_count_items ADD COLUMN IF NOT EXISTS product_variant_id INTEGER
  REFERENCES product_variants(id) ON DELETE SET NULL;
-- catalogProductId already exists

-- replen_tasks: add warehouseId (schema has it, DB does not yet)
ALTER TABLE replen_tasks ADD COLUMN IF NOT EXISTS warehouse_id INTEGER
  REFERENCES warehouses(id);

-- ============================================================================
-- STEP 6: MAKE productVariantId NOT NULL WHERE APPROPRIATE
-- (Only on tables where it's required for the model to work)
-- ============================================================================

-- inventory_levels: productVariantId must always be set
ALTER TABLE inventory_levels ALTER COLUMN product_variant_id SET NOT NULL;

-- channel_feeds: productVariantId must always be set
ALTER TABLE channel_feeds ALTER COLUMN product_variant_id SET NOT NULL;

-- ============================================================================
-- STEP 7: REBUILD UNIQUE INDEXES FOR CHANNEL TABLES (on new FK columns)
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS channel_pricing_channel_pv_idx
  ON channel_pricing(channel_id, product_variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS channel_listings_channel_pv_idx
  ON channel_listings(channel_id, product_variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS channel_variant_overrides_channel_pv_idx
  ON channel_variant_overrides(channel_id, product_variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS channel_reservations_channel_pv_idx
  ON channel_reservations(channel_id, product_variant_id);

-- ============================================================================
-- STEP 8: ADD MISSING INDEXES ON ALL FK COLUMNS
-- Performance indexes for common queries and JOINs
-- ============================================================================

-- orders (DO NOT ALTER TABLE STRUCTURE — only add indexes)
CREATE INDEX IF NOT EXISTS idx_orders_warehouse_status ON orders(warehouse_status);
CREATE INDEX IF NOT EXISTS idx_orders_assigned_picker_id ON orders(assigned_picker_id);
CREATE INDEX IF NOT EXISTS idx_orders_channel_id ON orders(channel_id);
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_priority ON orders(priority);
CREATE INDEX IF NOT EXISTS idx_orders_on_hold ON orders(on_hold);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_order_placed_at ON orders(order_placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_financial_status ON orders(financial_status);
CREATE INDEX IF NOT EXISTS idx_orders_combined_group_id ON orders(combined_group_id);

-- order_items (DO NOT ALTER TABLE STRUCTURE — only add indexes)
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_status ON order_items(status);
CREATE INDEX IF NOT EXISTS idx_order_items_sku ON order_items(sku);
CREATE INDEX IF NOT EXISTS idx_order_items_catalog_product_id ON order_items(catalog_product_id);

-- picking_logs
CREATE INDEX IF NOT EXISTS idx_picking_logs_order_id ON picking_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_picking_logs_picker_id ON picking_logs(picker_id);
CREATE INDEX IF NOT EXISTS idx_picking_logs_action_type ON picking_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_picking_logs_timestamp ON picking_logs(timestamp);

-- product_locations
CREATE INDEX IF NOT EXISTS idx_product_locations_catalog_product_id ON product_locations(catalog_product_id);
CREATE INDEX IF NOT EXISTS idx_product_locations_sku ON product_locations(sku);
CREATE INDEX IF NOT EXISTS idx_product_locations_location ON product_locations(location);
CREATE INDEX IF NOT EXISTS idx_product_locations_zone ON product_locations(zone);
CREATE INDEX IF NOT EXISTS idx_product_locations_warehouse_location_id ON product_locations(warehouse_location_id);
CREATE INDEX IF NOT EXISTS idx_product_locations_shopify_variant_id ON product_locations(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_product_locations_barcode ON product_locations(barcode);
CREATE INDEX IF NOT EXISTS idx_product_locations_status ON product_locations(status);

-- inventory_levels
CREATE INDEX IF NOT EXISTS idx_inventory_levels_product_variant_id ON inventory_levels(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_levels_warehouse_location_id ON inventory_levels(warehouse_location_id);

-- inventory_transactions
CREATE INDEX IF NOT EXISTS idx_inv_txn_product_variant_id ON inventory_transactions(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_from_location_id ON inventory_transactions(from_location_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_to_location_id ON inventory_transactions(to_location_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_transaction_type ON inventory_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_inv_txn_order_id ON inventory_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_receiving_order_id ON inventory_transactions(receiving_order_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_created_at ON inventory_transactions(created_at);

-- products
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);

-- product_variants
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_sku ON product_variants(sku);
CREATE INDEX IF NOT EXISTS idx_product_variants_shopify_variant_id ON product_variants(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode);
CREATE INDEX IF NOT EXISTS idx_product_variants_is_active ON product_variants(is_active);

-- catalog_products
CREATE INDEX IF NOT EXISTS idx_catalog_products_product_variant_id ON catalog_products(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_sku ON catalog_products(sku);
CREATE INDEX IF NOT EXISTS idx_catalog_products_status ON catalog_products(status);

-- warehouse_locations
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_warehouse_id ON warehouse_locations(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_zone ON warehouse_locations(zone);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_location_type ON warehouse_locations(location_type);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_is_pickable ON warehouse_locations(is_pickable);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_pick_sequence ON warehouse_locations(pick_sequence);

-- receiving_orders
CREATE INDEX IF NOT EXISTS idx_receiving_orders_status ON receiving_orders(status);
CREATE INDEX IF NOT EXISTS idx_receiving_orders_vendor_id ON receiving_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_receiving_orders_warehouse_id ON receiving_orders(warehouse_id);

-- receiving_lines
CREATE INDEX IF NOT EXISTS idx_receiving_lines_receiving_order_id ON receiving_lines(receiving_order_id);
CREATE INDEX IF NOT EXISTS idx_receiving_lines_product_variant_id ON receiving_lines(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_receiving_lines_catalog_product_id ON receiving_lines(catalog_product_id);
CREATE INDEX IF NOT EXISTS idx_receiving_lines_sku ON receiving_lines(sku);

-- cycle_counts
CREATE INDEX IF NOT EXISTS idx_cycle_counts_status ON cycle_counts(status);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_warehouse_id ON cycle_counts(warehouse_id);

-- cycle_count_items
CREATE INDEX IF NOT EXISTS idx_cycle_count_items_cycle_count_id ON cycle_count_items(cycle_count_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_items_warehouse_location_id ON cycle_count_items(warehouse_location_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_items_product_variant_id ON cycle_count_items(product_variant_id);

-- channel_feeds
CREATE INDEX IF NOT EXISTS idx_channel_feeds_product_variant_id ON channel_feeds(product_variant_id);

-- replen_rules
CREATE INDEX IF NOT EXISTS idx_replen_rules_catalog_product_id ON replen_rules(catalog_product_id);
CREATE INDEX IF NOT EXISTS idx_replen_rules_pick_product_variant_id ON replen_rules(pick_product_variant_id);
CREATE INDEX IF NOT EXISTS idx_replen_rules_source_product_variant_id ON replen_rules(source_product_variant_id);

-- replen_tasks
CREATE INDEX IF NOT EXISTS idx_replen_tasks_status ON replen_tasks(status);
CREATE INDEX IF NOT EXISTS idx_replen_tasks_from_location_id ON replen_tasks(from_location_id);
CREATE INDEX IF NOT EXISTS idx_replen_tasks_to_location_id ON replen_tasks(to_location_id);
CREATE INDEX IF NOT EXISTS idx_replen_tasks_catalog_product_id ON replen_tasks(catalog_product_id);
CREATE INDEX IF NOT EXISTS idx_replen_tasks_warehouse_id ON replen_tasks(warehouse_id);

-- replen_tier_defaults
CREATE INDEX IF NOT EXISTS idx_replen_tier_defaults_warehouse_id ON replen_tier_defaults(warehouse_id);

-- users
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

-- user_audit
CREATE INDEX IF NOT EXISTS idx_user_audit_user_id ON user_audit(user_id);

-- channel_connections
CREATE INDEX IF NOT EXISTS idx_channel_connections_channel_id ON channel_connections(channel_id);

-- partner_profiles (already has unique on channel_id)

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Verify legacy tables are gone
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'inventory_items') THEN
    RAISE EXCEPTION 'inventory_items table still exists!';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'uom_variants') THEN
    RAISE EXCEPTION 'uom_variants table still exists!';
  END IF;
  RAISE NOTICE 'Migration 002 verified: legacy tables dropped, indexes created.';
END $$;

COMMIT;
