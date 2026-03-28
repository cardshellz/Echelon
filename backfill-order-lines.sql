-- Backfill missing oms_order_lines from raw_payload
-- Run after code fixes are deployed

-- Temporary function to parse eBay line items from raw_payload
CREATE OR REPLACE FUNCTION backfill_ebay_line_items() RETURNS void AS $$
DECLARE
  order_rec RECORD;
  line_item JSONB;
  line_item_cost NUMERIC;
  discounted_cost NUMERIC;
  qty INTEGER;
  paid_price_cents INTEGER;
  total_price_cents INTEGER;
  discount_cents INTEGER;
BEGIN
  FOR order_rec IN 
    SELECT o.id, o.raw_payload
    FROM oms_orders o
    LEFT JOIN oms_order_lines ol ON ol.order_id = o.id
    WHERE ol.id IS NULL AND o.channel_id = 67 AND o.raw_payload IS NOT NULL
  LOOP
    -- Parse each line item from raw_payload->lineItems array
    FOR line_item IN SELECT * FROM jsonb_array_elements(order_rec.raw_payload->'lineItems')
    LOOP
      -- Extract line item cost (total for this line, all units)
      line_item_cost := COALESCE((line_item->'lineItemCost'->>'value')::NUMERIC, 0);
      discounted_cost := COALESCE((line_item->'discountedLineItemCost'->>'value')::NUMERIC, line_item_cost);
      qty := COALESCE((line_item->>'quantity')::INTEGER, 1);
      
      -- Calculate per-unit price
      paid_price_cents := ROUND(line_item_cost * 100 / qty);
      total_price_cents := ROUND(line_item_cost * 100);
      discount_cents := ROUND((line_item_cost - discounted_cost) * 100);
      
      -- Insert line item
      INSERT INTO oms_order_lines (
        order_id,
        external_line_item_id,
        external_product_id,
        sku,
        title,
        quantity,
        paid_price_cents,
        total_price_cents,
        total_discount_cents,
        created_at,
        updated_at
      ) VALUES (
        order_rec.id,
        line_item->>'lineItemId',
        line_item->>'legacyItemId',
        line_item->>'sku',
        line_item->>'title',
        qty,
        paid_price_cents,
        total_price_cents,
        discount_cents,
        NOW(),
        NOW()
      );
    END LOOP;
    
    RAISE NOTICE 'Backfilled order %', order_rec.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Run the backfill for eBay orders
SELECT backfill_ebay_line_items();

-- For Shopify orders, check if raw_payload contains line_items
CREATE OR REPLACE FUNCTION backfill_shopify_line_items() RETURNS void AS $$
DECLARE
  order_rec RECORD;
  line_item JSONB;
  price NUMERIC;
  qty INTEGER;
  discount NUMERIC;
BEGIN
  FOR order_rec IN 
    SELECT o.id, o.raw_payload
    FROM oms_orders o
    LEFT JOIN oms_order_lines ol ON ol.order_id = o.id
    WHERE ol.id IS NULL AND o.channel_id = 36 AND o.raw_payload IS NOT NULL
    AND o.raw_payload->'line_items' IS NOT NULL
  LOOP
    -- Parse each line item from raw_payload->line_items array
    FOR line_item IN SELECT * FROM jsonb_array_elements(order_rec.raw_payload->'line_items')
    LOOP
      price := COALESCE((line_item->>'price')::NUMERIC, 0);
      qty := COALESCE((line_item->>'quantity')::INTEGER, 1);
      discount := COALESCE((line_item->>'total_discount')::NUMERIC, 0);
      
      -- Insert line item
      INSERT INTO oms_order_lines (
        order_id,
        external_line_item_id,
        external_product_id,
        sku,
        title,
        variant_title,
        quantity,
        paid_price_cents,
        total_price_cents,
        total_discount_cents,
        created_at,
        updated_at
      ) VALUES (
        order_rec.id,
        line_item->>'id',
        line_item->>'product_id',
        line_item->>'sku',
        line_item->>'title',
        line_item->>'variant_title',
        qty,
        ROUND(price * 100),
        ROUND(price * 100 * qty - discount * 100),
        ROUND(discount * 100),
        NOW(),
        NOW()
      );
    END LOOP;
    
    RAISE NOTICE 'Backfilled order %', order_rec.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Run the backfill for Shopify orders
SELECT backfill_shopify_line_items();

-- Verify results
SELECT 
  'After backfill' as status,
  COUNT(*) as orders_missing_lines,
  COUNT(CASE WHEN o.channel_id = 67 THEN 1 END) as ebay_missing,
  COUNT(CASE WHEN o.channel_id != 67 THEN 1 END) as shopify_missing
FROM oms_orders o
LEFT JOIN oms_order_lines ol ON ol.order_id = o.id
WHERE ol.id IS NULL;

-- Drop temporary functions
DROP FUNCTION IF EXISTS backfill_ebay_line_items();
DROP FUNCTION IF EXISTS backfill_shopify_line_items();
