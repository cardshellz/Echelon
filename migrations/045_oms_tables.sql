-- Migration 045: OMS (Order Management System) tables
-- Unified, channel-agnostic order model for Echelon

-- Unified orders table
CREATE TABLE IF NOT EXISTS oms_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  external_order_id VARCHAR(100) NOT NULL,
  external_order_number VARCHAR(50),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  financial_status VARCHAR(30) DEFAULT 'paid',
  fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
  customer_name VARCHAR(200),
  customer_email VARCHAR(200),
  customer_phone VARCHAR(50),
  ship_to_name VARCHAR(200),
  ship_to_address1 VARCHAR(300),
  ship_to_address2 VARCHAR(300),
  ship_to_city VARCHAR(100),
  ship_to_state VARCHAR(100),
  ship_to_zip VARCHAR(20),
  ship_to_country VARCHAR(10),
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  warehouse_id INTEGER REFERENCES warehouses(id),
  tracking_number VARCHAR(100),
  tracking_carrier VARCHAR(50),
  shipped_at TIMESTAMP,
  raw_payload JSONB,
  notes TEXT,
  tags TEXT,
  ordered_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(channel_id, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_oms_orders_status ON oms_orders(status);
CREATE INDEX IF NOT EXISTS idx_oms_orders_channel ON oms_orders(channel_id);
CREATE INDEX IF NOT EXISTS idx_oms_orders_ordered ON oms_orders(ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_orders_external ON oms_orders(external_order_id);

-- Order line items
CREATE TABLE IF NOT EXISTS oms_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
  product_variant_id INTEGER REFERENCES product_variants(id),
  external_line_item_id VARCHAR(100),
  sku VARCHAR(100),
  title VARCHAR(300),
  variant_title VARCHAR(200),
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oms_lines_order ON oms_order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_oms_lines_variant ON oms_order_lines(product_variant_id);

-- Order status history / audit trail
CREATE TABLE IF NOT EXISTS oms_order_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oms_events_order ON oms_order_events(order_id);
