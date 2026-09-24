-- 0702: wallet rewards — a third, spend-only balance on the vendor wallet
-- (funding design phase 7, owner decisions of 2026-09-23).
--
-- In place of a fee on card, an incentive on the free rails: every bank or
-- USDC transfer earns rewards at a per-rail rate (1% at launch, card 0%),
-- credited when the transfer settles, deposits and automatic top-ups alike.
-- Rewards are money Card Shellz issues, so they are spend-only: never paid
-- out, never counted toward the minimum, the credit allowance or a top-up
-- trigger, and never cash for the treasury. By default each order debit takes
-- rewards first and cash second; a returned or disputed transfer takes back
-- the rewards it earned, and a part already spent comes out of the cash
-- balance through the existing reversal.
--
-- Same contract as 0683 and 0701: ADD COLUMN ... DEFAULT backfills the rows
-- that exist, the policy defaults are then dropped so every future INSERT
-- states its numbers, the immutability guard learns the columns, and every
-- statement is guarded so a re-run is a no-op.

-- 1. The rewards balance. Spend-only: the CHECK is the rule that rewards are
--    never overdrawn (the cash balance may go negative; this one may not).
ALTER TABLE dropship.dropship_wallet_accounts
  ADD COLUMN IF NOT EXISTS rewards_balance_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE dropship.dropship_wallet_accounts
  DROP CONSTRAINT IF EXISTS dropship_wallet_rewards_chk;
ALTER TABLE dropship.dropship_wallet_accounts
  ADD CONSTRAINT dropship_wallet_rewards_chk
    CHECK (rewards_balance_cents >= 0);
COMMENT ON COLUMN dropship.dropship_wallet_accounts.rewards_balance_cents IS
  'Spend-only rewards balance in cents, issued by Card Shellz on settled bank and USDC transfers. Never paid out, never counted as cash, never negative (migration 0702).';

-- 2. The ledger learns the rewards kinds and snapshots the rewards balance
--    after each line, as it does the cash balances. Rows written before this
--    migration carry NULL; the four writers outside the wallet repository
--    that never move rewards leave it NULL too.
ALTER TABLE dropship.dropship_wallet_ledger
  ADD COLUMN IF NOT EXISTS rewards_balance_after_cents bigint;
ALTER TABLE dropship.dropship_wallet_ledger
  DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_rewards_after_chk;
ALTER TABLE dropship.dropship_wallet_ledger
  ADD CONSTRAINT dropship_wallet_ledger_rewards_after_chk
    CHECK (rewards_balance_after_cents IS NULL OR rewards_balance_after_cents >= 0);
COMMENT ON COLUMN dropship.dropship_wallet_ledger.rewards_balance_after_cents IS
  'The rewards balance after this line, in cents; NULL on lines written before migration 0702 or by writers that never move rewards.';

-- The rewards kinds: earned on a settled transfer, spent on an order debit,
-- reversed when the transfer that earned them is taken back, reinstated
-- when that dispute is won, redeemed outside the wallet (a coupon; no writer
-- at launch, the kind is the ledger vocabulary the design names).
ALTER TABLE dropship.dropship_wallet_ledger
  DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk;
ALTER TABLE dropship.dropship_wallet_ledger
  ADD CONSTRAINT dropship_wallet_ledger_type_chk
    CHECK (type IN ('funding','order_debit','refund_credit','return_credit','return_fee','insurance_pool_credit','manual_adjustment','advance_fee','funding_reversal','funding_reinstated','rewards_earned','rewards_spent','rewards_reversed','rewards_reinstated','rewards_redeemed'));

-- 3. The per-rail rates are wallet policy, editable by staff like every other
--    limit. 1000 bps = 10% is the ceiling on each: a typo cannot pay out 100%.
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS rewards_rate_bank_bps integer NOT NULL DEFAULT 100;
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS rewards_rate_usdc_bps integer NOT NULL DEFAULT 100;
ALTER TABLE dropship.dropship_wallet_policies
  ADD COLUMN IF NOT EXISTS rewards_rate_card_bps integer NOT NULL DEFAULT 0;

ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN rewards_rate_bank_bps DROP DEFAULT;
ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN rewards_rate_usdc_bps DROP DEFAULT;
ALTER TABLE dropship.dropship_wallet_policies
  ALTER COLUMN rewards_rate_card_bps DROP DEFAULT;

ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_rewards_bank_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_rewards_bank_chk
    CHECK (rewards_rate_bank_bps BETWEEN 0 AND 1000);
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_rewards_usdc_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_rewards_usdc_chk
    CHECK (rewards_rate_usdc_bps BETWEEN 0 AND 1000);
ALTER TABLE dropship.dropship_wallet_policies
  DROP CONSTRAINT IF EXISTS dropship_wallet_policies_rewards_card_chk;
ALTER TABLE dropship.dropship_wallet_policies
  ADD CONSTRAINT dropship_wallet_policies_rewards_card_chk
    CHECK (rewards_rate_card_bps BETWEEN 0 AND 1000);

COMMENT ON COLUMN dropship.dropship_wallet_policies.rewards_rate_bank_bps IS
  'Rewards earned on a settled bank (ACH) transfer, in basis points of the amount credited (migration 0702).';
COMMENT ON COLUMN dropship.dropship_wallet_policies.rewards_rate_usdc_bps IS
  'Rewards earned on a settled USDC transfer, in basis points of the amount credited (migration 0702).';
COMMENT ON COLUMN dropship.dropship_wallet_policies.rewards_rate_card_bps IS
  'Rewards earned on a settled card charge, in basis points of the amount credited; zero at launch (migration 0702).';

-- 4. The immutability guard learns the new columns. Same contract as 0682,
--    0683 and 0701: a published policy is never edited in place; the only
--    permitted UPDATE is retirement (active -> inactive), and DELETE is never
--    permitted.
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

-- 5. The vendor's choice: rewards pay first (the default), or are saved to
--    spend later ("save my rewards"). It lives on the vendor's wallet
--    settings row, which exists for every provisioned vendor, and is never
--    touched by the autopay upsert (that statement names its own columns).
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD COLUMN IF NOT EXISTS spend_rewards_first boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN dropship.dropship_auto_reload_settings.spend_rewards_first IS
  'True: each order debit takes rewards first and cash second. False: rewards are saved and the order is paid from cash (migration 0702).';
