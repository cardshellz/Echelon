-- Reverse migration 064: drop chk_oms_fulfillment_order_id_not_null
--
-- Plan ref: shipstation-flow-refactor-plan.md §6 Commit 32.
--
-- Idempotent. Drops the NOT VALID check constraint added by 064.
-- After this runs, NULL writes to wms.orders.oms_fulfillment_order_id
-- are again accepted at the DB level (the C9 application-level
-- invariant in insertWmsOrder still applies).

ALTER TABLE wms.orders
  DROP CONSTRAINT IF EXISTS chk_oms_fulfillment_order_id_not_null;
