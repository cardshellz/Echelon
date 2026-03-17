-- Migration 044: eBay OAuth Tokens Table
-- Stores rotating OAuth2 tokens for eBay channel integration.
-- eBay refresh tokens change on every refresh — must persist new token immediately.

CREATE TABLE IF NOT EXISTS ebay_oauth_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  environment VARCHAR(20) NOT NULL DEFAULT 'production',
  access_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMP NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_token_expires_at TIMESTAMP,
  scopes TEXT,
  last_refreshed_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- One token set per channel + environment
CREATE UNIQUE INDEX IF NOT EXISTS ebay_oauth_tokens_channel_env_idx
  ON ebay_oauth_tokens(channel_id, environment);

-- Index for quick lookups by channel
CREATE INDEX IF NOT EXISTS ebay_oauth_tokens_channel_idx
  ON ebay_oauth_tokens(channel_id);
