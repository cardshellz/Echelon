DO $$
BEGIN
  IF (SELECT COUNT(*) FROM channels.sync_settings) > 1 THEN
    RAISE EXCEPTION
      'channels.sync_settings contains multiple rows; reconcile them before installing the canonical publication singleton';
  END IF;
END;
$$;

ALTER TABLE channels.sync_settings
  ADD COLUMN singleton_key BOOLEAN,
  ADD COLUMN revision BIGINT,
  ADD COLUMN changed_by VARCHAR(100),
  ADD COLUMN change_reason VARCHAR(1000);

UPDATE channels.sync_settings
SET singleton_key = TRUE,
    revision = 1,
    changed_by = 'migration:0669',
    change_reason = 'Established the audited global publication-control singleton.';

ALTER TABLE channels.sync_settings
  ALTER COLUMN singleton_key SET DEFAULT TRUE,
  ALTER COLUMN singleton_key SET NOT NULL,
  ALTER COLUMN revision SET DEFAULT 1,
  ALTER COLUMN revision SET NOT NULL,
  ALTER COLUMN changed_by SET DEFAULT 'system:uninitialized',
  ALTER COLUMN changed_by SET NOT NULL,
  ALTER COLUMN change_reason SET DEFAULT 'Created disabled pending an explicit operator command.',
  ALTER COLUMN change_reason SET NOT NULL,
  ADD CONSTRAINT sync_settings_singleton_key_chk CHECK (singleton_key = TRUE),
  ADD CONSTRAINT sync_settings_revision_chk CHECK (revision > 0),
  ADD CONSTRAINT sync_settings_changed_by_chk
    CHECK (changed_by = btrim(changed_by) AND changed_by <> ''),
  ADD CONSTRAINT sync_settings_change_reason_chk
    CHECK (change_reason = btrim(change_reason) AND change_reason <> '');

CREATE UNIQUE INDEX sync_settings_singleton_key_uq
  ON channels.sync_settings(singleton_key);

INSERT INTO channels.sync_settings(
  singleton_key,
  global_enabled,
  sweep_interval_minutes,
  revision,
  changed_by,
  change_reason
)
SELECT TRUE, FALSE, 15, 1, 'migration:0669',
       'Created disabled pending an explicit operator command.'
WHERE NOT EXISTS (SELECT 1 FROM channels.sync_settings);

COMMENT ON COLUMN channels.sync_settings.singleton_key IS
  'Enforces exactly one global inventory-publication emergency-stop control row.';
COMMENT ON COLUMN channels.sync_settings.revision IS
  'Optimistic-concurrency revision for operator publication-control commands.';

-- A live target remains irreversible back to preview, but operators require a
-- scoped emergency stop. The command implementation acquires every exact
-- destination/item publication lock before using this live -> disabled edge.
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
  IF OLD.state = 'live' AND NEW.state NOT IN ('live', 'disabled') THEN
    RAISE EXCEPTION 'a live publication target can only remain live or enter the scoped disabled stop state';
  END IF;
  IF NEW.state = 'live' AND OLD.state <> 'preview' THEN
    RAISE EXCEPTION 'a publication target must be previewed before it becomes live';
  END IF;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;
