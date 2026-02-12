-- Add auto_replen flag to tier defaults and rules
-- When enabled, the system auto-executes replen tasks immediately (no worker needed)
-- Useful for pick-to-pick replenishment where the picker handles it automatically

ALTER TABLE replen_tier_defaults ADD COLUMN IF NOT EXISTS auto_replen integer NOT NULL DEFAULT 0;
ALTER TABLE replen_rules ADD COLUMN IF NOT EXISTS auto_replen integer;
