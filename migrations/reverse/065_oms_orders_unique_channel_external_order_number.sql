-- Reverse migration 065: drop the unique index
--
-- Plan ref: shipstation-flow-refactor-plan.md §6 Commit 33.
--
-- Idempotent.

DROP INDEX CONCURRENTLY IF EXISTS oms.uniq_oms_orders_channel_external;
