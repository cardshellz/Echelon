-- Migration: 076_oms_order_line_adjustments
-- Persist marketplace line-level cancel/refund facts so OMS, WMS,
-- ShipStation, and Shopify fulfillment push can share the same active
-- ship quantity.

CREATE TABLE IF NOT EXISTS oms.order_line_adjustments (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  order_line_id BIGINT REFERENCES oms.oms_order_lines(id) ON DELETE CASCADE,
  external_line_item_id VARCHAR(100) NOT NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'shopify_webhook',
  source_event_id VARCHAR(100) NOT NULL,
  adjustment_type VARCHAR(30) NOT NULL,
  restock_policy VARCHAR(30) NOT NULL DEFAULT 'no_restock',
  quantity INTEGER NOT NULL,
  reason TEXT,
  raw_payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT order_line_adjustments_quantity_positive_chk CHECK (quantity > 0),
  CONSTRAINT order_line_adjustments_type_chk CHECK (adjustment_type IN ('refund', 'cancel')),
  CONSTRAINT order_line_adjustments_restock_policy_chk CHECK (restock_policy IN ('no_restock', 'return', 'restock', 'cancel', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS order_line_adjustments_event_line_uidx
  ON oms.order_line_adjustments(source, source_event_id, external_line_item_id, adjustment_type);

CREATE INDEX IF NOT EXISTS idx_order_line_adjustments_order
  ON oms.order_line_adjustments(order_id);

CREATE INDEX IF NOT EXISTS idx_order_line_adjustments_line
  ON oms.order_line_adjustments(order_line_id);
