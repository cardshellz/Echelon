-- Path C, Phase 0: channel-agnostic customer identity on oms_orders.
-- external_customer_id = the customer's id IN the source channel (Shopify
-- customer id, eBay buyer username, future own-site user id, ...), interpreted
-- via channel_id — mirrors the (channel_id, external_order_id) pattern. NOT
-- Shopify-specific. It is the stable key for membership resolution and for
-- WMS pick-priority's live membership join. Additive + idempotent.

ALTER TABLE oms.oms_orders ADD COLUMN IF NOT EXISTS external_customer_id VARCHAR(100);

-- Backfill existing rows from the stored raw payload, only where NULL.
-- Shopify orders: raw_payload.customer.id ; eBay orders: raw_payload.buyer.username.
UPDATE oms.oms_orders
SET external_customer_id = raw_payload->'customer'->>'id'
WHERE external_customer_id IS NULL
  AND raw_payload->'customer'->>'id' IS NOT NULL;

UPDATE oms.oms_orders
SET external_customer_id = raw_payload->'buyer'->>'username'
WHERE external_customer_id IS NULL
  AND raw_payload->'buyer'->>'username' IS NOT NULL;

-- Supports member resolution + pick-priority lookups by (channel, customer).
CREATE INDEX IF NOT EXISTS idx_oms_orders_channel_customer
  ON oms.oms_orders (channel_id, external_customer_id)
  WHERE external_customer_id IS NOT NULL;
