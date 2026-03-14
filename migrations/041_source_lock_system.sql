-- Migration 041: Source Lock System
-- Per-field-type, per-channel sync direction control
-- Locked = Echelon → channel only (channel edits overwritten)
-- Unlocked = 2-way sync (channel edits flow back to Echelon)

CREATE TABLE IF NOT EXISTS source_lock_config (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  field_type VARCHAR(30) NOT NULL, -- 'inventory', 'pricing', 'title', 'description', 'images', 'variants'
  is_locked INTEGER NOT NULL DEFAULT 1, -- 1 = Echelon-only (1-way push), 0 = 2-way sync
  locked_by VARCHAR(100), -- who changed the lock status
  locked_at TIMESTAMP DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(channel_id, field_type)
);

-- Seed default lock config for field types that are ALWAYS locked
-- These will be inserted per-channel when a channel is created
-- For now, create a comment documenting the defaults:
-- inventory: ALWAYS locked (1-way push)
-- pricing: ALWAYS locked (1-way push)  
-- variants: ALWAYS locked (1-way push)
-- title: DEFAULT unlocked (2-way sync)
-- description: DEFAULT unlocked (2-way sync)
-- images: DEFAULT locked (1-way push)

CREATE INDEX IF NOT EXISTS source_lock_config_channel_idx ON source_lock_config(channel_id);
