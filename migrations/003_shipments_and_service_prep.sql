-- ============================================================================
-- Migration 003: Shipments & Service Prep
-- Date: 2026-02-07
-- Description: Add shipments and shipment_items tables to track fulfillment
--              from warehouse through carrier delivery. Also adds shipment_id
--              reference to inventory_transactions for ship-type audit trail.
-- ============================================================================

BEGIN;

-- ============================================================================
-- STEP 1: CREATE SHIPMENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id INTEGER REFERENCES orders(id),
  channel_id INTEGER REFERENCES channels(id),
  external_fulfillment_id VARCHAR(200),  -- Shopify fulfillment ID or external reference
  source VARCHAR(30) NOT NULL DEFAULT 'shopify_webhook',  -- shopify_webhook, manual, api
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, packed, shipped, delivered
  carrier VARCHAR(100),
  tracking_number VARCHAR(200),
  tracking_url TEXT,
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- STEP 2: CREATE SHIPMENT_ITEMS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS shipment_items (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id INTEGER REFERENCES order_items(id),
  product_variant_id INTEGER REFERENCES product_variants(id),
  qty INTEGER NOT NULL DEFAULT 1,
  from_location_id INTEGER REFERENCES warehouse_locations(id),  -- which bin it was picked from
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- STEP 3: ADD SHIPMENT_ID TO INVENTORY_TRANSACTIONS
-- ============================================================================

ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS shipment_id INTEGER
  REFERENCES shipments(id);

-- ============================================================================
-- STEP 4: ADD INDEXES ON ALL FK COLUMNS
-- ============================================================================

-- shipments FK indexes
CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_channel_id ON shipments(channel_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_external_fulfillment_id ON shipments(external_fulfillment_id);
CREATE INDEX IF NOT EXISTS idx_shipments_created_at ON shipments(created_at);

-- shipment_items FK indexes
CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment_id ON shipment_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_order_item_id ON shipment_items(order_item_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_product_variant_id ON shipment_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_from_location_id ON shipment_items(from_location_id);

-- inventory_transactions shipment_id index
CREATE INDEX IF NOT EXISTS idx_inv_txn_shipment_id ON inventory_transactions(shipment_id);

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shipments') THEN
    RAISE EXCEPTION 'shipments table was not created!';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shipment_items') THEN
    RAISE EXCEPTION 'shipment_items table was not created!';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_transactions' AND column_name = 'shipment_id') THEN
    RAISE EXCEPTION 'shipment_id column was not added to inventory_transactions!';
  END IF;
  RAISE NOTICE 'Migration 003 verified: shipments, shipment_items created, shipment_id added to inventory_transactions.';
END $$;

COMMIT;
