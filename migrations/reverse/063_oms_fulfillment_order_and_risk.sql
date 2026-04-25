-- Reverse migration: 063_oms_fulfillment_order_and_risk
-- Reverses migrations/063_oms_fulfillment_order_and_risk.sql.
--
-- Plan reference: shipstation-flow-refactor-plan.md §6 Group E,
--   Commit 22a. See forward migration for context (Overlord decisions
--   D2/D3/D4).
--
-- !!! DATA-LOSS WARNING !!!
--   Dropping these columns permanently destroys:
--     1. Stored Shopify fulfillment-order line item IDs
--        (shopify_fulfillment_order_id,
--         shopify_fulfillment_order_line_item_id on oms.oms_order_lines).
--        Without these, C22c falls back to live Shopify queries
--        (Path B) for every push — slower, rate-limited, and breaks
--        the self-healing back-write loop (D4).
--     2. Shopify fraud / risk assessment capture
--        (risk_level, risk_score, risk_recommendation, risk_facts on
--         oms.oms_orders). Once dropped, historical risk context is
--        gone — fraud reporting / behavior gating in later commits
--        cannot recover it from local state.
--
--   - SAFE to run at this commit: C22a is schema-only, no writer
--     exists yet, so all 6 columns are guaranteed empty.
--   - DANGEROUS once C22b lands: C22b populates these columns at
--     OMS ingest from Shopify webhooks. Running this reverse after
--     that point loses every order's risk assessment and every
--     line's stored FO linkage permanently — both must be re-fetched
--     from Shopify (risk: only for live orders; FO linkage: per push).
--
-- Idempotent: DROP COLUMN IF EXISTS, safe to re-run.

-- ============================================================================
-- oms.oms_orders — drop fraud / risk columns
-- ============================================================================

ALTER TABLE oms.oms_orders
  DROP COLUMN IF EXISTS risk_facts;

ALTER TABLE oms.oms_orders
  DROP COLUMN IF EXISTS risk_recommendation;

ALTER TABLE oms.oms_orders
  DROP COLUMN IF EXISTS risk_score;

ALTER TABLE oms.oms_orders
  DROP COLUMN IF EXISTS risk_level;

-- ============================================================================
-- oms.oms_order_lines — drop Shopify fulfillment-order linkage columns
-- ============================================================================

ALTER TABLE oms.oms_order_lines
  DROP COLUMN IF EXISTS shopify_fulfillment_order_line_item_id;

ALTER TABLE oms.oms_order_lines
  DROP COLUMN IF EXISTS shopify_fulfillment_order_id;
