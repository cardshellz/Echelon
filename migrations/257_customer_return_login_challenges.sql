-- Short-lived browser-bound authentication challenges. No customer access is enabled.
CREATE TABLE IF NOT EXISTS returns.customer_login_challenges (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  shop_domain text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT customer_login_challenge_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CONSTRAINT customer_login_challenge_consumed CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at))
);
CREATE INDEX IF NOT EXISTS customer_login_challenge_expiry_idx ON returns.customer_login_challenges(expires_at);
