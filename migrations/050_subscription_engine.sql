-- 050_subscription_engine.sql
-- Native Shopify subscription engine — replacing Appstle

-- Extend plans table
ALTER TABLE plans ADD COLUMN IF NOT EXISTS shopify_selling_plan_id BIGINT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS shopify_selling_plan_gid VARCHAR(100);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(20);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_interval_count INTEGER DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'standard';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS includes_dropship BOOLEAN DEFAULT false;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Extend member_subscriptions table
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS shopify_subscription_contract_id BIGINT;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS shopify_subscription_contract_gid VARCHAR(100);
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS billing_status VARCHAR(30) DEFAULT 'current';
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS failed_billing_attempts INTEGER DEFAULT 0;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS billing_in_progress BOOLEAN DEFAULT false;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS payment_method_id VARCHAR(100);
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS revision_id VARCHAR(50);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ms_shopify_contract
  ON member_subscriptions(shopify_subscription_contract_id)
  WHERE shopify_subscription_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ms_next_billing
  ON member_subscriptions(next_billing_date)
  WHERE billing_status IN ('current', 'past_due') AND billing_in_progress = false;

-- Extend members table
ALTER TABLE members ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'standard';

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_shopify_customer
  ON members(shopify_customer_id)
  WHERE shopify_customer_id IS NOT NULL;

-- New table: subscription_billing_log
CREATE TABLE IF NOT EXISTS subscription_billing_log (
  id SERIAL PRIMARY KEY,
  member_subscription_id INTEGER NOT NULL REFERENCES member_subscriptions(id),
  shopify_billing_attempt_id VARCHAR(100),
  shopify_order_id BIGINT,
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(30) NOT NULL,
  error_code VARCHAR(100),
  error_message TEXT,
  idempotency_key VARCHAR(200),
  billing_period_start TIMESTAMP,
  billing_period_end TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sbl_subscription ON subscription_billing_log(member_subscription_id);
CREATE INDEX IF NOT EXISTS idx_sbl_status ON subscription_billing_log(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sbl_idempotency ON subscription_billing_log(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- New table: subscription_events (audit trail)
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  member_subscription_id INTEGER REFERENCES member_subscriptions(id),
  shopify_subscription_contract_id BIGINT,
  event_type VARCHAR(50) NOT NULL,
  event_source VARCHAR(30) NOT NULL,
  payload JSONB,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_se_subscription ON subscription_events(member_subscription_id);
CREATE INDEX IF NOT EXISTS idx_se_contract ON subscription_events(shopify_subscription_contract_id);
CREATE INDEX IF NOT EXISTS idx_se_type ON subscription_events(event_type);

-- New table: selling_plan_map
CREATE TABLE IF NOT EXISTS selling_plan_map (
  id SERIAL PRIMARY KEY,
  shopify_selling_plan_gid VARCHAR(100) NOT NULL UNIQUE,
  shopify_selling_plan_group_gid VARCHAR(100) NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  plan_name VARCHAR(100) NOT NULL,
  billing_interval VARCHAR(20) NOT NULL,
  price_cents INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
