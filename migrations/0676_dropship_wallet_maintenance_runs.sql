-- Daily wallet maintenance runs.
--
-- Replaces the weekly collection sweep (migration 191, design spec D5). The
-- sweep charged only the negative amount, once per 7-day period, after a
-- 7-day grace, and only when an order was not already forcing a reload. It
-- never brought a wallet back to its minimum, and nothing else did between
-- orders. The wallet maintenance job runs the routine minimum-balance
-- auto-reload for every active vendor once per UTC day, so a wallet below
-- its minimum (or negative after return fees) is topped up through the same
-- path, fee policy and ledger rules an order-triggered reload uses.
--
-- One row per (vendor, run_date) is the idempotency guard: a repeated or
-- crashed tick replays the row instead of charging again.
--
-- dropship_collection_config / dropship_collection_attempts are left in place
-- for their history; nothing writes them any more. Drop post-soak.

CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_maintenance_runs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  -- What the wallet was credited (net of any card fee), the fee, and the
  -- total the funding method was charged. Null until a reload happens.
  amount_cents bigint,
  card_fee_cents bigint,
  charged_cents bigint,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  funding_method_id integer REFERENCES dropship.dropship_funding_methods(id) ON DELETE SET NULL,
  funding_status varchar(20),
  wallet_ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE SET NULL,
  provider_payment_intent_id varchar(255),
  -- Skip reason or structured error code behind a terminal status.
  outcome_code varchar(120),
  outcome_message text,
  last_attempt_at timestamptz,
  idempotency_key varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_wallet_maintenance_runs_status_chk
    CHECK (status IN ('pending','retry_pending','reloaded','not_needed','attention','declined','failed')),
  CONSTRAINT dropship_wallet_maintenance_runs_attempts_chk
    CHECK (attempt_count >= 0),
  CONSTRAINT dropship_wallet_maintenance_runs_amount_chk
    CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CONSTRAINT dropship_wallet_maintenance_runs_fee_chk
    CHECK (card_fee_cents IS NULL OR card_fee_cents >= 0),
  CONSTRAINT dropship_wallet_maintenance_runs_charged_chk
    CHECK (charged_cents IS NULL OR charged_cents >= 0),
  CONSTRAINT dropship_wallet_maintenance_runs_funding_status_chk
    CHECK (funding_status IS NULL OR funding_status IN ('pending','settled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_maintenance_runs_vendor_date_idx
  ON dropship.dropship_wallet_maintenance_runs(vendor_id, run_date);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_maintenance_runs_idem_idx
  ON dropship.dropship_wallet_maintenance_runs(idempotency_key);
CREATE INDEX IF NOT EXISTS dropship_wallet_maintenance_runs_status_idx
  ON dropship.dropship_wallet_maintenance_runs(status, run_date);
