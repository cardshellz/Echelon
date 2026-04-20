-- 0554_priority_fields_fix_wms_schema.sql
-- Fixup: migrations 0552 and 0553 used unqualified ALTER TABLE orders.
-- That resolved to public.orders instead of the intended wms.orders.
-- This migration (a) adds the columns to wms.orders where they belong,
-- and (b) removes the stray columns that landed on public.orders.
-- Idempotent.

-- 1. Add to the correct table.
ALTER TABLE wms.orders
  ADD COLUMN IF NOT EXISTS shipping_service_level VARCHAR(20) NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS member_plan_name       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS member_plan_color      VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_wms_orders_shipping_service_level
  ON wms.orders(shipping_service_level);
CREATE INDEX IF NOT EXISTS idx_wms_orders_member_plan_name
  ON wms.orders(member_plan_name);

-- 2. Clean up stray columns that landed on public.orders by mistake.
ALTER TABLE public.orders
  DROP COLUMN IF EXISTS shipping_service_level,
  DROP COLUMN IF EXISTS member_plan_name,
  DROP COLUMN IF EXISTS member_plan_color;
