-- 0732: the `inherit` price mode for one size (Listing settings design M1,
-- PR 7; owner decisions A3 and L1, 2026-10-09).
--
-- A size saved as `inherit` has no price of its own. It takes the price the
-- store's pricing rules give it (a group rule that matches, else the store
-- default). When the rules give it no price (the store has none, two group
-- rules tie, or the rule has no cost to start from), it uses the Card Shellz
-- retail price. It never falls back to the price an earlier push saved on
-- the listing.
--
-- Only the allowed values change. Like `rules` and `catalog_default`,
-- `inherit` carries no price; the existing coherence check already says only
-- `fixed` has one. Existing rows are untouched and stay valid. Legacy null
-- modes keep their meaning (0659: a null price is catalog default, a price
-- is fixed).
--
-- Triggers need no change: the setting coherence trigger (0659) compares the
-- mode of a setting with its revision whatever the value, and the revision
-- immutability trigger (0657) fires on row UPDATE and DELETE only.
--
-- Lock: ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on each table and
-- scans it once inside the release transaction, so a price save on an old
-- dyno waits for it. The tables hold one row per priced size and store.
--
-- The release executor owns the transaction. Re-runnable: each check is
-- dropped if present and added again.

ALTER TABLE dropship.dropship_listing_price_revisions
  DROP CONSTRAINT IF EXISTS listing_price_revision_mode_chk;
ALTER TABLE dropship.dropship_listing_price_revisions
  ADD CONSTRAINT listing_price_revision_mode_chk CHECK
  (pricing_mode IS NULL OR (pricing_mode IN ('fixed','catalog_default','rules','inherit') AND
    ((pricing_mode = 'fixed') = (override_price_cents IS NOT NULL))));

ALTER TABLE dropship.dropship_listing_price_settings
  DROP CONSTRAINT IF EXISTS listing_price_setting_mode_chk;
ALTER TABLE dropship.dropship_listing_price_settings
  ADD CONSTRAINT listing_price_setting_mode_chk CHECK
  (pricing_mode IS NULL OR (pricing_mode IN ('fixed','catalog_default','rules','inherit') AND
    ((pricing_mode = 'fixed') = (override_price_cents IS NOT NULL))));
