-- Clean up duplicate orders caused by webhook race condition
-- Keeps the EARLIEST created order for each shopify_order_id

-- First, see what we're about to delete
SELECT 
  order_number,
  COUNT(*) as duplicate_count,
  array_agg(id ORDER BY created_at) as order_ids,
  array_agg(created_at::text ORDER BY created_at) as created_times
FROM orders 
WHERE source = 'shopify'
  AND shopify_order_id IS NOT NULL
GROUP BY order_number 
HAVING COUNT(*) > 1
ORDER BY order_number;

-- To execute the cleanup, uncomment this:
/*
DELETE FROM order_items 
WHERE order_id IN (
  SELECT id FROM (
    SELECT id, 
      ROW_NUMBER() OVER (PARTITION BY shopify_order_id ORDER BY created_at ASC) as rn
    FROM orders
    WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
  ) t
  WHERE rn > 1
);

DELETE FROM orders 
WHERE id IN (
  SELECT id FROM (
    SELECT id, 
      ROW_NUMBER() OVER (PARTITION BY shopify_order_id ORDER BY created_at ASC) as rn
    FROM orders
    WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
  ) t
  WHERE rn > 1
);
*/
