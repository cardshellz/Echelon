-- Inventory publication readiness remains inactive. This migration adds exact
-- target/SKU mapping drafts and concurrency evidence; it does not activate ATP,
-- enqueue publication, call providers, or change target state by itself.

ALTER TABLE inventory.inventory_publication_targets
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE inventory.inventory_publication_targets
  ADD CONSTRAINT inventory_publication_targets_revision_chk CHECK (revision > 0);

ALTER TABLE inventory.inventory_publication_readbacks
  ADD COLUMN external_inventory_item_id_snapshot VARCHAR(240);

ALTER TABLE inventory.inventory_publication_readbacks
  ADD CONSTRAINT inventory_publication_readbacks_identity_snapshot_chk CHECK (
    external_inventory_item_id_snapshot IS NULL
    OR char_length(btrim(external_inventory_item_id_snapshot)) BETWEEN 1 AND 240
  );

CREATE TABLE inventory.publication_variant_mapping_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  external_inventory_item_id VARCHAR(240) NOT NULL,
  external_sku VARCHAR(100),
  definition_hash VARCHAR(64) NOT NULL,
  supersedes_mapping_id INTEGER,
  change_reason VARCHAR(1000) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by VARCHAR(100) NOT NULL,
  sealed_by VARCHAR(100),
  sealed_at TIMESTAMPTZ,
  retired_by VARCHAR(100),
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT publication_variant_mapping_versions_target_variant_version_uq
    UNIQUE (publication_target_id, product_variant_id, version),
  CONSTRAINT publication_variant_mapping_versions_id_scope_uq
    UNIQUE (id, publication_target_id, product_variant_id),
  CONSTRAINT publication_variant_mapping_versions_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT publication_variant_mapping_versions_successor_uq UNIQUE (supersedes_mapping_id),
  CONSTRAINT publication_variant_mapping_versions_predecessor_fk
    FOREIGN KEY (supersedes_mapping_id, publication_target_id, product_variant_id)
    REFERENCES inventory.publication_variant_mapping_versions(
      id, publication_target_id, product_variant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT publication_variant_mapping_versions_version_chk CHECK (version > 0),
  CONSTRAINT publication_variant_mapping_versions_status_chk
    CHECK (lifecycle_status IN ('draft', 'sealed', 'retired')),
  CONSTRAINT publication_variant_mapping_versions_identity_chk CHECK (
    char_length(btrim(external_inventory_item_id)) BETWEEN 1 AND 240
    AND (external_sku IS NULL OR char_length(btrim(external_sku)) BETWEEN 1 AND 100)
  ),
  CONSTRAINT publication_variant_mapping_versions_hash_chk CHECK (
    definition_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT publication_variant_mapping_versions_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT publication_variant_mapping_versions_predecessor_chk CHECK (
    (version = 1 AND supersedes_mapping_id IS NULL)
    OR (version > 1 AND supersedes_mapping_id IS NOT NULL)
  ),
  CONSTRAINT publication_variant_mapping_versions_lifecycle_chk CHECK (
    (lifecycle_status = 'draft'
      AND sealed_by IS NULL AND sealed_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'sealed'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> '' AND sealed_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL)
    OR (lifecycle_status = 'retired'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> '' AND sealed_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= sealed_at)
  )
);

CREATE UNIQUE INDEX publication_variant_mapping_versions_one_draft_uq
  ON inventory.publication_variant_mapping_versions(publication_target_id, product_variant_id)
  WHERE lifecycle_status = 'draft';

CREATE INDEX publication_variant_mapping_versions_resolution_idx
  ON inventory.publication_variant_mapping_versions(
    publication_target_id, product_variant_id, id
  );

CREATE TABLE inventory.publication_variant_mapping_heads (
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  active_mapping_id INTEGER,
  draft_mapping_id INTEGER,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by VARCHAR(100) NOT NULL,
  update_reason VARCHAR(1000) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (publication_target_id, product_variant_id),
  CONSTRAINT publication_variant_mapping_heads_active_fk
    FOREIGN KEY (active_mapping_id, publication_target_id, product_variant_id)
    REFERENCES inventory.publication_variant_mapping_versions(
      id, publication_target_id, product_variant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT publication_variant_mapping_heads_draft_fk
    FOREIGN KEY (draft_mapping_id, publication_target_id, product_variant_id)
    REFERENCES inventory.publication_variant_mapping_versions(
      id, publication_target_id, product_variant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT publication_variant_mapping_heads_distinct_chk CHECK (
    active_mapping_id IS NULL OR draft_mapping_id IS NULL OR active_mapping_id <> draft_mapping_id
  ),
  CONSTRAINT publication_variant_mapping_heads_revision_chk CHECK (revision > 0),
  CONSTRAINT publication_variant_mapping_heads_actor_chk CHECK (
    char_length(btrim(updated_by)) BETWEEN 1 AND 100
    AND char_length(btrim(update_reason)) BETWEEN 1 AND 1000
  )
);

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_target_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id
     OR NEW.fulfillment_node_id IS DISTINCT FROM OLD.fulfillment_node_id
     OR NEW.provider_scope_type IS DISTINCT FROM OLD.provider_scope_type
     OR NEW.external_scope_id IS DISTINCT FROM OLD.external_scope_id
     OR NEW.publication_authority IS DISTINCT FROM OLD.publication_authority
     OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory publication target identity and creation evidence are immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'inventory publication target revision must increment by 1';
  END IF;
  IF OLD.state = 'live' AND NEW.state <> 'live' THEN
    RAISE EXCEPTION 'a live publication target cannot return to legacy or preview state';
  END IF;
  IF NEW.state = 'live' AND OLD.state <> 'preview' THEN
    RAISE EXCEPTION 'a publication target must be previewed before it becomes live';
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_publication_targets_update_guard
BEFORE UPDATE ON inventory.inventory_publication_targets
FOR EACH ROW EXECUTE FUNCTION inventory.guard_inventory_publication_target_update();

CREATE OR REPLACE FUNCTION inventory.guard_publication_variant_mapping_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.publication_target_id IS DISTINCT FROM OLD.publication_target_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.supersedes_mapping_id IS DISTINCT FROM OLD.supersedes_mapping_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication variant mapping identity and request evidence are immutable';
  END IF;
  IF OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status IN ('draft', 'sealed')
     AND NOT EXISTS (
       SELECT 1 FROM inventory.publication_variant_mapping_heads AS head
       WHERE head.publication_target_id = OLD.publication_target_id
         AND head.product_variant_id = OLD.product_variant_id
         AND head.draft_mapping_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'only the mapping referenced by the draft head may be edited';
  END IF;
  IF NEW.lifecycle_status <> 'draft' AND (
    NEW.external_inventory_item_id IS DISTINCT FROM OLD.external_inventory_item_id
    OR NEW.external_sku IS DISTINCT FROM OLD.external_sku
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
  ) THEN
    RAISE EXCEPTION 'sealed publication variant mapping definition is immutable';
  END IF;
  IF NOT (
    (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status IN ('draft', 'sealed'))
    OR (OLD.lifecycle_status = 'sealed' AND NEW.lifecycle_status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid publication variant mapping lifecycle transition from % to %',
      OLD.lifecycle_status, NEW.lifecycle_status;
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_variant_mapping_versions_write_guard
BEFORE UPDATE OR DELETE ON inventory.publication_variant_mapping_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_variant_mapping_update();

CREATE OR REPLACE FUNCTION inventory.check_publication_variant_mapping_head_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_target_id INTEGER := NEW.publication_target_id;
  checked_variant_id INTEGER := NEW.product_variant_id;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory.publication_variant_mapping_heads AS head
    LEFT JOIN inventory.publication_variant_mapping_versions AS active
      ON active.id = head.active_mapping_id
    LEFT JOIN inventory.publication_variant_mapping_versions AS draft
      ON draft.id = head.draft_mapping_id
    WHERE head.publication_target_id = checked_target_id
      AND head.product_variant_id = checked_variant_id
      AND (
        (active.id IS NOT NULL AND active.lifecycle_status <> 'sealed')
        OR (draft.id IS NOT NULL AND draft.lifecycle_status <> 'draft')
      )
  ) THEN
    RAISE EXCEPTION 'publication variant mapping head lifecycle is incoherent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM inventory.publication_variant_mapping_versions AS mapping
    LEFT JOIN inventory.publication_variant_mapping_heads AS head
      ON head.publication_target_id = mapping.publication_target_id
     AND head.product_variant_id = mapping.product_variant_id
     AND head.draft_mapping_id = mapping.id
    WHERE mapping.publication_target_id = checked_target_id
      AND mapping.product_variant_id = checked_variant_id
      AND mapping.lifecycle_status = 'draft'
      AND head.draft_mapping_id IS NULL
  ) THEN
    RAISE EXCEPTION 'a draft publication variant mapping must be owned by its exact head';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM inventory.publication_variant_mapping_heads AS head
    JOIN inventory.publication_variant_mapping_versions AS mapping
      ON mapping.id = COALESCE(head.draft_mapping_id, head.active_mapping_id)
    WHERE head.publication_target_id = checked_target_id
    GROUP BY mapping.external_inventory_item_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'one provider inventory item cannot map to multiple SKUs in the same publication target';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER publication_variant_mapping_heads_coherence_guard
AFTER INSERT OR UPDATE ON inventory.publication_variant_mapping_heads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_variant_mapping_head_coherence();

CREATE CONSTRAINT TRIGGER publication_variant_mapping_versions_head_coherence_guard
AFTER INSERT OR UPDATE ON inventory.publication_variant_mapping_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_variant_mapping_head_coherence();

CREATE OR REPLACE FUNCTION inventory.guard_publication_variant_mapping_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication variant mapping heads cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'new publication variant mapping head revision must be 1';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.publication_target_id IS DISTINCT FROM OLD.publication_target_id
    OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'publication variant mapping head identity is immutable and revision must increment by 1';
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_variant_mapping_heads_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_variant_mapping_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_variant_mapping_head_write();

COMMENT ON TABLE inventory.publication_variant_mapping_versions IS
  'Versioned exact provider inventory identities for one publication target and sellable SKU; inactive until catalog activation.';
COMMENT ON COLUMN inventory.inventory_publication_targets.revision IS
  'Optimistic concurrency revision for audited disabled/preview/live target-state transitions.';
COMMENT ON COLUMN inventory.inventory_publication_readbacks.external_inventory_item_id_snapshot IS
  'Provider inventory identity observed by the readback; readiness rejects identity-less or stale-mapping evidence.';
