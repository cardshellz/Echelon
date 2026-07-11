-- Versioned carrier-protection policies and deterministic assignment rules.

CREATE TABLE IF NOT EXISTS dropship.dropship_carrier_protection_policies (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  policy_key varchar(80) NOT NULL,
  version integer NOT NULL,
  supersedes_policy_id integer REFERENCES dropship.dropship_carrier_protection_policies(id) ON DELETE RESTRICT,
  name varchar(160) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft',
  covered_loss boolean NOT NULL DEFAULT true,
  covered_misdelivery boolean NOT NULL DEFAULT true,
  covered_damage boolean NOT NULL DEFAULT true,
  merchandise_reimbursement_bps integer NOT NULL DEFAULT 10000,
  shipping_reimbursement_bps integer NOT NULL DEFAULT 10000,
  deductible_cents bigint NOT NULL DEFAULT 0,
  max_credit_cents bigint,
  loss_wait_days integer NOT NULL DEFAULT 7,
  misdelivery_wait_days integer NOT NULL DEFAULT 2,
  damage_inspection_required boolean NOT NULL DEFAULT true,
  payout_trigger varchar(40) NOT NULL DEFAULT 'internal_approval',
  carrier_claim_required boolean NOT NULL DEFAULT true,
  approval_mode varchar(20) NOT NULL DEFAULT 'manual',
  automatic_approval_limit_cents bigint,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT dropship_carrier_protection_policy_key_version_uq UNIQUE (policy_key, version),
  CONSTRAINT dropship_carrier_protection_policy_status_chk CHECK (status IN ('draft','active','retired')),
  CONSTRAINT dropship_carrier_protection_policy_coverage_chk CHECK (covered_loss OR covered_misdelivery OR covered_damage),
  CONSTRAINT dropship_carrier_protection_policy_bps_chk CHECK (
    merchandise_reimbursement_bps BETWEEN 0 AND 10000
    AND shipping_reimbursement_bps BETWEEN 0 AND 10000
  ),
  CONSTRAINT dropship_carrier_protection_policy_money_chk CHECK (
    deductible_cents >= 0
    AND (max_credit_cents IS NULL OR max_credit_cents >= 0)
    AND (automatic_approval_limit_cents IS NULL OR automatic_approval_limit_cents >= 0)
  ),
  CONSTRAINT dropship_carrier_protection_policy_wait_chk CHECK (loss_wait_days BETWEEN 0 AND 365 AND misdelivery_wait_days BETWEEN 0 AND 365),
  CONSTRAINT dropship_carrier_protection_policy_trigger_chk CHECK (payout_trigger IN ('internal_approval','carrier_claim_approved','carrier_payment_received')),
  CONSTRAINT dropship_carrier_protection_policy_approval_chk CHECK (
    approval_mode IN ('manual','automatic')
    AND (approval_mode = 'automatic' OR automatic_approval_limit_cents IS NULL)
  ),
  CONSTRAINT dropship_carrier_protection_policy_effective_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT dropship_carrier_protection_policy_retired_chk CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS dropship_carrier_protection_policy_status_idx
  ON dropship.dropship_carrier_protection_policies(status, effective_from DESC, id DESC);

CREATE TABLE IF NOT EXISTS dropship.dropship_carrier_protection_assignments (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  policy_id integer NOT NULL REFERENCES dropship.dropship_carrier_protection_policies(id) ON DELETE RESTRICT,
  name varchar(160) NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  channel_id integer REFERENCES channels.channels(id) ON DELETE RESTRICT,
  warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  carrier varchar(80),
  service varchar(120),
  destination_country varchar(2),
  destination_region varchar(100),
  min_shipment_value_cents bigint,
  max_shipment_value_cents bigint,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CONSTRAINT dropship_carrier_protection_assignment_value_chk CHECK (
    (min_shipment_value_cents IS NULL OR min_shipment_value_cents >= 0)
    AND (max_shipment_value_cents IS NULL OR max_shipment_value_cents >= 0)
    AND (min_shipment_value_cents IS NULL OR max_shipment_value_cents IS NULL OR max_shipment_value_cents >= min_shipment_value_cents)
  ),
  CONSTRAINT dropship_carrier_protection_assignment_default_chk CHECK (
    NOT is_default OR (
      channel_id IS NULL AND warehouse_id IS NULL AND carrier IS NULL AND service IS NULL
      AND destination_country IS NULL AND destination_region IS NULL
      AND min_shipment_value_cents IS NULL AND max_shipment_value_cents IS NULL
    )
  ),
  CONSTRAINT dropship_carrier_protection_assignment_deactivated_chk CHECK ((is_active = false) = (deactivated_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS dropship_carrier_protection_default_idx
  ON dropship.dropship_carrier_protection_assignments(is_default, is_active)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS dropship_carrier_protection_assignment_match_idx
  ON dropship.dropship_carrier_protection_assignments(is_active, priority DESC, id ASC);

ALTER TABLE dropship.dropship_carrier_claims
  ADD COLUMN IF NOT EXISTS event_type varchar(30),
  ADD COLUMN IF NOT EXISTS policy_id integer REFERENCES dropship.dropship_carrier_protection_policies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS wholesale_cost_snapshot_cents bigint,
  ADD COLUMN IF NOT EXISTS shipping_charge_snapshot_cents bigint,
  ADD COLUMN IF NOT EXISTS calculated_credit_cents bigint,
  ADD COLUMN IF NOT EXISTS approved_credit_cents bigint;

ALTER TABLE dropship.dropship_carrier_claims
  DROP CONSTRAINT IF EXISTS dropship_carrier_claim_event_chk,
  ADD CONSTRAINT dropship_carrier_claim_event_chk CHECK (event_type IS NULL OR event_type IN ('loss','misdelivery','damage')),
  DROP CONSTRAINT IF EXISTS dropship_carrier_claim_credit_snapshot_chk,
  ADD CONSTRAINT dropship_carrier_claim_credit_snapshot_chk CHECK (
    (wholesale_cost_snapshot_cents IS NULL OR wholesale_cost_snapshot_cents >= 0)
    AND (shipping_charge_snapshot_cents IS NULL OR shipping_charge_snapshot_cents >= 0)
    AND (calculated_credit_cents IS NULL OR calculated_credit_cents >= 0)
    AND (approved_credit_cents IS NULL OR approved_credit_cents >= 0)
  );

CREATE OR REPLACE FUNCTION dropship.guard_carrier_protection_policy_terms()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'retired carrier-protection policies cannot be reactivated' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'active carrier-protection policies cannot return to draft' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to
     AND (NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to)) THEN
    RAISE EXCEPTION 'published carrier-protection windows may only be shortened' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.policy_key IS DISTINCT FROM OLD.policy_key
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.supersedes_policy_id IS DISTINCT FROM OLD.supersedes_policy_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.covered_loss IS DISTINCT FROM OLD.covered_loss
    OR NEW.covered_misdelivery IS DISTINCT FROM OLD.covered_misdelivery
    OR NEW.covered_damage IS DISTINCT FROM OLD.covered_damage
    OR NEW.merchandise_reimbursement_bps IS DISTINCT FROM OLD.merchandise_reimbursement_bps
    OR NEW.shipping_reimbursement_bps IS DISTINCT FROM OLD.shipping_reimbursement_bps
    OR NEW.deductible_cents IS DISTINCT FROM OLD.deductible_cents
    OR NEW.max_credit_cents IS DISTINCT FROM OLD.max_credit_cents
    OR NEW.loss_wait_days IS DISTINCT FROM OLD.loss_wait_days
    OR NEW.misdelivery_wait_days IS DISTINCT FROM OLD.misdelivery_wait_days
    OR NEW.damage_inspection_required IS DISTINCT FROM OLD.damage_inspection_required
    OR NEW.payout_trigger IS DISTINCT FROM OLD.payout_trigger
    OR NEW.carrier_claim_required IS DISTINCT FROM OLD.carrier_claim_required
    OR NEW.approval_mode IS DISTINCT FROM OLD.approval_mode
    OR NEW.automatic_approval_limit_cents IS DISTINCT FROM OLD.automatic_approval_limit_cents
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
  ) THEN
    RAISE EXCEPTION 'active or retired carrier-protection policy terms are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dropship_carrier_protection_policy_terms_guard
  ON dropship.dropship_carrier_protection_policies;
CREATE TRIGGER dropship_carrier_protection_policy_terms_guard
  BEFORE UPDATE ON dropship.dropship_carrier_protection_policies
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_carrier_protection_policy_terms();

CREATE OR REPLACE FUNCTION dropship.guard_carrier_claim_policy_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.policy_id IS NOT NULL AND (
    NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
    OR NEW.wholesale_cost_snapshot_cents IS DISTINCT FROM OLD.wholesale_cost_snapshot_cents
    OR NEW.shipping_charge_snapshot_cents IS DISTINCT FROM OLD.shipping_charge_snapshot_cents
    OR NEW.calculated_credit_cents IS DISTINCT FROM OLD.calculated_credit_cents
  ) THEN
    RAISE EXCEPTION 'carrier-claim policy snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dropship_carrier_claim_policy_snapshot_guard
  ON dropship.dropship_carrier_claims;
CREATE TRIGGER dropship_carrier_claim_policy_snapshot_guard
  BEFORE UPDATE ON dropship.dropship_carrier_claims
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_carrier_claim_policy_snapshot();
