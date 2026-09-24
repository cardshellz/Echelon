-- 0701: the card fee and the card minimum deposit become wallet policy
-- (funding design phase 7, owner decisions of 2026-09-23).
--
-- No processing fee on any rail: card deposits, routine card top-ups and
-- backup-card covers stop carrying the 3% the launch environment charged. The
-- fee stays a setting held at zero, so the disclosure machinery (the vendor's
-- acknowledgement in the autopay mandate, the fee on every quote) keeps
-- working should a fee ever return. Card deposits get their own minimum
-- ($100 at launch) because a free card charge on a trivial amount still costs
-- Stripe's fixed per-charge fee; bank deposits keep the general manual
-- minimum. Both numbers move with a new policy version, like every other
-- limit, and the environment variable DROPSHIP_CARD_FUNDING_FEE_BPS becomes
-- the fee's fallback for a database with no policy row.
--
-- Same contract as 0683: ADD COLUMN ... DEFAULT backfills the rows that exist,
-- the defaults are then dropped so every future INSERT states its numbers, the
-- immutability guard learns the columns, and every statement is guarded so a
-- re-run is a no-op.

-- 1. New policy columns.
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS card_funding_fee_bps integer NOT NULL DEFAULT 0;
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS card_funding_minimum_cents bigint NOT NULL DEFAULT 10000;

ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN card_funding_fee_bps DROP DEFAULT;
ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN card_funding_minimum_cents DROP DEFAULT;

-- 2. Backfill before the invariant. A row staff published with a manual
--    maximum below $100 would otherwise violate card minimum <= manual maximum
--    on the value the launch default just gave it. The immutability guard
--    blocks every UPDATE, so it is switched off for exactly this statement,
--    inside this migration's transaction: the column did not exist before
--    this migration, so this is the column taking its initial value, not a
--    published number moving.
ALTER TABLE dropship.dropship_wallet_policies
  DISABLE TRIGGER dropship_wallet_policies_guard_trg;
UPDATE dropship.dropship_wallet_policies
SET card_funding_minimum_cents = manual_top_up_maximum_cents
WHERE card_funding_minimum_cents > manual_top_up_maximum_cents;
ALTER TABLE dropship.dropship_wallet_policies
  ENABLE TRIGGER dropship_wallet_policies_guard_trg;

-- 3. Invariants SQL can express. Each is dropped-then-added so a re-run is safe.
--    1000 bps = 10%: the same misconfiguration guard the shared fee module
--    applies (MAX_CARD_FUNDING_FEE_BPS). A higher number is a typo, not a policy.
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_card_fee_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_card_fee_chk
    CHECK (card_funding_fee_bps BETWEEN 0 AND 1000);

-- A card deposit always has a minimum, and one a vendor can actually pay.
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_card_minimum_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_card_minimum_chk
    CHECK (card_funding_minimum_cents > 0);
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_card_minimum_range_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_card_minimum_range_chk
    CHECK (card_funding_minimum_cents <= manual_top_up_maximum_cents);

-- 4. The immutability guard learns the new columns. Same contract as 0682 and
--    0683: a published policy is never edited in place; the only permitted
--    UPDATE is retirement (active -> inactive), and DELETE is never permitted.
CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dropship_wallet_policies is append-only: rows cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.minimum_floor_cents IS DISTINCT FROM OLD.minimum_floor_cents
     OR NEW.case_tier_minimum_cents IS DISTINCT FROM OLD.case_tier_minimum_cents
     OR NEW.minimum_single_top_up_limit_cents IS DISTINCT FROM OLD.minimum_single_top_up_limit_cents
     OR NEW.manual_top_up_minimum_cents IS DISTINCT FROM OLD.manual_top_up_minimum_cents
     OR NEW.manual_top_up_maximum_cents IS DISTINCT FROM OLD.manual_top_up_maximum_cents
     OR NEW.default_payment_hold_timeout_minutes IS DISTINCT FROM OLD.default_payment_hold_timeout_minutes
     OR NEW.hold_expiry_warning_minutes IS DISTINCT FROM OLD.hold_expiry_warning_minutes
     OR NEW.advance_fee_bps IS DISTINCT FROM OLD.advance_fee_bps
     OR NEW.advance_cap_cents IS DISTINCT FROM OLD.advance_cap_cents
     OR NEW.tier_change_grace_days IS DISTINCT FROM OLD.tier_change_grace_days
     OR NEW.card_funding_fee_bps IS DISTINCT FROM OLD.card_funding_fee_bps
     OR NEW.card_funding_minimum_cents IS DISTINCT FROM OLD.card_funding_minimum_cents
     OR NEW.change_note IS DISTINCT FROM OLD.change_note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
  THEN
    RAISE EXCEPTION 'dropship_wallet_policies is immutable: publish a new version instead of editing one';
  END IF;
  IF NOT (OLD.is_active AND NOT NEW.is_active) THEN
    RAISE EXCEPTION 'dropship_wallet_policies rows may only be retired (active -> inactive)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_wallet_policies_guard_trg
  ON dropship.dropship_wallet_policies;
CREATE TRIGGER dropship_wallet_policies_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_policies
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_wallet_policies_guard();

-- 5. The rate a vendor agreed to lives on their settings row. Until now it was
--    recorded only in the audit payload written when they saved autopay, so
--    an unattended charge could only quote the live rate — the reason the fee
--    was read-only on the admin tab. With the acknowledgement stored, a
--    routine top-up or a backup-card cover is held to the rate the vendor
--    agreed to (DropshipWalletService.unattendedFeeBps): staff raising the
--    fee cannot charge a vendor more until they confirm the new rate. Both
--    columns are set together or not at all.
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD COLUMN IF NOT EXISTS acknowledged_card_fee_bps integer;
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

ALTER TABLE dropship.dropship_auto_reload_settings
  DROP CONSTRAINT IF EXISTS dropship_auto_reload_acknowledged_fee_chk;
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD CONSTRAINT dropship_auto_reload_acknowledged_fee_chk
    CHECK (acknowledged_card_fee_bps IS NULL OR acknowledged_card_fee_bps BETWEEN 0 AND 1000);
ALTER TABLE dropship.dropship_auto_reload_settings
  DROP CONSTRAINT IF EXISTS dropship_auto_reload_acknowledged_pair_chk;
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD CONSTRAINT dropship_auto_reload_acknowledged_pair_chk
    CHECK ((acknowledged_card_fee_bps IS NULL) = (acknowledged_at IS NULL));

COMMENT ON COLUMN dropship.dropship_auto_reload_settings.acknowledged_card_fee_bps IS
  'The card fee rate (basis points) the vendor agreed to when they last saved autopay; an unattended card charge never carries more than this. NULL: no acknowledgement stored, the live rate applies (migration 0701).';
COMMENT ON COLUMN dropship.dropship_auto_reload_settings.acknowledged_at IS
  'When the vendor agreed to acknowledged_card_fee_bps (migration 0701).';

-- 6. Backfill from the audit trail, so a vendor who agreed to a rate before
--    this migration keeps the protection: the most recent
--    wallet_auto_reload_configured event per settings row carries the rate
--    they acknowledged (acknowledgedCardFeeBps), or, for a save made before
--    the client sent one, the rate that was on their screen
--    (cardFundingFeeBps). A row with no such event stays NULL.
UPDATE dropship.dropship_auto_reload_settings AS s
SET acknowledged_card_fee_bps = latest.bps,
    acknowledged_at = latest.created_at
FROM (
  SELECT DISTINCT ON (e.entity_id)
         e.entity_id,
         e.created_at,
         COALESCE(
           NULLIF(e.payload->>'acknowledgedCardFeeBps', 'null')::integer,
           NULLIF(e.payload->>'cardFundingFeeBps', 'null')::integer
         ) AS bps
  FROM dropship.dropship_audit_events AS e
  WHERE e.entity_type = 'dropship_auto_reload_settings'
    AND e.event_type = 'wallet_auto_reload_configured'
  ORDER BY e.entity_id, e.created_at DESC, e.id DESC
) AS latest
WHERE s.id::text = latest.entity_id
  AND s.acknowledged_card_fee_bps IS NULL
  AND latest.bps IS NOT NULL
  AND latest.bps BETWEEN 0 AND 1000;
