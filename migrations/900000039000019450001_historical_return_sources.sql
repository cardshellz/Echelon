-- Read-only identity resolution. Never repair historical outbound orders/items
-- merely to receive a return. Native IDs are scoped by channel; SKU is not identity.
CREATE VIEW returns.customer_return_source_items AS
SELECT oo.id AS oms_order_id, ol.id AS oms_order_line_id,
  wi.id AS wms_order_item_id, wo.id AS wms_order_id,
  wi.fulfilled_quantity, wi.quantity,
  CASE WHEN wi.oms_order_line_id IS NOT NULL THEN 'canonical' ELSE 'native_purchased_line' END AS identity_source
FROM wms.order_items wi
JOIN wms.orders wo ON wo.id = wi.order_id
JOIN oms.oms_orders oo ON
  wo.oms_fulfillment_order_id = oo.id::text
  OR wo.source_table_id = oo.id::text
  OR (wo.channel_id = oo.channel_id AND wo.source = 'shopify'
    AND regexp_replace(COALESCE(wo.external_order_id, wo.source_table_id), '^gid://shopify/Order/', '')
      = regexp_replace(oo.external_order_id, '^gid://shopify/Order/', ''))
JOIN oms.oms_order_lines ol ON ol.order_id = oo.id AND
  (wi.oms_order_line_id = ol.id OR (wi.oms_order_line_id IS NULL
    AND regexp_replace(COALESCE(wi.shopify_line_item_id, wi.source_item_id), '^gid://shopify/LineItem/', '')
      = regexp_replace(ol.external_line_item_id, '^gid://shopify/LineItem/', '')))
WHERE (wo.channel_id IS NULL OR wo.channel_id = oo.channel_id)
  AND (wo.oms_fulfillment_order_id IS NULL OR wo.oms_fulfillment_order_id = oo.id::text)
  AND (wo.source_table_id IS NULL OR wo.source_table_id=oo.id::text
    OR regexp_replace(wo.source_table_id, '^gid://shopify/Order/', '')
      = regexp_replace(oo.external_order_id, '^gid://shopify/Order/', ''))
  AND (wo.external_order_id IS NULL OR regexp_replace(wo.external_order_id, '^gid://shopify/Order/', '')
    = regexp_replace(oo.external_order_id, '^gid://shopify/Order/', ''))
  AND (wi.shopify_line_item_id IS NULL OR regexp_replace(wi.shopify_line_item_id, '^gid://shopify/LineItem/', '')
    = regexp_replace(ol.external_line_item_id, '^gid://shopify/LineItem/', ''))
  AND (wi.oms_order_line_id IS NOT NULL OR wo.oms_fulfillment_order_id=oo.id::text OR NOT EXISTS (
    SELECT 1 FROM oms.oms_orders other WHERE other.channel_id=oo.channel_id AND other.id<>oo.id
      AND regexp_replace(other.external_order_id, '^gid://shopify/Order/', '')
        = regexp_replace(oo.external_order_id, '^gid://shopify/Order/', '')
  ));

CREATE OR REPLACE FUNCTION returns.guard_customer_return_authorization_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'customer_return_authorizations' THEN
    IF NOT EXISTS (SELECT 1 FROM oms.oms_orders WHERE id=NEW.oms_order_id AND channel_id=NEW.channel_id) THEN
      RAISE EXCEPTION 'Authorization source channel does not match its OMS order' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'customer_return_authorization_lines' THEN
    IF NOT EXISTS (SELECT 1 FROM returns.customer_return_authorizations a JOIN oms.oms_order_lines ol ON ol.order_id=a.oms_order_id
      WHERE a.id=NEW.authorization_id AND ol.id=NEW.oms_order_line_id AND ol.external_line_item_id=NEW.external_line_item_id) THEN
      RAISE EXCEPTION 'Authorization line does not match its OMS source' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (SELECT count(*) FROM returns.customer_return_authorization_lines al
      JOIN returns.customer_return_authorizations a ON a.id=al.authorization_id
      JOIN returns.customer_return_source_items s ON s.oms_order_id=a.oms_order_id
        AND s.oms_order_line_id=al.oms_order_line_id AND s.wms_order_item_id=NEW.wms_order_item_id
      WHERE al.id=NEW.authorization_line_id AND al.authorization_id=NEW.authorization_id) <> 1 THEN
      RAISE EXCEPTION 'Authorization allocation does not match its purchased-line source' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
