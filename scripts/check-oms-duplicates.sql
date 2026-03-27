-- Find duplicate orders in oms_orders
SELECT 
  channel_id,
  external_order_id,
  COUNT(*) as duplicate_count,
  ARRAY_AGG(id ORDER BY created_at) as order_ids,
  ARRAY_AGG(created_at ORDER BY created_at) as created_dates,
  ARRAY_AGG(status ORDER BY created_at) as statuses
FROM oms_orders
GROUP BY channel_id, external_order_id
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, channel_id, external_order_id;
