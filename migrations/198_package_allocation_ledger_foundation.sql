-- Provider-independent, append-only package allocation evidence.
-- This migration is intentionally inert: it installs no writer or executable effect path.

CREATE TABLE wms.package_allocation_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_key UUID NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_groups_key UNIQUE (group_key),
  CONSTRAINT package_allocation_groups_current_version_chk CHECK (current_version >= 0)
);

CREATE TABLE wms.package_allocation_source_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_wms_shipment_item_id INTEGER NOT NULL,
  shipment_request_item_id BIGINT,
  source_quantity INTEGER NOT NULL,
  shipment_item_purpose VARCHAR(30) NOT NULL,
  order_item_id INTEGER,
  replacement_for_order_item_id INTEGER,
  correction_for_shipment_item_id INTEGER,
  product_variant_id INTEGER,
  sku VARCHAR(100) NOT NULL,
  source_fingerprint VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_source_lines_wms_item
    UNIQUE (source_wms_shipment_item_id),
  CONSTRAINT uq_package_allocation_source_lines_request_item
    UNIQUE (shipment_request_item_id),
  CONSTRAINT uq_package_allocation_source_lines_fingerprint
    UNIQUE (source_fingerprint),
  CONSTRAINT fk_package_allocation_source_lines_wms_item
    FOREIGN KEY (source_wms_shipment_item_id)
    REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_source_lines_request_item
    FOREIGN KEY (shipment_request_item_id)
    REFERENCES wms.shipment_request_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_source_lines_order_item
    FOREIGN KEY (order_item_id)
    REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_source_lines_replacement_item
    FOREIGN KEY (replacement_for_order_item_id)
    REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_source_lines_correction_item
    FOREIGN KEY (correction_for_shipment_item_id)
    REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_source_lines_variant
    FOREIGN KEY (product_variant_id)
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  CONSTRAINT package_allocation_source_lines_quantity_chk
    CHECK (source_quantity > 0),
  CONSTRAINT package_allocation_source_lines_purpose_chk
    CHECK (shipment_item_purpose IN (
      'customer_fulfillment', 'replacement', 'concession',
      'omission_correction', 'unclassified'
    )),
  CONSTRAINT package_allocation_source_lines_request_purpose_chk
    CHECK (
      shipment_request_item_id IS NULL
      OR shipment_item_purpose = 'customer_fulfillment'
    ),
  CONSTRAINT package_allocation_source_lines_lineage_chk
    CHECK (
      (
        shipment_item_purpose = 'customer_fulfillment'
        AND order_item_id IS NOT NULL
        AND replacement_for_order_item_id IS NULL
        AND correction_for_shipment_item_id IS NULL
      )
      OR (
        shipment_item_purpose = 'replacement'
        AND order_item_id IS NULL
        AND replacement_for_order_item_id IS NOT NULL
        AND correction_for_shipment_item_id IS NULL
      )
      OR (
        shipment_item_purpose = 'concession'
        AND order_item_id IS NULL
        AND replacement_for_order_item_id IS NULL
        AND correction_for_shipment_item_id IS NULL
        AND product_variant_id IS NOT NULL
      )
      OR (
        shipment_item_purpose = 'omission_correction'
        AND order_item_id IS NULL
        AND replacement_for_order_item_id IS NULL
        AND correction_for_shipment_item_id IS NOT NULL
        AND product_variant_id IS NOT NULL
      )
      OR (
        shipment_item_purpose = 'unclassified'
        AND order_item_id IS NULL
        AND replacement_for_order_item_id IS NULL
        AND correction_for_shipment_item_id IS NULL
      )
    ),
  CONSTRAINT package_allocation_source_lines_sku_chk
    CHECK (BTRIM(sku) <> ''),
  CONSTRAINT package_allocation_source_lines_fingerprint_chk
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE wms.package_allocation_keys (
  allocation_key VARCHAR(500) PRIMARY KEY,
  package_allocation_source_line_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_keys_source
    UNIQUE (allocation_key, package_allocation_source_line_id),
  CONSTRAINT fk_package_allocation_keys_source
    FOREIGN KEY (package_allocation_source_line_id)
    REFERENCES wms.package_allocation_source_lines(id) ON DELETE RESTRICT,
  CONSTRAINT package_allocation_keys_key_chk
    CHECK (BTRIM(allocation_key) <> '')
);


CREATE TABLE wms.package_allocation_group_source_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_group_id BIGINT NOT NULL,
  package_allocation_source_line_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_group_source_lines_membership
    UNIQUE (package_allocation_group_id, package_allocation_source_line_id),
  CONSTRAINT uq_package_allocation_group_source_lines_source
    UNIQUE (package_allocation_source_line_id),
  CONSTRAINT fk_package_allocation_group_source_lines_group
    FOREIGN KEY (package_allocation_group_id)
    REFERENCES wms.package_allocation_groups(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_group_source_lines_source
    FOREIGN KEY (package_allocation_source_line_id)
    REFERENCES wms.package_allocation_source_lines(id) ON DELETE RESTRICT
);

CREATE TABLE wms.package_allocation_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_group_id BIGINT NOT NULL,
  plan_version INTEGER NOT NULL,
  expected_group_version INTEGER NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  state_hash VARCHAR(64) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  planner_version VARCHAR(100) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_by VARCHAR(200) NOT NULL,
  state_snapshot JSONB NOT NULL,
  review_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_plans_group_version
    UNIQUE (package_allocation_group_id, plan_version),
  CONSTRAINT uq_package_allocation_plans_group_input_hash
    UNIQUE (package_allocation_group_id, input_hash),
  CONSTRAINT uq_package_allocation_plans_id_group
    UNIQUE (id, package_allocation_group_id),
  CONSTRAINT fk_package_allocation_plans_group
    FOREIGN KEY (package_allocation_group_id)
    REFERENCES wms.package_allocation_groups(id) ON DELETE RESTRICT,
  CONSTRAINT package_allocation_plans_version_chk
    CHECK (
      plan_version > 0
      AND expected_group_version >= 0
      AND plan_version = expected_group_version + 1
    ),
  CONSTRAINT package_allocation_plans_input_hash_chk
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT package_allocation_plans_state_hash_chk
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  -- `unchanged` is absent: a pure planner no-op must not append a plan.
  CONSTRAINT package_allocation_plans_outcome_chk
    CHECK (outcome IN ('proposed', 'review')),
  CONSTRAINT package_allocation_plans_snapshots_chk
    CHECK (
      jsonb_typeof(state_snapshot) = 'object'
      AND jsonb_typeof(review_snapshot) = 'object'
    ),
  CONSTRAINT package_allocation_plans_text_chk
    CHECK (
      BTRIM(planner_version) <> ''
      AND BTRIM(reason) <> ''
      AND BTRIM(created_by) <> ''
    )
);

CREATE TABLE wms.package_allocation_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_plan_id BIGINT NOT NULL,
  package_allocation_group_id BIGINT NOT NULL,
  package_allocation_source_line_id BIGINT NOT NULL,
  allocation_key VARCHAR(500) NOT NULL,
  entry_key VARCHAR(500) NOT NULL,
  allocation_kind VARCHAR(40) NOT NULL,
  target_kind VARCHAR(40) NOT NULL,
  shipping_provider_label_id BIGINT,
  quantity INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_entries_key
    UNIQUE (package_allocation_plan_id, entry_key),
  CONSTRAINT fk_package_allocation_entries_plan_group
    FOREIGN KEY (package_allocation_plan_id, package_allocation_group_id)
    REFERENCES wms.package_allocation_plans(id, package_allocation_group_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_entries_allocation_key
    FOREIGN KEY (allocation_key, package_allocation_source_line_id)
    REFERENCES wms.package_allocation_keys(allocation_key, package_allocation_source_line_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_entries_group_source
    FOREIGN KEY (package_allocation_group_id, package_allocation_source_line_id)
    REFERENCES wms.package_allocation_group_source_lines(
      package_allocation_group_id,
      package_allocation_source_line_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_entries_label
    FOREIGN KEY (shipping_provider_label_id)
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  CONSTRAINT package_allocation_entries_key_chk CHECK (BTRIM(entry_key) <> ''),
  CONSTRAINT package_allocation_entries_allocation_key_chk
    CHECK (BTRIM(allocation_key) <> ''),
  CONSTRAINT package_allocation_entries_quantity_chk CHECK (quantity > 0),
  CONSTRAINT package_allocation_entries_kind_chk
    CHECK (allocation_kind IN (
      'primary_transfer', 'additional_physical_consumption'
    )),
  CONSTRAINT package_allocation_entries_target_chk
    CHECK (target_kind IN ('package', 'awaiting_relabel', 'held_for_unpack')),
  CONSTRAINT package_allocation_entries_target_shape_chk
    CHECK (
      (target_kind = 'package' AND shipping_provider_label_id IS NOT NULL)
      OR (
        target_kind IN ('awaiting_relabel', 'held_for_unpack')
        AND shipping_provider_label_id IS NULL
      )
    ),
  CONSTRAINT package_allocation_entries_consumption_target_chk
    CHECK (
      allocation_kind <> 'additional_physical_consumption'
      OR target_kind = 'package'
    )
);

CREATE UNIQUE INDEX uq_package_allocation_entries_semantic_target
  ON wms.package_allocation_entries (
    package_allocation_plan_id,
    allocation_key,
    package_allocation_source_line_id,
    allocation_kind,
    target_kind,
    COALESCE(shipping_provider_label_id, 0)
  );

CREATE TABLE wms.package_allocation_effect_intents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_plan_id BIGINT NOT NULL,
  package_allocation_group_id BIGINT NOT NULL,
  package_allocation_source_line_id BIGINT,
  shipping_provider_label_id BIGINT,
  intent_key VARCHAR(500) NOT NULL,
  effect_type VARCHAR(80) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  quantity INTEGER,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  executable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_package_allocation_effect_intents_key UNIQUE (intent_key),
  CONSTRAINT fk_package_allocation_effect_intents_plan_group
    FOREIGN KEY (package_allocation_plan_id, package_allocation_group_id)
    REFERENCES wms.package_allocation_plans(id, package_allocation_group_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_effect_intents_group_source
    FOREIGN KEY (package_allocation_group_id, package_allocation_source_line_id)
    REFERENCES wms.package_allocation_group_source_lines(
      package_allocation_group_id,
      package_allocation_source_line_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_package_allocation_effect_intents_label
    FOREIGN KEY (shipping_provider_label_id)
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  CONSTRAINT package_allocation_effect_intents_key_chk
    CHECK (BTRIM(intent_key) <> ''),
  CONSTRAINT package_allocation_effect_intents_type_chk
    CHECK (effect_type IN (
      'commercial_fulfillment', 'inventory_consumption', 'active_label_tracking',
      'pre_possession_void_removal', 'carrier_tracking', 'notification_candidate',
      'notification_reconciliation'
    )),
  CONSTRAINT package_allocation_effect_intents_payload_hash_chk
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT package_allocation_effect_intents_quantity_chk
    CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT package_allocation_effect_intents_source_quantity_chk
    CHECK (
      (package_allocation_source_line_id IS NULL AND quantity IS NULL)
      OR (package_allocation_source_line_id IS NOT NULL AND quantity IS NOT NULL)
    ),
  CONSTRAINT package_allocation_effect_intents_payload_chk
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT package_allocation_effect_intents_inert_chk
    CHECK (executable = FALSE)
);

CREATE OR REPLACE FUNCTION wms.guard_package_allocation_group_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'package allocation groups cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.group_key IS DISTINCT FROM OLD.group_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'package allocation group identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'package allocation group current_version must advance by exactly one'
      USING ERRCODE = '40001';
  END IF;

  IF NEW.version_updated_at < OLD.version_updated_at THEN
    RAISE EXCEPTION 'package allocation group version_updated_at cannot move backwards'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

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
  FOR KEY SHARE;

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
  FOR KEY SHARE;

  IF projected_version <> plan_row.expected_group_version THEN
    RAISE EXCEPTION 'package allocation plan can only be built against its expected group version'
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wms.validate_package_allocation_plan_conservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_plan_id BIGINT;
  affected_group_id BIGINT;
  affected_plan_version INTEGER;
  projected_version INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'package_allocation_groups' THEN
    IF NEW.current_version = 0 THEN
      RETURN NULL;
    END IF;

    SELECT id
      INTO affected_plan_id
    FROM wms.package_allocation_plans
    WHERE package_allocation_group_id = NEW.id
      AND plan_version = NEW.current_version;
  ELSIF TG_TABLE_NAME = 'package_allocation_plans' THEN
    affected_plan_id := NEW.id;
  ELSE
    affected_plan_id := NEW.package_allocation_plan_id;
  END IF;

  SELECT package_allocation_group_id, plan_version
    INTO affected_group_id, affected_plan_version
  FROM wms.package_allocation_plans
  WHERE id = affected_plan_id;

  IF affected_plan_id IS NULL OR affected_group_id IS NULL THEN
    RAISE EXCEPTION 'package allocation group current version has no plan'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'package_allocation_plan_conservation_chk';
  END IF;

  SELECT current_version
    INTO projected_version
  FROM wms.package_allocation_groups
  WHERE id = affected_group_id;

  IF projected_version <> affected_plan_version THEN
    RAISE EXCEPTION 'package allocation plan is not the group current version'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'package_allocation_plan_conservation_chk';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM wms.package_allocation_group_source_lines
    WHERE package_allocation_group_id = affected_group_id
  ) THEN
    RAISE EXCEPTION 'package allocation plan group has no source lines'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'package_allocation_plan_conservation_chk';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wms.package_allocation_entries
    WHERE package_allocation_plan_id = affected_plan_id
    GROUP BY allocation_key
    HAVING MIN(package_allocation_source_line_id)
      <> MAX(package_allocation_source_line_id)
  ) THEN
    RAISE EXCEPTION 'package allocation key spans multiple source lines'
      USING ERRCODE = '23514',
        CONSTRAINT = 'package_allocation_plan_conservation_chk';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wms.package_allocation_group_source_lines membership
    JOIN wms.package_allocation_source_lines source_line
      ON source_line.id = membership.package_allocation_source_line_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(entry.quantity), 0) AS primary_quantity
      FROM wms.package_allocation_entries entry
      WHERE entry.package_allocation_plan_id = affected_plan_id
        AND entry.package_allocation_source_line_id = source_line.id
        AND entry.allocation_kind = 'primary_transfer'
    ) allocation_total ON TRUE
    WHERE membership.package_allocation_group_id = affected_group_id
      AND allocation_total.primary_quantity <> source_line.source_quantity
  ) THEN
    RAISE EXCEPTION 'package allocation primary transfers do not conserve source quantity'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'package_allocation_plan_conservation_chk';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_package_allocation_groups_projection_guard BEFORE UPDATE OR DELETE ON wms.package_allocation_groups
FOR EACH ROW EXECUTE FUNCTION wms.guard_package_allocation_group_projection();
CREATE TRIGGER trg_package_allocation_source_lines_immutable BEFORE UPDATE OR DELETE ON wms.package_allocation_source_lines
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
CREATE TRIGGER trg_package_allocation_keys_immutable BEFORE UPDATE OR DELETE ON wms.package_allocation_keys
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
CREATE TRIGGER trg_package_allocation_group_source_lines_immutable BEFORE UPDATE OR DELETE ON wms.package_allocation_group_source_lines
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
CREATE TRIGGER trg_package_allocation_plans_immutable BEFORE UPDATE OR DELETE ON wms.package_allocation_plans
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
CREATE TRIGGER trg_package_allocation_entries_immutable BEFORE UPDATE OR DELETE ON wms.package_allocation_entries
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
CREATE TRIGGER trg_package_allocation_effect_intents_immutable BEFORE UPDATE OR DELETE ON wms.package_allocation_effect_intents
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

CREATE TRIGGER trg_package_allocation_membership_insert_guard BEFORE INSERT ON wms.package_allocation_group_source_lines
FOR EACH ROW EXECUTE FUNCTION wms.guard_package_allocation_membership_insert();
CREATE TRIGGER trg_package_allocation_plans_build_guard BEFORE INSERT ON wms.package_allocation_plans
FOR EACH ROW EXECUTE FUNCTION wms.guard_package_allocation_plan_build();
CREATE TRIGGER trg_package_allocation_entries_build_guard BEFORE INSERT ON wms.package_allocation_entries
FOR EACH ROW EXECUTE FUNCTION wms.guard_package_allocation_plan_build();
CREATE TRIGGER trg_package_allocation_effect_intents_build_guard BEFORE INSERT ON wms.package_allocation_effect_intents
FOR EACH ROW EXECUTE FUNCTION wms.guard_package_allocation_plan_build();

CREATE CONSTRAINT TRIGGER trg_package_allocation_groups_conservation AFTER INSERT OR UPDATE OF current_version ON wms.package_allocation_groups
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms.validate_package_allocation_plan_conservation();
CREATE CONSTRAINT TRIGGER trg_package_allocation_plans_conservation AFTER INSERT ON wms.package_allocation_plans
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms.validate_package_allocation_plan_conservation();
CREATE CONSTRAINT TRIGGER trg_package_allocation_entries_conservation AFTER INSERT ON wms.package_allocation_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms.validate_package_allocation_plan_conservation();
