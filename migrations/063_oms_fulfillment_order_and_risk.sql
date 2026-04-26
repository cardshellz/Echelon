-- Migration: 063_oms_fulfillment_order_and_risk
-- Adds Shopify fulfillment-order linkage columns to oms.oms_order_lines,
-- and Shopify fraud/risk capture columns to oms.oms_orders.
--
-- Plan reference: shipstation-flow-refactor-plan.md §6 Group E,
--   Commit 22a (this migration). Driven by Overlord decisions:
--     D2 — Path A (stored FO line item IDs) is the primary resolution
--          path for Shopify fulfillment pushes (C22c).
--     D3 — Capture Shopify fraud/risk data at OMS ingest (no behavior
--          gating yet; collected for future commits / reports).
--     D4 — Self-healing: Path B (live Shopify query) writes back into
--          the stored FO line item ID columns when found.
--
-- Purpose:
--   1. oms.oms_order_lines:
--        Add shopify_fulfillment_order_id and
--        shopify_fulfillment_order_line_item_id (Shopify GIDs, e.g.
--        gid://shopify/FulfillmentOrder/12345 and
--        gid://shopify/FulfillmentOrderLineItem/67890). C22b will
--        populate these at ingest. C22c (pushShopifyFulfillment) will
--        prefer them over a live Shopify query.
--   2. oms.oms_orders:
--        Add risk_level, risk_score, risk_recommendation, risk_facts.
--        C22b will populate these from the Shopify orders/create
--        (and orders/updated) webhook payloads. NULL for non-Shopify
--        channels.
--
-- Safety notes:
--   - All columns are NULLABLE and additive (ADD COLUMN IF NOT EXISTS).
--   - No data backfill in this migration. Historical orders/lines stay
--     NULL. C22b populates new ingests going forward.
--   - No reader and no writer in this commit: the columns are
--     completely inert until C22b lands. Zero behavior change here.
--   - Idempotent: re-running this migration is a no-op.
--   - Data risk: zero.
--
-- Reverse migration: migrations/reverse/063_oms_fulfillment_order_and_risk.sql
--   Drops all 6 columns with IF EXISTS. Safe to run now (no writer);
--   dangerous once C22b is live (will discard captured risk + FO
--   linkage data).

-- ============================================================================
-- oms.oms_order_lines — Shopify fulfillment-order linkage (D2/D4)
-- ============================================================================

ALTER TABLE oms.oms_order_lines
  ADD COLUMN IF NOT EXISTS shopify_fulfillment_order_id varchar(100);

ALTER TABLE oms.oms_order_lines
  ADD COLUMN IF NOT EXISTS shopify_fulfillment_order_line_item_id varchar(100);

-- ============================================================================
-- oms.oms_orders — Shopify fraud / risk capture (D3)
-- ============================================================================

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS risk_level varchar(20);

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS risk_score numeric(5, 4);

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS risk_recommendation varchar(20);

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS risk_facts jsonb;
