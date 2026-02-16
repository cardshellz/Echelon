-- Migration 017: Move picking operational settings from echelon_settings to warehouse_settings
-- These were previously global key-value pairs; now they're per-warehouse columns.

ALTER TABLE warehouse_settings ADD COLUMN IF NOT EXISTS picking_batch_size INTEGER NOT NULL DEFAULT 20;
ALTER TABLE warehouse_settings ADD COLUMN IF NOT EXISTS auto_release_delay_minutes INTEGER NOT NULL DEFAULT 30;
