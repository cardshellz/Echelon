-- Migration 014: Multi-warehouse support + fulfillment routing rules
-- Adds warehouse type configuration, inventory source abstraction, order-to-warehouse routing

-- ===== WAREHOUSE ENHANCEMENTS =====
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS inventory_source_type VARCHAR(20) NOT NULL DEFAULT 'internal';
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS inventory_source_config JSONB;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS last_inventory_sync_at TIMESTAMP;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS inventory_sync_status VARCHAR(20) DEFAULT 'never';

-- Migrate legacy warehouse_type values
UPDATE warehouses SET warehouse_type = 'operations' WHERE warehouse_type = 'fulfillment_center';
UPDATE warehouses SET warehouse_type = 'operations' WHERE warehouse_type = 'distribution_center';

-- ===== FULFILLMENT ROUTING RULES =====
CREATE TABLE IF NOT EXISTS fulfillment_routing_rules (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, -- NULL = all channels
  match_type VARCHAR(20) NOT NULL, -- location_id, sku_prefix, tag, country, default
  match_value VARCHAR(255), -- NULL for 'default' type
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0, -- Higher = evaluated first
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_channel ON fulfillment_routing_rules(channel_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_warehouse ON fulfillment_routing_rules(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_active ON fulfillment_routing_rules(is_active, priority DESC);

-- ===== ORDER WAREHOUSE ASSIGNMENT =====
ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_warehouse_id ON orders(warehouse_id);

-- Backfill existing orders to default warehouse
UPDATE orders SET warehouse_id = (
  SELECT id FROM warehouses WHERE is_default = 1 LIMIT 1
) WHERE warehouse_id IS NULL;

-- ===== SLA TRACKING =====
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sla_status VARCHAR(20);
