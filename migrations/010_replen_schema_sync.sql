-- Migration 010: Sync replen tables with schema.ts
-- Adds missing columns that were in schema but not pushed to DB

-- replen_rules: add missing columns
ALTER TABLE replen_rules ADD COLUMN IF NOT EXISTS pick_location_type VARCHAR(30);
ALTER TABLE replen_rules ADD COLUMN IF NOT EXISTS source_location_type VARCHAR(30);
ALTER TABLE replen_rules ADD COLUMN IF NOT EXISTS source_priority VARCHAR(20);

-- replen_tasks: add missing execution_mode column
ALTER TABLE replen_tasks ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) NOT NULL DEFAULT 'queue';
