-- Controlled full-catalog inventory availability cutover.
--
-- This migration is inactive by default. It creates a singleton runtime
-- authority row initialized to legacy, durable preparation receipts, a
-- configuration freeze, and the exact provider-routing evidence required by
-- the publication outbox worker. Deploying it cannot publish inventory or
-- change ATP/reservation authority.

ALTER TABLE inventory.availability_activation_runs
  ADD COLUMN source_dry_run_id BIGINT
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT;

ALTER TABLE inventory.availability_activation_runs
  ADD COLUMN prepared_at TIMESTAMPTZ,
  ADD COLUMN publication_verified_at TIMESTAMPTZ,
  ADD COLUMN activated_at TIMESTAMPTZ,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN provider_publication_required BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE inventory.availability_activation_runs
  ADD CONSTRAINT availability_activation_runs_source_dry_run_chk CHECK (
    (mode = 'dry_run' AND source_dry_run_id IS NULL)
    OR (mode IN ('activation', 'rollback') AND source_dry_run_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT availability_activation_runs_milestone_time_chk CHECK (
    (prepared_at IS NULL OR prepared_at >= started_at)
    AND (publication_verified_at IS NULL OR (
      prepared_at IS NOT NULL AND publication_verified_at >= prepared_at
    ))
    AND (activated_at IS NULL OR (
      publication_verified_at IS NOT NULL AND activated_at >= publication_verified_at
    ))
    AND (failed_at IS NULL OR failed_at >= started_at)
  );

CREATE UNIQUE INDEX availability_activation_runs_one_cutover_uq
  ON inventory.availability_activation_runs(scope)
  WHERE mode = 'activation'
    AND state IN ('validating', 'ready_for_publication', 'publishing',
                  'publication_verified', 'activating');

CREATE TABLE inventory.availability_runtime_authority (
  singleton_key BOOLEAN PRIMARY KEY DEFAULT true,
  authority VARCHAR(20) NOT NULL DEFAULT 'legacy',
  activation_run_id BIGINT
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL DEFAULT 1,
  changed_by VARCHAR(100) NOT NULL,
  change_reason VARCHAR(1000) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT availability_runtime_authority_singleton_chk CHECK (singleton_key = true),
  CONSTRAINT availability_runtime_authority_value_chk
    CHECK (authority IN ('legacy', 'canonical')),
  CONSTRAINT availability_runtime_authority_revision_chk CHECK (revision > 0),
  CONSTRAINT availability_runtime_authority_actor_chk CHECK (
    char_length(btrim(changed_by)) BETWEEN 1 AND 100
    AND char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT availability_runtime_authority_activation_chk CHECK (
    (authority = 'legacy' AND activation_run_id IS NULL)
    OR (authority = 'canonical' AND activation_run_id IS NOT NULL)
  )
);

INSERT INTO inventory.availability_runtime_authority (
  singleton_key, authority, activation_run_id, revision, changed_by, change_reason
) VALUES (
  true, 'legacy', NULL, 1, 'migration-0638',
  'Initialize inactive inventory availability cutover authority.'
) ON CONFLICT (singleton_key) DO NOTHING;

CREATE TABLE inventory.availability_activation_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_run_id BIGINT
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  command_type VARCHAR(30) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  result_hash VARCHAR(64) NOT NULL,
  request_payload JSONB NOT NULL,
  result_payload JSONB NOT NULL,
  actor VARCHAR(100) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT availability_activation_commands_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT availability_activation_commands_type_chk
    CHECK (command_type IN ('prepare', 'abort')),
  CONSTRAINT availability_activation_commands_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$' AND result_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT availability_activation_commands_payload_chk CHECK (
    jsonb_typeof(request_payload) = 'object'
    AND jsonb_typeof(result_payload) = 'object'
  ),
  CONSTRAINT availability_activation_commands_actor_chk CHECK (
    char_length(btrim(actor)) BETWEEN 1 AND 100
    AND char_length(btrim(reason)) BETWEEN 1 AND 1000
    AND char_length(btrim(idempotency_key)) BETWEEN 1 AND 120
  )
);

CREATE TABLE inventory.availability_activation_freezes (
  activation_run_id BIGINT PRIMARY KEY
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  source_dry_run_id BIGINT NOT NULL
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  evidence_hash VARCHAR(64) NOT NULL,
  acquired_by VARCHAR(100) NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  released_by VARCHAR(100),
  released_at TIMESTAMPTZ,
  release_reason VARCHAR(1000),
  CONSTRAINT availability_activation_freezes_hash_chk
    CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT availability_activation_freezes_actor_chk CHECK (
    char_length(btrim(acquired_by)) BETWEEN 1 AND 100
    AND (
      (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
      OR (released_at IS NOT NULL
        AND released_by IS NOT NULL AND btrim(released_by) <> ''
        AND release_reason IS NOT NULL AND btrim(release_reason) <> ''
        AND released_at >= acquired_at)
    )
  )
);

CREATE UNIQUE INDEX availability_activation_freezes_one_open_uq
  ON inventory.availability_activation_freezes ((true))
  WHERE released_at IS NULL;

ALTER TABLE inventory.inventory_publication_outbox
  ADD COLUMN publication_phase VARCHAR(20) NOT NULL DEFAULT 'legacy',
  ADD COLUMN channel_id_snapshot INTEGER,
  ADD COLUMN provider_key_snapshot VARCHAR(60),
  ADD COLUMN provider_scope_type_snapshot VARCHAR(30),
  ADD COLUMN external_sku_snapshot VARCHAR(100),
  ADD COLUMN publication_target_revision_snapshot BIGINT;

ALTER TABLE inventory.inventory_publication_outbox
  ADD CONSTRAINT inventory_publication_outbox_phase_chk
    CHECK (publication_phase IN ('legacy', 'conservative', 'full')),
  ADD CONSTRAINT inventory_publication_outbox_cutover_identity_chk CHECK (
    activation_run_id IS NULL OR (
      publication_phase IN ('conservative', 'full')
      AND channel_id_snapshot IS NOT NULL
      AND provider_key_snapshot IS NOT NULL AND btrim(provider_key_snapshot) <> ''
      AND provider_scope_type_snapshot IN ('account', 'location')
      AND publication_target_revision_snapshot IS NOT NULL
      AND publication_target_revision_snapshot > 0
    )
  ) NOT VALID,
  ADD CONSTRAINT inventory_publication_outbox_external_sku_chk CHECK (
    external_sku_snapshot IS NULL
    OR char_length(btrim(external_sku_snapshot)) BETWEEN 1 AND 100
  );

CREATE INDEX inventory_publication_outbox_activation_phase_idx
  ON inventory.inventory_publication_outbox(activation_run_id, publication_phase, state, id);

CREATE TABLE inventory.inventory_publication_readback_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state VARCHAR(20) NOT NULL DEFAULT 'running',
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  result_hash VARCHAR(64),
  result_payload JSONB,
  requested_by VARCHAR(100) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_readback_runs_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT inventory_publication_readback_runs_state_chk
    CHECK (state IN ('running', 'completed', 'partial')),
  CONSTRAINT inventory_publication_readback_runs_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT inventory_publication_readback_runs_payload_chk CHECK (
    (state = 'running' AND result_hash IS NULL AND result_payload IS NULL AND completed_at IS NULL)
    OR (state IN ('completed', 'partial')
      AND result_hash IS NOT NULL AND jsonb_typeof(result_payload) = 'object'
      AND completed_at IS NOT NULL AND completed_at >= started_at)
  ),
  CONSTRAINT inventory_publication_readback_runs_actor_chk CHECK (
    char_length(btrim(idempotency_key)) BETWEEN 1 AND 120
    AND char_length(btrim(requested_by)) BETWEEN 1 AND 100
    AND char_length(btrim(reason)) BETWEEN 1 AND 1000
  )
);

CREATE TABLE inventory.inventory_publication_readback_run_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  readback_run_id BIGINT NOT NULL
    REFERENCES inventory.inventory_publication_readback_runs(id) ON DELETE RESTRICT,
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL,
  evidence_hash VARCHAR(64) NOT NULL,
  evidence_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_readback_run_items_identity_uq
    UNIQUE (readback_run_id, publication_target_id, product_variant_id),
  CONSTRAINT inventory_publication_readback_run_items_status_chk
    CHECK (status IN ('observed', 'failed')),
  CONSTRAINT inventory_publication_readback_run_items_evidence_chk CHECK (
    evidence_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(evidence_payload) = 'object'
  )
);

ALTER TABLE inventory.inventory_publication_readbacks
  ADD COLUMN readback_run_id BIGINT
    REFERENCES inventory.inventory_publication_readback_runs(id) ON DELETE RESTRICT,
  ADD COLUMN channel_connection_id_snapshot INTEGER,
  ADD COLUMN provider_scope_type_snapshot VARCHAR(30),
  ADD COLUMN external_scope_id_snapshot VARCHAR(240),
  ADD COLUMN publication_target_revision_snapshot BIGINT;

ALTER TABLE inventory.inventory_publication_readbacks
  ADD CONSTRAINT inventory_publication_readbacks_exact_target_snapshot_chk CHECK (
    (channel_connection_id_snapshot IS NULL
      AND provider_scope_type_snapshot IS NULL
      AND external_scope_id_snapshot IS NULL
      AND publication_target_revision_snapshot IS NULL)
    OR (channel_connection_id_snapshot IS NOT NULL
      AND provider_scope_type_snapshot IN ('account', 'location')
      AND external_scope_id_snapshot IS NOT NULL AND btrim(external_scope_id_snapshot) <> ''
      AND publication_target_revision_snapshot IS NOT NULL
      AND publication_target_revision_snapshot > 0)
  );

ALTER TABLE inventory.availability_activation_events
  ADD COLUMN evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE inventory.availability_activation_events
  ADD CONSTRAINT availability_activation_events_payload_chk
    CHECK (jsonb_typeof(evidence_payload) = 'object');

CREATE OR REPLACE FUNCTION inventory.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER availability_activation_commands_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.availability_activation_commands
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE TRIGGER inventory_publication_readback_run_items_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.inventory_publication_readback_run_items
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_readback_run_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.state <> 'running' OR NEW.state NOT IN ('completed', 'partial') THEN
    RAISE EXCEPTION 'invalid inventory publication readback run transition';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory publication readback request evidence is immutable';
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_publication_readback_runs_update_guard
BEFORE UPDATE ON inventory.inventory_publication_readback_runs
FOR EACH ROW EXECUTE FUNCTION inventory.guard_inventory_publication_readback_run_update();

CREATE TRIGGER inventory_publication_readback_runs_delete_guard
BEFORE DELETE ON inventory.inventory_publication_readback_runs
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION inventory.guard_availability_activation_freeze_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.activation_run_id IS DISTINCT FROM NEW.activation_run_id
     OR OLD.source_dry_run_id IS DISTINCT FROM NEW.source_dry_run_id
     OR OLD.evidence_hash IS DISTINCT FROM NEW.evidence_hash
     OR OLD.acquired_by IS DISTINCT FROM NEW.acquired_by
     OR OLD.acquired_at IS DISTINCT FROM NEW.acquired_at THEN
    RAISE EXCEPTION 'activation freeze acquisition evidence is immutable';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released activation freeze is immutable';
  END IF;
  IF NEW.released_at IS NULL
     OR NEW.released_by IS NULL OR btrim(NEW.released_by) = ''
     OR NEW.release_reason IS NULL OR btrim(NEW.release_reason) = '' THEN
    RAISE EXCEPTION 'activation freeze release evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER availability_activation_freezes_update_guard
BEFORE UPDATE ON inventory.availability_activation_freezes
FOR EACH ROW EXECUTE FUNCTION inventory.guard_availability_activation_freeze_update();

CREATE TRIGGER availability_activation_freezes_delete_guard
BEFORE DELETE ON inventory.availability_activation_freezes
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION inventory.guard_availability_runtime_authority_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  activation_state VARCHAR(40);
BEGIN
  IF OLD.singleton_key IS DISTINCT FROM NEW.singleton_key THEN
    RAISE EXCEPTION 'runtime authority singleton identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'runtime authority revision must increment by 1';
  END IF;
  IF OLD.authority = 'canonical' AND NEW.authority <> 'canonical' THEN
    RAISE EXCEPTION 'the first canonical cutover cannot return to legacy authority';
  END IF;
  IF OLD.authority = 'legacy' AND NEW.authority = 'canonical' THEN
    SELECT state INTO activation_state
    FROM inventory.availability_activation_runs
    WHERE id = NEW.activation_run_id
    FOR SHARE;
    IF activation_state <> 'activating' THEN
      RAISE EXCEPTION 'canonical authority requires its activation run to be activating';
    END IF;
  ELSIF NEW.authority IS DISTINCT FROM OLD.authority
     OR NEW.activation_run_id IS DISTINCT FROM OLD.activation_run_id THEN
    RAISE EXCEPTION 'invalid runtime authority transition';
  END IF;
  NEW.changed_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER availability_runtime_authority_update_guard
BEFORE UPDATE ON inventory.availability_runtime_authority
FOR EACH ROW EXECUTE FUNCTION inventory.guard_availability_runtime_authority_update();

CREATE TRIGGER availability_runtime_authority_delete_guard
BEFORE DELETE ON inventory.availability_runtime_authority
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
     OR NEW.source_dry_run_id IS DISTINCT FROM OLD.source_dry_run_id
     OR NEW.provider_publication_required IS DISTINCT FROM OLD.provider_publication_required
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

  IF OLD.runtime_authority_changed AND NOT NEW.runtime_authority_changed THEN
    RAISE EXCEPTION 'runtime authority evidence cannot be cleared';
  END IF;
  IF OLD.provider_write_attempted AND NOT NEW.provider_write_attempted THEN
    RAISE EXCEPTION 'provider-write evidence cannot be cleared';
  END IF;
  IF OLD.outbox_enqueued AND NOT NEW.outbox_enqueued THEN
    RAISE EXCEPTION 'outbox evidence cannot be cleared';
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

  IF NEW.provider_publication_required
     AND NEW.state IN ('publishing', 'publication_verified', 'activating', 'active')
     AND NOT NEW.outbox_enqueued THEN
    RAISE EXCEPTION 'publication states require durable outbox evidence';
  END IF;
  IF NEW.provider_publication_required
     AND NEW.state IN ('publication_verified', 'activating', 'active')
     AND NOT NEW.provider_write_attempted THEN
    RAISE EXCEPTION 'verified publication states require provider-attempt evidence';
  END IF;
  IF NEW.state = 'active' AND NOT NEW.runtime_authority_changed THEN
    RAISE EXCEPTION 'active state requires canonical runtime authority evidence';
  END IF;

  IF NEW.prepared_at IS DISTINCT FROM OLD.prepared_at AND OLD.prepared_at IS NOT NULL THEN
    RAISE EXCEPTION 'prepared milestone is immutable once recorded';
  END IF;
  IF NEW.publication_verified_at IS DISTINCT FROM OLD.publication_verified_at
     AND OLD.publication_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'publication verified milestone is immutable once recorded';
  END IF;
  IF NEW.activated_at IS DISTINCT FROM OLD.activated_at AND OLD.activated_at IS NOT NULL THEN
    RAISE EXCEPTION 'activation milestone is immutable once recorded';
  END IF;
  IF NEW.failed_at IS DISTINCT FROM OLD.failed_at AND OLD.failed_at IS NOT NULL THEN
    RAISE EXCEPTION 'failure milestone is immutable once recorded';
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

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
     OR NEW.publication_phase IS DISTINCT FROM OLD.publication_phase
     OR NEW.channel_id_snapshot IS DISTINCT FROM OLD.channel_id_snapshot
     OR NEW.provider_key_snapshot IS DISTINCT FROM OLD.provider_key_snapshot
     OR NEW.provider_scope_type_snapshot IS DISTINCT FROM OLD.provider_scope_type_snapshot
     OR NEW.external_sku_snapshot IS DISTINCT FROM OLD.external_sku_snapshot
     OR NEW.publication_target_revision_snapshot IS DISTINCT FROM OLD.publication_target_revision_snapshot
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

CREATE OR REPLACE FUNCTION inventory.guard_cutover_configuration_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  frozen_run_id BIGINT;
  caller_run_id TEXT;
BEGIN
  SELECT activation_run_id INTO frozen_run_id
  FROM inventory.availability_activation_freezes
  WHERE released_at IS NULL;
  IF frozen_run_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  caller_run_id := current_setting('echelon.inventory_activation_run_id', true);
  IF caller_run_id IS NULL OR caller_run_id <> frozen_run_id::text THEN
    RAISE EXCEPTION 'inventory availability configuration is frozen by activation run %', frozen_run_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cutover_freeze_transformation_model_heads
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_transformation_model_versions
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_transformation_model_paths
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_paths
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_transformation_recipe_bindings
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_bindings
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_transformation_recipe_components
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_component_snapshots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_transformation_model_reviews
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_reviews
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_location_promise_policy_heads
BEFORE INSERT OR UPDATE OR DELETE ON inventory.location_promise_policy_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_location_promise_policy_versions
BEFORE INSERT OR UPDATE OR DELETE ON inventory.location_promise_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_promise_safety_policy_heads
BEFORE INSERT OR UPDATE OR DELETE ON inventory.promise_safety_policy_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_promise_safety_policy_versions
BEFORE INSERT OR UPDATE OR DELETE ON inventory.promise_safety_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_channel_exposure_policy_heads
BEFORE INSERT OR UPDATE OR DELETE ON inventory.channel_exposure_policy_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_channel_exposure_policy_versions
BEFORE INSERT OR UPDATE OR DELETE ON inventory.channel_exposure_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_publication_source_binding_heads
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_source_binding_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_publication_source_binding_versions
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_source_binding_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_publication_source_binding_members
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_source_binding_members
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_publication_variant_mapping_heads
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_variant_mapping_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_publication_variant_mapping_versions
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_variant_mapping_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();
CREATE TRIGGER cutover_freeze_inventory_publication_targets
BEFORE INSERT OR UPDATE OR DELETE ON inventory.inventory_publication_targets
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write();

COMMENT ON TABLE inventory.availability_runtime_authority IS
  'Reserved singleton ATP/reservation authority. Migration 0638 initializes legacy; this release exposes no operation that can switch it to canonical.';
COMMENT ON TABLE inventory.availability_activation_freezes IS
  'One durable full-catalog configuration freeze held while conservative publication is prepared, verified, or explicitly aborted.';
COMMENT ON TABLE inventory.availability_activation_commands IS
  'Append-only, idempotent prepare and abort command receipts for the role-gated conservative publication preparation.';
COMMENT ON TABLE inventory.inventory_publication_readback_runs IS
  'Audited exact provider quantity observations captured before conservative inventory publication.';
