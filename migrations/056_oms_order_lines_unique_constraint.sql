-- Migration 056: Add unique constraint on OMS order lines to prevent duplicate ingestion
-- Prevents race conditions where two webhooks create duplicate line items for the same order.

-- First, clean up any existing duplicates (keep the first one by ID)
DELETE FROM oms.oms_order_lines a USING oms.oms_order_lines b
WHERE a.id > b.id
  AND a.order_id = b.order_id
  AND a.external_line_item_id = b.external_line_item_id
  AND a.external_line_item_id IS NOT NULL;

-- Add unique constraint on (order_id, external_line_item_id)
-- This prevents duplicate line items from concurrent webhook processing
CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_order_lines_order_external_line
  ON oms.oms_order_lines (order_id, external_line_item_id)
  WHERE external_line_item_id IS NOT NULL;

-- Also clean up any duplicate WMS order items
DELETE FROM wms.order_items a USING wms.order_items b
WHERE a.id > b.id
  AND a.order_id = b.order_id
  AND a.source_item_id = b.source_item_id
  AND a.source_item_id IS NOT NULL;

-- Add unique constraint on WMS order items too
CREATE UNIQUE INDEX IF NOT EXISTS idx_wms_order_items_order_source_item
  ON wms.order_items (order_id, source_item_id)
  WHERE source_item_id IS NOT NULL;
