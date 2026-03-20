-- =============================================================================
-- Diagnostic: Find ALL products with pending order items but no reserve txn
-- =============================================================================
-- Run this FIRST to see the full scope before fixing anything.

-- 1. All SKUs with unreserved pending order items
SELECT 
  oi.sku,
  COUNT(DISTINCT oi.id) AS unreserved_items,
  COUNT(DISTINCT oi.order_id) AS affected_orders,
  SUM(oi.quantity) AS total_units_needed
FROM order_items oi
WHERE oi.status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM inventory_transactions it 
    WHERE it.order_item_id = oi.id 
      AND it.transaction_type = 'reserve'
  )
GROUP BY oi.sku
ORDER BY unreserved_items DESC;

-- 2. Specifically the EG-SLV-PF-P100 orphans
SELECT oi.id, oi.order_id, oi.sku, oi.quantity
FROM order_items oi
WHERE oi.sku = 'EG-SLV-PF-P100' 
  AND oi.status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM inventory_transactions it 
    WHERE it.order_item_id = oi.id 
      AND it.transaction_type = 'reserve'
  )
ORDER BY oi.order_id;
