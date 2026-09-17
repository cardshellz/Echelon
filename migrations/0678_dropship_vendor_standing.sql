-- Dropship vendor standing.
--
-- A vendor whose wallet funding was declined is paused: order acceptance
-- stops, every store connection they own is held at zero quantity through
-- the inventory publication hold (migration 0677), and selling resumes on its
-- own once a settled credit brings the balance back to the auto-reload
-- minimum. The standing columns record why and when; the listing-hold columns
-- record whether inventory planning currently holds the vendor's stores, so
-- an hourly reconciler can retry a hold or release that was deferred (for
-- example because a provider quantity request was in flight).
--
-- standing_revision changes on every pause and resume and keys the hold and
-- release commands, so a retried command replays instead of repeating.

ALTER TABLE dropship.dropship_vendors
  ADD COLUMN standing_reason VARCHAR(60),
  ADD COLUMN paused_at TIMESTAMPTZ,
  ADD COLUMN standing_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN listing_hold_state VARCHAR(20) NOT NULL DEFAULT 'released',
  ADD COLUMN listing_hold_reconciled_at TIMESTAMPTZ,
  ADD COLUMN listing_hold_detail TEXT;

-- Nothing wrote 'paused' before this migration; if a row was set by hand it
-- becomes an operator pause rather than tripping the new check.
UPDATE dropship.dropship_vendors
SET standing_reason = 'operator',
    paused_at = COALESCE(paused_at, updated_at)
WHERE status = 'paused'
  AND standing_reason IS NULL;

ALTER TABLE dropship.dropship_vendors
  ADD CONSTRAINT dropship_vendors_standing_chk CHECK (
    (status <> 'paused' AND standing_reason IS NULL AND paused_at IS NULL)
    OR (status = 'paused' AND standing_reason IS NOT NULL AND paused_at IS NOT NULL)
  ),
  ADD CONSTRAINT dropship_vendors_standing_reason_chk CHECK (
    standing_reason IS NULL OR standing_reason IN ('card_declined', 'funding_returned', 'operator')
  ),
  ADD CONSTRAINT dropship_vendors_standing_revision_chk CHECK (standing_revision >= 0),
  ADD CONSTRAINT dropship_vendors_listing_hold_state_chk CHECK (
    listing_hold_state IN ('released', 'held')
  );

-- The reconciler scans for vendors whose listing hold does not match their standing.
CREATE INDEX IF NOT EXISTS dropship_vendors_listing_hold_mismatch_idx
  ON dropship.dropship_vendors (status, listing_hold_state);
