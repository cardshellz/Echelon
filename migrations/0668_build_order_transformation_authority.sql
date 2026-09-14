-- Durable authorization for manual and claim-owned build execution.
-- This migration is additive only: existing rows remain legacy (all evidence
-- columns null) until an operator explicitly resolves them before cutover.
-- The four-column model FK uses the non-partial unique evidence index created
-- by 0622_inventory_availability_backfill_review.sql.

ALTER TABLE inventory.build_orders
  ADD COLUMN transformation_authority VARCHAR(20),
  ADD COLUMN transformation_authority_revision BIGINT,
  ADD COLUMN transformation_activation_run_id BIGINT,
  ADD COLUMN transformation_model_head_revision BIGINT,
  ADD COLUMN transformation_model_id INTEGER,
  ADD COLUMN transformation_model_version INTEGER,
  ADD COLUMN transformation_model_definition_hash VARCHAR(64),
  ADD COLUMN transformation_recipe_binding_id INTEGER,
  ADD COLUMN transformation_recipe_definition_hash VARCHAR(64),
  ADD COLUMN transformation_authorized_at TIMESTAMPTZ,
  ADD COLUMN transformation_authorized_by VARCHAR(100);

-- `id` is already unique; this evidence index additionally gives PostgreSQL an
-- exact FK target for the immutable binding identity persisted on a build.
CREATE UNIQUE INDEX transformation_recipe_bindings_build_evidence_uq
  ON inventory.transformation_recipe_bindings(
    id,
    model_id,
    recipe_id,
    recipe_definition_hash
  );

ALTER TABLE inventory.build_orders
  ADD CONSTRAINT build_orders_transformation_authority_chk CHECK (
    (transformation_authority IS NULL
      AND transformation_authority_revision IS NULL
      AND transformation_activation_run_id IS NULL
      AND transformation_model_head_revision IS NULL
      AND transformation_model_id IS NULL
      AND transformation_model_version IS NULL
      AND transformation_model_definition_hash IS NULL
      AND transformation_recipe_binding_id IS NULL
      AND transformation_recipe_definition_hash IS NULL
      AND transformation_authorized_at IS NULL
      AND transformation_authorized_by IS NULL)
    OR
    (transformation_authority = 'canonical'
      AND transformation_authority_revision > 0
      AND transformation_activation_run_id > 0
      AND (transformation_model_head_revision IS NULL OR transformation_model_head_revision >= 0)
      AND transformation_model_id > 0
      AND transformation_model_version > 0
      AND transformation_model_definition_hash ~ '^[0-9a-f]{64}$'
      AND transformation_recipe_binding_id > 0
      AND transformation_recipe_definition_hash ~ '^[0-9a-f]{64}$'
      AND transformation_authorized_at IS NOT NULL
      AND btrim(transformation_authorized_by) <> '')
  ),
  ADD CONSTRAINT build_orders_transformation_activation_fk
    FOREIGN KEY (transformation_activation_run_id)
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT build_orders_transformation_model_fk
    FOREIGN KEY (
      transformation_model_id,
      output_product_id,
      transformation_model_version,
      transformation_model_definition_hash
    ) REFERENCES inventory.transformation_model_versions(id, product_id, version, definition_hash)
    ON DELETE RESTRICT,
  ADD CONSTRAINT build_orders_transformation_binding_fk
    FOREIGN KEY (
      transformation_recipe_binding_id,
      transformation_model_id,
      recipe_id,
      transformation_recipe_definition_hash
    ) REFERENCES inventory.transformation_recipe_bindings(
      id,
      model_id,
      recipe_id,
      recipe_definition_hash
    )
    ON DELETE RESTRICT;

CREATE INDEX build_orders_transformation_authority_idx
  ON inventory.build_orders(transformation_authority, status, id)
  WHERE transformation_authority IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory.guard_build_order_transformation_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.transformation_authority = 'canonical'
     AND ROW(
       NEW.transformation_authority,
       NEW.transformation_authority_revision,
       NEW.transformation_activation_run_id,
       NEW.transformation_model_head_revision,
       NEW.transformation_model_id,
       NEW.transformation_model_version,
       NEW.transformation_model_definition_hash,
       NEW.transformation_recipe_binding_id,
       NEW.transformation_recipe_definition_hash,
       NEW.transformation_authorized_at,
       NEW.transformation_authorized_by
     ) IS DISTINCT FROM ROW(
       OLD.transformation_authority,
       OLD.transformation_authority_revision,
       OLD.transformation_activation_run_id,
       OLD.transformation_model_head_revision,
       OLD.transformation_model_id,
       OLD.transformation_model_version,
       OLD.transformation_model_definition_hash,
       OLD.transformation_recipe_binding_id,
       OLD.transformation_recipe_definition_hash,
       OLD.transformation_authorized_at,
       OLD.transformation_authorized_by
     ) THEN
    RAISE EXCEPTION 'canonical build transformation authority evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER build_orders_transformation_authority_guard
BEFORE UPDATE ON inventory.build_orders
FOR EACH ROW EXECUTE FUNCTION inventory.guard_build_order_transformation_authority();

COMMENT ON COLUMN inventory.build_orders.transformation_recipe_binding_id IS
  'Exact immutable recipe binding that authorized this released canonical build; null identifies a legacy build.';
COMMENT ON COLUMN inventory.build_orders.transformation_model_head_revision IS
  'Active-head revision observed for a manual release; claim-owned builds may omit it because the canonical claim already freezes model evidence.';
