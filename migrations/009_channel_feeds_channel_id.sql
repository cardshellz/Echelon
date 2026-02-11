-- Migration 009: Add channel_id FK to channel_feeds
-- Enables per-channel credential resolution for inventory sync

ALTER TABLE channel_feeds
  ADD COLUMN channel_id INTEGER REFERENCES channels(id);
