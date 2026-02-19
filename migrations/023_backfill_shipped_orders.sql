-- Migration 023: Backfill stuck orders to shipped
--
-- Hundreds of orders are stuck at ready/in_progress in the orders table
-- despite being fulfilled in Shopify. Root cause: inventory deduction failures
-- in the pick flow silently reverted item completions, preventing
-- updateOrderProgress() from firing, so warehouse_status never transitioned.
--
-- Additionally, syncOrderUpdate() only copied fulfillment_status to
-- shopify_fulfillment_status but never transitioned warehouse_status.
-- That gap is now fixed in code (orderSyncListener.ts), but existing
-- stuck orders need a one-time backfill.

BEGIN;

UPDATE orders o
SET warehouse_status = 'shipped',
    updated_at = NOW()
FROM shopify_orders so
WHERE o.source_table_id = so.id::text
  AND so.fulfillment_status = 'fulfilled'
  AND o.warehouse_status IN ('ready', 'in_progress');

COMMIT;
