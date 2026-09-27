-- 0706: the tiers the current listing tier rule found on at its last check
-- (owner decision of 2026-09-26).
--
-- One rule now decides both tiers: a tier turns on when the vendor's reserve
-- (their autopay minimum balance) and the wallet's money (balance plus
-- credits on their way) both reach the tier's amount, and it stays on while
-- the reserve still covers that amount, so a balance that dips after an order
-- or a fee does not pause listings. "Stays on" needs to know which tiers were
-- on at the last check.
--
-- held_tiers cannot answer that for rows the September rule wrote: that rule
-- kept the pack tier on with a reserve and no money. tiers_on is written only
-- by the current rule, on every decision it records (the tiers it did not
-- hold). NULL, which every existing row starts as, means the current rule has
-- not decided this vendor yet, so its first decision after deploy is made
-- from money. A dedicated column, rather than a version flag on held_tiers,
-- also keeps a September process still running during a deploy from making
-- its own decision look like the current rule's: it never writes tiers_on.
--
-- Additive and re-runnable: the column is nullable with no default, so code
-- that does not know it keeps working, and the constraint is dropped before
-- it is added.

ALTER TABLE dropship.dropship_vendor_listing_tier_holds
  ADD COLUMN IF NOT EXISTS tiers_on text[];

ALTER TABLE dropship.dropship_vendor_listing_tier_holds
  DROP CONSTRAINT IF EXISTS dropship_vendor_listing_tier_holds_tiers_on_chk;
ALTER TABLE dropship.dropship_vendor_listing_tier_holds
  ADD CONSTRAINT dropship_vendor_listing_tier_holds_tiers_on_chk
    CHECK (tiers_on IS NULL OR tiers_on <@ ARRAY['pack', 'case']::text[]);

COMMENT ON COLUMN dropship.dropship_vendor_listing_tier_holds.tiers_on IS
  'The tiers the current rule (reserve and money both reach the tier amount; a tier on at the last check stays on while the reserve covers it) found on at its last check. NULL until that rule first decides the vendor; rows written by the September rule are NULL (migration 0706).';
