-- Migration 032: Add channel sync kill switch to warehouse_settings
-- channelSyncEnabled defaults to 0 (disabled) — must be explicitly enabled when ready to push inventory

ALTER TABLE warehouse_settings
  ADD COLUMN IF NOT EXISTS channel_sync_enabled INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS channel_sync_interval_minutes INTEGER NOT NULL DEFAULT 15;
