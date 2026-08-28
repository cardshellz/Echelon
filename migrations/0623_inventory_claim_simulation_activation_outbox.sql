-- Phase 4 claim simulation, activation-run evidence, and inactive publication outbox.
--
-- This migration is additive and inactive by construction. It does not change the
-- operational ATP reader, reservation path, inventory, recipes, channel policy,
-- provider quantities, or publication scheduling. Dry runs are constrained to
-- record false for every operational side-effect flag.

CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_id_channel_uq
  ON channels.channel_connections(id, channel_id);

CREATE TABLE inventory.planner_claim_simulation_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  request_payload JSONB NOT NULL,
  root_product_ids JSONB NOT NULL,
  snapshot_fingerprint VARCHAR(64) NOT NULL,
  snapshot_payload JSONB NOT NULL,
  plan_status VARCHAR(20) NOT NULL,
  plan_payload JSONB NOT NULL,
  blocker_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key VARCHAR(120) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  requested_by VARCHAR(100) NOT NULL,
  operational_write_attempted BOOLEAN NOT NULL DEFAULT false,
  captured_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT planner_claim_simulation_runs_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT planner_claim_simulation_runs_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT planner_claim_simulation_runs_status_chk
    CHECK (plan_status IN ('satisfied', 'partial', 'blocked')),
  CONSTRAINT planner_claim_simulation_runs_nonwriting_chk
    CHECK (operational_write_attempted = false),
  CONSTRAINT planner_claim_simulation_runs_evidence_chk CHECK (
    jsonb_typeof(request_payload) = 'object'
    AND jsonb_typeof(root_product_ids) = 'array'
    AND jsonb_array_length(root_product_ids) > 0
    AND jsonb_typeof(snapshot_payload) = 'object'
    AND jsonb_typeof(plan_payload) = 'object'
    AND jsonb_typeof(blocker_codes) = 'array'
    AND snapshot_payload ->> 'schemaVersion' = 'inventory_availability_claim_snapshot_v1'
    AND snapshot_payload ->> 'snapshotFingerprint' = snapshot_fingerprint
    AND request_payload ->> 'requestKey' = request_key
    AND plan_payload ->> 'requestKey' = request_key
    AND plan_payload ->> 'status' = plan_status
    AND plan_payload ->> 'snapshotFingerprint' = snapshot_fingerprint
  ),
  CONSTRAINT planner_claim_simulation_runs_actor_chk CHECK (
    char_length(btrim(requested_by)) BETWEEN 1 AND 100
    AND char_length(btrim(reason)) BETWEEN 1 AND 1000
    AND char_length(btrim(idempotency_key)) BETWEEN 1 AND 120
  ),
  CONSTRAINT planner_claim_simulation_runs_time_chk CHECK (completed_at >= captured_at)
);

CREATE INDEX planner_claim_simulation_runs_request_idx
  ON inventory.planner_claim_simulation_runs(request_key, completed_at DESC, id DESC);

CREATE TABLE inventory.availability_activation_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode VARCHAR(20) NOT NULL,
  scope VARCHAR(30) NOT NULL DEFAULT 'full_catalog',
  state VARCHAR(40) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  result_hash VARCHAR(64),
  expected_catalog_input_hash VARCHAR(64) NOT NULL,
  expected_catalog_result_hash VARCHAR(64) NOT NULL,
  captured_catalog_input_hash VARCHAR(64) NOT NULL,
  captured_catalog_result_hash VARCHAR(64) NOT NULL,
  evidence_payload JSONB NOT NULL,
  blocker_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key VARCHAR(120) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  requested_by VARCHAR(100) NOT NULL,
  runtime_authority_changed BOOLEAN NOT NULL DEFAULT false,
  provider_write_attempted BOOLEAN NOT NULL DEFAULT false,
  outbox_enqueued BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT availability_activation_runs_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT availability_activation_runs_mode_chk
    CHECK (mode IN ('dry_run', 'activation', 'rollback')),
  CONSTRAINT availability_activation_runs_scope_chk CHECK (scope = 'full_catalog'),
  CONSTRAINT availability_activation_runs_state_chk CHECK (state IN (
    'validating', 'blocked', 'ready_for_publication', 'publishing',
    'publication_verified', 'activating', 'active', 'failed'
  )),
  CONSTRAINT availability_activation_runs_dry_run_chk CHECK (
    mode <> 'dry_run' OR (
      state IN ('blocked', 'ready_for_publication')
      AND runtime_authority_changed = false
      AND provider_write_attempted = false
      AND outbox_enqueued = false
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT availability_activation_runs_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$')
    AND expected_catalog_input_hash ~ '^[0-9a-f]{64}$'
    AND expected_catalog_result_hash ~ '^[0-9a-f]{64}$'
    AND captured_catalog_input_hash ~ '^[0-9a-f]{64}$'
    AND captured_catalog_result_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT availability_activation_runs_evidence_chk CHECK (
    jsonb_typeof(evidence_payload) = 'object'
    AND jsonb_typeof(blocker_codes) = 'array'
  ),
  CONSTRAINT availability_activation_runs_actor_chk CHECK (
    char_length(btrim(requested_by)) BETWEEN 1 AND 100
    AND char_length(btrim(reason)) BETWEEN 1 AND 1000
    AND char_length(btrim(idempotency_key)) BETWEEN 1 AND 120
  ),
  CONSTRAINT availability_activation_runs_time_chk
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX availability_activation_runs_state_idx
  ON inventory.availability_activation_runs(state, started_at DESC, id DESC);

CREATE TABLE inventory.availability_activation_product_evidence (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_run_id BIGINT NOT NULL
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL,
  evidence_hash VARCHAR(64) NOT NULL,
  evidence_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT availability_activation_product_evidence_run_product_uq
    UNIQUE (activation_run_id, product_id),
  CONSTRAINT availability_activation_product_evidence_status_chk
    CHECK (status IN ('ready', 'blocked')),
  CONSTRAINT availability_activation_product_evidence_payload_chk CHECK (
    evidence_hash ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(evidence_payload) = 'object'
  )
);

CREATE TABLE inventory.inventory_publication_targets (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  channel_connection_id INTEGER NOT NULL,
  fulfillment_node_id INTEGER NOT NULL
    REFERENCES warehouse.fulfillment_nodes(id) ON DELETE RESTRICT,
  provider_scope_type VARCHAR(30) NOT NULL,
  external_scope_id VARCHAR(240) NOT NULL,
  publication_authority VARCHAR(30) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'disabled',
  change_reason VARCHAR(1000) NOT NULL,
  created_by VARCHAR(100) NOT NULL,
  activated_by VARCHAR(100),
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_targets_connection_channel_fk
    FOREIGN KEY (channel_connection_id, channel_id)
    REFERENCES channels.channel_connections(id, channel_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_publication_targets_identity_uq UNIQUE (
    channel_connection_id, fulfillment_node_id, provider_scope_type, external_scope_id
  ),
  CONSTRAINT inventory_publication_targets_state_chk
    CHECK (state IN ('disabled', 'preview', 'live')),
  CONSTRAINT inventory_publication_targets_scope_chk CHECK (
    provider_scope_type IN ('account', 'location')
    AND char_length(btrim(external_scope_id)) BETWEEN 1 AND 240
  ),
  CONSTRAINT inventory_publication_targets_authority_chk
    CHECK (publication_authority IN ('echelon', 'external_provider', 'manual')),
  CONSTRAINT inventory_publication_targets_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT inventory_publication_targets_activation_chk CHECK (
    (state = 'disabled' AND activated_by IS NULL AND activated_at IS NULL)
    OR (state IN ('preview', 'live')
      AND activated_by IS NOT NULL AND btrim(activated_by) <> ''
      AND activated_at IS NOT NULL)
  )
);

CREATE TABLE inventory.inventory_publication_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_run_id BIGINT
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  desired_revision BIGINT NOT NULL,
  desired_quantity BIGINT NOT NULL,
  channel_connection_id_snapshot INTEGER NOT NULL,
  external_scope_id_snapshot VARCHAR(240) NOT NULL,
  external_inventory_item_id_snapshot VARCHAR(240) NOT NULL,
  state VARCHAR(30) NOT NULL DEFAULT 'desired',
  idempotency_key VARCHAR(160) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  lease_token VARCHAR(120),
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  last_error_class VARCHAR(60),
  last_error_message VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_outbox_target_variant_revision_uq
    UNIQUE (publication_target_id, product_variant_id, desired_revision),
  CONSTRAINT inventory_publication_outbox_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT inventory_publication_outbox_quantity_chk
    CHECK (desired_revision > 0 AND desired_quantity >= 0 AND attempt_count >= 0),
  CONSTRAINT inventory_publication_outbox_state_chk CHECK (state IN (
    'desired', 'queued', 'leased', 'acknowledged', 'verified', 'drifted',
    'retryable', 'dead_letter', 'superseded', 'cancelled'
  )),
  CONSTRAINT inventory_publication_outbox_hash_chk
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inventory_publication_outbox_identity_chk CHECK (
    char_length(btrim(idempotency_key)) BETWEEN 1 AND 160
    AND btrim(external_scope_id_snapshot) <> ''
    AND btrim(external_inventory_item_id_snapshot) <> ''
  ),
  CONSTRAINT inventory_publication_outbox_lease_chk CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND btrim(lease_token) <> ''
      AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX inventory_publication_outbox_dispatch_idx
  ON inventory.inventory_publication_outbox(state, available_at, id);

CREATE TABLE inventory.inventory_publication_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id BIGINT NOT NULL
    REFERENCES inventory.inventory_publication_outbox(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  outcome VARCHAR(30) NOT NULL,
  provider_request_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response_hash VARCHAR(64),
  error_class VARCHAR(60),
  error_message VARCHAR(2000),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_attempts_outbox_attempt_uq
    UNIQUE (outbox_id, attempt_number),
  CONSTRAINT inventory_publication_attempts_outcome_chk
    CHECK (outcome IN ('acknowledged', 'retryable', 'dead_letter', 'cancelled')),
  CONSTRAINT inventory_publication_attempts_evidence_chk CHECK (
    attempt_number > 0
    AND request_hash ~ '^[0-9a-f]{64}$'
    AND (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$')
    AND btrim(provider_request_key) <> ''
    AND completed_at >= started_at
  )
);

CREATE TABLE inventory.inventory_publication_readbacks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  outbox_id BIGINT
    REFERENCES inventory.inventory_publication_outbox(id) ON DELETE RESTRICT,
  observed_quantity BIGINT NOT NULL,
  matches_desired BOOLEAN,
  evidence_hash VARCHAR(64) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_readbacks_target_variant_observed_uq
    UNIQUE (publication_target_id, product_variant_id, observed_at, evidence_hash),
  CONSTRAINT inventory_publication_readbacks_evidence_chk CHECK (
    observed_quantity >= 0
    AND evidence_hash ~ '^[0-9a-f]{64}$'
    AND (
      (outbox_id IS NULL AND matches_desired IS NULL)
      OR (outbox_id IS NOT NULL AND matches_desired IS NOT NULL)
    )
  )
);

CREATE TABLE inventory.availability_activation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_run_id BIGINT NOT NULL
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  from_state VARCHAR(40),
  to_state VARCHAR(40) NOT NULL,
  actor VARCHAR(100) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  evidence_hash VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT availability_activation_events_evidence_chk CHECK (
    evidence_hash ~ '^[0-9a-f]{64}$'
    AND char_length(btrim(actor)) BETWEEN 1 AND 100
    AND char_length(btrim(reason)) BETWEEN 1 AND 1000
  )
);

CREATE INDEX availability_activation_events_run_idx
  ON inventory.availability_activation_events(activation_run_id, occurred_at, id);

CREATE OR REPLACE FUNCTION inventory.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER planner_claim_simulation_runs_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.planner_claim_simulation_runs
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE TRIGGER availability_activation_product_evidence_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.availability_activation_product_evidence
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE TRIGGER inventory_publication_attempts_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.inventory_publication_attempts
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE TRIGGER inventory_publication_readbacks_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.inventory_publication_readbacks
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE TRIGGER availability_activation_events_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.availability_activation_events
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION inventory.guard_availability_activation_run_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.expected_catalog_input_hash IS DISTINCT FROM OLD.expected_catalog_input_hash
     OR NEW.expected_catalog_result_hash IS DISTINCT FROM OLD.expected_catalog_result_hash
     OR NEW.captured_catalog_input_hash IS DISTINCT FROM OLD.captured_catalog_input_hash
     OR NEW.captured_catalog_result_hash IS DISTINCT FROM OLD.captured_catalog_result_hash
     OR NEW.evidence_payload IS DISTINCT FROM OLD.evidence_payload
     OR NEW.blocker_codes IS DISTINCT FROM OLD.blocker_codes
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'activation run request and captured evidence are immutable';
  END IF;

  IF OLD.mode = 'dry_run' THEN
    RAISE EXCEPTION 'dry-run activation evidence is append-only';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'validating' AND NEW.state IN ('blocked', 'ready_for_publication', 'failed'))
    OR (OLD.state = 'blocked' AND NEW.state = 'validating')
    OR (OLD.state = 'ready_for_publication' AND NEW.state IN ('validating', 'publishing', 'failed'))
    OR (OLD.state = 'publishing' AND NEW.state IN ('publication_verified', 'failed'))
    OR (OLD.state = 'publication_verified' AND NEW.state IN ('activating', 'failed'))
    OR (OLD.state = 'activating' AND NEW.state IN ('active', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid activation state transition from % to %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER availability_activation_runs_state_guard
BEFORE UPDATE ON inventory.availability_activation_runs
FOR EACH ROW EXECUTE FUNCTION inventory.guard_availability_activation_run_update();

CREATE TRIGGER availability_activation_runs_delete_guard
BEFORE DELETE ON inventory.availability_activation_runs
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE TRIGGER inventory_publication_targets_delete_guard
BEFORE DELETE ON inventory.inventory_publication_targets
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  latest_revision BIGINT;
  target_connection_id INTEGER;
  target_scope_id VARCHAR(240);
BEGIN
  PERFORM pg_advisory_xact_lock(NEW.publication_target_id, NEW.product_variant_id);

  SELECT channel_connection_id, external_scope_id
  INTO target_connection_id, target_scope_id
  FROM inventory.inventory_publication_targets
  WHERE id = NEW.publication_target_id
  FOR SHARE;

  IF target_connection_id IS NULL THEN
    RAISE EXCEPTION 'publication target does not exist';
  END IF;
  IF NEW.channel_connection_id_snapshot <> target_connection_id
     OR NEW.external_scope_id_snapshot <> target_scope_id THEN
    RAISE EXCEPTION 'publication identity snapshot differs from its target';
  END IF;

  SELECT max(desired_revision)
  INTO latest_revision
  FROM inventory.inventory_publication_outbox
  WHERE publication_target_id = NEW.publication_target_id
    AND product_variant_id = NEW.product_variant_id;

  IF latest_revision IS NOT NULL AND NEW.desired_revision <= latest_revision THEN
    RAISE EXCEPTION 'publication revision must be greater than existing revision %', latest_revision;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_publication_outbox_insert_guard
BEFORE INSERT ON inventory.inventory_publication_outbox
FOR EACH ROW EXECUTE FUNCTION inventory.guard_inventory_publication_outbox_insert();

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_outbox_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.activation_run_id IS DISTINCT FROM OLD.activation_run_id
     OR NEW.publication_target_id IS DISTINCT FROM OLD.publication_target_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
     OR NEW.desired_revision IS DISTINCT FROM OLD.desired_revision
     OR NEW.desired_quantity IS DISTINCT FROM OLD.desired_quantity
     OR NEW.channel_connection_id_snapshot IS DISTINCT FROM OLD.channel_connection_id_snapshot
     OR NEW.external_scope_id_snapshot IS DISTINCT FROM OLD.external_scope_id_snapshot
     OR NEW.external_inventory_item_id_snapshot IS DISTINCT FROM OLD.external_inventory_item_id_snapshot
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication outbox desired state and identity are immutable';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'desired' AND NEW.state IN ('queued', 'cancelled', 'superseded'))
    OR (OLD.state = 'queued' AND NEW.state IN ('leased', 'cancelled', 'superseded'))
    OR (OLD.state = 'leased' AND NEW.state IN (
      'acknowledged', 'retryable', 'dead_letter', 'cancelled', 'superseded'
    ))
    OR (OLD.state = 'retryable' AND NEW.state IN ('queued', 'dead_letter', 'cancelled', 'superseded'))
    OR (OLD.state = 'acknowledged' AND NEW.state IN ('verified', 'drifted'))
    OR (OLD.state = 'drifted' AND NEW.state IN ('queued', 'dead_letter', 'cancelled', 'superseded'))
  ) THEN
    RAISE EXCEPTION 'invalid publication state transition from % to %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_publication_outbox_update_guard
BEFORE UPDATE ON inventory.inventory_publication_outbox
FOR EACH ROW EXECUTE FUNCTION inventory.guard_inventory_publication_outbox_update();

CREATE TRIGGER inventory_publication_outbox_delete_guard
BEFORE DELETE ON inventory.inventory_publication_outbox
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  latest_attempt INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(NEW.outbox_id);
  SELECT max(attempt_number)
  INTO latest_attempt
  FROM inventory.inventory_publication_attempts
  WHERE outbox_id = NEW.outbox_id;
  IF NEW.attempt_number <> COALESCE(latest_attempt, 0) + 1 THEN
    RAISE EXCEPTION 'publication attempt number must follow existing attempt %',
      COALESCE(latest_attempt, 0);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_publication_attempts_insert_guard
BEFORE INSERT ON inventory.inventory_publication_attempts
FOR EACH ROW EXECUTE FUNCTION inventory.guard_inventory_publication_attempt_insert();

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_readback_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  desired_quantity BIGINT;
  desired_target_id INTEGER;
  desired_variant_id INTEGER;
BEGIN
  IF NEW.outbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT outbox.desired_quantity, outbox.publication_target_id, outbox.product_variant_id
  INTO desired_quantity, desired_target_id, desired_variant_id
  FROM inventory.inventory_publication_outbox AS outbox
  WHERE outbox.id = NEW.outbox_id
  FOR SHARE;
  IF desired_quantity IS NULL THEN
    RAISE EXCEPTION 'publication outbox row does not exist';
  END IF;
  IF NEW.publication_target_id <> desired_target_id
     OR NEW.product_variant_id <> desired_variant_id THEN
    RAISE EXCEPTION 'readback identity differs from its publication outbox row';
  END IF;
  IF NEW.matches_desired IS DISTINCT FROM (NEW.observed_quantity = desired_quantity) THEN
    RAISE EXCEPTION 'readback match flag does not match observed and desired quantities';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_publication_readbacks_insert_guard
BEFORE INSERT ON inventory.inventory_publication_readbacks
FOR EACH ROW EXECUTE FUNCTION inventory.guard_inventory_publication_readback_insert();

COMMENT ON TABLE inventory.planner_claim_simulation_runs IS
  'Append-only Phase 4 whole-order claim plans. These rows never reserve, release, build, or mutate inventory.';
COMMENT ON TABLE inventory.availability_activation_runs IS
  'Full-catalog activation state machine. Phase 4 creates only non-writing dry-run terminal evidence.';
COMMENT ON TABLE inventory.inventory_publication_targets IS
  'Exact channel connection, fulfillment node, and provider scope for inventory publication. Defaults disabled.';
COMMENT ON TABLE inventory.inventory_publication_outbox IS
  'Absolute desired inventory quantities with monotonic per-target/SKU revisions. No Phase 4 worker consumes this table.';
COMMENT ON TABLE inventory.inventory_publication_readbacks IS
  'Provider quantity observations kept separate from provider write acknowledgement.';
