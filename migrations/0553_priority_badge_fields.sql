-- 0553_priority_badge_fields.sql
-- Stamp membership plan metadata onto orders so the picker can render
-- shipping + membership badges without re-joining on every render.
-- Idempotent.
--
-- Picker badge rules (both shipping and membership visible when applicable):
--   Standard + .core        => no badges
--   Standard + .club/.ops   => membership badge only
--   Expedited + .core       => shipping badge only
--   Expedited + .club/.ops  => both badges
--
-- Fields are populated at WMS sync time, so badges reflect the customer's
-- membership state WHEN THE ORDER CAME IN. Later cancellations or upgrades
-- do not retroactively change fulfillment badges.
--
-- No code references these columns until the follow-up deploy.

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS member_plan_name  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS member_plan_color VARCHAR(20);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS member_plan_name  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS member_plan_color VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_orders_member_plan_name
  ON orders(member_plan_name);
CREATE INDEX IF NOT EXISTS idx_oms_orders_member_plan_name
  ON oms.oms_orders(member_plan_name);
