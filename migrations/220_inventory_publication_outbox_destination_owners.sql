-- Generalize immutable publication outbox identity from Channels-only ownership
-- to the exact owner already selected on the publication target. Existing rows
-- remain channel-owned through the non-destructive column default. This
-- migration creates no targets, outbox work, provider calls, or quantity writes.

ALTER TABLE inventory.inventory_publication_outbox
  ADD COLUMN destination_kind_snapshot VARCHAR(30) NOT NULL DEFAULT 'channel_connection',
  ADD COLUMN dropship_store_connection_id_snapshot INTEGER,
  ALTER COLUMN channel_connection_id_snapshot DROP NOT NULL,
  ADD CONSTRAINT inventory_publication_outbox_destination_chk CHECK (
    (destination_kind_snapshot = 'channel_connection'
      AND channel_connection_id_snapshot IS NOT NULL
      AND dropship_store_connection_id_snapshot IS NULL)
    OR (destination_kind_snapshot = 'dropship_store_connection'
      AND channel_connection_id_snapshot IS NULL
      AND dropship_store_connection_id_snapshot IS NOT NULL)
  );

ALTER TABLE inventory.inventory_publication_attempts
  DROP CONSTRAINT inventory_publication_attempts_outcome_chk,
  ADD CONSTRAINT inventory_publication_attempts_outcome_chk
    CHECK (outcome IN (
      'acknowledged', 'retryable', 'dead_letter', 'cancelled', 'superseded'
    ));

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  latest_revision BIGINT;
  target_exists BOOLEAN;
  target_destination_kind VARCHAR(30);
  target_channel_connection_id INTEGER;
  target_dropship_store_connection_id INTEGER;
  target_channel_id INTEGER;
  target_provider_key VARCHAR(60);
  target_policy_channel_provider VARCHAR(60);
  target_provider_scope_type VARCHAR(30);
  target_revision BIGINT;
  target_scope_id VARCHAR(240);
BEGIN
  PERFORM pg_advisory_xact_lock(NEW.publication_target_id, NEW.product_variant_id);

  SELECT true, target.destination_kind, target.channel_connection_id,
         target.dropship_store_connection_id, target.channel_id,
         lower(policy_channel.provider),
         target.provider_scope_type, target.revision, target.external_scope_id
  INTO target_exists, target_destination_kind, target_channel_connection_id,
       target_dropship_store_connection_id, target_channel_id,
       target_policy_channel_provider, target_provider_scope_type, target_revision,
       target_scope_id
  FROM inventory.inventory_publication_targets AS target
  JOIN channels.channels AS policy_channel ON policy_channel.id = target.channel_id
  WHERE target.id = NEW.publication_target_id
  FOR SHARE OF target, policy_channel;

  IF target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'publication target does not exist';
  END IF;
  IF target_destination_kind = 'dropship_store_connection' THEN
    SELECT lower(platform)
    INTO target_provider_key
    FROM dropship.dropship_store_connections
    WHERE id = target_dropship_store_connection_id
    FOR SHARE;
  ELSE
    target_provider_key := target_policy_channel_provider;
  END IF;
  IF NEW.destination_kind_snapshot IS DISTINCT FROM target_destination_kind
     OR NEW.channel_connection_id_snapshot IS DISTINCT FROM target_channel_connection_id
     OR NEW.dropship_store_connection_id_snapshot
       IS DISTINCT FROM target_dropship_store_connection_id
     OR (NEW.activation_run_id IS NOT NULL AND (
       NEW.channel_id_snapshot IS DISTINCT FROM target_channel_id
       OR lower(NEW.provider_key_snapshot) IS DISTINCT FROM target_provider_key
       OR NEW.provider_scope_type_snapshot IS DISTINCT FROM target_provider_scope_type
       OR NEW.publication_target_revision_snapshot IS DISTINCT FROM target_revision
     ))
     OR NEW.external_scope_id_snapshot IS DISTINCT FROM target_scope_id THEN
    RAISE EXCEPTION 'publication identity snapshot differs from its target';
  END IF;

  SELECT max(desired_revision)
  INTO latest_revision
  FROM inventory.inventory_publication_outbox
  WHERE publication_target_id = NEW.publication_target_id
    AND product_variant_id = NEW.product_variant_id;

  IF latest_revision IS NOT NULL AND NEW.desired_revision <= latest_revision THEN
    RAISE EXCEPTION 'publication revision must be greater than existing revision %', latest_revision;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_outbox_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.activation_run_id IS DISTINCT FROM OLD.activation_run_id
     OR NEW.publication_target_id IS DISTINCT FROM OLD.publication_target_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
     OR NEW.desired_revision IS DISTINCT FROM OLD.desired_revision
     OR NEW.desired_quantity IS DISTINCT FROM OLD.desired_quantity
     OR NEW.destination_kind_snapshot IS DISTINCT FROM OLD.destination_kind_snapshot
     OR NEW.channel_connection_id_snapshot IS DISTINCT FROM OLD.channel_connection_id_snapshot
     OR NEW.dropship_store_connection_id_snapshot
       IS DISTINCT FROM OLD.dropship_store_connection_id_snapshot
     OR NEW.external_scope_id_snapshot IS DISTINCT FROM OLD.external_scope_id_snapshot
     OR NEW.external_inventory_item_id_snapshot IS DISTINCT FROM OLD.external_inventory_item_id_snapshot
     OR NEW.publication_phase IS DISTINCT FROM OLD.publication_phase
     OR NEW.channel_id_snapshot IS DISTINCT FROM OLD.channel_id_snapshot
     OR NEW.provider_key_snapshot IS DISTINCT FROM OLD.provider_key_snapshot
     OR NEW.provider_scope_type_snapshot IS DISTINCT FROM OLD.provider_scope_type_snapshot
     OR NEW.external_sku_snapshot IS DISTINCT FROM OLD.external_sku_snapshot
     OR NEW.publication_target_revision_snapshot IS DISTINCT FROM OLD.publication_target_revision_snapshot
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication outbox desired state and identity are immutable';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'desired' AND NEW.state IN ('queued', 'cancelled', 'superseded'))
    OR (OLD.state = 'queued' AND NEW.state IN ('leased', 'cancelled', 'superseded'))
    OR (OLD.state = 'leased' AND NEW.state IN (
      'acknowledged', 'retryable', 'dead_letter', 'cancelled', 'superseded'
    ))
    OR (OLD.state = 'retryable' AND NEW.state IN ('queued', 'dead_letter', 'cancelled', 'superseded'))
    OR (OLD.state = 'acknowledged' AND NEW.state IN ('verified', 'drifted'))
    OR (OLD.state = 'drifted' AND NEW.state IN ('queued', 'dead_letter', 'cancelled', 'superseded'))
  ) THEN
    RAISE EXCEPTION 'invalid publication state transition from % to %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN inventory.inventory_publication_outbox.destination_kind_snapshot IS
  'Immutable exact transport owner kind captured before durable provider dispatch.';
COMMENT ON COLUMN inventory.inventory_publication_outbox.dropship_store_connection_id_snapshot IS
  'Immutable Dropship store owner when destination_kind_snapshot is dropship_store_connection.';
