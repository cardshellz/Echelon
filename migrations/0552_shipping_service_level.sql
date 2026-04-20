-- 0552_shipping_service_level.sql
-- Add normalized shipping_service_level column. Idempotent — safe to re-run.
-- NOTE: no code references this column yet. Drizzle schema updates come
-- in a SEPARATE follow-up deploy after this migration is verified in prod.

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS shipping_service_level VARCHAR(20) NOT NULL DEFAULT 'standard';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_service_level VARCHAR(20) NOT NULL DEFAULT 'standard';

CREATE INDEX IF NOT EXISTS idx_orders_shipping_service_level
  ON orders(shipping_service_level);
CREATE INDEX IF NOT EXISTS idx_oms_orders_shipping_service_level
  ON oms.oms_orders(shipping_service_level);

-- Plan priority_modifier cleanup.
-- Default was 5 on every plan including free .core, causing every member
-- (even free tier) to bump pick priority. Set sensible per-tier values
-- and flip default to 0 so future plans must opt in.
UPDATE membership.plans SET priority_modifier = 0   WHERE LOWER(name) IN ('core', '.core');
UPDATE membership.plans SET priority_modifier = 50  WHERE LOWER(name) IN ('club', '.club');
UPDATE membership.plans SET priority_modifier = 50  WHERE LOWER(name) IN ('hobby', '.hobby');
UPDATE membership.plans SET priority_modifier = 100 WHERE LOWER(name) IN ('ops', '.ops');

ALTER TABLE membership.plans
  ALTER COLUMN priority_modifier SET DEFAULT 0;
