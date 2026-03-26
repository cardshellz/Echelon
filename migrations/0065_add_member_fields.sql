-- Add Shellz Club member enrichment fields to oms_orders
ALTER TABLE oms_orders
ADD COLUMN IF NOT EXISTS member_id INTEGER,
ADD COLUMN IF NOT EXISTS member_email VARCHAR(255),
ADD COLUMN IF NOT EXISTS member_tier VARCHAR(50),
ADD COLUMN IF NOT EXISTS rewards_earned_cents INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS member_discount_cents INTEGER DEFAULT 0;

COMMENT ON COLUMN oms_orders.member_id IS 'Shellz Club member ID (from shellz-club-app members table)';
COMMENT ON COLUMN oms_orders.member_email IS 'Member email (for lookup/debugging)';
COMMENT ON COLUMN oms_orders.member_tier IS 'Member tier: shellz.core, shellz.pro, shellz.ops';
COMMENT ON COLUMN oms_orders.rewards_earned_cents IS 'Rewards points earned on this order (cents)';
COMMENT ON COLUMN oms_orders.member_discount_cents IS 'Member discount applied (cents)';
