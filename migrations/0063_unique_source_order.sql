-- Add unique constraint to prevent duplicate order ingestion from webhooks
-- This enforces database-level idempotency: same source order can only be imported once

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_source_unique 
ON orders (source, source_table_id) 
WHERE source_table_id IS NOT NULL;

-- Also add index on order_number for faster lookups (not unique because eBay can reuse numbers across years)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_order_number ON orders (order_number);
