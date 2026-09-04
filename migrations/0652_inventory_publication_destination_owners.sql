-- Exact inventory publication destinations may be owned either by a Channels
-- connection or by a Dropship store connection. Existing rows are preserved as
-- Channels destinations. This migration creates no target, policy, mapping,
-- outbox row, provider request, or inventory quantity change.

ALTER TABLE inventory.inventory_publication_targets
  ADD COLUMN destination_kind VARCHAR(30) NOT NULL DEFAULT 'channel_connection',
  ADD COLUMN dropship_store_connection_id INTEGER;

ALTER TABLE inventory.inventory_publication_targets
  ALTER COLUMN channel_connection_id DROP NOT NULL,
  ADD CONSTRAINT inventory_publication_targets_dropship_store_connection_fk
    FOREIGN KEY (dropship_store_connection_id)
    REFERENCES dropship.dropship_store_connections(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_publication_targets_destination_chk CHECK (
    (destination_kind = 'channel_connection'
      AND channel_connection_id IS NOT NULL
      AND dropship_store_connection_id IS NULL)
    OR (destination_kind = 'dropship_store_connection'
      AND channel_connection_id IS NULL
      AND dropship_store_connection_id IS NOT NULL)
  );

ALTER TABLE inventory.inventory_publication_targets
  DROP CONSTRAINT inventory_publication_targets_identity_uq;

CREATE UNIQUE INDEX inventory_publication_targets_channel_identity_uq
  ON inventory.inventory_publication_targets(
    channel_connection_id,
    fulfillment_node_id,
    provider_scope_type,
    external_scope_id
  )
  WHERE destination_kind = 'channel_connection';

CREATE UNIQUE INDEX inventory_publication_targets_dropship_identity_uq
  ON inventory.inventory_publication_targets(
    dropship_store_connection_id,
    fulfillment_node_id,
    provider_scope_type,
    external_scope_id
  )
  WHERE destination_kind = 'dropship_store_connection';

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_target_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.destination_kind IS DISTINCT FROM OLD.destination_kind
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id
     OR NEW.dropship_store_connection_id IS DISTINCT FROM OLD.dropship_store_connection_id
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

COMMENT ON COLUMN inventory.inventory_publication_targets.channel_id IS
  'Logical allocation-policy channel whose channel/product/SKU dials apply to this destination.';
COMMENT ON COLUMN inventory.inventory_publication_targets.destination_kind IS
  'Exact transport owner kind. Exactly one matching owner foreign key must be populated.';
COMMENT ON COLUMN inventory.inventory_publication_targets.dropship_store_connection_id IS
  'Exact Dropship storefront transport owner when destination_kind is dropship_store_connection.';

ALTER TABLE inventory.inventory_publication_readbacks
  DROP CONSTRAINT inventory_publication_readbacks_exact_target_snapshot_chk,
  ADD COLUMN destination_kind_snapshot VARCHAR(30),
  ADD COLUMN dropship_store_connection_id_snapshot INTEGER,
  ADD CONSTRAINT inventory_publication_readbacks_destination_snapshot_chk CHECK (
    (destination_kind_snapshot IS NULL
      AND dropship_store_connection_id_snapshot IS NULL)
    OR (destination_kind_snapshot = 'channel_connection'
      AND channel_connection_id_snapshot IS NOT NULL
      AND dropship_store_connection_id_snapshot IS NULL)
    OR (destination_kind_snapshot = 'dropship_store_connection'
      AND channel_connection_id_snapshot IS NULL
      AND dropship_store_connection_id_snapshot IS NOT NULL)
  ),
  ADD CONSTRAINT inventory_publication_readbacks_exact_target_snapshot_chk CHECK (
    (channel_connection_id_snapshot IS NULL
      AND dropship_store_connection_id_snapshot IS NULL
      AND provider_scope_type_snapshot IS NULL
      AND external_scope_id_snapshot IS NULL
      AND publication_target_revision_snapshot IS NULL)
    OR ((channel_connection_id_snapshot IS NOT NULL
        OR dropship_store_connection_id_snapshot IS NOT NULL)
      AND provider_scope_type_snapshot IN ('account', 'location')
      AND external_scope_id_snapshot IS NOT NULL
      AND btrim(external_scope_id_snapshot) <> ''
      AND publication_target_revision_snapshot IS NOT NULL
      AND publication_target_revision_snapshot > 0)
  );

COMMENT ON COLUMN inventory.inventory_publication_readbacks.destination_kind_snapshot IS
  'Immutable destination owner kind captured with a provider quantity observation.';
