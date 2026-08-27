-- Phase 2 shadow evidence only. These append-only tables do not own runtime ATP,
-- claims, reservations, builds, activation, publication, or channel quantities.
CREATE TABLE inventory.planner_shadow_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  model_id INTEGER,
  model_version INTEGER,
  model_definition_hash VARCHAR(64),
  legacy_inventory_strategy VARCHAR(30) NOT NULL,
  snapshot_fingerprint VARCHAR(64) NOT NULL,
  snapshot_payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL,
  blocker_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key VARCHAR(120) NOT NULL,
  requested_by VARCHAR(100) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT planner_shadow_runs_model_product_fk
    FOREIGN KEY (model_id, product_id)
    REFERENCES inventory.transformation_model_versions(id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT planner_shadow_runs_status_chk
    CHECK (status IN ('completed', 'blocked')),
  CONSTRAINT planner_shadow_runs_legacy_strategy_chk
    CHECK (legacy_inventory_strategy IN ('physical_fungible', 'recipe_managed', 'physical_only')),
  CONSTRAINT planner_shadow_runs_hash_chk
    CHECK (
      snapshot_fingerprint ~ '^[0-9a-f]{64}$'
      AND (model_definition_hash IS NULL OR model_definition_hash ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT planner_shadow_runs_model_evidence_chk
    CHECK (
      (model_id IS NULL AND model_version IS NULL AND model_definition_hash IS NULL)
      OR (model_id IS NOT NULL AND model_version > 0 AND model_definition_hash IS NOT NULL)
    ),
  CONSTRAINT planner_shadow_runs_json_chk
    CHECK (
      jsonb_typeof(snapshot_payload) = 'object'
      AND jsonb_typeof(blocker_codes) = 'array'
      AND snapshot_payload ->> 'schemaVersion' = 'inventory_availability_snapshot_v1'
      AND snapshot_payload ->> 'snapshotFingerprint' = snapshot_fingerprint
      AND (snapshot_payload ->> 'productId')::integer = product_id
      AND snapshot_payload ->> 'legacyInventoryStrategy' = legacy_inventory_strategy
      AND (snapshot_payload ->> 'capturedAt')::timestamptz = captured_at
    ),
  CONSTRAINT planner_shadow_runs_actor_chk
    CHECK (btrim(requested_by) <> '' AND btrim(idempotency_key) <> ''),
  CONSTRAINT planner_shadow_runs_time_chk CHECK (completed_at >= captured_at)
);

CREATE UNIQUE INDEX planner_shadow_runs_idempotency_uq
  ON inventory.planner_shadow_runs(idempotency_key);
CREATE INDEX planner_shadow_runs_product_lookup_idx
  ON inventory.planner_shadow_runs(product_id, completed_at DESC, id DESC);

CREATE TABLE inventory.planner_shadow_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES inventory.planner_shadow_runs(id) ON DELETE RESTRICT,
  warehouse_id INTEGER REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  product_variant_id INTEGER NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  legacy_atp_units BIGINT NOT NULL,
  proposed_atp_units BIGINT NOT NULL,
  difference_units BIGINT NOT NULL,
  readiness_state VARCHAR(20) NOT NULL,
  classifications JSONB NOT NULL,
  proposed_projection JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT planner_shadow_results_quantity_chk
    CHECK (
      legacy_atp_units >= 0
      AND proposed_atp_units >= 0
      AND difference_units = proposed_atp_units - legacy_atp_units
    ),
  CONSTRAINT planner_shadow_results_readiness_chk
    CHECK (readiness_state IN ('ready', 'blocked')),
  CONSTRAINT planner_shadow_results_evidence_chk
    CHECK (
      jsonb_typeof(classifications) = 'array'
      AND jsonb_array_length(classifications) > 0
      AND jsonb_typeof(proposed_projection) = 'object'
      AND proposed_projection ->> 'targetVariantId' = product_variant_id::text
      AND proposed_projection ->> 'atpUnits' = proposed_atp_units::text
      AND proposed_projection ->> 'status' = readiness_state
      AND (
        (warehouse_id IS NULL
          AND proposed_projection #>> '{scope,kind}' = 'network')
        OR (warehouse_id IS NOT NULL
          AND proposed_projection #>> '{scope,kind}' = 'warehouse'
          AND proposed_projection #>> '{scope,warehouseId}' = warehouse_id::text)
      )
    )
);

CREATE UNIQUE INDEX planner_shadow_results_scope_variant_uq
  ON inventory.planner_shadow_results(run_id, COALESCE(warehouse_id, 0), product_variant_id);
CREATE INDEX planner_shadow_results_run_idx
  ON inventory.planner_shadow_results(run_id, warehouse_id, product_variant_id);

CREATE OR REPLACE FUNCTION inventory.guard_planner_shadow_evidence_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'planner shadow evidence is append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER planner_shadow_runs_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.planner_shadow_runs
FOR EACH ROW EXECUTE FUNCTION inventory.guard_planner_shadow_evidence_write();

CREATE TRIGGER planner_shadow_results_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.planner_shadow_results
FOR EACH ROW EXECUTE FUNCTION inventory.guard_planner_shadow_evidence_write();
