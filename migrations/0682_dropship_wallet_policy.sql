-- Dropship wallet policy: the staff-managed limits the vendor wallet enforces.
--
-- Until this migration the auto-reload floors, the manual top-up bounds, the
-- payment-hold timeout default and the hold-expiry warning window lived only in
-- environment variables (server/modules/dropship/application/dropship-wallet-service.ts
-- and server/modules/dropship/infrastructure/dropship-order-processing-runner.ts).
-- Changing a limit meant a config change on the dyno, invisible to staff and to
-- the vendor wallet page, which fell back to a hard-coded table.
--
-- Shape follows dropship.dropship_return_policies (migration 186): versioned,
-- immutable, exactly one active row enforced by a partial unique index. An edit
-- is a NEW VERSION; the previous row is retired in the same transaction. The
-- env resolvers stay in the code as the documented fallback for when no row
-- exists (an empty dev database, or the window before this migration lands).
--
-- Money is integer cents. Timings are whole minutes. Every statement is guarded
-- so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_policies (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  version integer NOT NULL,

  -- Auto-reload floors. The TRIGGER floor is the balance below which auto-reload
  -- fires; the LIMIT floor is the smallest permitted single top-up.
  minimum_floor_cents bigint NOT NULL,
  minimum_single_top_up_limit_cents bigint NOT NULL,

  -- Bounds on a vendor-initiated (manual) Stripe wallet top-up.
  manual_top_up_minimum_cents bigint NOT NULL,
  manual_top_up_maximum_cents bigint NOT NULL,

  -- How long an order waits in payment hold, and how long before expiry the
  -- vendor is warned. Both in minutes.
  default_payment_hold_timeout_minutes integer NOT NULL,
  hold_expiry_warning_minutes integer NOT NULL,

  is_active boolean NOT NULL DEFAULT true,
  change_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type varchar(40) NOT NULL,
  created_by_actor_id varchar(255),
  deactivated_at timestamptz,

  CONSTRAINT dropship_wallet_policies_version_chk
    CHECK (version > 0),
  CONSTRAINT dropship_wallet_policies_minimum_floor_chk
    CHECK (minimum_floor_cents > 0),
  CONSTRAINT dropship_wallet_policies_minimum_limit_chk
    CHECK (minimum_single_top_up_limit_cents > 0),
  CONSTRAINT dropship_wallet_policies_manual_minimum_chk
    CHECK (manual_top_up_minimum_cents > 0),
  CONSTRAINT dropship_wallet_policies_manual_maximum_chk
    CHECK (manual_top_up_maximum_cents > 0),
  -- A manual minimum above the maximum would refuse every top-up.
  CONSTRAINT dropship_wallet_policies_manual_range_chk
    CHECK (manual_top_up_minimum_cents <= manual_top_up_maximum_cents),
  -- A single top-up below the trigger floor can never clear the trigger, so
  -- auto-reload would fire forever without ever restoring the balance.
  CONSTRAINT dropship_wallet_policies_limit_covers_floor_chk
    CHECK (minimum_single_top_up_limit_cents >= minimum_floor_cents),
  -- 43200 minutes = 30 days, the ceiling the auto-reload input schema already
  -- enforces (configureDropshipAutoReloadInputSchema.paymentHoldTimeoutMinutes).
  CONSTRAINT dropship_wallet_policies_hold_timeout_chk
    CHECK (default_payment_hold_timeout_minutes BETWEEN 1 AND 43200),
  -- A warning window at or beyond the timeout would fire the moment the hold
  -- opens (or never), so it must be strictly inside the hold.
  CONSTRAINT dropship_wallet_policies_warning_window_chk
    CHECK (
      hold_expiry_warning_minutes >= 1
      AND hold_expiry_warning_minutes < default_payment_hold_timeout_minutes
    ),
  CONSTRAINT dropship_wallet_policies_actor_chk
    CHECK (created_by_actor_type IN ('admin', 'system')),
  CONSTRAINT dropship_wallet_policies_deactivated_chk
    CHECK ((is_active AND deactivated_at IS NULL) OR (NOT is_active AND deactivated_at IS NOT NULL))
);

-- Exactly one active row. The wallet resolves its limits from it on every read.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_policies_one_active_idx
  ON dropship.dropship_wallet_policies((true))
  WHERE is_active;

-- Versions are dense and unique; the history is the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_policies_version_idx
  ON dropship.dropship_wallet_policies(version);

-- Immutability. A published policy priced someone's order and gated someone's
-- auto-reload: it is never edited in place. The only permitted UPDATE is
-- retirement (active -> inactive, stamping deactivated_at), which is how a new
-- version supersedes the current one. DELETE is never permitted.
CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dropship_wallet_policies is append-only: rows cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.minimum_floor_cents IS DISTINCT FROM OLD.minimum_floor_cents
     OR NEW.minimum_single_top_up_limit_cents IS DISTINCT FROM OLD.minimum_single_top_up_limit_cents
     OR NEW.manual_top_up_minimum_cents IS DISTINCT FROM OLD.manual_top_up_minimum_cents
     OR NEW.manual_top_up_maximum_cents IS DISTINCT FROM OLD.manual_top_up_maximum_cents
     OR NEW.default_payment_hold_timeout_minutes IS DISTINCT FROM OLD.default_payment_hold_timeout_minutes
     OR NEW.hold_expiry_warning_minutes IS DISTINCT FROM OLD.hold_expiry_warning_minutes
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

-- Seed version 1 with the values the env resolvers default to today, so this
-- migration changes no behavior on deploy:
--   DEFAULT_AUTO_RELOAD_MIN_TRIGGER_CENTS        5000
--   DEFAULT_AUTO_RELOAD_MIN_AMOUNT_CENTS        10000
--   DEFAULT_STRIPE_MIN_WALLET_FUNDING_CENTS      1000
--   DEFAULT_STRIPE_MAX_WALLET_FUNDING_CENTS    500000
--   DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES 2880 (48h)
--   DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES  120
-- A deployment that overrode one of these through the environment keeps that
-- override until staff publish version 2: the env resolvers remain the fallback
-- and the admin GET shows both values side by side.
INSERT INTO dropship.dropship_wallet_policies (
  version,
  minimum_floor_cents,
  minimum_single_top_up_limit_cents,
  manual_top_up_minimum_cents,
  manual_top_up_maximum_cents,
  default_payment_hold_timeout_minutes,
  hold_expiry_warning_minutes,
  is_active,
  change_note,
  created_by_actor_type,
  created_by_actor_id
)
SELECT 1, 5000, 10000, 1000, 500000, 2880, 120, true,
       'Seeded from the launch environment defaults (migration 0681).',
       'system', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM dropship.dropship_wallet_policies
);

COMMENT ON TABLE dropship.dropship_wallet_policies IS
  'Versioned, immutable, staff-managed wallet limits. Exactly one active row; an edit is a new version. Retirement (active -> inactive) is the only permitted UPDATE.';
