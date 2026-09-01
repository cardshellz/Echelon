-- Inactive channel-exposure policy and publication-source scope foundation.
--
-- This migration intentionally creates no policy, source binding, publication
-- target, outbox entry, or provider work. Legacy allocation remains runtime
-- authority until a separately reviewed full-catalog activation.

CREATE TABLE inventory.channel_exposure_policy_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key VARCHAR(200) NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  scope_type VARCHAR(20) NOT NULL,
  product_id INTEGER REFERENCES catalog.products(id) ON DELETE RESTRICT,
  product_variant_id INTEGER,
  version INTEGER NOT NULL,
  lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  allocation_semantics VARCHAR(20),
  eligible BOOLEAN,
  share_bps INTEGER,
  holdback_sellable_units BIGINT,
  max_publish_mode VARCHAR(20),
  max_publish_sellable_units BIGINT,
  min_publish_sellable_units BIGINT,
  definition_hash VARCHAR(64) NOT NULL,
  supersedes_policy_id INTEGER,
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
  CONSTRAINT channel_exposure_policy_versions_variant_product_fk
    FOREIGN KEY (product_variant_id, product_id)
    REFERENCES catalog.product_variants(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT channel_exposure_policy_versions_scope_version_uq
    UNIQUE (scope_key, version),
  CONSTRAINT channel_exposure_policy_versions_id_scope_uq UNIQUE (id, scope_key),
  CONSTRAINT channel_exposure_policy_versions_predecessor_fk
    FOREIGN KEY (supersedes_policy_id, scope_key)
    REFERENCES inventory.channel_exposure_policy_versions(id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT channel_exposure_policy_versions_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT channel_exposure_policy_versions_scope_chk CHECK (
    (scope_type = 'channel'
      AND scope_key = 'channel:' || channel_id::text
      AND product_id IS NULL AND product_variant_id IS NULL)
    OR (scope_type = 'product'
      AND scope_key = 'channel:' || channel_id::text || ':product:' || product_id::text
      AND product_id IS NOT NULL AND product_variant_id IS NULL)
    OR (scope_type = 'variant'
      AND scope_key = 'channel:' || channel_id::text || ':variant:' || product_variant_id::text
      AND product_id IS NOT NULL AND product_variant_id IS NOT NULL)
  ),
  CONSTRAINT channel_exposure_policy_versions_value_chk CHECK (
    allocation_semantics IS NOT NULL OR eligible IS NOT NULL OR share_bps IS NOT NULL
      OR holdback_sellable_units IS NOT NULL OR max_publish_mode IS NOT NULL
      OR min_publish_sellable_units IS NOT NULL
  ),
  CONSTRAINT channel_exposure_policy_versions_semantics_chk
    CHECK (allocation_semantics IS NULL OR allocation_semantics IN ('exposure', 'partitioned')),
  CONSTRAINT channel_exposure_policy_versions_quantity_chk CHECK (
    (share_bps IS NULL OR share_bps BETWEEN 0 AND 10000)
    AND (holdback_sellable_units IS NULL OR holdback_sellable_units >= 0)
    AND ((max_publish_mode IS NULL AND max_publish_sellable_units IS NULL)
      OR (max_publish_mode = 'unlimited' AND max_publish_sellable_units IS NULL)
      OR (max_publish_mode = 'units' AND max_publish_sellable_units IS NOT NULL
        AND max_publish_sellable_units >= 0))
    AND (min_publish_sellable_units IS NULL OR min_publish_sellable_units >= 0)
  ),
  CONSTRAINT channel_exposure_policy_versions_version_chk CHECK (version > 0),
  CONSTRAINT channel_exposure_policy_versions_status_chk
    CHECK (lifecycle_status IN ('draft', 'sealed', 'retired')),
  CONSTRAINT channel_exposure_policy_versions_hash_chk CHECK (
    definition_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT channel_exposure_policy_versions_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT channel_exposure_policy_versions_predecessor_chk CHECK (
    (version = 1 AND supersedes_policy_id IS NULL)
    OR (version > 1 AND supersedes_policy_id IS NOT NULL)
  ),
  CONSTRAINT channel_exposure_policy_versions_lifecycle_chk CHECK (
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

CREATE UNIQUE INDEX channel_exposure_policy_versions_one_draft_uq
  ON inventory.channel_exposure_policy_versions(scope_key)
  WHERE lifecycle_status = 'draft';
CREATE UNIQUE INDEX channel_exposure_policy_versions_successor_uq
  ON inventory.channel_exposure_policy_versions(supersedes_policy_id)
  WHERE supersedes_policy_id IS NOT NULL;
CREATE INDEX channel_exposure_policy_versions_resolution_idx
  ON inventory.channel_exposure_policy_versions(channel_id, product_id, product_variant_id, id);

CREATE TABLE inventory.channel_exposure_policy_heads (
  scope_key VARCHAR(200) PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  active_policy_id INTEGER,
  draft_policy_id INTEGER,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by VARCHAR(100) NOT NULL,
  update_reason VARCHAR(1000) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT channel_exposure_policy_heads_active_fk
    FOREIGN KEY (active_policy_id, scope_key)
    REFERENCES inventory.channel_exposure_policy_versions(id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT channel_exposure_policy_heads_draft_fk
    FOREIGN KEY (draft_policy_id, scope_key)
    REFERENCES inventory.channel_exposure_policy_versions(id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT channel_exposure_policy_heads_distinct_chk CHECK (
    active_policy_id IS NULL OR draft_policy_id IS NULL OR active_policy_id <> draft_policy_id
  ),
  CONSTRAINT channel_exposure_policy_heads_revision_chk CHECK (revision >= 0),
  CONSTRAINT channel_exposure_policy_heads_actor_chk CHECK (
    char_length(btrim(updated_by)) BETWEEN 1 AND 100
    AND char_length(btrim(update_reason)) BETWEEN 1 AND 1000
  )
);

CREATE TABLE inventory.publication_source_binding_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  definition_hash VARCHAR(64) NOT NULL,
  supersedes_binding_id INTEGER,
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
  CONSTRAINT publication_source_binding_versions_target_version_uq
    UNIQUE (publication_target_id, version),
  CONSTRAINT publication_source_binding_versions_id_target_uq
    UNIQUE (id, publication_target_id),
  CONSTRAINT publication_source_binding_versions_predecessor_fk
    FOREIGN KEY (supersedes_binding_id, publication_target_id)
    REFERENCES inventory.publication_source_binding_versions(id, publication_target_id)
    ON DELETE RESTRICT,
  CONSTRAINT publication_source_binding_versions_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT publication_source_binding_versions_version_chk CHECK (version > 0),
  CONSTRAINT publication_source_binding_versions_status_chk
    CHECK (lifecycle_status IN ('draft', 'sealed', 'retired')),
  CONSTRAINT publication_source_binding_versions_hash_chk CHECK (
    definition_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT publication_source_binding_versions_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND char_length(btrim(change_reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT publication_source_binding_versions_predecessor_chk CHECK (
    (version = 1 AND supersedes_binding_id IS NULL)
    OR (version > 1 AND supersedes_binding_id IS NOT NULL)
  ),
  CONSTRAINT publication_source_binding_versions_lifecycle_chk CHECK (
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

CREATE UNIQUE INDEX publication_source_binding_versions_one_draft_uq
  ON inventory.publication_source_binding_versions(publication_target_id)
  WHERE lifecycle_status = 'draft';
CREATE UNIQUE INDEX publication_source_binding_versions_successor_uq
  ON inventory.publication_source_binding_versions(supersedes_binding_id)
  WHERE supersedes_binding_id IS NOT NULL;

CREATE TABLE inventory.publication_source_binding_members (
  binding_id INTEGER NOT NULL,
  publication_target_id INTEGER NOT NULL,
  fulfillment_node_id INTEGER NOT NULL
    REFERENCES warehouse.fulfillment_nodes(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (binding_id, fulfillment_node_id),
  CONSTRAINT publication_source_binding_members_binding_fk
    FOREIGN KEY (binding_id, publication_target_id)
    REFERENCES inventory.publication_source_binding_versions(id, publication_target_id)
    ON DELETE CASCADE,
  CONSTRAINT publication_source_binding_members_priority_uq
    UNIQUE (binding_id, priority),
  CONSTRAINT publication_source_binding_members_priority_chk CHECK (priority > 0)
);

CREATE INDEX publication_source_binding_members_target_idx
  ON inventory.publication_source_binding_members(publication_target_id, binding_id, priority);

CREATE TABLE inventory.publication_source_binding_heads (
  publication_target_id INTEGER PRIMARY KEY
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  active_binding_id INTEGER,
  draft_binding_id INTEGER,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by VARCHAR(100) NOT NULL,
  update_reason VARCHAR(1000) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT publication_source_binding_heads_active_fk
    FOREIGN KEY (active_binding_id, publication_target_id)
    REFERENCES inventory.publication_source_binding_versions(id, publication_target_id)
    ON DELETE RESTRICT,
  CONSTRAINT publication_source_binding_heads_draft_fk
    FOREIGN KEY (draft_binding_id, publication_target_id)
    REFERENCES inventory.publication_source_binding_versions(id, publication_target_id)
    ON DELETE RESTRICT,
  CONSTRAINT publication_source_binding_heads_distinct_chk CHECK (
    active_binding_id IS NULL OR draft_binding_id IS NULL OR active_binding_id <> draft_binding_id
  ),
  CONSTRAINT publication_source_binding_heads_revision_chk CHECK (revision >= 0),
  CONSTRAINT publication_source_binding_heads_actor_chk CHECK (
    char_length(btrim(updated_by)) BETWEEN 1 AND 100
    AND char_length(btrim(update_reason)) BETWEEN 1 AND 1000
  )
);

CREATE OR REPLACE FUNCTION inventory.guard_channel_exposure_draft_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.supersedes_policy_id IS DISTINCT FROM OLD.supersedes_policy_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'channel exposure policy identity and request evidence are immutable';
  END IF;
  IF OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status IN ('draft', 'sealed')
     AND NOT EXISTS (
    SELECT 1 FROM inventory.channel_exposure_policy_heads AS head
    WHERE head.scope_key = OLD.scope_key AND head.draft_policy_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'only the policy referenced by the draft head may be edited';
  END IF;
  IF NEW.lifecycle_status <> 'draft' AND (
    NEW.allocation_semantics IS DISTINCT FROM OLD.allocation_semantics
    OR NEW.eligible IS DISTINCT FROM OLD.eligible
    OR NEW.share_bps IS DISTINCT FROM OLD.share_bps
    OR NEW.holdback_sellable_units IS DISTINCT FROM OLD.holdback_sellable_units
    OR NEW.max_publish_mode IS DISTINCT FROM OLD.max_publish_mode
    OR NEW.max_publish_sellable_units IS DISTINCT FROM OLD.max_publish_sellable_units
    OR NEW.min_publish_sellable_units IS DISTINCT FROM OLD.min_publish_sellable_units
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
  ) THEN
    RAISE EXCEPTION 'sealed channel exposure definition is immutable';
  END IF;
  IF OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status = 'sealed'
     AND NEW.scope_type = 'channel'
     AND (NEW.allocation_semantics IS NULL OR NEW.eligible IS NULL OR NEW.share_bps IS NULL
       OR NEW.holdback_sellable_units IS NULL OR NEW.max_publish_mode IS NULL
       OR NEW.min_publish_sellable_units IS NULL) THEN
    RAISE EXCEPTION 'a channel default must resolve every exposure field before sealing';
  END IF;
  IF NOT (
    (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status IN ('draft', 'sealed'))
    OR (OLD.lifecycle_status = 'sealed' AND NEW.lifecycle_status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid channel exposure lifecycle transition from % to %',
      OLD.lifecycle_status, NEW.lifecycle_status;
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_exposure_policy_versions_write_guard
BEFORE UPDATE OR DELETE ON inventory.channel_exposure_policy_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_channel_exposure_draft_update();

CREATE OR REPLACE FUNCTION inventory.guard_publication_source_binding_update()
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
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.supersedes_binding_id IS DISTINCT FROM OLD.supersedes_binding_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication source binding identity and request evidence are immutable';
  END IF;
  IF OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status IN ('draft', 'sealed')
     AND NOT EXISTS (
    SELECT 1 FROM inventory.publication_source_binding_heads AS head
    WHERE head.publication_target_id = OLD.publication_target_id
      AND head.draft_binding_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'only the binding referenced by the draft head may be edited';
  END IF;
  IF NEW.lifecycle_status <> 'draft' AND (
    NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
  ) THEN
    RAISE EXCEPTION 'sealed publication source binding definition is immutable';
  END IF;
  IF OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status = 'sealed'
     AND NOT EXISTS (
       SELECT 1 FROM inventory.publication_source_binding_members AS member
       WHERE member.binding_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'a publication source binding must contain at least one node before sealing';
  END IF;
  IF NOT (
    (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status IN ('draft', 'sealed'))
    OR (OLD.lifecycle_status = 'sealed' AND NEW.lifecycle_status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid publication source binding lifecycle transition from % to %',
      OLD.lifecycle_status, NEW.lifecycle_status;
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_source_binding_versions_write_guard
BEFORE UPDATE OR DELETE ON inventory.publication_source_binding_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_source_binding_update();

CREATE OR REPLACE FUNCTION inventory.guard_publication_source_binding_member_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_id INTEGER;
  parent_target_id INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.binding_id;
    parent_target_id := OLD.publication_target_id;
  ELSE
    parent_id := NEW.binding_id;
    parent_target_id := NEW.publication_target_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM inventory.publication_source_binding_versions AS binding
    JOIN inventory.publication_source_binding_heads AS head
      ON head.publication_target_id = binding.publication_target_id
     AND head.draft_binding_id = binding.id
    WHERE binding.id = parent_id
      AND binding.publication_target_id = parent_target_id
      AND binding.lifecycle_status = 'draft'
  ) THEN
    RAISE EXCEPTION 'source binding members may change only on the current draft';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_source_binding_members_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_source_binding_members
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_source_binding_member_write();

CREATE OR REPLACE FUNCTION inventory.check_channel_exposure_policy_head_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_scope_key VARCHAR(200) := CASE
    WHEN TG_TABLE_NAME = 'channel_exposure_policy_heads' THEN NEW.scope_key
    ELSE NEW.scope_key
  END;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory.channel_exposure_policy_heads AS head
    LEFT JOIN inventory.channel_exposure_policy_versions AS active ON active.id = head.active_policy_id
    LEFT JOIN inventory.channel_exposure_policy_versions AS draft ON draft.id = head.draft_policy_id
    WHERE head.scope_key = checked_scope_key
      AND (
        (active.id IS NOT NULL AND (active.lifecycle_status <> 'sealed' OR active.channel_id <> head.channel_id))
        OR (draft.id IS NOT NULL AND (draft.lifecycle_status <> 'draft' OR draft.channel_id <> head.channel_id))
      )
  ) THEN
    RAISE EXCEPTION 'channel exposure policy head lifecycle or channel is incoherent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER channel_exposure_policy_heads_coherence_guard
AFTER INSERT OR UPDATE ON inventory.channel_exposure_policy_heads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.check_channel_exposure_policy_head_coherence();

CREATE CONSTRAINT TRIGGER channel_exposure_policy_versions_head_coherence_guard
AFTER UPDATE ON inventory.channel_exposure_policy_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.check_channel_exposure_policy_head_coherence();

CREATE OR REPLACE FUNCTION inventory.check_publication_source_binding_head_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_target_id INTEGER := NEW.publication_target_id;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory.publication_source_binding_heads AS head
    LEFT JOIN inventory.publication_source_binding_versions AS active ON active.id = head.active_binding_id
    LEFT JOIN inventory.publication_source_binding_versions AS draft ON draft.id = head.draft_binding_id
    WHERE head.publication_target_id = checked_target_id
      AND (
        (active.id IS NOT NULL AND active.lifecycle_status <> 'sealed')
        OR (draft.id IS NOT NULL AND draft.lifecycle_status <> 'draft')
      )
  ) THEN
    RAISE EXCEPTION 'publication source binding head lifecycle is incoherent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER publication_source_binding_heads_coherence_guard
AFTER INSERT OR UPDATE ON inventory.publication_source_binding_heads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_source_binding_head_coherence();

CREATE CONSTRAINT TRIGGER publication_source_binding_versions_head_coherence_guard
AFTER UPDATE ON inventory.publication_source_binding_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_source_binding_head_coherence();

CREATE OR REPLACE FUNCTION inventory.guard_channel_exposure_policy_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel exposure policy heads cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'new channel exposure policy head revision must be 1';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.scope_key IS DISTINCT FROM OLD.scope_key
    OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'channel exposure policy head identity is immutable and revision must increment by 1';
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_exposure_policy_heads_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.channel_exposure_policy_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_channel_exposure_policy_head_write();

CREATE OR REPLACE FUNCTION inventory.guard_publication_source_binding_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication source binding heads cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'new publication source binding head revision must be 1';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.publication_target_id IS DISTINCT FROM OLD.publication_target_id
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'publication source binding head identity is immutable and revision must increment by 1';
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_source_binding_heads_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_source_binding_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_source_binding_head_write();

COMMENT ON TABLE inventory.channel_exposure_policy_versions IS
  'Versioned channel/product/SKU sellable-unit exposure dials. Inactive until catalog activation.';
COMMENT ON TABLE inventory.publication_source_binding_versions IS
  'Versioned exact fulfillment-node sets feeding one external publication target.';
COMMENT ON TABLE inventory.publication_source_binding_members IS
  'Ordered fulfillment nodes in one publication-source binding version; never defaults to all warehouses.';
