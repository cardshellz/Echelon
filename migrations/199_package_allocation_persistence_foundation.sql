-- Transactional persistence hardening for the inert package-allocation ledger.
-- Package identity is provider-qualified, label-neutral, and immutable.


-- Slice 1 installed no writer. Lock and verify that no manual rows were added
-- before changing target identity; an unknown history cannot be backfilled safely.
LOCK TABLE
  wms.package_allocation_groups,
  wms.package_allocation_source_lines,
  wms.package_allocation_group_source_lines,
  wms.package_allocation_keys,
  wms.package_allocation_plans,
  wms.package_allocation_entries,
  wms.package_allocation_effect_intents
IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wms.package_allocation_groups)
     OR EXISTS (SELECT 1 FROM wms.package_allocation_source_lines)
     OR EXISTS (SELECT 1 FROM wms.package_allocation_group_source_lines)
     OR EXISTS (SELECT 1 FROM wms.package_allocation_keys)
     OR EXISTS (SELECT 1 FROM wms.package_allocation_plans)
     OR EXISTS (SELECT 1 FROM wms.package_allocation_entries)
     OR EXISTS (SELECT 1 FROM wms.package_allocation_effect_intents) THEN
    RAISE EXCEPTION
      'package allocation persistence migration requires an empty inert ledger'
      USING ERRCODE = '55000',
            HINT = 'Audit and preserve any unexpected package-allocation evidence before retrying.';
  END IF;
END;
$$;

-- Serialize every membership/plan-child insert against the group version CAS.
-- A key-share lock is compatible with a non-key version update and can admit
-- immutable rows after the plan-level deferred validator has already run.
CREATE OR REPLACE FUNCTION wms.guard_package_allocation_membership_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  projected_version INTEGER;
BEGIN
  SELECT current_version
    INTO projected_version
  FROM wms.package_allocation_groups
  WHERE id = NEW.package_allocation_group_id
  FOR UPDATE;

  IF projected_version <> 0 THEN
    RAISE EXCEPTION 'package allocation group membership is sealed after its first plan'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wms.guard_package_allocation_plan_build()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_row wms.package_allocation_plans%ROWTYPE;
  projected_version INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'package_allocation_plans' THEN
    plan_row := NEW;
  ELSE
    SELECT *
      INTO plan_row
    FROM wms.package_allocation_plans
    WHERE id = NEW.package_allocation_plan_id;
  END IF;

  SELECT current_version
    INTO projected_version
  FROM wms.package_allocation_groups
  WHERE id = plan_row.package_allocation_group_id
  FOR UPDATE;

  IF projected_version <> plan_row.expected_group_version THEN
    RAISE EXCEPTION 'package allocation plan can only be built against its expected group version'
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE wms.package_allocation_package_bindings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_group_id BIGINT NOT NULL,
  package_key VARCHAR(180) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  provider_physical_shipment_id VARCHAR(200) NOT NULL,
  identity_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_package_bindings_group_key
    UNIQUE (package_allocation_group_id, package_key),
  CONSTRAINT uq_package_allocation_package_bindings_provider_identity
    UNIQUE (provider, provider_physical_shipment_id),
  CONSTRAINT uq_package_allocation_package_bindings_id_group
    UNIQUE (id, package_allocation_group_id),
  CONSTRAINT fk_package_allocation_package_bindings_group
    FOREIGN KEY (package_allocation_group_id)
    REFERENCES wms.package_allocation_groups(id) ON DELETE RESTRICT,
  CONSTRAINT package_allocation_package_bindings_text_chk
    CHECK (
      BTRIM(package_key) <> ''
      AND BTRIM(provider) <> ''
      AND BTRIM(provider_physical_shipment_id) <> ''
    ),
  CONSTRAINT package_allocation_package_bindings_hash_chk
    CHECK (identity_hash ~ '^[0-9a-f]{64}$')
);

CREATE TRIGGER trg_package_allocation_package_bindings_immutable
BEFORE UPDATE OR DELETE ON wms.package_allocation_package_bindings
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

ALTER TABLE wms.package_allocation_entries
  ADD COLUMN package_allocation_package_binding_id BIGINT;

ALTER TABLE wms.package_allocation_entries
  ADD CONSTRAINT fk_package_allocation_entries_package_binding
  FOREIGN KEY (
    package_allocation_package_binding_id,
    package_allocation_group_id
  ) REFERENCES wms.package_allocation_package_bindings(
    id,
    package_allocation_group_id
  ) ON DELETE RESTRICT;

ALTER TABLE wms.package_allocation_entries
  DROP CONSTRAINT package_allocation_entries_target_shape_chk;

ALTER TABLE wms.package_allocation_entries
  ADD CONSTRAINT package_allocation_entries_target_shape_chk
  CHECK (
    (
      target_kind = 'package'
      AND package_allocation_package_binding_id IS NOT NULL
    )
    OR (
      target_kind IN ('awaiting_relabel', 'held_for_unpack')
      AND package_allocation_package_binding_id IS NULL
      AND shipping_provider_label_id IS NULL
    )
  );

DROP INDEX wms.uq_package_allocation_entries_semantic_target;

CREATE UNIQUE INDEX uq_package_allocation_entries_semantic_target
  ON wms.package_allocation_entries (
    package_allocation_plan_id,
    allocation_key,
    package_allocation_source_line_id,
    allocation_kind,
    target_kind,
    COALESCE(package_allocation_package_binding_id, 0)
  );

ALTER TABLE wms.package_allocation_effect_intents
  ADD COLUMN package_allocation_package_binding_id BIGINT;

CREATE INDEX idx_package_allocation_entries_plan_source_kind
  ON wms.package_allocation_entries (
    package_allocation_plan_id,
    package_allocation_source_line_id,
    allocation_kind
  );


ALTER TABLE wms.package_allocation_effect_intents
  ADD CONSTRAINT fk_package_allocation_effect_intents_package_binding
  FOREIGN KEY (
    package_allocation_package_binding_id,
    package_allocation_group_id
  ) REFERENCES wms.package_allocation_package_bindings(
    id,
    package_allocation_group_id
  ) ON DELETE RESTRICT;

ALTER TABLE wms.package_allocation_effect_intents
  ADD CONSTRAINT package_allocation_effect_intents_label_binding_chk
  CHECK (
    shipping_provider_label_id IS NULL
    OR package_allocation_package_binding_id IS NOT NULL
  );

-- The plan-level and group-version deferred triggers each validate the final
-- transaction state once. The per-entry trigger repeated the same full-plan
-- scan for every row, making commit cost quadratic at supported planner bounds.
DROP TRIGGER trg_package_allocation_entries_conservation
  ON wms.package_allocation_entries;
