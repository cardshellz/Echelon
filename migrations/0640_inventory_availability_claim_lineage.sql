BEGIN;

CREATE TABLE inventory.availability_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_key varchar(200) NOT NULL,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  status varchar(30) NOT NULL,
  plan_status varchar(20) NOT NULL,
  scope_kind varchar(20) NOT NULL,
  scope_warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  activation_run_id bigint NOT NULL
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  runtime_authority_revision bigint NOT NULL,
  request_hash varchar(64) NOT NULL,
  plan_hash varchar(64) NOT NULL,
  snapshot_fingerprint varchar(64) NOT NULL,
  request_payload jsonb NOT NULL,
  plan_payload jsonb NOT NULL,
  model_evidence jsonb NOT NULL,
  requested_by varchar(100) NOT NULL,
  reason varchar(1000) NOT NULL,
  reserved_at timestamptz NOT NULL,
  released_at timestamptz,
  cancelled_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claims_key_uq UNIQUE (claim_key),
  CONSTRAINT availability_claims_order_revision_uq UNIQUE (order_id, revision),
  CONSTRAINT availability_claims_id_key_uq UNIQUE (id, claim_key),
  CONSTRAINT availability_claims_revision_chk CHECK (revision > 0),
  CONSTRAINT availability_claims_status_chk CHECK (
    status IN ('active', 'released', 'cancelled', 'superseded', 'failed')
  ),
  CONSTRAINT availability_claims_plan_status_chk CHECK (plan_status IN ('satisfied', 'partial')),
  CONSTRAINT availability_claims_scope_chk CHECK (
    (scope_kind = 'network' AND scope_warehouse_id IS NULL)
    OR (scope_kind = 'warehouse' AND scope_warehouse_id IS NOT NULL)
  ),
  CONSTRAINT availability_claims_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND plan_hash ~ '^[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT availability_claims_authority_chk CHECK (runtime_authority_revision > 0),
  CONSTRAINT availability_claims_actor_chk CHECK (
    btrim(claim_key) <> '' AND btrim(requested_by) <> '' AND btrim(reason) <> ''
  ),
  CONSTRAINT availability_claims_evidence_chk CHECK (
    jsonb_typeof(request_payload) = 'object'
    AND jsonb_typeof(plan_payload) = 'object'
    AND jsonb_typeof(model_evidence) = 'array'
    AND request_payload ->> 'requestKey' = claim_key
    AND plan_payload ->> 'requestKey' = claim_key
    AND plan_payload ->> 'status' = plan_status
    AND plan_payload ->> 'snapshotFingerprint' = snapshot_fingerprint
  ),
  CONSTRAINT availability_claims_lifecycle_chk CHECK (
    (status = 'active' AND released_at IS NULL AND cancelled_at IS NULL AND superseded_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND cancelled_at IS NULL AND superseded_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
    OR status = 'failed'
  )
);

CREATE UNIQUE INDEX availability_claims_one_active_order_uq
  ON inventory.availability_claims (order_id)
  WHERE status = 'active';
CREATE INDEX availability_claims_order_idx
  ON inventory.availability_claims (order_id, revision DESC, id DESC);

CREATE TABLE inventory.availability_claim_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  line_key varchar(200) NOT NULL,
  order_item_id integer NOT NULL REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  target_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  requested_qty bigint NOT NULL,
  planned_qty bigint NOT NULL,
  shortfall_qty bigint NOT NULL,
  released_target_qty bigint NOT NULL DEFAULT 0,
  consumed_target_qty bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_lines_claim_key_uq UNIQUE (claim_id, line_key),
  CONSTRAINT availability_claim_lines_claim_item_uq UNIQUE (claim_id, order_item_id),
  CONSTRAINT availability_claim_lines_id_claim_uq UNIQUE (id, claim_id),
  CONSTRAINT availability_claim_lines_quantity_chk CHECK (
    requested_qty > 0
    AND planned_qty >= 0
    AND shortfall_qty >= 0
    AND requested_qty = planned_qty + shortfall_qty
    AND released_target_qty >= 0
    AND consumed_target_qty >= 0
    AND released_target_qty + consumed_target_qty <= planned_qty
  )
);

CREATE INDEX availability_claim_lines_order_item_idx
  ON inventory.availability_claim_lines (order_item_id, claim_id DESC);

CREATE TABLE inventory.availability_claim_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  claim_line_id bigint NOT NULL,
  operation_key varchar(300) NOT NULL,
  parent_operation_key varchar(300),
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  operation_type varchar(30) NOT NULL,
  authority_id integer NOT NULL,
  destination_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  planned_executions bigint NOT NULL,
  output_qty bigint NOT NULL,
  output_location_id integer REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  status varchar(30) NOT NULL DEFAULT 'pending',
  executed_executions bigint NOT NULL DEFAULT 0,
  released_executions bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_operations_line_fk
    FOREIGN KEY (claim_line_id, claim_id)
    REFERENCES inventory.availability_claim_lines(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_operations_claim_key_uq UNIQUE (claim_id, operation_key),
  CONSTRAINT availability_claim_operations_id_claim_uq UNIQUE (id, claim_id),
  CONSTRAINT availability_claim_operations_parent_fk
    FOREIGN KEY (claim_id, parent_operation_key)
    REFERENCES inventory.availability_claim_operations(claim_id, operation_key)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT availability_claim_operations_type_chk CHECK (
    operation_type IN ('break_pack', 'assemble_pack', 'directed_conversion', 'component_build')
  ),
  CONSTRAINT availability_claim_operations_status_chk CHECK (
    status IN ('pending', 'ready', 'executing', 'completed', 'released', 'failed')
  ),
  CONSTRAINT availability_claim_operations_quantity_chk CHECK (
    planned_executions > 0
    AND output_qty > 0
    AND executed_executions >= 0
    AND released_executions >= 0
    AND executed_executions + released_executions <= planned_executions
  ),
  CONSTRAINT availability_claim_operations_authority_chk CHECK (authority_id > 0)
);

CREATE INDEX availability_claim_operations_dispatch_idx
  ON inventory.availability_claim_operations (status, warehouse_id, id)
  WHERE status IN ('pending', 'ready', 'failed');

CREATE TABLE inventory.availability_claim_operation_inputs (
  claim_operation_id bigint NOT NULL,
  claim_id bigint NOT NULL,
  source_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  required_qty bigint NOT NULL,
  input_ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_operation_id, source_variant_id),
  CONSTRAINT availability_claim_operation_inputs_operation_fk
    FOREIGN KEY (claim_operation_id, claim_id)
    REFERENCES inventory.availability_claim_operations(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_operation_inputs_ordinal_uq
    UNIQUE (claim_operation_id, input_ordinal),
  CONSTRAINT availability_claim_operation_inputs_quantity_chk CHECK (required_qty > 0),
  CONSTRAINT availability_claim_operation_inputs_ordinal_chk CHECK (input_ordinal >= 0)
);

CREATE TABLE inventory.availability_claim_resources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  claim_line_id bigint NOT NULL,
  consumer_operation_key varchar(300),
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  inventory_level_id integer NOT NULL REFERENCES inventory.inventory_levels(id) ON DELETE RESTRICT,
  source_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  claimed_qty bigint NOT NULL,
  released_qty bigint NOT NULL DEFAULT 0,
  consumed_qty bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_resources_line_fk
    FOREIGN KEY (claim_line_id, claim_id)
    REFERENCES inventory.availability_claim_lines(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_resources_operation_fk
    FOREIGN KEY (claim_id, consumer_operation_key)
    REFERENCES inventory.availability_claim_operations(claim_id, operation_key)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT availability_claim_resources_id_claim_uq UNIQUE (id, claim_id),
  CONSTRAINT availability_claim_resources_quantity_chk CHECK (
    claimed_qty > 0
    AND released_qty >= 0
    AND consumed_qty >= 0
    AND released_qty + consumed_qty <= claimed_qty
  )
);

CREATE UNIQUE INDEX availability_claim_resources_identity_uq
  ON inventory.availability_claim_resources (
    claim_line_id,
    warehouse_id,
    warehouse_location_id,
    inventory_level_id,
    source_variant_id,
    COALESCE(consumer_operation_key, '')
  );
CREATE INDEX availability_claim_resources_level_idx
  ON inventory.availability_claim_resources (inventory_level_id, claim_id);

CREATE TABLE inventory.availability_claim_lot_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  claim_resource_id bigint NOT NULL,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  claimed_qty bigint NOT NULL,
  released_qty bigint NOT NULL DEFAULT 0,
  consumed_qty bigint NOT NULL DEFAULT 0,
  unit_cost_mills bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_lot_allocations_resource_fk
    FOREIGN KEY (claim_resource_id, claim_id)
    REFERENCES inventory.availability_claim_resources(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_lot_allocations_resource_lot_uq
    UNIQUE (claim_resource_id, inventory_lot_id),
  CONSTRAINT availability_claim_lot_allocations_quantity_chk CHECK (
    claimed_qty > 0
    AND released_qty >= 0
    AND consumed_qty >= 0
    AND released_qty + consumed_qty <= claimed_qty
  ),
  CONSTRAINT availability_claim_lot_allocations_cost_chk CHECK (unit_cost_mills >= 0)
);

CREATE INDEX availability_claim_lot_allocations_lot_idx
  ON inventory.availability_claim_lot_allocations (inventory_lot_id, claim_id);

CREATE TABLE inventory.availability_claim_commands (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  command_type varchar(30) NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  request_hash varchar(64) NOT NULL,
  result_hash varchar(64) NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  actor varchar(100) NOT NULL,
  reason varchar(1000) NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_commands_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN ('claim', 'release', 'cancel', 'execute')
  ),
  CONSTRAINT availability_claim_commands_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$' AND result_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT availability_claim_commands_actor_chk CHECK (
    btrim(idempotency_key) <> '' AND btrim(actor) <> '' AND btrim(reason) <> ''
  ),
  CONSTRAINT availability_claim_commands_evidence_chk CHECK (
    jsonb_typeof(request_payload) = 'object' AND jsonb_typeof(result_payload) = 'object'
  )
);

CREATE INDEX availability_claim_commands_claim_idx
  ON inventory.availability_claim_commands (claim_id, occurred_at, id);

CREATE TABLE inventory.availability_claim_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  event_type varchar(50) NOT NULL,
  from_status varchar(30),
  to_status varchar(30),
  evidence_payload jsonb NOT NULL,
  evidence_hash varchar(64) NOT NULL,
  actor varchar(100) NOT NULL,
  reason varchar(1000) NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_events_hash_chk CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT availability_claim_events_actor_chk CHECK (
    btrim(event_type) <> '' AND btrim(actor) <> '' AND btrim(reason) <> ''
  ),
  CONSTRAINT availability_claim_events_evidence_chk CHECK (jsonb_typeof(evidence_payload) = 'object')
);

CREATE INDEX availability_claim_events_claim_idx
  ON inventory.availability_claim_events (claim_id, occurred_at, id);

CREATE OR REPLACE FUNCTION inventory.reject_availability_claim_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('%s is append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER availability_claim_commands_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_claim_commands
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE TRIGGER availability_claim_events_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_claim_events
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

COMMENT ON TABLE inventory.availability_claims IS
  'Versioned canonical whole-order claims. Deployment alone does not route live orders here or change ATP authority.';
COMMENT ON TABLE inventory.availability_claim_lot_allocations IS
  'Exact FIFO lot ownership for canonical claims; release and execution must mutate only these attributed allocations.';
COMMENT ON COLUMN inventory.availability_claim_resources.consumer_operation_key IS
  'Null means direct finished allocation; otherwise identifies the exact transformation/build operation consuming the resource.';

COMMIT;
