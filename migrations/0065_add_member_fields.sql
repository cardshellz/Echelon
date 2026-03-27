-- Add member tier for historical snapshot (analytics)
-- Other member data retrieved via JOIN when needed
ALTER TABLE oms_orders
ADD COLUMN IF NOT EXISTS member_tier VARCHAR(50);

COMMENT ON COLUMN oms_orders.member_tier IS 'Member tier at time of order (historical snapshot): shellz.core, shellz.pro, shellz.ops';
