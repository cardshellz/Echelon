CREATE SCHEMA IF NOT EXISTS marketplace;

-- This index is also created by migration 159. Migration files are executed
-- alphabetically, so fresh databases need it before this migration can create
-- the composite variant/product foreign key below.
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_id_product_uidx
  ON catalog.product_variants (id, product_id);

CREATE TABLE marketplace.listing_scopes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_kind VARCHAR(20) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  marketplace_id VARCHAR(100) NOT NULL,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  created_by_type VARCHAR(20) NOT NULL,
  created_by_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_scopes_id_product_uq UNIQUE (id, product_id),
  CONSTRAINT listing_scopes_owner_kind_chk CHECK (owner_kind IN ('channel', 'dropship')),
  CONSTRAINT listing_scopes_provider_chk CHECK (
    provider = lower(btrim(provider))
    AND provider ~ '^[a-z][a-z0-9_-]{0,39}$'
  ),
  CONSTRAINT listing_scopes_marketplace_chk CHECK (
    marketplace_id = btrim(marketplace_id) AND marketplace_id <> ''
  ),
  CONSTRAINT listing_scopes_actor_chk CHECK (
    created_by_type IN ('user', 'service', 'system')
    AND created_by_id = btrim(created_by_id)
    AND created_by_id <> ''
  ),
  CONSTRAINT listing_scopes_time_chk CHECK (updated_at >= created_at)
);

CREATE INDEX listing_scopes_product_idx
  ON marketplace.listing_scopes(product_id, id);

CREATE TABLE marketplace.channel_listing_scopes (
  scope_id BIGINT PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  marketplace_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT channel_listing_scopes_scope_product_fk
    FOREIGN KEY (scope_id, product_id)
    REFERENCES marketplace.listing_scopes(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT channel_listing_scopes_owner_uq
    UNIQUE (channel_id, product_id, marketplace_id),
  CONSTRAINT channel_listing_scopes_marketplace_chk CHECK (
    marketplace_id = btrim(marketplace_id) AND marketplace_id <> ''
  )
);

CREATE TABLE marketplace.dropship_listing_scopes (
  scope_id BIGINT PRIMARY KEY,
  store_connection_id INTEGER NOT NULL
    REFERENCES dropship.dropship_store_connections(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  marketplace_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT dropship_listing_scopes_scope_product_fk
    FOREIGN KEY (scope_id, product_id)
    REFERENCES marketplace.listing_scopes(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT dropship_listing_scopes_owner_uq
    UNIQUE (store_connection_id, product_id, marketplace_id),
  CONSTRAINT dropship_listing_scopes_marketplace_chk CHECK (
    marketplace_id = btrim(marketplace_id) AND marketplace_id <> ''
  )
);

CREATE TABLE marketplace.listing_publications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  supersedes_publication_id BIGINT,
  status VARCHAR(30) NOT NULL,
  desired_state_hash VARCHAR(64) NOT NULL,
  provider_publication_key VARCHAR(255),
  external_listing_id VARCHAR(255),
  external_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_type VARCHAR(20) NOT NULL,
  created_by_id VARCHAR(255) NOT NULL,
  published_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_publications_scope_product_fk
    FOREIGN KEY (scope_id, product_id)
    REFERENCES marketplace.listing_scopes(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT listing_publications_id_scope_uq UNIQUE (id, scope_id),
  CONSTRAINT listing_publications_id_scope_product_uq UNIQUE (id, scope_id, product_id),
  CONSTRAINT listing_publications_scope_generation_uq UNIQUE (scope_id, generation),
  CONSTRAINT listing_publications_supersedes_scope_fk
    FOREIGN KEY (supersedes_publication_id, scope_id)
    REFERENCES marketplace.listing_publications(id, scope_id) ON DELETE RESTRICT,
  CONSTRAINT listing_publications_generation_chk CHECK (generation > 0),
  CONSTRAINT listing_publications_status_chk CHECK (
    status IN ('planned', 'staged', 'active', 'superseded', 'withdrawn', 'failed')
  ),
  CONSTRAINT listing_publications_hash_chk CHECK (
    desired_state_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT listing_publications_external_identity_chk CHECK (
    (provider_publication_key IS NULL OR (
      provider_publication_key = btrim(provider_publication_key)
      AND provider_publication_key <> ''
    ))
    AND (external_listing_id IS NULL OR (
      external_listing_id = btrim(external_listing_id)
      AND external_listing_id <> ''
    ))
    AND (external_url IS NULL OR external_listing_id IS NOT NULL)
    AND (published_at IS NULL OR external_listing_id IS NOT NULL)
  ),
  CONSTRAINT listing_publications_metadata_chk CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT listing_publications_actor_chk CHECK (
    created_by_type IN ('user', 'service', 'system')
    AND created_by_id = btrim(created_by_id)
    AND created_by_id <> ''
  ),
  CONSTRAINT listing_publications_time_chk CHECK (
    updated_at >= created_at
    AND (published_at IS NULL OR published_at >= created_at)
    AND (verified_at IS NULL OR (
      published_at IS NOT NULL AND verified_at >= published_at
    ))
    AND (retired_at IS NULL OR (
      verified_at IS NOT NULL AND retired_at >= verified_at
    ))
  ),
  CONSTRAINT listing_publications_lifecycle_chk CHECK (
    (
      status = 'planned'
      AND provider_publication_key IS NULL
      AND external_listing_id IS NULL
      AND external_url IS NULL
      AND published_at IS NULL
      AND verified_at IS NULL
      AND retired_at IS NULL
    )
    OR (status = 'staged' AND verified_at IS NULL AND retired_at IS NULL)
    OR (status = 'failed' AND verified_at IS NULL AND retired_at IS NULL)
    OR (
      status = 'active'
      AND external_listing_id IS NOT NULL
      AND published_at IS NOT NULL
      AND verified_at IS NOT NULL
      AND retired_at IS NULL
    )
    OR (
      status IN ('superseded', 'withdrawn')
      AND external_listing_id IS NOT NULL
      AND published_at IS NOT NULL
      AND verified_at IS NOT NULL
      AND retired_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX listing_publications_active_scope_uidx
  ON marketplace.listing_publications(scope_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX listing_publications_external_listing_uidx
  ON marketplace.listing_publications(scope_id, external_listing_id)
  WHERE external_listing_id IS NOT NULL;

CREATE UNIQUE INDEX listing_publications_provider_key_uidx
  ON marketplace.listing_publications(scope_id, provider_publication_key)
  WHERE provider_publication_key IS NOT NULL;

CREATE INDEX listing_publications_scope_history_idx
  ON marketplace.listing_publications(scope_id, generation);

CREATE TABLE marketplace.listing_publication_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_id BIGINT NOT NULL,
  scope_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  product_variant_id INTEGER NOT NULL,
  sku_snapshot VARCHAR(100) NOT NULL,
  disposition VARCHAR(20) NOT NULL,
  reason_code VARCHAR(100),
  external_variant_id VARCHAR(255),
  external_offer_id VARCHAR(255),
  external_inventory_item_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_publication_members_publication_fk
    FOREIGN KEY (publication_id, scope_id, product_id)
    REFERENCES marketplace.listing_publications(id, scope_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT listing_publication_members_variant_product_fk
    FOREIGN KEY (product_variant_id, product_id)
    REFERENCES catalog.product_variants(id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT listing_publication_members_publication_variant_uq
    UNIQUE (publication_id, product_variant_id),
  CONSTRAINT listing_publication_members_publication_sku_uq
    UNIQUE (publication_id, sku_snapshot),
  CONSTRAINT listing_publication_members_sku_chk CHECK (
    sku_snapshot = btrim(sku_snapshot) AND sku_snapshot <> ''
  ),
  CONSTRAINT listing_publication_members_disposition_chk CHECK (
    disposition IN ('included', 'excluded')
  ),
  CONSTRAINT listing_publication_members_reason_chk CHECK (
    (disposition = 'included' AND reason_code IS NULL)
    OR (
      disposition = 'excluded'
      AND reason_code IS NOT NULL
      AND reason_code = btrim(reason_code)
      AND reason_code <> ''
    )
  ),
  CONSTRAINT listing_publication_members_external_identity_chk CHECK (
    (external_variant_id IS NULL OR (
      external_variant_id = btrim(external_variant_id)
      AND external_variant_id <> ''
    ))
    AND (external_offer_id IS NULL OR (
      external_offer_id = btrim(external_offer_id)
      AND external_offer_id <> ''
    ))
    AND (external_inventory_item_id IS NULL OR (
      external_inventory_item_id = btrim(external_inventory_item_id)
      AND external_inventory_item_id <> ''
    ))
  ),
  CONSTRAINT listing_publication_members_metadata_chk CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT listing_publication_members_time_chk CHECK (updated_at >= created_at)
);

CREATE INDEX listing_publication_members_variant_history_idx
  ON marketplace.listing_publication_members(product_variant_id, publication_id);

CREATE TABLE marketplace.listing_replacement_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  source_publication_id BIGINT NOT NULL,
  target_publication_id BIGINT NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  desired_state_hash VARCHAR(64) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'planned',
  current_phase VARCHAR(30) NOT NULL DEFAULT 'preflight',
  state_version INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_limit INTEGER NOT NULL DEFAULT 5,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  requested_by_type VARCHAR(20) NOT NULL,
  requested_by_id VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(100),
  error_code VARCHAR(100),
  error_message VARCHAR(2000),
  recovery_context JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_replacement_operations_source_scope_fk
    FOREIGN KEY (source_publication_id, scope_id)
    REFERENCES marketplace.listing_publications(id, scope_id) ON DELETE RESTRICT,
  CONSTRAINT listing_replacement_operations_target_scope_fk
    FOREIGN KEY (target_publication_id, scope_id)
    REFERENCES marketplace.listing_publications(id, scope_id) ON DELETE RESTRICT,
  CONSTRAINT listing_replacement_operations_scope_idem_uq
    UNIQUE (scope_id, idempotency_key),
  CONSTRAINT listing_replacement_operations_target_uq UNIQUE (target_publication_id),
  CONSTRAINT listing_replacement_operations_publication_chk CHECK (
    source_publication_id <> target_publication_id
  ),
  CONSTRAINT listing_replacement_operations_idempotency_chk CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),
  CONSTRAINT listing_replacement_operations_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND desired_state_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT listing_replacement_operations_status_chk CHECK (
    status IN (
      'planned', 'running', 'compensating', 'completed', 'failed',
      'manual_recovery_required', 'cancelled'
    )
  ),
  CONSTRAINT listing_replacement_operations_phase_chk CHECK (
    current_phase IN (
      'preflight', 'cutover', 'publish', 'verify',
      'switch_mapping', 'compensate', 'complete'
    )
  ),
  CONSTRAINT listing_replacement_operations_attempt_chk CHECK (
    attempt_count >= 0
    AND attempt_limit BETWEEN 1 AND 100
    AND attempt_count <= attempt_limit
    AND state_version > 0
  ),
  CONSTRAINT listing_replacement_operations_actor_chk CHECK (
    requested_by_type IN ('user', 'service', 'system')
    AND requested_by_id = btrim(requested_by_id)
    AND requested_by_id <> ''
  ),
  CONSTRAINT listing_replacement_operations_error_chk CHECK (
    (error_code IS NULL AND error_message IS NULL)
    OR (
      error_code IS NOT NULL AND btrim(error_code) <> ''
      AND error_message IS NOT NULL AND btrim(error_message) <> ''
    )
  ),
  CONSTRAINT listing_replacement_operations_recovery_context_chk CHECK (
    recovery_context IS NULL OR jsonb_typeof(recovery_context) = 'object'
  ),
  CONSTRAINT listing_replacement_operations_time_chk CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR (
      completed_at >= created_at
      AND (started_at IS NULL OR completed_at >= started_at)
    ))
    AND (lease_expires_at IS NULL OR lease_expires_at > updated_at)
  ),
  CONSTRAINT listing_replacement_operations_lifecycle_chk CHECK (
    (
      status = 'planned'
      AND current_phase = 'preflight'
      AND attempt_count = 0
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'running'
      AND current_phase IN ('preflight', 'cutover', 'publish', 'verify', 'switch_mapping')
      AND attempt_count > 0
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'compensating'
      AND current_phase = 'compensate'
      AND attempt_count > 0
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'completed'
      AND current_phase = 'complete'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      status = 'failed'
      AND current_phase IN ('preflight', 'compensate')
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
    OR (
      status = 'manual_recovery_required'
      AND current_phase <> 'complete'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
    OR (
      status = 'cancelled'
      AND current_phase = 'preflight'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NULL
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    )
  )
);

CREATE UNIQUE INDEX listing_replacement_operations_active_scope_uidx
  ON marketplace.listing_replacement_operations(scope_id)
  WHERE status IN ('planned', 'running', 'compensating', 'manual_recovery_required');

CREATE INDEX listing_replacement_operations_lease_idx
  ON marketplace.listing_replacement_operations(lease_expires_at, id)
  WHERE status IN ('running', 'compensating');

CREATE INDEX listing_replacement_operations_history_idx
  ON marketplace.listing_replacement_operations(scope_id, created_at, id);

CREATE TABLE marketplace.listing_replacement_steps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id BIGINT NOT NULL
    REFERENCES marketplace.listing_replacement_operations(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  step_key VARCHAR(100) NOT NULL,
  phase VARCHAR(30) NOT NULL,
  execution_path VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_limit INTEGER NOT NULL DEFAULT 5,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_evidence JSONB,
  error_code VARCHAR(100),
  error_message VARCHAR(2000),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_replacement_steps_id_operation_phase_uq
    UNIQUE (id, operation_id, phase),
  CONSTRAINT listing_replacement_steps_operation_sequence_uq UNIQUE (operation_id, execution_path, sequence),
  CONSTRAINT listing_replacement_steps_operation_key_uq UNIQUE (operation_id, step_key),
  CONSTRAINT listing_replacement_steps_operation_idem_uq UNIQUE (operation_id, idempotency_key),
  CONSTRAINT listing_replacement_steps_sequence_chk CHECK (sequence > 0),
  CONSTRAINT listing_replacement_steps_key_chk CHECK (
    step_key = btrim(step_key)
    AND step_key ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  CONSTRAINT listing_replacement_steps_phase_chk CHECK (
    phase IN ('preflight', 'cutover', 'publish', 'verify', 'switch_mapping', 'compensate')
  ),
  CONSTRAINT listing_replacement_steps_execution_path_chk CHECK (
    execution_path IN ('forward', 'compensation')
  ),
  CONSTRAINT listing_replacement_steps_path_phase_chk CHECK (
    (
      execution_path = 'forward'
      AND phase IN ('preflight', 'cutover', 'publish', 'verify', 'switch_mapping')
    ) OR (execution_path = 'compensation' AND phase = 'compensate')
  ),
  CONSTRAINT listing_replacement_steps_status_chk CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed')
  ),
  CONSTRAINT listing_replacement_steps_idempotency_chk CHECK (
    idempotency_key = btrim(idempotency_key)
    AND idempotency_key <> ''
    AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT listing_replacement_steps_attempt_chk CHECK (
    state_version > 0
    AND attempt_count >= 0
    AND attempt_limit BETWEEN 1 AND 100
    AND attempt_count <= attempt_limit
  ),
  CONSTRAINT listing_replacement_steps_payload_chk CHECK (
    jsonb_typeof(request_payload) = 'object'
    AND (result_evidence IS NULL OR jsonb_typeof(result_evidence) = 'object')
  ),
  CONSTRAINT listing_replacement_steps_error_chk CHECK (
    (error_code IS NULL AND error_message IS NULL)
    OR (
      error_code IS NOT NULL AND btrim(error_code) <> ''
      AND error_message IS NOT NULL AND btrim(error_message) <> ''
    )
  ),
  CONSTRAINT listing_replacement_steps_time_chk CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR (
      completed_at >= created_at
      AND (started_at IS NULL OR completed_at >= started_at)
    ))
  ),
  CONSTRAINT listing_replacement_steps_lifecycle_chk CHECK (
    (
      status = 'pending' AND attempt_count = 0
      AND started_at IS NULL AND completed_at IS NULL
      AND result_evidence IS NULL AND error_code IS NULL
    )
    OR (
      status = 'running' AND attempt_count > 0
      AND started_at IS NOT NULL AND completed_at IS NULL
      AND result_evidence IS NULL AND error_code IS NULL
    )
    OR (
      status = 'succeeded' AND attempt_count > 0
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND result_evidence IS NOT NULL AND error_code IS NULL
    )
    OR (
      status = 'failed' AND attempt_count > 0
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX listing_replacement_steps_running_operation_uidx
  ON marketplace.listing_replacement_steps(operation_id)
  WHERE status = 'running';

CREATE TABLE marketplace.listing_replacement_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id BIGINT NOT NULL
    REFERENCES marketplace.listing_replacement_operations(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  phase VARCHAR(30) NOT NULL,
  step_id BIGINT,
  actor_type VARCHAR(20) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  from_status VARCHAR(40),
  to_status VARCHAR(40) NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  subject_state_version INTEGER NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_replacement_events_step_operation_phase_fk
    FOREIGN KEY (step_id, operation_id, phase)
    REFERENCES marketplace.listing_replacement_steps(id, operation_id, phase)
    ON DELETE RESTRICT,
  CONSTRAINT listing_replacement_events_operation_sequence_uq UNIQUE (operation_id, sequence),
  CONSTRAINT listing_replacement_events_sequence_chk CHECK (sequence > 0),
  CONSTRAINT listing_replacement_events_type_chk CHECK (
    event_type = btrim(event_type)
    AND event_type ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  CONSTRAINT listing_replacement_events_phase_chk CHECK (
    phase IN ('preflight', 'cutover', 'publish', 'verify', 'switch_mapping', 'compensate', 'complete')
  ),
  CONSTRAINT listing_replacement_events_actor_chk CHECK (
    actor_type IN ('user', 'service', 'system')
    AND actor_id = btrim(actor_id)
    AND actor_id <> ''
  ),
  CONSTRAINT listing_replacement_events_status_chk CHECK (
    (
      step_id IS NULL
      AND (from_status IS NULL OR from_status IN (
        'planned', 'running', 'compensating', 'completed', 'failed',
        'manual_recovery_required', 'cancelled'
      ))
      AND to_status IN (
        'planned', 'running', 'compensating', 'completed', 'failed',
        'manual_recovery_required', 'cancelled'
      )
    ) OR (
      step_id IS NOT NULL
      AND (from_status IS NULL OR from_status IN (
        'pending', 'running', 'succeeded', 'failed'
      ))
      AND to_status IN (
        'pending', 'running', 'succeeded', 'failed'
      )
    )
  ),
  CONSTRAINT listing_replacement_events_attempt_chk CHECK (
    attempt >= 0 AND subject_state_version > 0
  ),
  CONSTRAINT listing_replacement_events_evidence_chk CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE UNIQUE INDEX listing_replacement_events_operation_version_uidx
  ON marketplace.listing_replacement_events(operation_id, subject_state_version)
  WHERE step_id IS NULL;

CREATE UNIQUE INDEX listing_replacement_events_step_version_uidx
  ON marketplace.listing_replacement_events(operation_id, step_id, subject_state_version)
  WHERE step_id IS NOT NULL;

CREATE INDEX listing_replacement_events_operation_time_idx
  ON marketplace.listing_replacement_events(operation_id, created_at, id);

CREATE OR REPLACE FUNCTION marketplace.guard_channel_listing_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  scope_row marketplace.listing_scopes%ROWTYPE;
  channel_provider TEXT;
BEGIN
  SELECT * INTO scope_row
  FROM marketplace.listing_scopes
  WHERE id = NEW.scope_id;

  SELECT lower(provider) INTO channel_provider
  FROM channels.channels
  WHERE id = NEW.channel_id;

  IF scope_row.id IS NULL OR channel_provider IS NULL
     OR scope_row.owner_kind IS DISTINCT FROM 'channel'
     OR scope_row.product_id IS DISTINCT FROM NEW.product_id
     OR scope_row.marketplace_id IS DISTINCT FROM NEW.marketplace_id
     OR scope_row.provider IS DISTINCT FROM channel_provider THEN
    RAISE EXCEPTION 'Channel listing scope owner/provider/product does not match scope %', NEW.scope_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_listing_scopes_guard
BEFORE INSERT ON marketplace.channel_listing_scopes
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_scope();

CREATE OR REPLACE FUNCTION marketplace.guard_dropship_listing_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  scope_row marketplace.listing_scopes%ROWTYPE;
  store_provider TEXT;
BEGIN
  SELECT * INTO scope_row
  FROM marketplace.listing_scopes
  WHERE id = NEW.scope_id;

  SELECT lower(platform) INTO store_provider
  FROM dropship.dropship_store_connections
  WHERE id = NEW.store_connection_id;

  IF scope_row.id IS NULL OR store_provider IS NULL
     OR scope_row.owner_kind IS DISTINCT FROM 'dropship'
     OR scope_row.product_id IS DISTINCT FROM NEW.product_id
     OR scope_row.marketplace_id IS DISTINCT FROM NEW.marketplace_id
     OR scope_row.provider IS DISTINCT FROM store_provider THEN
    RAISE EXCEPTION 'Dropship listing scope owner/provider/product does not match scope %', NEW.scope_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dropship_listing_scopes_guard
BEFORE INSERT ON marketplace.dropship_listing_scopes
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_dropship_listing_scope();

CREATE OR REPLACE FUNCTION marketplace.enforce_listing_scope_owner_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  target_scope_id BIGINT;
  scope_kind TEXT;
  channel_bound BOOLEAN;
  dropship_bound BOOLEAN;
BEGIN
  -- The trigger is shared by tables with different row shapes. Branch before
  -- referencing table-specific fields because PL/pgSQL resolves every field in
  -- a CASE expression against the active trigger record at runtime.
  IF TG_TABLE_NAME = 'listing_scopes' THEN
    target_scope_id := NEW.id;
  ELSE
    target_scope_id := NEW.scope_id;
  END IF;

  SELECT owner_kind INTO scope_kind
  FROM marketplace.listing_scopes
  WHERE id = target_scope_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM marketplace.channel_listing_scopes WHERE scope_id = target_scope_id
  ) INTO channel_bound;
  SELECT EXISTS (
    SELECT 1 FROM marketplace.dropship_listing_scopes WHERE scope_id = target_scope_id
  ) INTO dropship_bound;

  IF (scope_kind = 'channel' AND (NOT channel_bound OR dropship_bound))
     OR (scope_kind = 'dropship' AND (NOT dropship_bound OR channel_bound)) THEN
    RAISE EXCEPTION 'Listing scope % must have exactly one matching owner binding', target_scope_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER listing_scopes_owner_binding_required
AFTER INSERT ON marketplace.listing_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_listing_scope_owner_binding();

CREATE CONSTRAINT TRIGGER channel_listing_scopes_owner_binding_required
AFTER INSERT ON marketplace.channel_listing_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_listing_scope_owner_binding();

CREATE CONSTRAINT TRIGGER dropship_listing_scopes_owner_binding_required
AFTER INSERT ON marketplace.dropship_listing_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_listing_scope_owner_binding();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  prior_generation INTEGER;
  has_included_member BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'planned' THEN
      RAISE EXCEPTION 'Listing publications must be created in planned status'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.generation = 1 AND NEW.supersedes_publication_id IS NOT NULL THEN
      RAISE EXCEPTION 'First publication generation cannot supersede another publication'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.generation > 1 AND NEW.supersedes_publication_id IS NULL THEN
      RAISE EXCEPTION 'Publication generation % requires a predecessor', NEW.generation
        USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_publication_id IS NOT NULL THEN
      SELECT generation INTO prior_generation
      FROM marketplace.listing_publications
      WHERE id = NEW.supersedes_publication_id AND scope_id = NEW.scope_id;
      IF prior_generation IS NULL OR prior_generation >= NEW.generation THEN
        RAISE EXCEPTION 'A publication may only supersede an earlier generation in its scope'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.scope_id, NEW.product_id, NEW.generation, NEW.supersedes_publication_id,
    NEW.desired_state_hash, NEW.created_by_type, NEW.created_by_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.scope_id, OLD.product_id, OLD.generation, OLD.supersedes_publication_id,
    OLD.desired_state_hash, OLD.created_by_type, OLD.created_by_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Publication lineage, desired state, and creator are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('superseded', 'withdrawn', 'failed') THEN
    RAISE EXCEPTION 'Terminal listing publications are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.provider_publication_key IS NOT NULL
        AND NEW.provider_publication_key IS DISTINCT FROM OLD.provider_publication_key)
     OR (OLD.external_listing_id IS NOT NULL
        AND NEW.external_listing_id IS DISTINCT FROM OLD.external_listing_id)
     OR (OLD.external_url IS NOT NULL
        AND NEW.external_url IS DISTINCT FROM OLD.external_url)
     OR (OLD.published_at IS NOT NULL
        AND NEW.published_at IS DISTINCT FROM OLD.published_at)
     OR (OLD.verified_at IS NOT NULL
        AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'Publication provider identity and timestamps are append-only'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'planned' AND NEW.status = 'failed' AND ROW(
    NEW.provider_publication_key, NEW.external_listing_id, NEW.external_url, NEW.published_at
  ) IS DISTINCT FROM ROW(
    OLD.provider_publication_key, OLD.external_listing_id, OLD.external_url, OLD.published_at
  ) THEN
    RAISE EXCEPTION 'A planned publication cannot gain provider identity while failing'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'active' AND ROW(
    NEW.provider_publication_key, NEW.external_listing_id, NEW.external_url,
    NEW.metadata, NEW.published_at, NEW.verified_at
  ) IS DISTINCT FROM ROW(
    OLD.provider_publication_key, OLD.external_listing_id, OLD.external_url,
    OLD.metadata, OLD.published_at, OLD.verified_at
  ) THEN
    RAISE EXCEPTION 'Active publication identity and evidence are immutable'
      USING ERRCODE = '23514';
  END IF;


  IF OLD.status IS DISTINCT FROM 'active' AND NEW.status = 'active' THEN
    SELECT EXISTS (
      SELECT 1
      FROM marketplace.listing_publication_members
      WHERE publication_id = NEW.id
        AND disposition = 'included'
    ) INTO has_included_member;
    IF NOT has_included_member THEN
      RAISE EXCEPTION 'A listing publication requires at least one included member before activation'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (OLD.status = 'planned' AND NEW.status NOT IN ('planned', 'staged', 'failed'))
     OR (OLD.status = 'staged' AND NEW.status NOT IN ('staged', 'active', 'failed'))
     OR (OLD.status = 'active' AND NEW.status NOT IN ('active', 'superseded', 'withdrawn')) THEN
    RAISE EXCEPTION 'Invalid listing publication transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_publications_guard
BEFORE INSERT OR UPDATE ON marketplace.listing_publications
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_publication();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_publication_member()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  publication_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Listing publication member history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO publication_status
    FROM marketplace.listing_publications
    WHERE id = NEW.publication_id
    FOR UPDATE;
    IF publication_status IS DISTINCT FROM 'planned' THEN
      RAISE EXCEPTION 'Publication members may only be added while the publication is planned'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM marketplace.listing_replacement_operations
      WHERE target_publication_id = NEW.publication_id
    ) THEN
      RAISE EXCEPTION 'Replacement target membership is sealed after operation creation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.publication_id, NEW.scope_id, NEW.product_id, NEW.product_variant_id,
    NEW.sku_snapshot, NEW.disposition, NEW.reason_code, NEW.metadata, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.publication_id, OLD.scope_id, OLD.product_id, OLD.product_variant_id,
    OLD.sku_snapshot, OLD.disposition, OLD.reason_code, OLD.metadata, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Listing publication member identity and disposition are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.external_variant_id IS NOT NULL
        AND NEW.external_variant_id IS DISTINCT FROM OLD.external_variant_id)
     OR (OLD.external_offer_id IS NOT NULL
        AND NEW.external_offer_id IS DISTINCT FROM OLD.external_offer_id)
     OR (OLD.external_inventory_item_id IS NOT NULL
        AND NEW.external_inventory_item_id IS DISTINCT FROM OLD.external_inventory_item_id) THEN
    RAISE EXCEPTION 'Publication member provider identities are append-only'
      USING ERRCODE = '23514';
  END IF;

  SELECT status INTO publication_status
  FROM marketplace.listing_publications
  WHERE id = OLD.publication_id
  FOR UPDATE;
  IF publication_status IS DISTINCT FROM 'staged' THEN
    RAISE EXCEPTION 'External member identities cannot change after publication activation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_publication_members_guard
BEFORE INSERT OR UPDATE OR DELETE ON marketplace.listing_publication_members
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_publication_member();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_replacement_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  source_status TEXT;
  target_status TEXT;
  target_predecessor BIGINT;
  target_hash TEXT;
  target_has_external_effect BOOLEAN;
  forward_step_count INTEGER;
  compensation_step_count INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state_version <> 1 THEN
      RAISE EXCEPTION 'Replacement operations must be created at state_version 1'
        USING ERRCODE = '23514';
    END IF;
    SELECT status INTO source_status
    FROM marketplace.listing_publications
    WHERE id = NEW.source_publication_id AND scope_id = NEW.scope_id
    FOR UPDATE;
    SELECT status, supersedes_publication_id, desired_state_hash
      INTO target_status, target_predecessor, target_hash
    FROM marketplace.listing_publications
    WHERE id = NEW.target_publication_id AND scope_id = NEW.scope_id
    FOR UPDATE;
    IF source_status IS DISTINCT FROM 'active'
       OR target_status IS DISTINCT FROM 'planned'
       OR target_predecessor IS DISTINCT FROM NEW.source_publication_id
       OR target_hash IS DISTINCT FROM NEW.desired_state_hash THEN
      RAISE EXCEPTION 'Replacement operation source/target publication contract is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.scope_id, NEW.source_publication_id, NEW.target_publication_id,
    NEW.idempotency_key, NEW.request_hash, NEW.desired_state_hash,
    NEW.requested_by_type, NEW.requested_by_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.scope_id, OLD.source_publication_id, OLD.target_publication_id,
    OLD.idempotency_key, OLD.request_hash, OLD.desired_state_hash,
    OLD.requested_by_type, OLD.requested_by_id, OLD.correlation_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Replacement operation identity and request are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Terminal replacement operations are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'Replacement operation state_version must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count NOT IN (OLD.attempt_count, OLD.attempt_count + 1) THEN
    RAISE EXCEPTION 'Replacement operation attempt_count may only stay fixed or advance by one'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('running', 'compensating')
     AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'A new operation lease must advance attempt_count by one'
      USING ERRCODE = '23514';
  ELSIF NEW.status IN ('running', 'compensating')
     AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
     AND OLD.status IN ('running', 'compensating')
     AND OLD.lease_expires_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'An unexpired operation lease cannot be replaced'
      USING ERRCODE = '55P03';
  ELSIF NOT (NEW.status IN ('running', 'compensating')
     AND NEW.lease_token IS DISTINCT FROM OLD.lease_token)
     AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'attempt_count may only advance when a new operation lease is acquired'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.status = 'planned' AND NEW.status NOT IN ('running', 'cancelled'))
     OR (OLD.status = 'running' AND NEW.status NOT IN (
       'running', 'compensating', 'completed', 'failed', 'manual_recovery_required'
     ))
     OR (OLD.status = 'compensating' AND NEW.status NOT IN (
       'compensating', 'failed', 'manual_recovery_required'
     ))
     OR (OLD.status = 'manual_recovery_required' AND NEW.status NOT IN (
       'running', 'compensating'
     )) THEN
    RAISE EXCEPTION 'Invalid listing replacement transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'failed' AND (
    OLD.current_phase <> 'preflight'
    OR NEW.current_phase IS DISTINCT FROM OLD.current_phase
  ) THEN
    RAISE EXCEPTION 'A replacement may fail directly only before external-effect phases'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.current_phase IS DISTINCT FROM OLD.current_phase AND NOT (
    (OLD.current_phase = 'preflight' AND NEW.current_phase IN ('cutover', 'compensate'))
    OR (OLD.current_phase = 'cutover' AND NEW.current_phase IN ('publish', 'compensate'))
    OR (OLD.current_phase = 'publish' AND NEW.current_phase IN ('verify', 'compensate'))
    OR (OLD.current_phase = 'verify' AND NEW.current_phase IN ('switch_mapping', 'compensate'))
    OR (OLD.current_phase = 'switch_mapping' AND NEW.current_phase IN ('complete', 'compensate'))
  ) THEN
    RAISE EXCEPTION 'Invalid listing replacement phase transition from % to %',
      OLD.current_phase,
      NEW.current_phase
      USING ERRCODE = '23514';
  END IF;

  IF NEW.current_phase IS DISTINCT FROM OLD.current_phase THEN
    IF NEW.current_phase = 'compensate' THEN
      IF EXISTS (
        SELECT 1 FROM marketplace.listing_replacement_steps
        WHERE operation_id = NEW.id AND status = 'running'
      ) THEN
        RAISE EXCEPTION 'Compensation cannot begin while a replacement step is running'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT COUNT(*) INTO forward_step_count
      FROM marketplace.listing_replacement_steps
      WHERE operation_id = NEW.id
        AND execution_path = 'forward'
        AND phase = OLD.current_phase;
      IF forward_step_count = 0 OR EXISTS (
        SELECT 1 FROM marketplace.listing_replacement_steps
        WHERE operation_id = NEW.id
          AND execution_path = 'forward'
          AND phase = OLD.current_phase
          AND status <> 'succeeded'
      ) THEN
        RAISE EXCEPTION 'Forward phase % requires all mandatory steps to succeed before advancement',
          OLD.current_phase
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.status IN ('completed', 'failed', 'cancelled') AND EXISTS (
    SELECT 1 FROM marketplace.listing_replacement_steps
    WHERE operation_id = NEW.id AND status = 'running'
  ) THEN
    RAISE EXCEPTION 'A replacement cannot become terminal while a step is running'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'completed' THEN
    SELECT COUNT(*) INTO forward_step_count
    FROM marketplace.listing_replacement_steps
    WHERE operation_id = NEW.id AND execution_path = 'forward';
    IF forward_step_count = 0 OR EXISTS (
      SELECT 1 FROM marketplace.listing_replacement_steps
      WHERE operation_id = NEW.id
        AND execution_path = 'forward'
        AND status <> 'succeeded'
    ) THEN
      RAISE EXCEPTION 'Replacement completion requires every mandatory forward step to succeed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'failed' AND OLD.status = 'compensating' THEN
    SELECT COUNT(*) INTO compensation_step_count
    FROM marketplace.listing_replacement_steps
    WHERE operation_id = NEW.id AND execution_path = 'compensation';
    IF compensation_step_count = 0 OR EXISTS (
      SELECT 1 FROM marketplace.listing_replacement_steps
      WHERE operation_id = NEW.id
        AND execution_path = 'compensation'
        AND status <> 'succeeded'
    ) THEN
      RAISE EXCEPTION 'Safe replacement failure requires every compensation step to succeed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('completed', 'failed', 'cancelled') THEN
    SELECT status INTO source_status
    FROM marketplace.listing_publications
    WHERE id = NEW.source_publication_id AND scope_id = NEW.scope_id
    FOR UPDATE;
    SELECT
      status,
      provider_publication_key IS NOT NULL
        OR external_listing_id IS NOT NULL
        OR external_url IS NOT NULL
        OR published_at IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM marketplace.listing_publication_members AS member
          WHERE member.publication_id = NEW.target_publication_id
            AND (
              member.external_variant_id IS NOT NULL
              OR member.external_offer_id IS NOT NULL
              OR member.external_inventory_item_id IS NOT NULL
            )
        )
      INTO target_status, target_has_external_effect
    FROM marketplace.listing_publications
    WHERE id = NEW.target_publication_id AND scope_id = NEW.scope_id
    FOR UPDATE;

    IF NEW.status = 'completed' AND (
      source_status IS DISTINCT FROM 'superseded'
      OR target_status IS DISTINCT FROM 'active'
    ) THEN
      RAISE EXCEPTION 'Completed replacement requires a superseded source and active target'
        USING ERRCODE = '23514';
    ELSIF NEW.status = 'cancelled' AND (
      source_status IS DISTINCT FROM 'active'
      OR target_status IS DISTINCT FROM 'failed'
      OR target_has_external_effect IS DISTINCT FROM FALSE
    ) THEN
      RAISE EXCEPTION 'Cancelled replacement requires an active source and untouched failed target'
        USING ERRCODE = '23514';
    ELSIF NEW.status = 'failed' AND (
      source_status IS DISTINCT FROM 'active'
      OR target_status IS DISTINCT FROM 'failed'
      OR (
        OLD.status = 'running'
        AND target_has_external_effect IS DISTINCT FROM FALSE
      )
    ) THEN
      RAISE EXCEPTION 'Failed replacement does not have a verified safe publication outcome'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_replacement_operations_guard
BEFORE INSERT OR UPDATE ON marketplace.listing_replacement_operations
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_replacement_operation();

CREATE OR REPLACE FUNCTION marketplace.enforce_listing_replacement_publication_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_operation_id BIGINT;
  operation_status TEXT;
  operation_phase TEXT;
  source_status TEXT;
  target_status TEXT;
  target_has_external_effect BOOLEAN;
  compensation_step_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'listing_replacement_operations' THEN
    checked_operation_id := NEW.id;
  ELSE
    IF OLD.status = 'active' AND NEW.status = 'withdrawn' THEN
      IF EXISTS (
        SELECT 1
        FROM marketplace.listing_replacement_operations
        WHERE source_publication_id = NEW.id
          AND scope_id = NEW.scope_id
          AND status IN (
            'planned', 'running', 'compensating', 'manual_recovery_required'
          )
      ) THEN
        RAISE EXCEPTION 'An active replacement source cannot be withdrawn'
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END IF;

    IF OLD.status = 'active' AND NEW.status = 'superseded' THEN
      SELECT operation.id INTO checked_operation_id
      FROM marketplace.listing_replacement_operations AS operation
      WHERE operation.source_publication_id = NEW.id
        AND operation.scope_id = NEW.scope_id
        AND operation.status = 'completed'
      ORDER BY operation.id DESC
      LIMIT 1;
      IF checked_operation_id IS NULL THEN
        RAISE EXCEPTION 'Publication supersession requires a completed replacement operation'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT operation.id INTO checked_operation_id
      FROM marketplace.listing_replacement_operations AS operation
      WHERE operation.target_publication_id = NEW.id;
    END IF;

    IF checked_operation_id IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT status, current_phase
    INTO operation_status, operation_phase
  FROM marketplace.listing_replacement_operations
  WHERE id = checked_operation_id;

  SELECT publication.status INTO source_status
  FROM marketplace.listing_publications AS publication
  JOIN marketplace.listing_replacement_operations AS operation
    ON operation.source_publication_id = publication.id
   AND operation.scope_id = publication.scope_id
  WHERE operation.id = checked_operation_id;

  SELECT
    publication.status,
    publication.provider_publication_key IS NOT NULL
      OR publication.external_listing_id IS NOT NULL
      OR publication.external_url IS NOT NULL
      OR publication.published_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM marketplace.listing_publication_members AS member
        WHERE member.publication_id = publication.id
          AND (
            member.external_variant_id IS NOT NULL
            OR member.external_offer_id IS NOT NULL
            OR member.external_inventory_item_id IS NOT NULL
          )
      )
    INTO target_status, target_has_external_effect
  FROM marketplace.listing_publications AS publication
  JOIN marketplace.listing_replacement_operations AS operation
    ON operation.target_publication_id = publication.id
   AND operation.scope_id = publication.scope_id
  WHERE operation.id = checked_operation_id;

  IF operation_status = 'planned' AND (
    source_status IS DISTINCT FROM 'active'
    OR target_status IS DISTINCT FROM 'planned'
    OR target_has_external_effect IS DISTINCT FROM FALSE
  ) THEN
    RAISE EXCEPTION 'Planned replacement publication state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'running' AND operation_phase IN ('preflight', 'cutover') AND (
    source_status IS DISTINCT FROM 'active'
    OR target_status IS DISTINCT FROM 'planned'
    OR target_has_external_effect IS DISTINCT FROM FALSE
  ) THEN
    RAISE EXCEPTION 'Pre-publication replacement state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'running' AND operation_phase = 'publish' AND (
    source_status IS DISTINCT FROM 'active'
    OR NOT (
      (target_status IS NOT DISTINCT FROM 'planned' AND target_has_external_effect IS FALSE)
      OR target_status IS NOT DISTINCT FROM 'staged'
    )
  ) THEN
    RAISE EXCEPTION 'Publishing replacement state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'running' AND operation_phase IN ('verify', 'switch_mapping') AND (
    source_status IS DISTINCT FROM 'active'
    OR target_status IS DISTINCT FROM 'staged'
  ) THEN
    RAISE EXCEPTION 'Verified replacement state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'compensating' AND (
    operation_phase IS DISTINCT FROM 'compensate'
    OR source_status IS DISTINCT FROM 'active'
    OR (
      target_status IS DISTINCT FROM 'planned'
      AND target_status IS DISTINCT FROM 'staged'
    )
  ) THEN
    RAISE EXCEPTION 'Compensating replacement publication state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'manual_recovery_required' AND (
    source_status IS DISTINCT FROM 'active'
    OR (
      operation_phase IN ('preflight', 'cutover')
      AND (
        target_status IS DISTINCT FROM 'planned'
        OR target_has_external_effect IS DISTINCT FROM FALSE
      )
    )
    OR (
      operation_phase = 'publish'
      AND NOT (
        (target_status IS NOT DISTINCT FROM 'planned' AND target_has_external_effect IS FALSE)
        OR target_status IS NOT DISTINCT FROM 'staged'
      )
    )
    OR (
      operation_phase IN ('verify', 'switch_mapping')
      AND target_status IS DISTINCT FROM 'staged'
    )
    OR (
      operation_phase = 'compensate'
      AND (
        target_status IS DISTINCT FROM 'planned'
        AND target_status IS DISTINCT FROM 'staged'
      )
    )
  ) THEN
    RAISE EXCEPTION 'Manual-recovery publication state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'completed' AND (
    operation_phase IS DISTINCT FROM 'complete'
    OR source_status IS DISTINCT FROM 'superseded'
    OR target_status IS DISTINCT FROM 'active'
  ) THEN
    RAISE EXCEPTION 'Completed replacement publication state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status IN ('cancelled', 'failed') AND operation_phase = 'preflight' AND (
    source_status IS DISTINCT FROM 'active'
    OR target_status IS DISTINCT FROM 'failed'
    OR target_has_external_effect IS DISTINCT FROM FALSE
  ) THEN
    RAISE EXCEPTION 'Preflight terminal replacement publication state is inconsistent'
      USING ERRCODE = '23514';
  ELSIF operation_status = 'failed' AND operation_phase = 'compensate' THEN
    SELECT COUNT(*) INTO compensation_step_count
    FROM marketplace.listing_replacement_steps
    WHERE operation_id = checked_operation_id
      AND execution_path = 'compensation';
    IF source_status IS DISTINCT FROM 'active'
       OR target_status IS DISTINCT FROM 'failed'
       OR compensation_step_count = 0
       OR EXISTS (
         SELECT 1
         FROM marketplace.listing_replacement_steps
         WHERE operation_id = checked_operation_id
           AND execution_path = 'compensation'
           AND status <> 'succeeded'
       ) THEN
      RAISE EXCEPTION 'Compensated replacement publication state is inconsistent'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER listing_replacement_operation_publications_consistent
AFTER INSERT OR UPDATE ON marketplace.listing_replacement_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_listing_replacement_publication_consistency();

CREATE CONSTRAINT TRIGGER listing_publication_replacement_consistent
AFTER UPDATE ON marketplace.listing_publications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_listing_replacement_publication_consistency();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_replacement_step()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  operation_status TEXT;
  operation_phase TEXT;
BEGIN
  SELECT status, current_phase INTO operation_status, operation_phase
  FROM marketplace.listing_replacement_operations
  WHERE id = NEW.operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Replacement step operation does not exist'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF operation_status IS DISTINCT FROM 'planned'
       OR NEW.status <> 'pending'
       OR NEW.state_version <> 1 THEN
      RAISE EXCEPTION 'Replacement steps may only be added as pending while the operation is planned'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.execution_path = 'forward' AND (
       operation_status IS DISTINCT FROM 'running'
       OR operation_phase IS DISTINCT FROM NEW.phase
     )) OR (NEW.execution_path = 'compensation' AND (
       operation_status IS DISTINCT FROM 'compensating'
       OR operation_phase IS DISTINCT FROM 'compensate'
       OR NEW.phase IS DISTINCT FROM 'compensate'
     )) THEN
    RAISE EXCEPTION 'Replacement step does not match the active operation status and phase'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
    NEW.operation_id, NEW.execution_path, NEW.sequence, NEW.step_key, NEW.phase,
    NEW.idempotency_key, NEW.request_hash, NEW.request_payload, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.execution_path, OLD.sequence, OLD.step_key, OLD.phase,
    OLD.idempotency_key, OLD.request_hash, OLD.request_payload, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Replacement step identity and request are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'Terminal replacement steps are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'Replacement step state_version must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'running' AND OLD.status IN ('pending', 'failed')
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Starting or retrying a replacement step must advance attempt_count by one'
      USING ERRCODE = '23514';
  ELSIF NOT (NEW.status = 'running' AND OLD.status IN ('pending', 'failed'))
     AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'Replacement step attempt_count may only advance when an attempt starts'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'pending' AND NEW.status <> 'running')
     OR (OLD.status = 'running' AND NEW.status NOT IN ('succeeded', 'failed'))
     OR (OLD.status = 'failed' AND NEW.status <> 'running') THEN
    RAISE EXCEPTION 'Invalid listing replacement step transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_replacement_steps_guard
BEFORE INSERT OR UPDATE ON marketplace.listing_replacement_steps
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_replacement_step();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_replacement_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  actual_state_version INTEGER;
  expected_sequence INTEGER;
  expected_from_status TEXT;
  expected_event_type TEXT;
BEGIN
  -- One operation-row lock serializes the shared event sequence across both
  -- operation and step events. Future transition writers must use the same
  -- operation-first lock order before updating individual steps.
  PERFORM 1
  FROM marketplace.listing_replacement_operations
  WHERE id = NEW.operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Replacement event operation does not exist'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.step_id IS NULL THEN
    SELECT state_version INTO actual_state_version
    FROM marketplace.listing_replacement_operations
    WHERE id = NEW.operation_id;
  ELSE
    SELECT state_version INTO actual_state_version
    FROM marketplace.listing_replacement_steps
    WHERE id = NEW.step_id AND operation_id = NEW.operation_id;
  END IF;

  IF actual_state_version IS NULL THEN
    RAISE EXCEPTION 'Replacement event subject does not exist'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.subject_state_version > actual_state_version THEN
    RAISE EXCEPTION 'Replacement event cannot describe a future subject state version'
      USING ERRCODE = '23514';
  END IF;

  expected_event_type := CASE
    WHEN NEW.step_id IS NULL THEN 'operation.' || NEW.to_status
    ELSE 'step.' || NEW.to_status
  END;
  IF NEW.event_type IS DISTINCT FROM expected_event_type THEN
    RAISE EXCEPTION 'Replacement event type does not match its subject transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.subject_state_version = 1 THEN
    expected_from_status := NULL;
  ELSE
    SELECT to_status INTO expected_from_status
    FROM marketplace.listing_replacement_events
    WHERE operation_id = NEW.operation_id
      AND step_id IS NOT DISTINCT FROM NEW.step_id
      AND subject_state_version = NEW.subject_state_version - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Replacement event requires the immediately preceding subject version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.from_status IS DISTINCT FROM expected_from_status THEN
    RAISE EXCEPTION 'Replacement event from_status must continue the versioned subject history'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(sequence), 0) + 1
    INTO expected_sequence
  FROM marketplace.listing_replacement_events
  WHERE operation_id = NEW.operation_id;
  IF NEW.sequence IS DISTINCT FROM expected_sequence THEN
    RAISE EXCEPTION 'Replacement event sequence must be contiguous per operation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_replacement_events_guard
BEFORE INSERT ON marketplace.listing_replacement_events
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_replacement_event();

CREATE OR REPLACE FUNCTION marketplace.require_listing_replacement_operation_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  expected_from_status TEXT;
  recorded_from_status TEXT;
  recorded_to_status TEXT;
  recorded_phase TEXT;
  recorded_attempt INTEGER;
  recorded_evidence JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    expected_from_status := OLD.status;
  END IF;

  SELECT from_status, to_status, phase, attempt, evidence
    INTO recorded_from_status, recorded_to_status, recorded_phase, recorded_attempt,
      recorded_evidence
  FROM marketplace.listing_replacement_events
  WHERE operation_id = NEW.id
    AND step_id IS NULL
    AND subject_state_version = NEW.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Replacement operation state version % requires an audit event', NEW.state_version
      USING ERRCODE = '23514';
  END IF;
  IF recorded_from_status IS DISTINCT FROM expected_from_status
     OR recorded_to_status IS DISTINCT FROM NEW.status
     OR recorded_phase IS DISTINCT FROM NEW.current_phase
     OR recorded_attempt IS DISTINCT FROM NEW.attempt_count THEN
    RAISE EXCEPTION 'Replacement operation audit event does not match state version %', NEW.state_version
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('failed', 'manual_recovery_required') AND (
    recorded_evidence ->> 'errorCode' IS DISTINCT FROM NEW.error_code
    OR recorded_evidence ->> 'errorMessage' IS DISTINCT FROM NEW.error_message
    OR (
      NEW.recovery_context IS NOT NULL
      AND recorded_evidence -> 'recoveryContext' IS DISTINCT FROM NEW.recovery_context
    )
  ) THEN
    RAISE EXCEPTION 'Replacement operation failure event must preserve error and recovery evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER listing_replacement_operation_event_required
AFTER INSERT OR UPDATE ON marketplace.listing_replacement_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.require_listing_replacement_operation_event();

CREATE OR REPLACE FUNCTION marketplace.require_listing_replacement_step_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  expected_from_status TEXT;
  recorded_from_status TEXT;
  recorded_to_status TEXT;
  recorded_phase TEXT;
  recorded_attempt INTEGER;
  recorded_evidence JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    expected_from_status := OLD.status;
  END IF;

  SELECT from_status, to_status, phase, attempt, evidence
    INTO recorded_from_status, recorded_to_status, recorded_phase, recorded_attempt,
      recorded_evidence
  FROM marketplace.listing_replacement_events
  WHERE operation_id = NEW.operation_id
    AND step_id = NEW.id
    AND subject_state_version = NEW.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Replacement step state version % requires an audit event', NEW.state_version
      USING ERRCODE = '23514';
  END IF;
  IF recorded_from_status IS DISTINCT FROM expected_from_status
     OR recorded_to_status IS DISTINCT FROM NEW.status
     OR recorded_phase IS DISTINCT FROM NEW.phase
     OR recorded_attempt IS DISTINCT FROM NEW.attempt_count THEN
    RAISE EXCEPTION 'Replacement step audit event does not match state version %', NEW.state_version
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'failed' AND (
    recorded_evidence ->> 'errorCode' IS DISTINCT FROM NEW.error_code
    OR recorded_evidence ->> 'errorMessage' IS DISTINCT FROM NEW.error_message
  ) THEN
    RAISE EXCEPTION 'Replacement step failure event must preserve error evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'succeeded'
     AND recorded_evidence -> 'resultEvidence' IS DISTINCT FROM NEW.result_evidence THEN
    RAISE EXCEPTION 'Replacement step success event must preserve result evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER listing_replacement_step_event_required
AFTER INSERT OR UPDATE ON marketplace.listing_replacement_steps
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace.require_listing_replacement_step_event();

CREATE OR REPLACE FUNCTION marketplace.reject_listing_replacement_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Marketplace listing replacement history is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER listing_replacement_events_immutable
BEFORE UPDATE OR DELETE ON marketplace.listing_replacement_events
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

CREATE TRIGGER listing_replacement_operations_no_delete
BEFORE DELETE ON marketplace.listing_replacement_operations
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

CREATE TRIGGER listing_replacement_steps_no_delete
BEFORE DELETE ON marketplace.listing_replacement_steps
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

CREATE TRIGGER listing_publications_no_delete
BEFORE DELETE ON marketplace.listing_publications
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

CREATE TRIGGER listing_scopes_immutable
BEFORE UPDATE OR DELETE ON marketplace.listing_scopes
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

CREATE TRIGGER channel_listing_scopes_immutable
BEFORE UPDATE OR DELETE ON marketplace.channel_listing_scopes
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

CREATE TRIGGER dropship_listing_scopes_immutable
BEFORE UPDATE OR DELETE ON marketplace.dropship_listing_scopes
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_listing_replacement_history_mutation();

COMMENT ON SCHEMA marketplace IS
  'Canonical marketplace publication generations and replacement lifecycle; provider APIs remain behind adapters.';
COMMENT ON TABLE marketplace.listing_scopes IS
  'Concurrency root for one catalog product on one owned marketplace account and marketplace.';
COMMENT ON TABLE marketplace.listing_publications IS
  'Immutable desired-state generations that allow old and replacement marketplace publications to coexist.';
COMMENT ON TABLE marketplace.listing_publication_members IS
  'Normalized variant membership snapshots for each marketplace publication generation.';
COMMENT ON TABLE marketplace.listing_replacement_operations IS
  'Durable, leased, idempotent saga state for replacing a marketplace publication.';
COMMENT ON TABLE marketplace.listing_replacement_events IS
  'Append-only, exactly-once-per-subject-version actor and state-transition evidence.';
