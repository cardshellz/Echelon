-- Dropship wallet funding design, phase 3: the pending-ACH advance.
--
-- An order whose debit outruns the available balance may be accepted against
-- bank transfers still settling (server/modules/dropship/domain/acceptance-funding.ts).
-- The advance is represented as an overdraft of the available balance, which
-- migration 191 already permits (negative balances are the receivable the
-- daily wallet run collects). This migration adds only what the ledger and the
-- eligibility rules need:
--
--   1. a ledger kind for the service fee on the amount advanced;
--   2. an append-only record of bank balance reads through the payment
--      provider (Stripe Financial Connections), one of the three facts an
--      account must show before its pending credits can be advanced against.
--
-- The other two facts are read from existing data: the account holder type
-- on the funding method (migration 0683 phase 1c) and a settled earlier pull
-- in the wallet ledger. Every statement is guarded so a re-run is a no-op.

-- 1. Ledger kind. `advance_fee` rows are debits from available, posted in the
--    same transaction as the order debit they belong to and referencing the
--    same order intake. The list otherwise matches migration 0086.
ALTER TABLE dropship.dropship_wallet_ledger
  DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk;
ALTER TABLE dropship.dropship_wallet_ledger
  ADD CONSTRAINT dropship_wallet_ledger_type_chk
    CHECK (type IN (
      'funding',
      'order_debit',
      'refund_credit',
      'return_credit',
      'return_fee',
      'insurance_pool_credit',
      'manual_adjustment',
      'advance_fee'
    ));

-- 2. Bank balance verifications. One row per read attempt; the latest
--    `succeeded` row for a funding method is what makes it "balance verified".
--    Amounts are the provider's integer minor units; a negative balance is a
--    real reading (money owed by the account holder) and is stored as such —
--    the eligibility rule decides what to make of it.
CREATE TABLE IF NOT EXISTS dropship.dropship_funding_method_balance_verifications (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  funding_method_id integer NOT NULL REFERENCES dropship.dropship_funding_methods(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL,
  provider_account_id varchar(255) NOT NULL,
  status varchar(20) NOT NULL,
  source varchar(20) NOT NULL,
  available_cents bigint,
  currency varchar(3),
  balance_as_of timestamptz,
  provider_event_id varchar(255),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_funding_method_balance_verifications_status_chk
    CHECK (status IN ('succeeded', 'pending', 'failed')),
  CONSTRAINT dropship_funding_method_balance_verifications_source_chk
    CHECK (source IN ('link', 'refresh', 'webhook')),
  CONSTRAINT dropship_funding_method_balance_verifications_succeeded_chk
    CHECK (status <> 'succeeded'
      OR (available_cents IS NOT NULL AND currency IS NOT NULL AND balance_as_of IS NOT NULL)),
  CONSTRAINT dropship_funding_method_balance_verifications_provider_chk
    CHECK (provider = btrim(provider) AND provider <> ''),
  CONSTRAINT dropship_funding_method_balance_verifications_account_chk
    CHECK (provider_account_id = btrim(provider_account_id) AND provider_account_id <> ''),
  CONSTRAINT dropship_funding_method_balance_verifications_currency_chk
    CHECK (currency IS NULL OR currency = upper(currency))
);

CREATE INDEX IF NOT EXISTS dropship_funding_method_balance_verifications_method_idx
  ON dropship.dropship_funding_method_balance_verifications (funding_method_id, created_at DESC, id DESC);

-- A replayed provider event records nothing twice.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_funding_method_balance_verifications_event_idx
  ON dropship.dropship_funding_method_balance_verifications (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- Append-only: a reading is evidence of what the provider said at that moment.
CREATE OR REPLACE FUNCTION dropship.dropship_funding_method_balance_verifications_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dropship_funding_method_balance_verifications is append-only: rows cannot be % ', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_funding_method_balance_verifications_guard_trg
  ON dropship.dropship_funding_method_balance_verifications;
CREATE TRIGGER dropship_funding_method_balance_verifications_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_funding_method_balance_verifications
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_funding_method_balance_verifications_guard();

COMMENT ON TABLE dropship.dropship_funding_method_balance_verifications IS
  'Append-only bank balance reads through the payment provider (funding design phase 3). The latest succeeded row for a funding method is the "balance verified" fact the pending-ACH advance requires.';
COMMENT ON COLUMN dropship.dropship_funding_method_balance_verifications.available_cents IS
  'The provider''s available cash balance in integer minor units at balance_as_of; negative when the holder owes the bank.';
COMMENT ON COLUMN dropship.dropship_funding_method_balance_verifications.source IS
  'link: read when the account was linked; refresh: a balance refresh we requested; webhook: the provider reported a refreshed balance.';
