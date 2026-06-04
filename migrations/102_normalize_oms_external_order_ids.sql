-- Normalize existing oms_orders.external_order_id values that still contain
-- the Shopify Order GID prefix (gid://shopify/Order/XXXXX → XXXXX).
--
-- Before the normalizeExternalOrderId() fix was deployed, the bridge path
-- stored the full GID while the webhook path stored the bare numeric id.
-- This created duplicate OMS rows for the same Shopify order — each with its
-- own WMS order and ShipStation shipment.
--
-- Step 1: Cancel GID-format OMS duplicates where a numeric twin exists.
-- Step 2: Cancel WMS orders linked to those cancelled GID OMS orders.
-- Step 3: Cancel shipments linked to those cancelled WMS orders.
-- Step 4: Normalize remaining GID-only rows (no numeric twin) — strip prefix.

BEGIN;

-- Step 1: Mark GID-format duplicates as cancelled so they stop generating
-- WMS orders and shipments.  Only targets rows where a numeric twin exists.
UPDATE oms.oms_orders gid_row
SET status = 'cancelled',
    updated_at = NOW()
WHERE gid_row.external_order_id LIKE 'gid://shopify/Order/%'
  AND EXISTS (
    SELECT 1 FROM oms.oms_orders num_row
    WHERE num_row.channel_id = gid_row.channel_id
      AND num_row.external_order_id = split_part(gid_row.external_order_id, '/', -1)
      AND num_row.id <> gid_row.id
  )
  AND gid_row.status NOT IN ('cancelled', 'refunded');

-- Step 2: Cancel WMS orders linked to the now-cancelled GID OMS orders.
-- These are the duplicates that spawned extra ShipStation shipments.
UPDATE wms.orders o
SET warehouse_status = 'cancelled',
    updated_at = NOW()
FROM oms.oms_orders oo
WHERE o.oms_fulfillment_order_id = oo.id::text
  AND o.source = 'oms'
  AND oo.status = 'cancelled'
  AND oo.external_order_id LIKE 'gid://shopify/Order/%'
  AND o.warehouse_status NOT IN ('cancelled', 'shipped');

-- Step 3: Cancel shipments linked to those cancelled WMS orders.
UPDATE wms.outbound_shipments s
SET status = 'cancelled',
    updated_at = NOW()
FROM wms.orders o
JOIN oms.oms_orders oo ON o.oms_fulfillment_order_id = oo.id::text AND o.source = 'oms'
WHERE s.order_id = o.id
  AND oo.status = 'cancelled'
  AND oo.external_order_id LIKE 'gid://shopify/Order/%'
  AND s.status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost');

-- Step 4: Normalize GID-only rows that have NO numeric twin.
-- These are orders ingested only via the bridge — safe to strip the prefix
-- because no conflicting numeric row exists for the unique index.
UPDATE oms.oms_orders
SET external_order_id = split_part(external_order_id, '/', -1),
    updated_at = NOW()
WHERE external_order_id LIKE 'gid://shopify/Order/%'
  AND NOT EXISTS (
    SELECT 1 FROM oms.oms_orders twin
    WHERE twin.channel_id = oms_orders.channel_id
      AND twin.external_order_id = split_part(oms_orders.external_order_id, '/', -1)
      AND twin.id <> oms_orders.id
  );

COMMIT;
