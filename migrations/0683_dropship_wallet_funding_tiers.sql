-- Dropship wallet funding design, phase 1: listing tiers, the pending-ACH
-- advance, tier-change grace, a 24-hour payment hold, and a per-vendor credit
-- profile stub.
--
-- Decisions this migration records (owner, 2026-09-20):
--   * Two listing tiers. Vendors selling eaches and inner packs (variant type
--     P, B) keep at least the PACK tier minimum; vendors selling cases (C) keep
--     at least the CASE tier minimum. One balance, one minimum per vendor: the
--     highest tier they have enabled. The existing minimum_floor_cents column
--     IS the pack tier minimum (it was always "the lowest minimum any vendor may
--     keep"); only the case tier is new.
--   * Pending-ACH advance. An order that outruns the available balance may be
--     accepted against ACH that is still settling, for a service fee on the
--     amount used, up to a cap. The fee and the global cap live here; the
--     eligibility rules (company account, verified balance, first pull settled)
--     are code, shipped separately.
--   * Raising a tier minimum grandfathers affected vendors for a grace period
--     before their listings in that tier are unpublished.
--   * A payment hold (an order waiting for funds) lasts 24 hours, not 48.
--   * A per-vendor credit profile: today only an advance-cap override, so a
--     trusted vendor can be advanced more than the global cap. The trust tier
--     and credit terms the program will grow into hang off this row later.
--
-- Shape follows migration 0682: the policy table stays versioned and immutable
-- (one active row, an edit is a new version), so the new limits are columns on
-- it, the immutability guard learns them, and the launch values are published
-- as VERSION 2 — but only when the active row is still the system-seeded
-- version 1. A row staff already published is never overridden; the new
-- columns simply take their launch defaults on it and staff set them from the
-- Wallet Policy tab.
--
-- Money is integer cents. Fees are basis points. Timings are whole minutes or
-- days. Every statement is guarded so a re-run is a no-op.

-- 1. New policy columns. ADD COLUMN ... DEFAULT backfills the rows that exist;
--    the defaults are then dropped so a future INSERT that forgets a column
--    fails loudly instead of silently taking a launch value.
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS case_tier_minimum_cents bigint NOT NULL DEFAULT 50000;
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS advance_fee_bps integer NOT NULL DEFAULT 100;
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS advance_cap_cents bigint NOT NULL DEFAULT 50000;
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS tier_change_grace_days integer NOT NULL DEFAULT 14;

ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN case_tier_minimum_cents DROP DEFAULT;
ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN advance_fee_bps DROP DEFAULT;
ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN advance_cap_cents DROP DEFAULT;
ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN tier_change_grace_days DROP DEFAULT;

-- 2. Backfill before the invariant. A row staff published with a pack floor
--    above $500 would otherwise violate case >= pack on the row the launch
--    default just gave it, and the ADD CONSTRAINT below would abort the
--    deploy. The immutability guard blocks every UPDATE, so it is switched
--    off for exactly this statement, inside this migration's transaction:
--    the column did not exist before this migration, so this is the column
--    taking its initial value, not a published number moving.
ALTER TABLE dropship.dropship_wallet_policies
  DISABLE TRIGGER dropship_wallet_policies_guard_trg;
UPDATE dropship.dropship_wallet_policies
SET case_tier_minimum_cents = minimum_floor_cents
WHERE case_tier_minimum_cents < minimum_floor_cents;
ALTER TABLE dropship.dropship_wallet_policies
  ENABLE TRIGGER dropship_wallet_policies_guard_trg;

-- 3. Invariants SQL can express. Each is dropped-then-added so a re-run is safe.
--    The case tier can never sit below the pack tier: a vendor enabling cases
--    raises their minimum, never lowers it.
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_case_tier_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_case_tier_chk
    CHECK (case_tier_minimum_cents >= minimum_floor_cents);

-- 10000 bps = 100%. A fee above the whole amount is a data error, not a policy.
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_advance_fee_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_advance_fee_chk
    CHECK (advance_fee_bps BETWEEN 0 AND 10000);

-- A cap of zero is a legitimate policy: nothing is advanced. It is arithmetic,
-- not a flag, so no separate enabled switch exists to drift out of sync.
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_advance_cap_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_advance_cap_chk
    CHECK (advance_cap_cents >= 0);

-- Zero days means a raised tier is enforced immediately. A year is the ceiling
-- so a typo cannot grandfather a vendor forever.
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_grace_days_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_grace_days_chk
    CHECK (tier_change_grace_days BETWEEN 0 AND 365);

-- 4. The immutability guard learns the new columns. Same contract as 0682:
--    retirement (active -> inactive) is the only permitted UPDATE, DELETE never.
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

-- 5. Publish the launch values as version 2, retiring the seeded version 1 —
--    ONLY when version 1 is still the active row and nothing later exists. If
--    staff have already published a version, their numbers stand and the new
--    columns carry the launch defaults from step 1 until they are edited.
--
--    The retire and the insert run in this migration's transaction (the
--    executor wraps each file), so the one-active-row index can never observe
--    zero or two active rows.
--
--    Version 2:
--      minimum_floor_cents (pack tier)        10000  ($100)
--      case_tier_minimum_cents                50000  ($500)
--      minimum_single_top_up_limit_cents      10000  (must cover the pack floor)
--      manual_top_up_minimum_cents             1000  (unchanged)
--      manual_top_up_maximum_cents           500000  (unchanged)
--      default_payment_hold_timeout_minutes    1440  (24h, was 48h)
--      hold_expiry_warning_minutes              120  (unchanged)
--      advance_fee_bps                          100  (1%)
--      advance_cap_cents                      50000  ($500)
--      tier_change_grace_days                    14
UPDATE dropship.dropship_wallet_policies
SET is_active = false, deactivated_at = now()
WHERE is_active = true
  AND version = 1
  AND created_by_actor_type = 'system'
  AND NOT EXISTS (
    SELECT 1 FROM dropship.dropship_wallet_policies WHERE version >= 2
  );

INSERT INTO dropship.dropship_wallet_policies (
  version,
  minimum_floor_cents,
  case_tier_minimum_cents,
  minimum_single_top_up_limit_cents,
  manual_top_up_minimum_cents,
  manual_top_up_maximum_cents,
  default_payment_hold_timeout_minutes,
  hold_expiry_warning_minutes,
  advance_fee_bps,
  advance_cap_cents,
  tier_change_grace_days,
  is_active,
  change_note,
  created_by_actor_type,
  created_by_actor_id
)
SELECT 2, 10000, 50000, 10000, 1000, 500000, 1440, 120, 100, 50000, 14, true,
       'Funding design phase 1: pack tier $100, case tier $500, 24-hour payment hold, 1% advance fee capped at $500, 14-day tier grace (migration 0683).',
       'system', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM dropship.dropship_wallet_policies WHERE is_active = true
)
AND EXISTS (
  SELECT 1 FROM dropship.dropship_wallet_policies
  WHERE version = 1 AND created_by_actor_type = 'system' AND NOT is_active
)
AND NOT EXISTS (
  SELECT 1 FROM dropship.dropship_wallet_policies WHERE version >= 2
);

-- 6. The payment hold is 24 hours. The active policy row governs at acceptance
--    time (server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts,
--    loadPaymentHoldTimeoutWithClient); the per-vendor column is retained for
--    compatibility with the current vendor contract and now defaults to the
--    same value. Existing vendor rows are NOT rewritten: they no longer decide
--    the hold, and rewriting stored vendor configuration from a migration is
--    exactly what the policy design avoids.
ALTER TABLE dropship.dropship_auto_reload_settings
  ALTER COLUMN payment_hold_timeout_minutes SET DEFAULT 1440;

-- 7. Per-vendor credit profile. Mutable configuration (like auto-reload
--    settings), one row per vendor, every change audited with before -> after
--    in dropship.dropship_audit_events. Only the advance-cap override exists
--    today; NULL means "the global policy cap applies".
CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_credit_profiles (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  advance_cap_override_cents bigint,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_actor_type varchar(40) NOT NULL,
  updated_by_actor_id varchar(255),
  CONSTRAINT dropship_vendor_credit_profiles_cap_chk
    CHECK (advance_cap_override_cents IS NULL OR advance_cap_override_cents >= 0),
  CONSTRAINT dropship_vendor_credit_profiles_actor_chk
    CHECK (updated_by_actor_type IN ('admin', 'system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_vendor_credit_profiles_vendor_idx
  ON dropship.dropship_vendor_credit_profiles(vendor_id);

COMMENT ON TABLE dropship.dropship_vendor_credit_profiles IS
  'Per-vendor credit profile (funding design phase 1). advance_cap_override_cents overrides dropship_wallet_policies.advance_cap_cents when set; NULL means the global cap applies. Trust tier and credit terms attach here as the program matures.';

COMMENT ON COLUMN dropship.dropship_wallet_policies.minimum_floor_cents IS
  'Pack tier minimum: the lowest minimum balance any vendor may keep; applies to vendors selling eaches and inner packs (variant type P, B).';
COMMENT ON COLUMN dropship.dropship_wallet_policies.case_tier_minimum_cents IS
  'Case tier minimum: vendors with case listings (variant type C) enabled must keep at least this. Never below minimum_floor_cents.';
COMMENT ON COLUMN dropship.dropship_wallet_policies.advance_fee_bps IS
  'Service fee, in basis points, on the amount of pending ACH an order is accepted against.';
COMMENT ON COLUMN dropship.dropship_wallet_policies.advance_cap_cents IS
  'Global ceiling on the pending-ACH amount an order may be accepted against. Zero means nothing is advanced. dropship_vendor_credit_profiles.advance_cap_override_cents overrides it per vendor.';
COMMENT ON COLUMN dropship.dropship_wallet_policies.tier_change_grace_days IS
  'Days a vendor below a raised tier minimum keeps that tier''s listings before they are unpublished. Zero enforces immediately.';
