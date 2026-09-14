-- Durable saga boundary for canonical dropship acceptance.
--
-- Canonical inventory claims own a SERIALIZABLE transaction and therefore
-- cannot participate in the wallet/OMS acceptance transaction. This record
-- makes the required prepare -> claim -> finalize sequence resumable without
-- confirming or charging the vendor before inventory authority succeeds.

CREATE TABLE IF NOT EXISTS dropship.dropship_order_acceptance_stages (
  intake_id integer PRIMARY KEY
    REFERENCES dropship.dropship_order_intake(id) ON DELETE RESTRICT,
  oms_order_id bigint NOT NULL UNIQUE
    REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  vendor_id integer NOT NULL
    REFERENCES dropship.dropship_vendors(id) ON DELETE RESTRICT,
  store_connection_id integer NOT NULL
    REFERENCES dropship.dropship_store_connections(id) ON DELETE RESTRICT,
  shipping_quote_snapshot_id integer NOT NULL
    REFERENCES dropship.dropship_shipping_quote_snapshots(id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id),
  wallet_account_id integer NOT NULL
    REFERENCES dropship.dropship_wallet_accounts(id) ON DELETE RESTRICT,
  state varchar(30) NOT NULL DEFAULT 'prepared',
  claim_attempt_number integer CHECK (claim_attempt_number IS NULL OR claim_attempt_number > 0),
  wms_order_id integer REFERENCES wms.orders(id) ON DELETE RESTRICT,
  request_hash varchar(64) NOT NULL,
  submitted_idempotency_key varchar(200) NOT NULL,
  actor_type varchar(20) NOT NULL,
  actor_id varchar(255),
  member_id varchar(255) NOT NULL,
  membership_plan_id varchar(255),
  currency varchar(3) NOT NULL,
  retail_subtotal_cents bigint NOT NULL,
  wholesale_subtotal_cents bigint NOT NULL,
  shipping_cents bigint NOT NULL,
  insurance_pool_cents bigint NOT NULL,
  fees_cents bigint NOT NULL,
  total_debit_cents bigint NOT NULL,
  cost_evidence_hash varchar(64) NOT NULL,
  pricing_snapshot jsonb NOT NULL,
  prepared_at timestamptz NOT NULL,
  inventory_claimed_at timestamptz,
  inventory_release_requested_at timestamptz,
  inventory_released_at timestamptz,
  inventory_release_reason text,
  expired_at timestamptz,
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT dropship_order_acceptance_stage_state_chk
    CHECK (state IN (
      'prepared',
      'inventory_claimed',
      'compensation_pending',
      'inventory_released',
      'expired',
      'finalized'
    )),
  CONSTRAINT dropship_order_acceptance_stage_request_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT dropship_order_acceptance_stage_cost_hash_chk
    CHECK (cost_evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT dropship_order_acceptance_stage_actor_chk
    CHECK (
      actor_type IN ('vendor', 'admin', 'system', 'job')
      AND (actor_id IS NULL OR btrim(actor_id) <> '')
    ),
  CONSTRAINT dropship_order_acceptance_stage_identity_chk CHECK (
    btrim(submitted_idempotency_key) <> ''
    AND btrim(member_id) <> ''
    AND currency ~ '^[A-Z]{3}$'
    AND jsonb_typeof(pricing_snapshot) = 'object'
  ),
  CONSTRAINT dropship_order_acceptance_stage_money_chk CHECK (
    retail_subtotal_cents >= 0
    AND wholesale_subtotal_cents >= 0
    AND shipping_cents >= 0
    AND insurance_pool_cents >= 0
    AND fees_cents >= 0
    AND total_debit_cents > 0
    AND total_debit_cents = wholesale_subtotal_cents + shipping_cents + fees_cents
  ),
  CONSTRAINT dropship_order_acceptance_stage_claim_state_chk CHECK (
    (state = 'prepared'
      AND claim_attempt_number IS NULL
      AND wms_order_id IS NULL
      AND inventory_claimed_at IS NULL
      AND inventory_release_requested_at IS NULL
      AND inventory_released_at IS NULL
      AND inventory_release_reason IS NULL
      AND expired_at IS NULL
      AND finalized_at IS NULL)
    OR (state = 'inventory_claimed'
      AND claim_attempt_number IS NOT NULL
      AND wms_order_id IS NOT NULL
      AND inventory_claimed_at IS NOT NULL
      AND inventory_release_requested_at IS NULL
      AND inventory_released_at IS NULL
      AND inventory_release_reason IS NULL
      AND expired_at IS NULL
      AND finalized_at IS NULL)
    OR (state = 'compensation_pending'
      AND claim_attempt_number IS NOT NULL
      AND wms_order_id IS NOT NULL
      AND inventory_claimed_at IS NOT NULL
      AND inventory_release_requested_at IS NOT NULL
      AND inventory_released_at IS NULL
      AND inventory_release_reason IS NOT NULL
      AND btrim(inventory_release_reason) <> ''
      AND expired_at IS NULL
      AND finalized_at IS NULL)
    OR (state = 'inventory_released'
      AND claim_attempt_number IS NOT NULL
      AND wms_order_id IS NOT NULL
      AND inventory_claimed_at IS NOT NULL
      AND inventory_release_requested_at IS NOT NULL
      AND inventory_released_at IS NOT NULL
      AND inventory_release_reason IS NOT NULL
      AND btrim(inventory_release_reason) <> ''
      AND expired_at IS NULL
      AND finalized_at IS NULL)
    OR (state = 'expired'
      AND claim_attempt_number IS NOT NULL
      AND wms_order_id IS NOT NULL
      AND inventory_claimed_at IS NOT NULL
      AND inventory_release_requested_at IS NOT NULL
      AND inventory_released_at IS NOT NULL
      AND inventory_release_reason IS NOT NULL
      AND btrim(inventory_release_reason) <> ''
      AND expired_at IS NOT NULL
      AND finalized_at IS NULL)
    OR (state = 'finalized'
      AND claim_attempt_number IS NOT NULL
      AND wms_order_id IS NOT NULL
      AND inventory_claimed_at IS NOT NULL
      AND inventory_release_requested_at IS NULL
      AND inventory_released_at IS NULL
      AND inventory_release_reason IS NULL
      AND expired_at IS NULL
      AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT dropship_order_acceptance_stage_time_order_chk CHECK (
    updated_at >= prepared_at
    AND (inventory_claimed_at IS NULL OR inventory_claimed_at >= prepared_at)
    AND (inventory_release_requested_at IS NULL OR inventory_release_requested_at >= inventory_claimed_at)
    AND (inventory_released_at IS NULL OR inventory_released_at >= inventory_release_requested_at)
    AND (expired_at IS NULL OR expired_at >= inventory_released_at)
    AND (finalized_at IS NULL OR finalized_at >= inventory_claimed_at)
    AND (inventory_claimed_at IS NULL OR updated_at >= inventory_claimed_at)
    AND (inventory_release_requested_at IS NULL OR updated_at >= inventory_release_requested_at)
    AND (inventory_released_at IS NULL OR updated_at >= inventory_released_at)
    AND (expired_at IS NULL OR updated_at >= expired_at)
    AND (finalized_at IS NULL OR updated_at >= finalized_at)
  )
);

CREATE INDEX IF NOT EXISTS dropship_order_acceptance_stages_state_idx
  ON dropship.dropship_order_acceptance_stages(state, updated_at);

ALTER TABLE dropship.dropship_order_acceptance_stages
  ADD CONSTRAINT dropship_order_acceptance_stage_attempt_parent_uk
  UNIQUE (intake_id, oms_order_id, warehouse_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_order_acceptance_claim_attempts (
  intake_id integer NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  oms_order_id bigint NOT NULL,
  wms_order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL,
  claim_authority varchar(20) NOT NULL DEFAULT 'canonical'
    CHECK (claim_authority = 'canonical'),
  claim_owner varchar(40) NOT NULL DEFAULT 'dropship_acceptance'
    CHECK (claim_owner = 'dropship_acceptance'),
  claim_outcome varchar(30) NOT NULL
    CHECK (claim_outcome IN ('claimed', 'no_claim_required')),
  availability_claim_id bigint UNIQUE
    REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  state varchar(30) NOT NULL DEFAULT 'claimed'
    CHECK (state IN ('claimed', 'compensation_pending', 'released', 'expired', 'finalized')),
  claimed_at timestamptz NOT NULL,
  release_requested_at timestamptz,
  released_at timestamptz,
  release_reason text,
  expired_at timestamptz,
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (intake_id, attempt_number),
  CONSTRAINT dropship_order_acceptance_claim_attempt_parent_fk
    FOREIGN KEY (intake_id, oms_order_id, warehouse_id)
    REFERENCES dropship.dropship_order_acceptance_stages
      (intake_id, oms_order_id, warehouse_id)
    ON DELETE RESTRICT,
  CONSTRAINT dropship_order_acceptance_claim_attempt_claim_outcome_chk CHECK (
    (claim_outcome = 'claimed' AND availability_claim_id IS NOT NULL)
    OR (claim_outcome = 'no_claim_required' AND availability_claim_id IS NULL)
  ),
  CONSTRAINT dropship_order_acceptance_claim_attempt_state_chk CHECK (
    (state = 'claimed'
      AND release_requested_at IS NULL AND released_at IS NULL
      AND release_reason IS NULL AND expired_at IS NULL AND finalized_at IS NULL)
    OR (state = 'compensation_pending'
      AND release_requested_at IS NOT NULL AND released_at IS NULL
      AND release_reason IS NOT NULL AND btrim(release_reason) <> ''
      AND expired_at IS NULL AND finalized_at IS NULL)
    OR (state = 'released'
      AND release_requested_at IS NOT NULL AND released_at IS NOT NULL
      AND release_reason IS NOT NULL AND btrim(release_reason) <> ''
      AND expired_at IS NULL AND finalized_at IS NULL)
    OR (state = 'expired'
      AND release_requested_at IS NOT NULL AND released_at IS NOT NULL
      AND release_reason IS NOT NULL AND btrim(release_reason) <> ''
      AND expired_at IS NOT NULL AND finalized_at IS NULL)
    OR (state = 'finalized'
      AND release_requested_at IS NULL AND released_at IS NULL
      AND release_reason IS NULL AND expired_at IS NULL AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT dropship_order_acceptance_claim_attempt_time_chk CHECK (
    updated_at >= claimed_at
    AND (release_requested_at IS NULL OR release_requested_at >= claimed_at)
    AND (released_at IS NULL OR released_at >= release_requested_at)
    AND (expired_at IS NULL OR expired_at >= released_at)
    AND (finalized_at IS NULL OR finalized_at >= claimed_at)
  )
);

CREATE INDEX IF NOT EXISTS dropship_order_acceptance_claim_attempts_state_idx
  ON dropship.dropship_order_acceptance_claim_attempts(state, updated_at);

ALTER TABLE dropship.dropship_order_acceptance_stages
  ADD CONSTRAINT dropship_order_acceptance_stage_current_attempt_fk
  FOREIGN KEY (intake_id, claim_attempt_number)
  REFERENCES dropship.dropship_order_acceptance_claim_attempts
    (intake_id, attempt_number)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION dropship.guard_dropship_order_acceptance_claim_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.claim_outcome = 'claimed' THEN
    PERFORM 1
    FROM inventory.availability_claims claim
    WHERE claim.id = NEW.availability_claim_id
      AND claim.order_id = NEW.wms_order_id
      AND claim.status = 'active'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'dropship acceptance attempt does not match an active canonical inventory claim';
    END IF;
  ELSE
    PERFORM 1
    FROM inventory.availability_claims claim
    WHERE claim.order_id = NEW.wms_order_id
      AND claim.status = 'active'
    LIMIT 1
    FOR SHARE;
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'dropship acceptance no-claim attempt conflicts with active inventory ownership';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_dropship_order_acceptance_claim_attempt_insert
  ON dropship.dropship_order_acceptance_claim_attempts;
CREATE TRIGGER trg_guard_dropship_order_acceptance_claim_attempt_insert
BEFORE INSERT ON dropship.dropship_order_acceptance_claim_attempts
FOR EACH ROW EXECUTE FUNCTION dropship.guard_dropship_order_acceptance_claim_attempt_insert();

CREATE OR REPLACE FUNCTION dropship.guard_dropship_order_acceptance_claim_attempt_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.intake_id, NEW.attempt_number, NEW.oms_order_id, NEW.wms_order_id,
    NEW.warehouse_id, NEW.claim_authority, NEW.claim_owner,
    NEW.claim_outcome, NEW.availability_claim_id, NEW.claimed_at
  ) IS DISTINCT FROM ROW(
    OLD.intake_id, OLD.attempt_number, OLD.oms_order_id, OLD.wms_order_id,
    OLD.warehouse_id, OLD.claim_authority, OLD.claim_owner,
    OLD.claim_outcome, OLD.availability_claim_id, OLD.claimed_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance claim attempt identity is immutable';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'claimed' AND NEW.state IN ('compensation_pending', 'finalized'))
    OR (OLD.state = 'compensation_pending' AND NEW.state IN ('released', 'expired'))
    OR (OLD.state = 'released' AND NEW.state = 'expired')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid dropship acceptance claim attempt transition';
  END IF;
  IF OLD.release_requested_at IS NOT NULL
     AND ROW(NEW.release_requested_at, NEW.release_reason)
       IS DISTINCT FROM ROW(OLD.release_requested_at, OLD.release_reason) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance claim release intent is immutable';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance claim release receipt is immutable';
  END IF;
  IF OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance claim expiry receipt is immutable';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance claim finalization receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_dropship_order_acceptance_claim_attempt_update
  ON dropship.dropship_order_acceptance_claim_attempts;
CREATE TRIGGER trg_guard_dropship_order_acceptance_claim_attempt_update
BEFORE UPDATE ON dropship.dropship_order_acceptance_claim_attempts
FOR EACH ROW EXECUTE FUNCTION dropship.guard_dropship_order_acceptance_claim_attempt_update();

CREATE OR REPLACE FUNCTION dropship.reject_dropship_order_acceptance_claim_attempt_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'dropship acceptance claim attempts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_dropship_order_acceptance_claim_attempt_delete
  ON dropship.dropship_order_acceptance_claim_attempts;
CREATE TRIGGER trg_reject_dropship_order_acceptance_claim_attempt_delete
BEFORE DELETE ON dropship.dropship_order_acceptance_claim_attempts
FOR EACH ROW EXECUTE FUNCTION dropship.reject_dropship_order_acceptance_claim_attempt_delete();

CREATE OR REPLACE FUNCTION dropship.guard_dropship_order_acceptance_stage_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reopens_after_release boolean := OLD.state = 'inventory_released' AND NEW.state = 'prepared';
BEGIN
  IF ROW(
    NEW.intake_id, NEW.oms_order_id, NEW.vendor_id, NEW.store_connection_id,
    NEW.shipping_quote_snapshot_id, NEW.warehouse_id, NEW.wallet_account_id,
    NEW.request_hash, NEW.submitted_idempotency_key, NEW.actor_type, NEW.actor_id,
    NEW.member_id, NEW.membership_plan_id, NEW.currency,
    NEW.retail_subtotal_cents, NEW.wholesale_subtotal_cents, NEW.shipping_cents,
    NEW.insurance_pool_cents, NEW.fees_cents, NEW.total_debit_cents,
    NEW.cost_evidence_hash, NEW.pricing_snapshot, NEW.prepared_at
  ) IS DISTINCT FROM ROW(
    OLD.intake_id, OLD.oms_order_id, OLD.vendor_id, OLD.store_connection_id,
    OLD.shipping_quote_snapshot_id, OLD.warehouse_id, OLD.wallet_account_id,
    OLD.request_hash, OLD.submitted_idempotency_key, OLD.actor_type, OLD.actor_id,
    OLD.member_id, OLD.membership_plan_id, OLD.currency,
    OLD.retail_subtotal_cents, OLD.wholesale_subtotal_cents, OLD.shipping_cents,
    OLD.insurance_pool_cents, OLD.fees_cents, OLD.total_debit_cents,
    OLD.cost_evidence_hash, OLD.pricing_snapshot, OLD.prepared_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'dropship acceptance stage frozen evidence is immutable';
  END IF;

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'prepared' AND NEW.state = 'inventory_claimed')
    OR (OLD.state = 'inventory_claimed' AND NEW.state IN ('compensation_pending', 'finalized'))
    OR (OLD.state = 'compensation_pending' AND NEW.state IN ('inventory_released', 'expired'))
    OR (OLD.state = 'inventory_released' AND NEW.state = 'expired')
    OR reopens_after_release
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid dropship acceptance stage transition';
  END IF;

  IF NEW.state <> 'prepared' AND NOT EXISTS (
    SELECT 1
    FROM dropship.dropship_order_acceptance_claim_attempts attempt
    WHERE attempt.intake_id = NEW.intake_id
      AND attempt.attempt_number = NEW.claim_attempt_number
      AND attempt.oms_order_id = NEW.oms_order_id
      AND attempt.wms_order_id = NEW.wms_order_id
      AND attempt.warehouse_id = NEW.warehouse_id
      AND attempt.claim_authority = 'canonical'
      AND attempt.claim_owner = 'dropship_acceptance'
      AND attempt.state = CASE NEW.state
        WHEN 'inventory_claimed' THEN 'claimed'
        WHEN 'compensation_pending' THEN 'compensation_pending'
        WHEN 'inventory_released' THEN 'released'
        WHEN 'expired' THEN 'expired'
        WHEN 'finalized' THEN 'finalized'
      END
      AND attempt.claimed_at = NEW.inventory_claimed_at
      AND attempt.release_requested_at IS NOT DISTINCT FROM NEW.inventory_release_requested_at
      AND attempt.released_at IS NOT DISTINCT FROM NEW.inventory_released_at
      AND attempt.release_reason IS NOT DISTINCT FROM NEW.inventory_release_reason
      AND attempt.expired_at IS NOT DISTINCT FROM NEW.expired_at
      AND attempt.finalized_at IS NOT DISTINCT FROM NEW.finalized_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance stage does not match its current claim attempt';
  END IF;

  IF reopens_after_release AND NOT EXISTS (
    SELECT 1
    FROM dropship.dropship_order_acceptance_claim_attempts attempt
    WHERE attempt.intake_id = OLD.intake_id
      AND attempt.attempt_number = OLD.claim_attempt_number
      AND attempt.oms_order_id = OLD.oms_order_id
      AND attempt.wms_order_id = OLD.wms_order_id
      AND attempt.warehouse_id = OLD.warehouse_id
      AND attempt.state = 'released'
      AND attempt.released_at = OLD.inventory_released_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'dropship acceptance stage cannot reopen without a durable released claim attempt';
  END IF;

  IF NOT reopens_after_release
     AND OLD.claim_attempt_number IS NOT NULL
     AND NEW.claim_attempt_number IS DISTINCT FROM OLD.claim_attempt_number THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance claim attempt identity is immutable';
  END IF;
  IF NOT reopens_after_release
     AND OLD.wms_order_id IS NOT NULL AND NEW.wms_order_id IS DISTINCT FROM OLD.wms_order_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance WMS identity is immutable';
  END IF;
  IF NOT reopens_after_release AND OLD.inventory_claimed_at IS NOT NULL
     AND NEW.inventory_claimed_at IS DISTINCT FROM OLD.inventory_claimed_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance claim receipt is immutable';
  END IF;
  IF NOT reopens_after_release AND OLD.inventory_release_requested_at IS NOT NULL
     AND ROW(NEW.inventory_release_requested_at, NEW.inventory_release_reason)
       IS DISTINCT FROM ROW(OLD.inventory_release_requested_at, OLD.inventory_release_reason) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance release intent is immutable';
  END IF;
  IF NOT reopens_after_release AND OLD.inventory_released_at IS NOT NULL
     AND NEW.inventory_released_at IS DISTINCT FROM OLD.inventory_released_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance release receipt is immutable';
  END IF;
  IF OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance expiry receipt is immutable';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dropship acceptance finalization receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_dropship_order_acceptance_stage_update
  ON dropship.dropship_order_acceptance_stages;
CREATE TRIGGER trg_guard_dropship_order_acceptance_stage_update
BEFORE UPDATE ON dropship.dropship_order_acceptance_stages
FOR EACH ROW EXECUTE FUNCTION dropship.guard_dropship_order_acceptance_stage_update();
