ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS ship_to_company VARCHAR(200);

ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS shipping_company TEXT,
  ADD COLUMN IF NOT EXISTS shipping_address2 TEXT;

UPDATE oms.oms_orders
SET ship_to_company = NULLIF(raw_payload->'shipping_address'->>'company', '')
WHERE ship_to_company IS NULL
  AND raw_payload IS NOT NULL
  AND raw_payload->'shipping_address'->>'company' IS NOT NULL;

UPDATE wms.orders w
SET
  shipping_company = COALESCE(w.shipping_company, o.ship_to_company),
  shipping_address2 = COALESCE(w.shipping_address2, o.ship_to_address2)
FROM oms.oms_orders o
WHERE w.source = 'oms'
  AND w.oms_fulfillment_order_id = o.id::text
  AND (
    (w.shipping_company IS NULL AND o.ship_to_company IS NOT NULL)
    OR (w.shipping_address2 IS NULL AND o.ship_to_address2 IS NOT NULL)
  );
