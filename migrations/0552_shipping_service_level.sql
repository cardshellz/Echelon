-- 0552_shipping_service_level.sql
-- Adds a normalized shipping_service_level concept that expresses business
-- fulfillment intent ("standard", "expedited", "overnight") independent of
-- the customer-facing shipping_method string. The shipping_method column
-- is a free-form label (zone-dependent, customer-friendly) and must NOT
-- be used for priority/routing decisions.
--
-- Today Card Shellz only offers "standard" fulfillment. The column is added
-- now so the WMS priority calculation can stop string-parsing the method
-- title (which caused USPS Priority Mail zone labels to be mis-classified
-- as customer-paid expedite). Future "expedited" / "overnight" tiers can
-- be introduced without another migration.
--
-- Backfill strategy: every existing order is treated as "standard" because
-- no expedited option has ever been offered to customers.

-- Add to oms_orders (source of truth for OMS layer)
ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS shipping_service_level VARCHAR(20) NOT NULL DEFAULT 'standard';

-- Add to orders (WMS layer) so pickers/UI can display without a join
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_service_level VARCHAR(20) NOT NULL DEFAULT 'standard';

-- Backfill any existing rows (NOT NULL DEFAULT handled new inserts; this
-- normalizes the literal "standard" value on pre-existing data explicitly).
UPDATE oms.oms_orders SET shipping_service_level = 'standard' WHERE shipping_service_level IS NULL;
UPDATE orders SET shipping_service_level = 'standard' WHERE shipping_service_level IS NULL;

-- Indexes for priority-related queries
CREATE INDEX IF NOT EXISTS idx_orders_shipping_service_level
  ON orders(shipping_service_level);
CREATE INDEX IF NOT EXISTS idx_oms_orders_shipping_service_level
  ON oms.oms_orders(shipping_service_level);

-- Plan priority modifier cleanup:
-- The membership.plans.priority_modifier column defaulted to 5, meaning
-- every plan (including the free .core tier) added +5 to every order's
-- pick priority score. That is not the intended behavior. Free tier
-- should contribute zero. Paid tiers get real boosts.
--
-- We apply a sensible default set here. Adjust values in the admin UI
-- (Subscriptions page) if different numbers are preferred.

UPDATE membership.plans SET priority_modifier = 0   WHERE LOWER(name) IN ('core', '.core');
UPDATE membership.plans SET priority_modifier = 50  WHERE LOWER(name) IN ('club', '.club');
UPDATE membership.plans SET priority_modifier = 50  WHERE LOWER(name) IN ('hobby', '.hobby');
UPDATE membership.plans SET priority_modifier = 100 WHERE LOWER(name) IN ('ops', '.ops');

-- Flip the default going forward so new plans don't silently bump priority
-- just by existing. Admin must set a value intentionally.
ALTER TABLE membership.plans
  ALTER COLUMN priority_modifier SET DEFAULT 0;
