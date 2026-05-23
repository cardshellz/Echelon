-- Per-channel fulfillment SLA (business days).
--
-- Until now SLA days could only be configured on partner_profiles, which
-- exists 1:1 only for partner channels (dropship/wholesale) and requires a
-- company_name. Internal channels (Shopify, eBay) had no place to store an
-- SLA, so they all fell through to the global priority.sla_default_days (3).
--
-- This adds an SLA-days column directly to channels so ANY channel can set
-- its own SLA. NULL = use the global default. The resolution order in
-- sla-monitor.setSLAForOrder becomes:
--   1. platform ship-by date (e.g. eBay shipByDate) -- hard commitment, wins
--   2. channels.sla_days                            -- this column
--   3. partner_profiles.sla_days                    -- back-compat for partners
--   4. priority.sla_default_days                    -- global fallback
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No default -> existing rows stay NULL
-- and keep their current (global-default) behavior until an admin sets a value.

ALTER TABLE channels.channels
  ADD COLUMN IF NOT EXISTS sla_days integer;
