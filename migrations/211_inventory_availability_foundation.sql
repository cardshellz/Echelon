-- Phase 1 inventory-availability foundation.
--
-- This migration is additive and inactive by construction:
--   * it inserts no policies, models, provider identities, or demand evidence;
--   * existing ATP, reservation, recipe, and channel code does not read it;
--   * it creates no claim, activation, runtime-binding, or publication authority.

CREATE TABLE warehouse.fulfillment_nodes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(60) NOT NULL,
  name varchar(200) NOT NULL,
  node_type varchar(30) NOT NULL,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  provider_account_id integer,
  provider_location_id integer,
  inventory_authority varchar(30) NOT NULL,
  fulfillment_authority varchar(30) NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  created_by varchar(100) NOT NULL,
  activated_by varchar(100),
  activated_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fulfillment_nodes_code_uq UNIQUE (code),
  CONSTRAINT fulfillment_nodes_id_warehouse_uq UNIQUE (id, warehouse_id),
  CONSTRAINT fulfillment_nodes_provider_identity_uq
    UNIQUE (id, warehouse_id, provider_account_id, provider_location_id),
  CONSTRAINT fulfillment_nodes_code_chk CHECK (
    code = btrim(code) AND code ~ '^[A-Z0-9][A-Z0-9_-]{0,59}$'
  ),
  CONSTRAINT fulfillment_nodes_name_chk CHECK (btrim(name) <> ''),
  CONSTRAINT fulfillment_nodes_type_chk CHECK (
    node_type IN ('internal_warehouse', 'third_party_logistics', 'virtual')
  ),
  CONSTRAINT fulfillment_nodes_inventory_authority_chk CHECK (
    inventory_authority IN ('echelon', 'external_provider', 'manual')
  ),
  CONSTRAINT fulfillment_nodes_fulfillment_authority_chk CHECK (
    fulfillment_authority IN ('echelon', 'external_provider', 'none')
  ),
  CONSTRAINT fulfillment_nodes_provider_identity_shape_chk CHECK (
    (provider_account_id IS NULL AND provider_location_id IS NULL)
    OR (provider_account_id IS NOT NULL AND provider_location_id IS NOT NULL)
  ),
  CONSTRAINT fulfillment_nodes_status_chk CHECK (
    lifecycle_status IN ('draft', 'active', 'retired')
  ),
  CONSTRAINT fulfillment_nodes_lifecycle_evidence_chk CHECK (
    (
      lifecycle_status = 'draft'
      AND activated_by IS NULL AND activated_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'active'
      AND activated_by IS NOT NULL AND btrim(activated_by) <> ''
      AND activated_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'retired'
      AND activated_by IS NOT NULL AND btrim(activated_by) <> ''
      AND activated_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= activated_at
    )
  )
);

CREATE UNIQUE INDEX fulfillment_nodes_live_warehouse_uq
  ON warehouse.fulfillment_nodes(warehouse_id)
  WHERE lifecycle_status <> 'retired';

COMMENT ON TABLE warehouse.fulfillment_nodes IS
  'Inactive Phase 1 fulfillment/custody scope. A node may represent an internal warehouse, a 3PL, or a virtual routing boundary.';

CREATE TABLE warehouse.fulfillment_provider_accounts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider varchar(60) NOT NULL,
  account_namespace varchar(60) NOT NULL,
  identity_scheme varchar(60) NOT NULL,
  external_account_id varchar(240) NOT NULL,
  display_name_snapshot varchar(200) NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  evidence_hash varchar(64) NOT NULL,
  created_by varchar(100) NOT NULL,
  verified_by varchar(100),
  verified_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fulfillment_provider_accounts_identity_uq
    UNIQUE (provider, account_namespace, identity_scheme, external_account_id),
  CONSTRAINT fulfillment_provider_accounts_identity_chk CHECK (
    provider = lower(btrim(provider)) AND provider ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
    AND account_namespace = lower(btrim(account_namespace))
    AND account_namespace ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
    AND identity_scheme = lower(btrim(identity_scheme))
    AND identity_scheme ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
    AND btrim(external_account_id) <> ''
    AND btrim(display_name_snapshot) <> ''
    AND evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fulfillment_provider_accounts_status_chk CHECK (
    lifecycle_status IN ('draft', 'active', 'retired')
  ),
  CONSTRAINT fulfillment_provider_accounts_lifecycle_chk CHECK (
    (lifecycle_status = 'draft'
      AND verified_by IS NULL AND verified_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'active'
      AND verified_by IS NOT NULL AND btrim(verified_by) <> ''
      AND verified_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'retired'
      AND verified_by IS NOT NULL AND btrim(verified_by) <> ''
      AND verified_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= verified_at)
  )
);

CREATE TABLE warehouse.fulfillment_provider_locations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_account_id integer NOT NULL
    REFERENCES warehouse.fulfillment_provider_accounts(id) ON DELETE RESTRICT,
  identity_scheme varchar(60) NOT NULL,
  external_location_id varchar(240) NOT NULL,
  display_name_snapshot varchar(200) NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  evidence_hash varchar(64) NOT NULL,
  created_by varchar(100) NOT NULL,
  verified_by varchar(100),
  verified_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fulfillment_provider_locations_identity_uq
    UNIQUE (provider_account_id, identity_scheme, external_location_id),
  CONSTRAINT fulfillment_provider_locations_id_account_uq UNIQUE (id, provider_account_id),
  CONSTRAINT fulfillment_provider_locations_identity_chk CHECK (
    identity_scheme = lower(btrim(identity_scheme))
    AND identity_scheme ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
    AND btrim(external_location_id) <> ''
    AND btrim(display_name_snapshot) <> ''
    AND evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fulfillment_provider_locations_status_chk CHECK (
    lifecycle_status IN ('draft', 'active', 'retired')
  ),
  CONSTRAINT fulfillment_provider_locations_lifecycle_chk CHECK (
    (lifecycle_status = 'draft'
      AND verified_by IS NULL AND verified_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'active'
      AND verified_by IS NOT NULL AND btrim(verified_by) <> ''
      AND verified_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'retired'
      AND verified_by IS NOT NULL AND btrim(verified_by) <> ''
      AND verified_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= verified_at)
  )
);

ALTER TABLE warehouse.fulfillment_nodes
  ADD CONSTRAINT fulfillment_nodes_provider_location_account_fk
  FOREIGN KEY (provider_location_id, provider_account_id)
  REFERENCES warehouse.fulfillment_provider_locations(id, provider_account_id)
  ON DELETE RESTRICT;

CREATE TABLE warehouse.fulfillment_node_provider_bindings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fulfillment_node_id integer NOT NULL,
  warehouse_id integer NOT NULL,
  provider_account_id integer NOT NULL
    REFERENCES warehouse.fulfillment_provider_accounts(id) ON DELETE RESTRICT,
  provider_location_id integer NOT NULL,
  capability varchar(40) NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  created_by varchar(100) NOT NULL,
  activated_by varchar(100),
  activated_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fulfillment_node_provider_bindings_node_warehouse_fk
    FOREIGN KEY (fulfillment_node_id, warehouse_id)
    REFERENCES warehouse.fulfillment_nodes(id, warehouse_id) ON DELETE RESTRICT,
  CONSTRAINT fulfillment_node_provider_bindings_location_account_fk
    FOREIGN KEY (provider_location_id, provider_account_id)
    REFERENCES warehouse.fulfillment_provider_locations(id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT fulfillment_node_provider_bindings_node_provider_fk
    FOREIGN KEY (
      fulfillment_node_id, warehouse_id, provider_account_id, provider_location_id
    ) REFERENCES warehouse.fulfillment_nodes(
      id, warehouse_id, provider_account_id, provider_location_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fulfillment_node_provider_bindings_capability_chk CHECK (
    capability IN ('inventory_observation', 'fulfillment_execution', 'custody_reconciliation')
  ),
  CONSTRAINT fulfillment_node_provider_bindings_status_chk CHECK (
    lifecycle_status IN ('draft', 'active', 'retired')
  ),
  CONSTRAINT fulfillment_node_provider_bindings_lifecycle_chk CHECK (
    (lifecycle_status = 'draft'
      AND activated_by IS NULL AND activated_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'active'
      AND activated_by IS NOT NULL AND btrim(activated_by) <> ''
      AND activated_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'retired'
      AND activated_by IS NOT NULL AND btrim(activated_by) <> ''
      AND activated_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= activated_at)
  )
);

CREATE UNIQUE INDEX fulfillment_node_provider_bindings_live_identity_uq
  ON warehouse.fulfillment_node_provider_bindings(
    fulfillment_node_id, provider_account_id, provider_location_id, capability
  ) WHERE lifecycle_status <> 'retired';
CREATE UNIQUE INDEX fulfillment_node_provider_bindings_active_node_capability_uq
  ON warehouse.fulfillment_node_provider_bindings(fulfillment_node_id, capability)
  WHERE lifecycle_status = 'active';
CREATE UNIQUE INDEX fulfillment_node_provider_bindings_active_location_capability_uq
  ON warehouse.fulfillment_node_provider_bindings(provider_location_id, capability)
  WHERE lifecycle_status = 'active';

CREATE TABLE inventory.location_promise_policy_versions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_location_id integer NOT NULL
    REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  eligibility_mode varchar(20) NOT NULL,
  definition_hash varchar(64) NOT NULL,
  supersedes_policy_id integer
    REFERENCES inventory.location_promise_policy_versions(id) ON DELETE RESTRICT,
  change_reason varchar(1000) NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_by varchar(100) NOT NULL,
  sealed_by varchar(100),
  sealed_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT location_promise_policy_versions_location_version_uq
    UNIQUE (warehouse_location_id, version),
  CONSTRAINT location_promise_policy_versions_id_location_uq
    UNIQUE (id, warehouse_location_id),
  CONSTRAINT location_promise_policy_versions_idempotency_uq
    UNIQUE (idempotency_key),
  CONSTRAINT location_promise_policy_versions_version_chk CHECK (version > 0),
  CONSTRAINT location_promise_policy_versions_status_chk CHECK (
    lifecycle_status IN ('draft', 'sealed', 'retired')
  ),
  CONSTRAINT location_promise_policy_versions_mode_chk CHECK (
    eligibility_mode IN ('inherit', 'eligible', 'ineligible')
  ),
  CONSTRAINT location_promise_policy_versions_hash_chk CHECK (
    definition_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT location_promise_policy_versions_reason_chk CHECK (
    char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT location_promise_policy_versions_predecessor_chk CHECK (
    (version = 1 AND supersedes_policy_id IS NULL)
    OR (version > 1 AND supersedes_policy_id IS NOT NULL)
  ),
  CONSTRAINT location_promise_policy_versions_lifecycle_chk CHECK (
    (
      lifecycle_status = 'draft'
      AND sealed_by IS NULL AND sealed_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'sealed'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> ''
      AND sealed_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'retired'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> ''
      AND sealed_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= sealed_at
    )
  )
);

CREATE UNIQUE INDEX location_promise_policy_versions_one_draft_uq
  ON inventory.location_promise_policy_versions(warehouse_location_id)
  WHERE lifecycle_status = 'draft';
CREATE UNIQUE INDEX location_promise_policy_versions_successor_uq
  ON inventory.location_promise_policy_versions(supersedes_policy_id)
  WHERE supersedes_policy_id IS NOT NULL;

CREATE TABLE inventory.location_promise_policy_heads (
  warehouse_location_id integer PRIMARY KEY
    REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  active_policy_id integer,
  draft_policy_id integer,
  revision bigint NOT NULL DEFAULT 0,
  updated_by varchar(100) NOT NULL,
  update_reason varchar(1000) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT location_promise_policy_heads_active_fk
    FOREIGN KEY (active_policy_id, warehouse_location_id)
    REFERENCES inventory.location_promise_policy_versions(id, warehouse_location_id)
    ON DELETE RESTRICT,
  CONSTRAINT location_promise_policy_heads_draft_fk
    FOREIGN KEY (draft_policy_id, warehouse_location_id)
    REFERENCES inventory.location_promise_policy_versions(id, warehouse_location_id)
    ON DELETE RESTRICT,
  CONSTRAINT location_promise_policy_heads_distinct_chk CHECK (
    active_policy_id IS NULL OR draft_policy_id IS NULL OR active_policy_id <> draft_policy_id
  ),
  CONSTRAINT location_promise_policy_heads_revision_chk CHECK (revision >= 0),
  CONSTRAINT location_promise_policy_heads_reason_chk CHECK (
    char_length(btrim(update_reason)) BETWEEN 1 AND 1000
  )
);

CREATE TABLE inventory.transformation_model_versions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  build_to_promise_enabled boolean NOT NULL DEFAULT false,
  definition_hash varchar(64) NOT NULL,
  validation_state varchar(20) NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes_model_id integer
    REFERENCES inventory.transformation_model_versions(id) ON DELETE RESTRICT,
  change_reason varchar(1000) NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_by varchar(100) NOT NULL,
  sealed_by varchar(100),
  sealed_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT transformation_model_versions_product_version_uq UNIQUE (product_id, version),
  CONSTRAINT transformation_model_versions_id_product_uq UNIQUE (id, product_id),
  CONSTRAINT transformation_model_versions_id_product_version_uq UNIQUE (id, product_id, version),
  CONSTRAINT transformation_model_versions_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT transformation_model_versions_version_chk CHECK (version > 0),
  CONSTRAINT transformation_model_versions_status_chk CHECK (
    lifecycle_status IN ('draft', 'sealed', 'retired')
  ),
  CONSTRAINT transformation_model_versions_validation_chk CHECK (
    validation_state IN ('valid', 'invalid')
    AND jsonb_typeof(validation_errors) = 'array'
    AND (
      (validation_state = 'valid' AND jsonb_array_length(validation_errors) = 0)
      OR (validation_state = 'invalid' AND jsonb_array_length(validation_errors) > 0)
    )
  ),
  CONSTRAINT transformation_model_versions_hash_chk CHECK (
    definition_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT transformation_model_versions_reason_chk CHECK (
    char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT transformation_model_versions_predecessor_chk CHECK (
    (version = 1 AND supersedes_model_id IS NULL)
    OR (version > 1 AND supersedes_model_id IS NOT NULL)
  ),
  CONSTRAINT transformation_model_versions_lifecycle_chk CHECK (
    (
      lifecycle_status = 'draft'
      AND sealed_by IS NULL AND sealed_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'sealed'
      AND validation_state = 'valid'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> ''
      AND sealed_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'retired'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> ''
      AND sealed_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= sealed_at
    )
  )
);

CREATE UNIQUE INDEX transformation_model_versions_one_draft_uq
  ON inventory.transformation_model_versions(product_id)
  WHERE lifecycle_status = 'draft';
CREATE UNIQUE INDEX transformation_model_versions_successor_uq
  ON inventory.transformation_model_versions(supersedes_model_id)
  WHERE supersedes_model_id IS NOT NULL;

CREATE TABLE inventory.transformation_model_paths (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id integer NOT NULL
    REFERENCES inventory.transformation_model_versions(id) ON DELETE CASCADE,
  source_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  destination_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  input_qty integer NOT NULL,
  output_qty integer NOT NULL,
  source_units_per_variant integer NOT NULL,
  destination_units_per_variant integer NOT NULL,
  operation_type varchar(30) NOT NULL,
  authority_state varchar(20) NOT NULL,
  transformation_recipe_binding_id integer,
  validation_state varchar(20) NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT transformation_model_paths_identity_uq
    UNIQUE (model_id, source_variant_id, destination_variant_id, operation_type),
  CONSTRAINT transformation_model_paths_id_model_uq UNIQUE (id, model_id),
  CONSTRAINT transformation_model_paths_distinct_variants_chk CHECK (
    source_variant_id <> destination_variant_id
  ),
  CONSTRAINT transformation_model_paths_quantity_chk CHECK (
    input_qty > 0 AND output_qty > 0
    AND source_units_per_variant > 0 AND destination_units_per_variant > 0
  ),
  CONSTRAINT transformation_model_paths_conservation_chk CHECK (
    authority_state = 'blocked'
    OR input_qty::bigint * source_units_per_variant::bigint
      = output_qty::bigint * destination_units_per_variant::bigint
    OR (
      operation_type = 'directed_conversion'
      AND transformation_recipe_binding_id IS NOT NULL
    )
  ),
  CONSTRAINT transformation_model_paths_operation_chk CHECK (
    operation_type IN ('break_pack', 'assemble_pack', 'directed_conversion')
  ),
  CONSTRAINT transformation_model_paths_recipe_shape_chk CHECK (
    operation_type = 'directed_conversion'
    OR transformation_recipe_binding_id IS NULL
  ),
  CONSTRAINT transformation_model_paths_authority_chk CHECK (
    authority_state IN ('allowed', 'blocked')
  ),
  CONSTRAINT transformation_model_paths_validation_chk CHECK (
    validation_state IN ('valid', 'invalid')
    AND jsonb_typeof(validation_errors) = 'array'
    AND (
      (validation_state = 'valid' AND jsonb_array_length(validation_errors) = 0)
      OR (validation_state = 'invalid' AND jsonb_array_length(validation_errors) > 0)
    )
  )
);

CREATE INDEX transformation_model_paths_destination_idx
  ON inventory.transformation_model_paths(model_id, destination_variant_id, authority_state);

CREATE TABLE inventory.transformation_recipe_bindings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id integer NOT NULL
    REFERENCES inventory.transformation_model_versions(id) ON DELETE CASCADE,
  recipe_id integer NOT NULL
    REFERENCES inventory.build_recipes(id) ON DELETE RESTRICT,
  relationship_role varchar(30) NOT NULL,
  warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  recipe_code_snapshot varchar(50) NOT NULL,
  recipe_version_snapshot integer NOT NULL,
  recipe_definition_hash varchar(64) NOT NULL,
  output_product_id_snapshot integer NOT NULL
    REFERENCES catalog.products(id) ON DELETE RESTRICT,
  output_variant_id_snapshot integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  output_units_per_variant_snapshot integer NOT NULL,
  output_qty_snapshot integer NOT NULL,
  validation_state varchar(20) NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT transformation_recipe_bindings_id_model_uq UNIQUE (id, model_id),
  CONSTRAINT transformation_recipe_bindings_role_chk CHECK (
    relationship_role IN ('component_build', 'directional_conversion', 'disassembly')
  ),
  CONSTRAINT transformation_recipe_bindings_output_variant_product_fk
    FOREIGN KEY (output_variant_id_snapshot, output_product_id_snapshot)
    REFERENCES catalog.product_variants(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT transformation_recipe_bindings_snapshot_chk CHECK (
    recipe_version_snapshot > 0
    AND btrim(recipe_code_snapshot) <> ''
    AND recipe_definition_hash ~ '^[0-9a-f]{64}$'
    AND output_units_per_variant_snapshot > 0
    AND output_qty_snapshot > 0
  ),
  CONSTRAINT transformation_recipe_bindings_validation_chk CHECK (
    validation_state IN ('valid', 'invalid')
    AND jsonb_typeof(validation_errors) = 'array'
    AND (
      (validation_state = 'valid' AND jsonb_array_length(validation_errors) = 0)
      OR (validation_state = 'invalid' AND jsonb_array_length(validation_errors) > 0)
    )
  )
);

CREATE UNIQUE INDEX transformation_recipe_bindings_scope_uq
  ON inventory.transformation_recipe_bindings(model_id, recipe_id, COALESCE(warehouse_id, 0));

CREATE TABLE inventory.transformation_recipe_component_snapshots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transformation_recipe_binding_id integer NOT NULL,
  model_id integer NOT NULL,
  component_variant_id integer NOT NULL,
  component_product_id integer NOT NULL,
  component_units_per_variant integer NOT NULL,
  component_qty integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT transformation_recipe_component_snapshots_binding_model_fk
    FOREIGN KEY (transformation_recipe_binding_id, model_id)
    REFERENCES inventory.transformation_recipe_bindings(id, model_id)
    ON DELETE CASCADE,
  CONSTRAINT transformation_recipe_component_snapshots_variant_product_fk
    FOREIGN KEY (component_variant_id, component_product_id)
    REFERENCES catalog.product_variants(id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT transformation_recipe_component_snapshots_identity_uq
    UNIQUE (transformation_recipe_binding_id, component_variant_id),
  CONSTRAINT transformation_recipe_component_snapshots_id_model_uq
    UNIQUE (id, model_id),
  CONSTRAINT transformation_recipe_component_snapshots_quantity_chk CHECK (
    component_units_per_variant > 0 AND component_qty > 0
  )
);

ALTER TABLE inventory.transformation_model_paths
  ADD CONSTRAINT transformation_model_paths_recipe_binding_fk
  FOREIGN KEY (transformation_recipe_binding_id, model_id)
  REFERENCES inventory.transformation_recipe_bindings(id, model_id)
  ON DELETE RESTRICT;

CREATE TABLE inventory.transformation_model_heads (
  product_id integer PRIMARY KEY REFERENCES catalog.products(id) ON DELETE RESTRICT,
  active_model_id integer,
  draft_model_id integer,
  revision bigint NOT NULL DEFAULT 0,
  updated_by varchar(100) NOT NULL,
  update_reason varchar(1000) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT transformation_model_heads_active_fk
    FOREIGN KEY (active_model_id, product_id)
    REFERENCES inventory.transformation_model_versions(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT transformation_model_heads_draft_fk
    FOREIGN KEY (draft_model_id, product_id)
    REFERENCES inventory.transformation_model_versions(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT transformation_model_heads_distinct_chk CHECK (
    active_model_id IS NULL OR draft_model_id IS NULL OR active_model_id <> draft_model_id
  ),
  CONSTRAINT transformation_model_heads_revision_chk CHECK (revision >= 0),
  CONSTRAINT transformation_model_heads_reason_chk CHECK (
    char_length(btrim(update_reason)) BETWEEN 1 AND 1000
  )
);

CREATE TABLE inventory.promise_safety_policy_versions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key varchar(160) NOT NULL,
  scope_type varchar(30) NOT NULL,
  product_variant_id integer
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  lifecycle_status varchar(20) NOT NULL DEFAULT 'draft',
  policy_mode varchar(30) NOT NULL,
  fixed_units integer,
  days_of_cover_milli_days integer,
  untrusted_demand_fallback_units integer,
  demand_method_version varchar(60),
  definition_hash varchar(64) NOT NULL,
  supersedes_policy_id integer
    REFERENCES inventory.promise_safety_policy_versions(id) ON DELETE RESTRICT,
  change_reason varchar(1000) NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_by varchar(100) NOT NULL,
  sealed_by varchar(100),
  sealed_at timestamptz,
  retired_by varchar(100),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT promise_safety_policy_versions_scope_version_uq UNIQUE (scope_key, version),
  CONSTRAINT promise_safety_policy_versions_id_scope_uq UNIQUE (id, scope_key),
  CONSTRAINT promise_safety_policy_versions_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT promise_safety_policy_versions_scope_chk CHECK (
    (scope_type = 'business' AND scope_key = 'business'
      AND product_variant_id IS NULL AND warehouse_id IS NULL)
    OR (scope_type = 'network_variant'
      AND scope_key = 'network:variant:' || product_variant_id::text
      AND product_variant_id IS NOT NULL AND warehouse_id IS NULL)
    OR (scope_type = 'warehouse_variant'
      AND scope_key = 'warehouse:' || warehouse_id::text || ':variant:' || product_variant_id::text
      AND product_variant_id IS NOT NULL AND warehouse_id IS NOT NULL)
  ),
  CONSTRAINT promise_safety_policy_versions_version_chk CHECK (version > 0),
  CONSTRAINT promise_safety_policy_versions_status_chk CHECK (
    lifecycle_status IN ('draft', 'sealed', 'retired')
  ),
  CONSTRAINT promise_safety_policy_versions_mode_chk CHECK (
    policy_mode IN ('inherit', 'off', 'fixed_units', 'days_of_cover')
    AND (scope_type <> 'business' OR policy_mode <> 'inherit')
  ),
  CONSTRAINT promise_safety_policy_versions_value_shape_chk CHECK (
    (policy_mode = 'inherit'
      AND fixed_units IS NULL AND days_of_cover_milli_days IS NULL
      AND untrusted_demand_fallback_units IS NULL AND demand_method_version IS NULL)
    OR (policy_mode = 'off'
      AND fixed_units IS NULL AND days_of_cover_milli_days IS NULL
      AND untrusted_demand_fallback_units IS NULL AND demand_method_version IS NULL)
    OR (policy_mode = 'fixed_units'
      AND fixed_units IS NOT NULL AND fixed_units >= 0 AND days_of_cover_milli_days IS NULL
      AND untrusted_demand_fallback_units IS NULL AND demand_method_version IS NULL)
    OR (policy_mode = 'days_of_cover'
      AND fixed_units IS NULL
      AND days_of_cover_milli_days IS NOT NULL AND days_of_cover_milli_days > 0
      AND untrusted_demand_fallback_units IS NOT NULL AND untrusted_demand_fallback_units >= 0
      AND demand_method_version IS NOT NULL AND btrim(demand_method_version) <> '')
  ),
  CONSTRAINT promise_safety_policy_versions_hash_chk CHECK (
    definition_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT promise_safety_policy_versions_reason_chk CHECK (
    char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT promise_safety_policy_versions_predecessor_chk CHECK (
    (version = 1 AND supersedes_policy_id IS NULL)
    OR (version > 1 AND supersedes_policy_id IS NOT NULL)
  ),
  CONSTRAINT promise_safety_policy_versions_lifecycle_chk CHECK (
    (
      lifecycle_status = 'draft'
      AND sealed_by IS NULL AND sealed_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'sealed'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> '' AND sealed_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL
    ) OR (
      lifecycle_status = 'retired'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> '' AND sealed_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= sealed_at
    )
  )
);

CREATE UNIQUE INDEX promise_safety_policy_versions_one_draft_uq
  ON inventory.promise_safety_policy_versions(scope_key)
  WHERE lifecycle_status = 'draft';
CREATE UNIQUE INDEX promise_safety_policy_versions_successor_uq
  ON inventory.promise_safety_policy_versions(supersedes_policy_id)
  WHERE supersedes_policy_id IS NOT NULL;

CREATE TABLE inventory.promise_safety_policy_heads (
  scope_key varchar(160) PRIMARY KEY,
  active_policy_id integer,
  draft_policy_id integer,
  revision bigint NOT NULL DEFAULT 0,
  updated_by varchar(100) NOT NULL,
  update_reason varchar(1000) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT promise_safety_policy_heads_active_fk
    FOREIGN KEY (active_policy_id, scope_key)
    REFERENCES inventory.promise_safety_policy_versions(id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT promise_safety_policy_heads_draft_fk
    FOREIGN KEY (draft_policy_id, scope_key)
    REFERENCES inventory.promise_safety_policy_versions(id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT promise_safety_policy_heads_distinct_chk CHECK (
    active_policy_id IS NULL OR draft_policy_id IS NULL OR active_policy_id <> draft_policy_id
  ),
  CONSTRAINT promise_safety_policy_heads_revision_chk CHECK (revision >= 0),
  CONSTRAINT promise_safety_policy_heads_reason_chk CHECK (
    char_length(btrim(update_reason)) BETWEEN 1 AND 1000
  )
);

CREATE TABLE inventory.demand_evidence_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  irreversible_consumption_units bigint NOT NULL,
  observed_days integer NOT NULL,
  daily_demand_milli_units bigint NOT NULL,
  trust_status varchar(20) NOT NULL,
  trust_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  method_version varchar(60) NOT NULL,
  input_fingerprint varchar(64) NOT NULL,
  override_by varchar(100),
  override_reason varchar(1000),
  override_expires_at timestamptz,
  calculated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT demand_evidence_snapshots_window_chk CHECK (
    window_ended_at > window_started_at AND calculated_at >= window_ended_at
  ),
  CONSTRAINT demand_evidence_snapshots_quantity_chk CHECK (
    irreversible_consumption_units >= 0 AND observed_days > 0 AND daily_demand_milli_units >= 0
  ),
  CONSTRAINT demand_evidence_snapshots_trust_chk CHECK (
    trust_status IN ('trusted', 'untrusted', 'overridden')
    AND jsonb_typeof(trust_reasons) = 'array'
  ),
  CONSTRAINT demand_evidence_snapshots_hash_chk CHECK (
    input_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT demand_evidence_snapshots_override_chk CHECK (
    (trust_status <> 'overridden'
      AND override_by IS NULL AND override_reason IS NULL AND override_expires_at IS NULL)
    OR (trust_status = 'overridden'
      AND override_by IS NOT NULL AND btrim(override_by) <> ''
      AND override_reason IS NOT NULL AND btrim(override_reason) <> ''
      AND override_expires_at IS NOT NULL AND override_expires_at > calculated_at)
  )
);

CREATE INDEX demand_evidence_snapshots_lookup_idx
  ON inventory.demand_evidence_snapshots(
    product_variant_id, warehouse_id, calculated_at DESC, id DESC
  );
CREATE UNIQUE INDEX demand_evidence_snapshots_input_uq
  ON inventory.demand_evidence_snapshots(
    product_variant_id,
    COALESCE(warehouse_id, 0),
    method_version,
    window_started_at,
    window_ended_at,
    input_fingerprint
  );

CREATE OR REPLACE FUNCTION warehouse.guard_fulfillment_identity_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  account_status varchar(20);
  location_status varchar(20);
  node_status varchar(20);
  lock_id integer;
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  old_id integer;
  new_id integer;
  old_provider_account_id integer;
  new_provider_account_id integer;
  old_provider_location_id integer;
  new_provider_location_id integer;
  old_fulfillment_node_id integer;
  new_fulfillment_node_id integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;

  old_id := NULLIF(old_row ->> 'id', '')::integer;
  new_id := NULLIF(new_row ->> 'id', '')::integer;
  old_provider_account_id := NULLIF(old_row ->> 'provider_account_id', '')::integer;
  new_provider_account_id := NULLIF(new_row ->> 'provider_account_id', '')::integer;
  old_provider_location_id := NULLIF(old_row ->> 'provider_location_id', '')::integer;
  new_provider_location_id := NULLIF(new_row ->> 'provider_location_id', '')::integer;
  old_fulfillment_node_id := NULLIF(old_row ->> 'fulfillment_node_id', '')::integer;
  new_fulfillment_node_id := NULLIF(new_row ->> 'fulfillment_node_id', '')::integer;

  -- Every lifecycle writer acquires the same hierarchy. Draft identity edits
  -- lock both the old and new parents so activation cannot race a re-parent.
  -- Families: provider account -> provider location -> fulfillment node.
  FOR lock_id IN
    SELECT DISTINCT candidate
    FROM unnest(CASE TG_TABLE_NAME
      WHEN 'fulfillment_provider_accounts' THEN ARRAY[
        CASE WHEN TG_OP = 'INSERT' THEN new_id ELSE old_id END,
        CASE WHEN TG_OP = 'UPDATE' THEN new_id END
      ]
      WHEN 'fulfillment_provider_locations' THEN ARRAY[
        CASE WHEN TG_OP = 'INSERT' THEN new_provider_account_id ELSE old_provider_account_id END,
        CASE WHEN TG_OP = 'UPDATE' THEN new_provider_account_id END
      ]
      WHEN 'fulfillment_nodes' THEN ARRAY[
        CASE WHEN TG_OP = 'INSERT' THEN new_provider_account_id ELSE old_provider_account_id END,
        CASE WHEN TG_OP = 'UPDATE' THEN new_provider_account_id END
      ]
      WHEN 'fulfillment_node_provider_bindings' THEN ARRAY[
        CASE WHEN TG_OP = 'INSERT' THEN new_provider_account_id ELSE old_provider_account_id END,
        CASE WHEN TG_OP = 'UPDATE' THEN new_provider_account_id END
      ]
    END) AS candidate
    WHERE candidate IS NOT NULL
    ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock(918411, lock_id);
  END LOOP;

  IF TG_TABLE_NAME IN (
    'fulfillment_provider_locations', 'fulfillment_nodes', 'fulfillment_node_provider_bindings'
  ) THEN
    FOR lock_id IN
      SELECT DISTINCT candidate
      FROM unnest(CASE TG_TABLE_NAME
        WHEN 'fulfillment_provider_locations' THEN ARRAY[
          CASE WHEN TG_OP = 'INSERT' THEN new_id ELSE old_id END,
          CASE WHEN TG_OP = 'UPDATE' THEN new_id END
        ]
        WHEN 'fulfillment_nodes' THEN ARRAY[
          CASE WHEN TG_OP = 'INSERT' THEN new_provider_location_id ELSE old_provider_location_id END,
          CASE WHEN TG_OP = 'UPDATE' THEN new_provider_location_id END
        ]
        WHEN 'fulfillment_node_provider_bindings' THEN ARRAY[
          CASE WHEN TG_OP = 'INSERT' THEN new_provider_location_id ELSE old_provider_location_id END,
          CASE WHEN TG_OP = 'UPDATE' THEN new_provider_location_id END
        ]
      END) AS candidate
      WHERE candidate IS NOT NULL
      ORDER BY candidate
    LOOP
      PERFORM pg_advisory_xact_lock(918412, lock_id);
    END LOOP;
  END IF;

  IF TG_TABLE_NAME IN ('fulfillment_nodes', 'fulfillment_node_provider_bindings') THEN
    FOR lock_id IN
      SELECT DISTINCT candidate
      FROM unnest(CASE TG_TABLE_NAME
        WHEN 'fulfillment_nodes' THEN ARRAY[
          CASE WHEN TG_OP = 'INSERT' THEN new_id ELSE old_id END,
          CASE WHEN TG_OP = 'UPDATE' THEN new_id END
        ]
        WHEN 'fulfillment_node_provider_bindings' THEN ARRAY[
          CASE WHEN TG_OP = 'INSERT' THEN new_fulfillment_node_id ELSE old_fulfillment_node_id END,
          CASE WHEN TG_OP = 'UPDATE' THEN new_fulfillment_node_id END
        ]
      END) AS candidate
      WHERE candidate IS NOT NULL
      ORDER BY candidate
    LOOP
      PERFORM pg_advisory_xact_lock(918413, lock_id);
    END LOOP;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF new_row ->> 'lifecycle_status' <> 'draft' THEN
      RAISE EXCEPTION '% must be inserted as a draft', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF old_row ->> 'lifecycle_status' = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% active or retired identities cannot be deleted', TG_TABLE_NAME;
  END IF;

  IF old_row -> 'id' IS DISTINCT FROM new_row -> 'id'
     OR old_row -> 'created_by' IS DISTINCT FROM new_row -> 'created_by'
     OR old_row -> 'created_at' IS DISTINCT FROM new_row -> 'created_at' THEN
    RAISE EXCEPTION '% durable identity fields are immutable', TG_TABLE_NAME;
  END IF;

  IF old_row ->> 'lifecycle_status' = 'draft'
     AND new_row ->> 'lifecycle_status' = 'draft' THEN
    RETURN NEW;
  END IF;

  IF old_row ->> 'lifecycle_status' = 'draft'
     AND new_row ->> 'lifecycle_status' = 'active' THEN
    IF TG_TABLE_NAME IN ('fulfillment_nodes', 'fulfillment_node_provider_bindings') THEN
      IF (
        new_row - ARRAY['lifecycle_status', 'activated_by', 'activated_at', 'updated_at']
      ) IS DISTINCT FROM (
        old_row - ARRAY['lifecycle_status', 'activated_by', 'activated_at', 'updated_at']
      ) THEN
        RAISE EXCEPTION '% identity cannot change while activating', TG_TABLE_NAME;
      END IF;
    ELSE
      IF (
        new_row - ARRAY['lifecycle_status', 'verified_by', 'verified_at', 'updated_at']
      ) IS DISTINCT FROM (
        old_row - ARRAY['lifecycle_status', 'verified_by', 'verified_at', 'updated_at']
      ) THEN
        RAISE EXCEPTION '% identity cannot change while verifying', TG_TABLE_NAME;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fulfillment_provider_locations' THEN
      SELECT lifecycle_status INTO account_status
      FROM warehouse.fulfillment_provider_accounts
      WHERE id = new_provider_account_id
      FOR KEY SHARE;
      IF account_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'provider location requires an active provider account';
      END IF;
    ELSIF TG_TABLE_NAME = 'fulfillment_node_provider_bindings' THEN
      SELECT lifecycle_status INTO account_status
      FROM warehouse.fulfillment_provider_accounts
      WHERE id = new_provider_account_id
      FOR KEY SHARE;
      SELECT lifecycle_status INTO location_status
      FROM warehouse.fulfillment_provider_locations
      WHERE id = new_provider_location_id
      FOR KEY SHARE;
      SELECT lifecycle_status INTO node_status
      FROM warehouse.fulfillment_nodes
      WHERE id = new_fulfillment_node_id
      FOR KEY SHARE;
      IF account_status IS DISTINCT FROM 'active'
         OR location_status IS DISTINCT FROM 'active'
         OR node_status NOT IN ('draft', 'active') THEN
        RAISE EXCEPTION 'node provider binding requires active provider identity and live node';
      END IF;
    ELSIF TG_TABLE_NAME = 'fulfillment_nodes' THEN
      IF (new_row ->> 'inventory_authority' = 'external_provider'
          OR new_row ->> 'fulfillment_authority' = 'external_provider')
         AND (new_provider_account_id IS NULL OR new_provider_location_id IS NULL) THEN
        RAISE EXCEPTION 'external authority requires one exact provider account and location';
      END IF;
      IF new_row ->> 'inventory_authority' = 'external_provider' AND NOT EXISTS (
        SELECT 1 FROM warehouse.fulfillment_node_provider_bindings
        WHERE fulfillment_node_id = new_id
          AND provider_account_id = new_provider_account_id
          AND provider_location_id = new_provider_location_id
          AND lifecycle_status = 'active' AND capability = 'inventory_observation'
      ) THEN
        RAISE EXCEPTION 'external inventory authority requires an active observation binding';
      END IF;
      IF new_row ->> 'fulfillment_authority' = 'external_provider' AND NOT EXISTS (
        SELECT 1 FROM warehouse.fulfillment_node_provider_bindings
        WHERE fulfillment_node_id = new_id
          AND provider_account_id = new_provider_account_id
          AND provider_location_id = new_provider_location_id
          AND lifecycle_status = 'active' AND capability = 'fulfillment_execution'
      ) THEN
        RAISE EXCEPTION 'external fulfillment authority requires an active execution binding';
      END IF;
      IF (new_row ->> 'inventory_authority' = 'external_provider'
          OR new_row ->> 'fulfillment_authority' = 'external_provider') AND NOT EXISTS (
        SELECT 1 FROM warehouse.fulfillment_node_provider_bindings
        WHERE fulfillment_node_id = new_id
          AND provider_account_id = new_provider_account_id
          AND provider_location_id = new_provider_location_id
          AND lifecycle_status = 'active' AND capability = 'custody_reconciliation'
      ) THEN
        RAISE EXCEPTION 'external authority requires an active custody reconciliation binding';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF old_row ->> 'lifecycle_status' = 'active'
     AND new_row ->> 'lifecycle_status' = 'retired' THEN
    IF (
      new_row - ARRAY['lifecycle_status', 'retired_by', 'retired_at', 'updated_at']
    ) IS DISTINCT FROM (
      old_row - ARRAY['lifecycle_status', 'retired_by', 'retired_at', 'updated_at']
    ) THEN
      RAISE EXCEPTION '% identity cannot change while retiring', TG_TABLE_NAME;
    END IF;

    IF TG_TABLE_NAME = 'fulfillment_provider_accounts' AND EXISTS (
      SELECT 1 FROM warehouse.fulfillment_provider_locations
      WHERE provider_account_id = old_id AND lifecycle_status = 'active'
    ) THEN
      RAISE EXCEPTION 'provider account with active locations cannot be retired';
    ELSIF TG_TABLE_NAME = 'fulfillment_provider_locations' AND EXISTS (
      SELECT 1 FROM warehouse.fulfillment_node_provider_bindings
      WHERE provider_location_id = old_id AND lifecycle_status = 'active'
    ) THEN
      RAISE EXCEPTION 'provider location with active node bindings cannot be retired';
    ELSIF TG_TABLE_NAME = 'fulfillment_node_provider_bindings' AND EXISTS (
      SELECT 1 FROM warehouse.fulfillment_nodes
      WHERE id = old_fulfillment_node_id AND lifecycle_status = 'active'
    ) THEN
      RAISE EXCEPTION 'provider binding cannot retire while its node is active';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% lifecycle transition % -> % is not allowed',
    TG_TABLE_NAME, old_row ->> 'lifecycle_status', new_row ->> 'lifecycle_status';
END;
$$;

CREATE TRIGGER fulfillment_nodes_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON warehouse.fulfillment_nodes
FOR EACH ROW EXECUTE FUNCTION warehouse.guard_fulfillment_identity_write();
CREATE TRIGGER fulfillment_provider_accounts_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON warehouse.fulfillment_provider_accounts
FOR EACH ROW EXECUTE FUNCTION warehouse.guard_fulfillment_identity_write();
CREATE TRIGGER fulfillment_provider_locations_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON warehouse.fulfillment_provider_locations
FOR EACH ROW EXECUTE FUNCTION warehouse.guard_fulfillment_identity_write();
CREATE TRIGGER fulfillment_node_provider_bindings_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON warehouse.fulfillment_node_provider_bindings
FOR EACH ROW EXECUTE FUNCTION warehouse.guard_fulfillment_identity_write();

CREATE OR REPLACE FUNCTION warehouse.assert_fulfillment_node_binding_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  affected_node_id integer;
  row_data jsonb;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  affected_node_id := CASE
    WHEN TG_TABLE_NAME = 'fulfillment_nodes' THEN NULLIF(row_data ->> 'id', '')::integer
    ELSE NULLIF(row_data ->> 'fulfillment_node_id', '')::integer
  END;

  IF EXISTS (
    SELECT 1
    FROM warehouse.fulfillment_nodes AS node
    JOIN warehouse.fulfillment_node_provider_bindings AS binding
      ON binding.fulfillment_node_id = node.id
    WHERE node.id = affected_node_id
      AND node.lifecycle_status = 'retired'
      AND binding.lifecycle_status = 'active'
  ) THEN
    RAISE EXCEPTION 'retired fulfillment node % retains active provider bindings', affected_node_id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE CONSTRAINT TRIGGER fulfillment_nodes_binding_coherence_guard
AFTER UPDATE ON warehouse.fulfillment_nodes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION warehouse.assert_fulfillment_node_binding_coherence();

CREATE CONSTRAINT TRIGGER fulfillment_node_bindings_node_coherence_guard
AFTER INSERT OR UPDATE OR DELETE ON warehouse.fulfillment_node_provider_bindings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION warehouse.assert_fulfillment_node_binding_coherence();

CREATE OR REPLACE FUNCTION inventory.guard_demand_evidence_snapshot_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'demand evidence snapshots are append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER demand_evidence_snapshots_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.demand_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_demand_evidence_snapshot_write();

CREATE OR REPLACE FUNCTION inventory.assert_version_predecessor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  predecessor_owner text;
  predecessor_version integer;
  expected_owner text;
  predecessor_id integer;
  version_number integer;
  new_row jsonb;
BEGIN
  new_row := to_jsonb(NEW);
  version_number := NULLIF(new_row ->> 'version', '')::integer;
  IF version_number = 1 THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'location_promise_policy_versions' THEN
    expected_owner := new_row ->> 'warehouse_location_id';
    predecessor_id := NULLIF(new_row ->> 'supersedes_policy_id', '')::integer;
    SELECT warehouse_location_id::text, version
      INTO predecessor_owner, predecessor_version
      FROM inventory.location_promise_policy_versions
      WHERE id = predecessor_id
      FOR KEY SHARE;
  ELSIF TG_TABLE_NAME = 'transformation_model_versions' THEN
    expected_owner := new_row ->> 'product_id';
    predecessor_id := NULLIF(new_row ->> 'supersedes_model_id', '')::integer;
    SELECT product_id::text, version
      INTO predecessor_owner, predecessor_version
      FROM inventory.transformation_model_versions
      WHERE id = predecessor_id
      FOR KEY SHARE;
  ELSIF TG_TABLE_NAME = 'promise_safety_policy_versions' THEN
    expected_owner := new_row ->> 'scope_key';
    predecessor_id := NULLIF(new_row ->> 'supersedes_policy_id', '')::integer;
    SELECT scope_key, version
      INTO predecessor_owner, predecessor_version
      FROM inventory.promise_safety_policy_versions
      WHERE id = predecessor_id
      FOR KEY SHARE;
  ELSE
    RAISE EXCEPTION 'unsupported versioned definition table %', TG_TABLE_NAME;
  END IF;

  IF predecessor_owner IS DISTINCT FROM expected_owner
     OR predecessor_version IS DISTINCT FROM version_number - 1 THEN
    RAISE EXCEPTION
      '% version % must supersede version % owned by the same scope',
      TG_TABLE_NAME, version_number, version_number - 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_promise_policy_versions_predecessor_guard
BEFORE INSERT ON inventory.location_promise_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.assert_version_predecessor();

CREATE TRIGGER transformation_model_versions_predecessor_guard
BEFORE INSERT ON inventory.transformation_model_versions
FOR EACH ROW EXECUTE FUNCTION inventory.assert_version_predecessor();

CREATE TRIGGER promise_safety_policy_versions_predecessor_guard
BEFORE INSERT ON inventory.promise_safety_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.assert_version_predecessor();

CREATE OR REPLACE FUNCTION inventory.guard_versioned_definition_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  requires_owner_lock boolean := true;
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  old_status varchar(20);
  new_status varchar(20);
  old_id integer;
  new_id integer;
  new_product_id integer;
  new_build_to_promise_enabled boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;
  old_status := old_row ->> 'lifecycle_status';
  new_status := new_row ->> 'lifecycle_status';
  old_id := NULLIF(old_row ->> 'id', '')::integer;
  new_id := NULLIF(new_row ->> 'id', '')::integer;
  new_product_id := NULLIF(new_row ->> 'product_id', '')::integer;
  new_build_to_promise_enabled := COALESCE(
    NULLIF(new_row ->> 'build_to_promise_enabled', '')::boolean,
    false
  );

  IF TG_OP = 'DELETE' AND old_status = 'draft' THEN
    requires_owner_lock := false;
  ELSIF TG_OP = 'UPDATE' AND old_status = 'draft' AND new_status = 'draft' THEN
    requires_owner_lock := false;
  END IF;

  IF requires_owner_lock AND TG_TABLE_NAME = 'location_promise_policy_versions' THEN
    PERFORM pg_advisory_xact_lock(
      918421,
      COALESCE(
        NULLIF(new_row ->> 'warehouse_location_id', '')::integer,
        NULLIF(old_row ->> 'warehouse_location_id', '')::integer
      )
    );
  ELSIF requires_owner_lock AND TG_TABLE_NAME = 'transformation_model_versions' THEN
    PERFORM pg_advisory_xact_lock(
      918422,
      COALESCE(new_product_id, NULLIF(old_row ->> 'product_id', '')::integer)
    );
  ELSIF requires_owner_lock AND TG_TABLE_NAME = 'promise_safety_policy_versions' THEN
    PERFORM pg_advisory_xact_lock(
      918423,
      hashtext(COALESCE(new_row ->> 'scope_key', old_row ->> 'scope_key'))
    );
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF new_status <> 'draft' THEN
      RAISE EXCEPTION '% must be inserted as a draft', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF old_status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% sealed definitions are append-only', TG_TABLE_NAME;
  END IF;

  IF old_status = 'draft' AND new_status = 'draft' THEN
    IF TG_TABLE_NAME = 'location_promise_policy_versions'
       AND (
         new_row -> 'id' IS DISTINCT FROM old_row -> 'id'
         OR new_row -> 'warehouse_location_id' IS DISTINCT FROM old_row -> 'warehouse_location_id'
         OR new_row -> 'version' IS DISTINCT FROM old_row -> 'version'
         OR new_row -> 'supersedes_policy_id' IS DISTINCT FROM old_row -> 'supersedes_policy_id'
         OR new_row -> 'idempotency_key' IS DISTINCT FROM old_row -> 'idempotency_key'
         OR new_row -> 'created_by' IS DISTINCT FROM old_row -> 'created_by'
         OR new_row -> 'created_at' IS DISTINCT FROM old_row -> 'created_at'
       ) THEN
      RAISE EXCEPTION 'location policy draft identity is immutable';
    ELSIF TG_TABLE_NAME = 'transformation_model_versions'
       AND (
         new_row -> 'id' IS DISTINCT FROM old_row -> 'id'
         OR new_row -> 'product_id' IS DISTINCT FROM old_row -> 'product_id'
         OR new_row -> 'version' IS DISTINCT FROM old_row -> 'version'
         OR new_row -> 'supersedes_model_id' IS DISTINCT FROM old_row -> 'supersedes_model_id'
         OR new_row -> 'idempotency_key' IS DISTINCT FROM old_row -> 'idempotency_key'
         OR new_row -> 'created_by' IS DISTINCT FROM old_row -> 'created_by'
         OR new_row -> 'created_at' IS DISTINCT FROM old_row -> 'created_at'
       ) THEN
      RAISE EXCEPTION 'transformation model draft identity is immutable';
    ELSIF TG_TABLE_NAME = 'promise_safety_policy_versions'
       AND (
         new_row -> 'id' IS DISTINCT FROM old_row -> 'id'
         OR new_row -> 'scope_key' IS DISTINCT FROM old_row -> 'scope_key'
         OR new_row -> 'scope_type' IS DISTINCT FROM old_row -> 'scope_type'
         OR new_row -> 'product_variant_id' IS DISTINCT FROM old_row -> 'product_variant_id'
         OR new_row -> 'warehouse_id' IS DISTINCT FROM old_row -> 'warehouse_id'
         OR new_row -> 'version' IS DISTINCT FROM old_row -> 'version'
         OR new_row -> 'supersedes_policy_id' IS DISTINCT FROM old_row -> 'supersedes_policy_id'
         OR new_row -> 'idempotency_key' IS DISTINCT FROM old_row -> 'idempotency_key'
         OR new_row -> 'created_by' IS DISTINCT FROM old_row -> 'created_by'
         OR new_row -> 'created_at' IS DISTINCT FROM old_row -> 'created_at'
       ) THEN
      RAISE EXCEPTION 'safety policy draft identity is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF old_status = 'draft' AND new_status = 'sealed' THEN
    IF (
      new_row - ARRAY['lifecycle_status', 'sealed_by', 'sealed_at', 'updated_at']
    ) IS DISTINCT FROM (
      old_row - ARRAY['lifecycle_status', 'sealed_by', 'sealed_at', 'updated_at']
    ) THEN
      RAISE EXCEPTION '% definition fields cannot change while sealing', TG_TABLE_NAME;
    END IF;

    IF TG_TABLE_NAME = 'transformation_model_versions' AND (
      EXISTS (
        SELECT 1
        FROM inventory.transformation_model_paths AS path
        JOIN catalog.product_variants AS source_variant
          ON source_variant.id = path.source_variant_id
        JOIN catalog.product_variants AS destination_variant
          ON destination_variant.id = path.destination_variant_id
        WHERE path.model_id = new_id
          AND (
            path.validation_state <> 'valid'
            OR source_variant.product_id <> new_product_id
            OR destination_variant.product_id <> new_product_id
            OR source_variant.units_per_variant <> path.source_units_per_variant
            OR destination_variant.units_per_variant <> path.destination_units_per_variant
          )
      )
      OR EXISTS (
        SELECT 1
        FROM inventory.transformation_recipe_bindings AS binding
        JOIN inventory.build_recipes AS recipe ON recipe.id = binding.recipe_id
        WHERE binding.model_id = new_id
          AND (
            binding.validation_state <> 'valid'
            OR recipe.status <> 'active'
            OR recipe.output_product_id <> new_product_id
            OR recipe.code <> binding.recipe_code_snapshot
            OR recipe.version <> binding.recipe_version_snapshot
            OR recipe.output_product_id <> binding.output_product_id_snapshot
            OR recipe.output_variant_id <> binding.output_variant_id_snapshot
            OR recipe.output_units_per_variant <> binding.output_units_per_variant_snapshot
            OR recipe.output_qty <> binding.output_qty_snapshot
          )
      )
      OR EXISTS (
        SELECT 1
        FROM inventory.transformation_recipe_bindings AS binding
        WHERE binding.model_id = new_id
          AND (
            NOT EXISTS (
              SELECT 1
              FROM inventory.transformation_recipe_component_snapshots AS snapshot
              WHERE snapshot.transformation_recipe_binding_id = binding.id
            )
            OR EXISTS (
              (
                SELECT component_variant_id, component_product_id,
                       component_units_per_variant, qty
                FROM inventory.build_recipe_components
                WHERE recipe_id = binding.recipe_id
              )
              EXCEPT
              (
                SELECT component_variant_id, component_product_id,
                       component_units_per_variant, component_qty
                FROM inventory.transformation_recipe_component_snapshots
                WHERE transformation_recipe_binding_id = binding.id
              )
            )
            OR EXISTS (
              (
                SELECT component_variant_id, component_product_id,
                       component_units_per_variant, component_qty
                FROM inventory.transformation_recipe_component_snapshots
                WHERE transformation_recipe_binding_id = binding.id
              )
              EXCEPT
              (
                SELECT component_variant_id, component_product_id,
                       component_units_per_variant, qty
                FROM inventory.build_recipe_components
                WHERE recipe_id = binding.recipe_id
              )
            )
          )
      )
      OR (
        new_build_to_promise_enabled
        AND NOT EXISTS (
          SELECT 1
          FROM inventory.transformation_recipe_bindings AS binding
          WHERE binding.model_id = new_id
            AND binding.relationship_role = 'component_build'
            AND binding.validation_state = 'valid'
        )
      )
      OR EXISTS (
        SELECT 1
        FROM inventory.transformation_model_paths AS path
        JOIN inventory.transformation_recipe_bindings AS binding
          ON binding.id = path.transformation_recipe_binding_id
         AND binding.model_id = path.model_id
        WHERE path.model_id = new_id
          AND (
            binding.output_variant_id_snapshot <> path.destination_variant_id
            OR binding.output_units_per_variant_snapshot <> path.destination_units_per_variant
            OR (
              path.operation_type = 'directed_conversion'
              AND (
                binding.relationship_role <> 'directional_conversion'
                OR binding.output_qty_snapshot <> path.output_qty
                OR (
                  SELECT count(*)
                  FROM inventory.build_recipe_components AS component
                  WHERE component.recipe_id = binding.recipe_id
                ) <> 1
                OR NOT EXISTS (
                  SELECT 1
                  FROM inventory.build_recipe_components AS component
                  WHERE component.recipe_id = binding.recipe_id
                    AND component.component_variant_id = path.source_variant_id
                    AND component.component_units_per_variant = path.source_units_per_variant
                    AND component.qty = path.input_qty
                )
              )
            )
          )
      )
    ) THEN
      RAISE EXCEPTION
        'transformation model % contains invalid or ownership-mismatched members',
        new_id;
    END IF;
    RETURN NEW;
  END IF;

  IF old_status = 'sealed' AND new_status = 'retired' THEN
    IF (
      new_row - ARRAY['lifecycle_status', 'retired_by', 'retired_at', 'updated_at']
    ) IS DISTINCT FROM (
      old_row - ARRAY['lifecycle_status', 'retired_by', 'retired_at', 'updated_at']
    ) THEN
      RAISE EXCEPTION '% definition fields cannot change while retiring', TG_TABLE_NAME;
    END IF;

    IF TG_TABLE_NAME = 'location_promise_policy_versions'
       AND EXISTS (
         SELECT 1 FROM inventory.location_promise_policy_heads
         WHERE active_policy_id = old_id
       ) THEN
      RAISE EXCEPTION 'active location policy % cannot be retired', old_id;
    ELSIF TG_TABLE_NAME = 'transformation_model_versions'
       AND EXISTS (
         SELECT 1 FROM inventory.transformation_model_heads
         WHERE active_model_id = old_id
       ) THEN
      RAISE EXCEPTION 'active transformation model % cannot be retired', old_id;
    ELSIF TG_TABLE_NAME = 'promise_safety_policy_versions'
       AND EXISTS (
         SELECT 1 FROM inventory.promise_safety_policy_heads
         WHERE active_policy_id = old_id
       ) THEN
      RAISE EXCEPTION 'active safety policy % cannot be retired', old_id;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% lifecycle transition % -> % is not allowed',
    TG_TABLE_NAME, old_status, new_status;
END;
$$;

CREATE TRIGGER location_promise_policy_versions_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.location_promise_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_versioned_definition_update();

CREATE TRIGGER transformation_model_versions_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_versioned_definition_update();

CREATE TRIGGER promise_safety_policy_versions_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.promise_safety_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_versioned_definition_update();

CREATE OR REPLACE FUNCTION inventory.guard_definition_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  active_id integer;
  draft_id integer;
  active_status varchar(20);
  draft_status varchar(20);
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  old_revision bigint;
  new_revision bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'location_promise_policy_heads'
       AND new_row -> 'warehouse_location_id'
         IS DISTINCT FROM old_row -> 'warehouse_location_id' THEN
      RAISE EXCEPTION '% owner key is immutable', TG_TABLE_NAME;
    ELSIF TG_TABLE_NAME = 'transformation_model_heads'
       AND new_row -> 'product_id' IS DISTINCT FROM old_row -> 'product_id' THEN
      RAISE EXCEPTION '% owner key is immutable', TG_TABLE_NAME;
    ELSIF TG_TABLE_NAME = 'promise_safety_policy_heads'
       AND new_row -> 'scope_key' IS DISTINCT FROM old_row -> 'scope_key' THEN
      RAISE EXCEPTION '% owner key is immutable', TG_TABLE_NAME;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% heads cannot be deleted', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'location_promise_policy_heads' THEN
    PERFORM pg_advisory_xact_lock(
      918421,
      NULLIF(new_row ->> 'warehouse_location_id', '')::integer
    );
  ELSIF TG_TABLE_NAME = 'transformation_model_heads' THEN
    PERFORM pg_advisory_xact_lock(918422, NULLIF(new_row ->> 'product_id', '')::integer);
  ELSIF TG_TABLE_NAME = 'promise_safety_policy_heads' THEN
    PERFORM pg_advisory_xact_lock(918423, hashtext(new_row ->> 'scope_key'));
  END IF;

  old_revision := NULLIF(old_row ->> 'revision', '')::bigint;
  new_revision := NULLIF(new_row ->> 'revision', '')::bigint;
  IF TG_OP = 'INSERT' AND new_revision <> 0 THEN
    RAISE EXCEPTION '% initial revision must be zero', TG_TABLE_NAME;
  ELSIF TG_OP = 'UPDATE' AND new_revision <> old_revision + 1 THEN
    RAISE EXCEPTION '% revision must advance exactly once', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'location_promise_policy_heads' THEN
    active_id := NULLIF(new_row ->> 'active_policy_id', '')::integer;
    draft_id := NULLIF(new_row ->> 'draft_policy_id', '')::integer;
    IF active_id IS NOT NULL THEN
      SELECT lifecycle_status INTO active_status
      FROM inventory.location_promise_policy_versions
      WHERE id = active_id FOR KEY SHARE;
    END IF;
    IF draft_id IS NOT NULL THEN
      SELECT lifecycle_status INTO draft_status
      FROM inventory.location_promise_policy_versions
      WHERE id = draft_id FOR KEY SHARE;
    END IF;
  ELSIF TG_TABLE_NAME = 'transformation_model_heads' THEN
    active_id := NULLIF(new_row ->> 'active_model_id', '')::integer;
    draft_id := NULLIF(new_row ->> 'draft_model_id', '')::integer;
    IF active_id IS NOT NULL THEN
      SELECT lifecycle_status INTO active_status
      FROM inventory.transformation_model_versions
      WHERE id = active_id FOR KEY SHARE;
    END IF;
    IF draft_id IS NOT NULL THEN
      SELECT lifecycle_status INTO draft_status
      FROM inventory.transformation_model_versions
      WHERE id = draft_id FOR KEY SHARE;
    END IF;
  ELSIF TG_TABLE_NAME = 'promise_safety_policy_heads' THEN
    active_id := NULLIF(new_row ->> 'active_policy_id', '')::integer;
    draft_id := NULLIF(new_row ->> 'draft_policy_id', '')::integer;
    IF active_id IS NOT NULL THEN
      SELECT lifecycle_status INTO active_status
      FROM inventory.promise_safety_policy_versions
      WHERE id = active_id FOR KEY SHARE;
    END IF;
    IF draft_id IS NOT NULL THEN
      SELECT lifecycle_status INTO draft_status
      FROM inventory.promise_safety_policy_versions
      WHERE id = draft_id FOR KEY SHARE;
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported definition head table %', TG_TABLE_NAME;
  END IF;

  IF active_id IS NOT NULL AND active_status IS DISTINCT FROM 'sealed' THEN
    RAISE EXCEPTION '% active pointer must reference a sealed definition', TG_TABLE_NAME;
  END IF;
  IF draft_id IS NOT NULL AND draft_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '% draft pointer must reference a draft definition', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_promise_policy_heads_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.location_promise_policy_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_definition_head_write();

CREATE TRIGGER transformation_model_heads_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_definition_head_write();

CREATE TRIGGER promise_safety_policy_heads_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.promise_safety_policy_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_definition_head_write();

CREATE OR REPLACE FUNCTION inventory.assert_definition_head_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  new_row jsonb;
  owner_integer integer;
  owner_text text;
BEGIN
  new_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'location_promise_policy_versions' THEN
    owner_integer := NULLIF(new_row ->> 'warehouse_location_id', '')::integer;
    IF EXISTS (
      SELECT 1 FROM inventory.location_promise_policy_heads AS head
      JOIN inventory.location_promise_policy_versions AS active
        ON active.id = head.active_policy_id
      WHERE head.warehouse_location_id = owner_integer
        AND active.lifecycle_status <> 'sealed'
    ) OR EXISTS (
      SELECT 1 FROM inventory.location_promise_policy_heads AS head
      JOIN inventory.location_promise_policy_versions AS draft
        ON draft.id = head.draft_policy_id
      WHERE head.warehouse_location_id = owner_integer
        AND draft.lifecycle_status <> 'draft'
    ) THEN
      RAISE EXCEPTION 'location promise policy head is not coherent with definition lifecycle';
    END IF;
  ELSIF TG_TABLE_NAME = 'transformation_model_versions' THEN
    owner_integer := NULLIF(new_row ->> 'product_id', '')::integer;
    IF EXISTS (
      SELECT 1 FROM inventory.transformation_model_heads AS head
      JOIN inventory.transformation_model_versions AS active
        ON active.id = head.active_model_id
      WHERE head.product_id = owner_integer
        AND active.lifecycle_status <> 'sealed'
    ) OR EXISTS (
      SELECT 1 FROM inventory.transformation_model_heads AS head
      JOIN inventory.transformation_model_versions AS draft
        ON draft.id = head.draft_model_id
      WHERE head.product_id = owner_integer
        AND draft.lifecycle_status <> 'draft'
    ) THEN
      RAISE EXCEPTION 'transformation model head is not coherent with definition lifecycle';
    END IF;
  ELSIF TG_TABLE_NAME = 'promise_safety_policy_versions' THEN
    owner_text := new_row ->> 'scope_key';
    IF EXISTS (
      SELECT 1 FROM inventory.promise_safety_policy_heads AS head
      JOIN inventory.promise_safety_policy_versions AS active
        ON active.id = head.active_policy_id
      WHERE head.scope_key = owner_text
        AND active.lifecycle_status <> 'sealed'
    ) OR EXISTS (
      SELECT 1 FROM inventory.promise_safety_policy_heads AS head
      JOIN inventory.promise_safety_policy_versions AS draft
        ON draft.id = head.draft_policy_id
      WHERE head.scope_key = owner_text
        AND draft.lifecycle_status <> 'draft'
    ) THEN
      RAISE EXCEPTION 'safety policy head is not coherent with definition lifecycle';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER location_policy_head_coherence_guard
AFTER UPDATE ON inventory.location_promise_policy_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.assert_definition_head_coherence();
CREATE CONSTRAINT TRIGGER transformation_model_head_coherence_guard
AFTER UPDATE ON inventory.transformation_model_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.assert_definition_head_coherence();
CREATE CONSTRAINT TRIGGER safety_policy_head_coherence_guard
AFTER UPDATE ON inventory.promise_safety_policy_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.assert_definition_head_coherence();

CREATE OR REPLACE FUNCTION inventory.guard_transformation_member_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_model_id integer;
  parent_status varchar(20);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.model_id IS DISTINCT FROM OLD.model_id THEN
      RAISE EXCEPTION 'transformation member model_id is immutable';
    END IF;
  END IF;

  parent_model_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.model_id
    ELSE NEW.model_id
  END;

  SELECT lifecycle_status
  INTO parent_status
  FROM inventory.transformation_model_versions
  WHERE id = parent_model_id
  FOR NO KEY UPDATE;

  IF parent_status IS NULL AND TG_OP = 'DELETE' THEN
    -- The parent draft may already be invisible while ON DELETE CASCADE runs.
    RETURN OLD;
  END IF;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'transformation model % does not exist', parent_model_id;
  END IF;

  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'transformation model % is immutable after sealing', parent_model_id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER transformation_model_paths_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_model_paths
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_member_write();

CREATE TRIGGER transformation_recipe_bindings_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_bindings
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_member_write();

CREATE TRIGGER transformation_recipe_component_snapshots_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_component_snapshots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_member_write();

CREATE OR REPLACE FUNCTION inventory.invalidate_transformation_model_after_member_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_model_id integer;
BEGIN
  parent_model_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.model_id
    ELSE NEW.model_id
  END;

  UPDATE inventory.transformation_model_versions
  SET
    validation_state = 'invalid',
    validation_errors = jsonb_build_array(
      jsonb_build_object(
        'code', 'members_changed',
        'member_table', TG_TABLE_NAME
      )
    ),
    updated_at = transaction_timestamp()
  WHERE id = parent_model_id
    AND lifecycle_status = 'draft';

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER transformation_model_paths_invalidate_parent
AFTER INSERT OR UPDATE OR DELETE ON inventory.transformation_model_paths
FOR EACH ROW EXECUTE FUNCTION inventory.invalidate_transformation_model_after_member_write();

CREATE TRIGGER transformation_recipe_bindings_invalidate_parent
AFTER INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_bindings
FOR EACH ROW EXECUTE FUNCTION inventory.invalidate_transformation_model_after_member_write();

CREATE TRIGGER transformation_recipe_component_snapshots_invalidate_parent
AFTER INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_component_snapshots
FOR EACH ROW EXECUTE FUNCTION inventory.invalidate_transformation_model_after_member_write();

COMMENT ON TABLE inventory.transformation_model_paths IS
  'Explicit directed authority only. A reverse conversion requires a separate row; UI grouping grants no authority.';
COMMENT ON COLUMN inventory.promise_safety_policy_versions.days_of_cover_milli_days IS
  'Fixed-point days of cover: 1000 = 1.000 day. Never use floating point in planner policy math.';
