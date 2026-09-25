-- 0705: rewards points expire (funding design phase 7, owner decision of
-- 2026-09-24). Staff set how many days after they are earned unused points
-- expire, or never; the setting is empty (never) at launch, and a change
-- applies to points earned after it.
--
-- To know which points expire when, every earning becomes a lot with its own
-- expiry date, and every movement of points in or out of a lot is recorded
-- against the ledger row that caused it. The rewards balance on the wallet
-- account stays the money authority; the lots are the index that says which
-- of those points expire when. The two are kept equal by the writers, which
-- lock the wallet account first, reconcile the lots to the balance, then move
-- both together.
--
-- No backfill: an account's first lot is opened by the first writer that
-- touches it after this migration, for the balance it finds, never expiring
-- (every point earned before this migration was earned when nothing expired).
-- Opening lots at first touch rather than here also covers points moved by the
-- previous release while this one deploys.
--
-- Same contract as 0683, 0701 and 0702 for the policy column; every statement
-- is guarded so a re-run is a no-op.

-- 1. The expiry setting on the wallet policy. NULL is "never". The bound is a
--    typo guard on the date arithmetic (ten years), like the 10% ceiling on
--    the rates.
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS rewards_expiry_days integer;
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_rewards_expiry_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_rewards_expiry_chk
    CHECK (rewards_expiry_days IS NULL OR rewards_expiry_days BETWEEN 1 AND 3650);
COMMENT ON COLUMN dropship.dropship_wallet_policies.rewards_expiry_days IS
  'Days after they are earned that unused rewards points expire; NULL means they never expire. Applies to points earned while this version is in force (migration 0705).';

-- The immutability guard learns the new column. A published policy is never
-- edited in place; the only permitted UPDATE is retirement.
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
     OR NEW.rewards_rate_bank_bps IS DISTINCT FROM OLD.rewards_rate_bank_bps
     OR NEW.rewards_rate_usdc_bps IS DISTINCT FROM OLD.rewards_rate_usdc_bps
     OR NEW.rewards_rate_card_bps IS DISTINCT FROM OLD.rewards_rate_card_bps
     OR NEW.rewards_expiry_days IS DISTINCT FROM OLD.rewards_expiry_days
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

-- 2. The ledger kinds: expired points get their own line. The coupon kind from
--    0702 leaves the vocabulary: store redemption was dropped (owner decision
--    of 2026-09-24) and the kind never had a writer. Should a row carrying it
--    exist anyway, the migration stops here for a person to look, rather than
--    failing on the constraint below with a less useful message.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dropship.dropship_wallet_ledger WHERE type = 'rewards_redeemed') THEN
    RAISE EXCEPTION 'migration 0705: dropship.dropship_wallet_ledger holds rewards_redeemed rows, a kind that never had a writer; review them before retiring the kind';
  END IF;
END
$$;
ALTER TABLE dropship.dropship_wallet_ledger
  DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk;
ALTER TABLE dropship.dropship_wallet_ledger
  ADD CONSTRAINT dropship_wallet_ledger_type_chk
    CHECK (type IN ('funding','order_debit','refund_credit','return_credit','return_fee','insurance_pool_credit','manual_adjustment','advance_fee','funding_reversal','funding_reinstated','rewards_earned','rewards_spent','rewards_reversed','rewards_reinstated','rewards_expired'));

-- 3. The lots. One per earning ('earned', created with its rewards_earned
--    row), one opening lot per account for the points it held when lots began
--    ('opening_balance'), points returned by a won dispute whose clawback
--    predates lots ('restored', created with its rewards_reinstated row), and
--    points a writer moved without lots ('reconciled', an anomaly a person
--    reviews). Only earned lots can expire. Financial history is never deleted,
--    so the references restrict deletes.
CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_rewards_lots (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  wallet_account_id integer NOT NULL REFERENCES dropship.dropship_wallet_accounts(id) ON DELETE RESTRICT,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE RESTRICT,
  source varchar(30) NOT NULL,
  origin_ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE RESTRICT,
  earned_cents bigint NOT NULL,
  remaining_cents bigint NOT NULL,
  earned_at timestamptz NOT NULL,
  expires_at timestamptz,
  expiry_days integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT dropship_wallet_rewards_lots_source_chk
    CHECK (source IN ('earned','opening_balance','restored','reconciled')),
  CONSTRAINT dropship_wallet_rewards_lots_origin_chk
    CHECK ((source IN ('earned','restored')) = (origin_ledger_entry_id IS NOT NULL)),
  CONSTRAINT dropship_wallet_rewards_lots_amount_chk
    CHECK (earned_cents > 0 AND remaining_cents >= 0 AND remaining_cents <= earned_cents),
  CONSTRAINT dropship_wallet_rewards_lots_expiry_chk
    CHECK (
      (expires_at IS NULL) = (expiry_days IS NULL)
      AND (expiry_days IS NULL OR expiry_days BETWEEN 1 AND 3650)
      AND (expires_at IS NULL OR (source = 'earned' AND expires_at > earned_at))
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_rewards_lots_origin_idx
  ON dropship.dropship_wallet_rewards_lots(origin_ledger_entry_id)
  WHERE origin_ledger_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_rewards_lots_opening_idx
  ON dropship.dropship_wallet_rewards_lots(wallet_account_id)
  WHERE source = 'opening_balance';
-- Per account, not partial: the writers ask both for an account's open lots
-- and whether it has any lot at all.
CREATE INDEX IF NOT EXISTS dropship_wallet_rewards_lots_account_idx
  ON dropship.dropship_wallet_rewards_lots(wallet_account_id);
CREATE INDEX IF NOT EXISTS dropship_wallet_rewards_lots_due_idx
  ON dropship.dropship_wallet_rewards_lots(expires_at)
  WHERE remaining_cents > 0 AND expires_at IS NOT NULL;
COMMENT ON TABLE dropship.dropship_wallet_rewards_lots IS
  'Rewards points by where they came from and when they expire. The sum of remaining_cents per account equals the account''s rewards_balance_cents (migration 0705).';

-- 4. Every movement of points in or out of a lot, against the ledger row that
--    caused it (a spend, a clawback, a returned clawback, an expiry), or, with
--    no ledger row, a reconciliation of the lots to the balance. Append-only.
CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_rewards_lot_movements (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  lot_id integer NOT NULL REFERENCES dropship.dropship_wallet_rewards_lots(id) ON DELETE RESTRICT,
  ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE RESTRICT,
  reason varchar(30) NOT NULL,
  amount_cents bigint NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT dropship_wallet_rewards_lot_movements_reason_chk
    CHECK (reason IN ('ledger','reconciliation')),
  CONSTRAINT dropship_wallet_rewards_lot_movements_ledger_chk
    CHECK ((reason = 'ledger') = (ledger_entry_id IS NOT NULL)),
  CONSTRAINT dropship_wallet_rewards_lot_movements_amount_chk
    CHECK (amount_cents <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_rewards_lot_movements_ledger_idx
  ON dropship.dropship_wallet_rewards_lot_movements(ledger_entry_id, lot_id)
  WHERE ledger_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dropship_wallet_rewards_lot_movements_lot_idx
  ON dropship.dropship_wallet_rewards_lot_movements(lot_id);

CREATE OR REPLACE FUNCTION dropship.dropship_wallet_rewards_lot_movements_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'dropship wallet rewards lot movements are append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS dropship_wallet_rewards_lot_movements_guard_trg
  ON dropship.dropship_wallet_rewards_lot_movements;
CREATE TRIGGER dropship_wallet_rewards_lot_movements_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_rewards_lot_movements
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_wallet_rewards_lot_movements_guard();
