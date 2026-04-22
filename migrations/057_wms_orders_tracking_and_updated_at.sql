-- Migration 057: Add tracking_number and updated_at to wms.orders
-- These columns are essential for shipping operations and were missing from the schema.

ALTER TABLE wms.orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(200);
ALTER TABLE wms.orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW() NOT NULL;

-- Backfill updated_at from completed_at or created_at for existing rows
UPDATE wms.orders SET updated_at = COALESCE(completed_at, created_at) WHERE updated_at = created_at;
