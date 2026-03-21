-- Add floor_type to channel_allocation_rules for "days of cover" mode
ALTER TABLE channel_allocation_rules ADD COLUMN IF NOT EXISTS floor_type VARCHAR(10) DEFAULT 'units';
