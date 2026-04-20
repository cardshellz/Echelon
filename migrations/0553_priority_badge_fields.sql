-- 0553_priority_badge_fields.sql
-- Stamp membership plan metadata onto orders so the picker can render
-- dynamic badges without re-querying membership.plans for every row.
--
-- Picker badge rules (both shipping and membership visible when applicable):
--   Standard + .core        => no badges
--   Standard + .club/.ops   => membership badge only
--   Expedited + .core       => shipping badge only
--   Expedited + .club/.ops  => both badges
--
-- Shipping always outweighs membership in sort math (enforced by the
-- relative sizes of shipping_base vs plan_modifier in wms-sync.service.ts).
--
-- These fields are stamped at WMS sync time. The stamp represents the
-- customer's membership state when the order came in; later cancellations
-- or upgrades do not retroactively change fulfillment badges.

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS member_plan_name  VARCHAR(20), -- e.g. '.core', '.club', '.ops'; null if non-member
  ADD COLUMN IF NOT EXISTS member_plan_color VARCHAR(20); -- e.g. '#4A8A3A'; snapshot of plans.primary_color at sync

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS member_plan_name  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS member_plan_color VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_orders_member_plan_name
  ON orders(member_plan_name);
CREATE INDEX IF NOT EXISTS idx_oms_orders_member_plan_name
  ON oms.oms_orders(member_plan_name);
