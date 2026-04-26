-- Migration 065: unique index on oms.oms_orders (channel_id, external_order_number)
--
-- Plan ref: shipstation-flow-refactor-plan.md §6 Commit 33.
--
-- Purpose: prevent duplicate OMS rows for the same Shopify order via
-- unique-key enforcement. Diagnostic queries on 2026-04-23 found ~10
-- known duplicates (orders like #55521 ingested twice). Those must be
-- de-duplicated BEFORE this index is created.
--
-- Pre-flight (REQUIRED before running this migration):
--   heroku run -a cardshellz-echelon -- "npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts"
--   # review output, then
--   heroku run -a cardshellz-echelon -- "npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts --execute"
--
-- The migration uses CREATE UNIQUE INDEX CONCURRENTLY so it doesn't
-- lock the table. CONCURRENTLY cannot be used inside a transaction —
-- the migration runner must apply this file outside a transaction.
--
-- Idempotent: IF NOT EXISTS guard.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_oms_orders_channel_external
  ON oms.oms_orders (channel_id, external_order_number)
  WHERE external_order_number IS NOT NULL;
