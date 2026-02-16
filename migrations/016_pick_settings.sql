-- Migration 016: Add picking workflow settings to warehouse_settings
-- These columns control post-pick behavior, pick mode, and scan requirements per warehouse.

ALTER TABLE warehouse_settings ADD COLUMN IF NOT EXISTS post_pick_status VARCHAR(30) NOT NULL DEFAULT 'ready_to_ship';
ALTER TABLE warehouse_settings ADD COLUMN IF NOT EXISTS pick_mode VARCHAR(20) NOT NULL DEFAULT 'single_order';
ALTER TABLE warehouse_settings ADD COLUMN IF NOT EXISTS require_scan_confirm INTEGER NOT NULL DEFAULT 0;
