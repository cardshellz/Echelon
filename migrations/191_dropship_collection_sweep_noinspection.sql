-- Dropship collection sweep + no-inspection branch (B2, stack 3/4).
-- Spec: dropship-returns-design-spec.md (D3 no-inspection branch, D5 collection
--       sweep, D-governing versioned config) + dropship-returns-build-spec.md.

-- 1. D5 bug fix: negative wallet balances are ALLOWED (design spec D5, locked
--    2026-08-05). Migration 187 recorded the decision in a comment but the
--    phase-0 CHECK constraints from migration 0086 were never dropped, so any
--    fee remainder that would drive the wallet negative would violate the
--    constraint and crash the inspection path. Drop them now. The wallet
--    ledger IS the receivable; the collection sweep below is the recovery
--    mechanism.

ALTER TABLE dropship.dropship_wallet_accounts
  DROP CONSTRAINT IF EXISTS dropship_wallet_available_chk;

ALTER TABLE dropship.dropship_wallet_ledger
  DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_balance_chk;

-- 2. Collection sweep config (D5 + D-governing): versioned, immutable money
--    knobs. One active global row (collection policy is platform-wide; there
--    is no per-vendor collection override in D5). Changes = new version row;
--    once effective_from passes, money fields never mutate.

CREATE TABLE IF NOT EXISTS dropship.dropship_collection_config (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  version integer NOT NULL,
  grace_days integer NOT NULL DEFAULT 7,
  sweep_cadence_days integer NOT NULL DEFAULT 7,
  max_consecutive_failures integer NOT NULL DEFAULT 3,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_collection_config_grace_chk
    CHECK (grace_days >= 0 AND grace_days <= 90),
  CONSTRAINT dropship_collection_config_cadence_chk
    CHECK (sweep_cadence_days > 0 AND sweep_cadence_days <= 90),
  CONSTRAINT dropship_collection_config_failures_chk
    CHECK (max_consecutive_failures > 0 AND max_consecutive_failures <= 100),
  CONSTRAINT dropship_collection_config_window_chk
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Exactly one active global collection config row.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_collection_config_active_idx
  ON dropship.dropship_collection_config ((is_active))
  WHERE is_active = true;

-- Seed the default: 7-day grace, weekly sweep, 3 failures before human review.
INSERT INTO dropship.dropship_collection_config
  (version, grace_days, sweep_cadence_days, max_consecutive_failures, is_active)
SELECT 1, 7, 7, 3, true
WHERE NOT EXISTS (
  SELECT 1 FROM dropship.dropship_collection_config WHERE is_active = true
);

COMMENT ON TABLE dropship.dropship_collection_config IS
  'Versioned collection-sweep knobs (design spec D5 + D-governing). Negative wallet balances past grace_days are charged to the vendor saved funding method every sweep_cadence_days; after max_consecutive_failures the vendor is escalated to human account review (never automatic suspension). Once effective_from passes, money fields are immutable — changes are a new version row.';

-- 3. Collection attempts: one row per (vendor, sweep period). The unique
--    (vendor_id, period_start) index is the idempotency backbone — a sweep
--    that crashes and reruns inside the same period replays against the same
--    row instead of double-charging.

CREATE TABLE IF NOT EXISTS dropship.dropship_collection_attempts (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount_cents bigint NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  funding_method_id integer REFERENCES dropship.dropship_funding_methods(id) ON DELETE SET NULL,
  config_version_id integer REFERENCES dropship.dropship_collection_config(id) ON DELETE SET NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_failure_code varchar(120),
  last_failure_message text,
  provider_payment_intent_id varchar(255),
  wallet_ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE SET NULL,
  escalated_at timestamptz,
  idempotency_key varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_collection_attempts_status_chk
    CHECK (status IN ('pending','succeeded','failed','escalated','skipped')),
  CONSTRAINT dropship_collection_attempts_amount_chk
    CHECK (amount_cents > 0),
  CONSTRAINT dropship_collection_attempts_period_chk
    CHECK (period_end > period_start),
  CONSTRAINT dropship_collection_attempts_failures_chk
    CHECK (consecutive_failures >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_collection_attempts_vendor_period_idx
  ON dropship.dropship_collection_attempts(vendor_id, period_start);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_collection_attempts_idem_idx
  ON dropship.dropship_collection_attempts(idempotency_key);
CREATE INDEX IF NOT EXISTS dropship_collection_attempts_status_idx
  ON dropship.dropship_collection_attempts(status, period_start);

COMMENT ON TABLE dropship.dropship_collection_attempts IS
  'One row per (vendor, sweep period) collection attempt (design spec D5). Unique (vendor_id, period_start) makes the sweep idempotent per vendor per period; consecutive_failures drives escalation to human account review after the configured threshold.';

-- 4. No-inspection branch knobs (D3 + D-governing): the lost-in-transit
--    timeout (expected delivery + N days with no delivery scan) is a
--    versioned policy knob on the B1 return policy row, alongside
--    no_ship_timeout_days (migration 187).

ALTER TABLE dropship.dropship_return_policies
  ADD COLUMN IF NOT EXISTS no_inspection_timeout_days integer NOT NULL DEFAULT 10;

ALTER TABLE dropship.dropship_return_policies
  DROP CONSTRAINT IF EXISTS dropship_return_policies_no_inspection_chk;
ALTER TABLE dropship.dropship_return_policies
  ADD CONSTRAINT dropship_return_policies_no_inspection_chk
    CHECK (no_inspection_timeout_days > 0 AND no_inspection_timeout_days <= 90);

-- 5. Expected-delivery date for the return leg (D3 timeout trigger). Set by
--    the channel return-intake adapter (PR 4) or admin when the label is
--    created; NULL means the timeout path cannot fire for that RMA (only the
--    carrier lost-status path can).

ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS return_expected_delivery_at timestamptz;

COMMENT ON COLUMN dropship.dropship_rmas.return_expected_delivery_at IS
  'Carrier-promised delivery date for the return leg (design spec D3). The no-inspection watcher moves the RMA to no_inspection_review when this passes + no_inspection_timeout_days with no delivery scan. NULL disables the timeout path for the RMA.';

-- 6. Insurance pool ledger (D3 pool accounting surface). The pool is funded
--    by insurance_pool_cents collected on shipping quotes and pays out
--    no-inspection credits; when a linked carrier claim later pays out, the
--    payout replenishes the POOL (never the vendor twice). One row per pool
--    movement; running balance is derivable but not stored (audit-first).

CREATE TABLE IF NOT EXISTS dropship.dropship_insurance_pool_ledger (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entry_type varchar(40) NOT NULL,
  amount_cents bigint NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  rma_id integer REFERENCES dropship.dropship_rmas(id) ON DELETE SET NULL,
  carrier_claim_id integer REFERENCES dropship.dropship_carrier_claims(id) ON DELETE SET NULL,
  wallet_ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE SET NULL,
  reference_type varchar(80),
  reference_id varchar(255),
  idempotency_key varchar(200) NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_pool_ledger_type_chk
    CHECK (entry_type IN ('no_inspection_payout','claim_replenishment','manual_adjustment')),
  CONSTRAINT dropship_pool_ledger_amount_chk
    CHECK (amount_cents <> 0),
  CONSTRAINT dropship_pool_ledger_reference_chk
    CHECK (
      (reference_type IS NULL AND reference_id IS NULL)
      OR (reference_type IS NOT NULL AND reference_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_pool_ledger_idem_idx
  ON dropship.dropship_insurance_pool_ledger(idempotency_key);
CREATE INDEX IF NOT EXISTS dropship_pool_ledger_rma_idx
  ON dropship.dropship_insurance_pool_ledger(rma_id);
CREATE INDEX IF NOT EXISTS dropship_pool_ledger_claim_idx
  ON dropship.dropship_insurance_pool_ledger(carrier_claim_id);

COMMENT ON TABLE dropship.dropship_insurance_pool_ledger IS
  'Insurance pool accounting surface (design spec D3). no_inspection_payout rows (negative) record pool money credited to a vendor wallet for an approved no-inspection RMA; claim_replenishment rows (positive) record a carrier-claim payout returning to the pool. Replenishment credits the POOL only — the vendor is never credited twice. Idempotent via unique idempotency_key.';
