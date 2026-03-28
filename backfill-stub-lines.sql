-- Backfill stub line items for orders missing lines where no raw_payload data exists
-- These orders were ingested without line item data, but have already been fulfilled
-- Create a single stub line item with order totals as a placeholder

-- This preserves data integrity while acknowledging we can't recover the actual line items
INSERT INTO oms_order_lines (
  order_id,
  sku,
  title,
  quantity,
  paid_price_cents,
  total_price_cents,
  total_discount_cents,
  created_at,
  updated_at
)
SELECT 
  o.id,
  'UNKNOWN',
  'Order items (data lost)',
  1,
  o.total_cents,
  o.total_cents,
  0,
  NOW(),
  NOW()
FROM oms_orders o
LEFT JOIN oms_order_lines ol ON ol.order_id = o.id
WHERE ol.id IS NULL
  AND (o.raw_payload IS NULL OR (o.raw_payload->'line_items' IS NULL AND o.raw_payload->'lineItems' IS NULL));

-- Verify
SELECT 
  'After stub backfill' as status,
  COUNT(*) as orders_missing_lines
FROM oms_orders o
LEFT JOIN oms_order_lines ol ON ol.order_id = o.id
WHERE ol.id IS NULL;
