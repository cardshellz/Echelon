BEGIN;

-- Additive only: no definitions selected, inventory moved, or publication enabled.
ALTER TABLE inventory.channel_exposure_policy_versions
  ADD COLUMN source_fulfillment_node_ids integer[],
  ADD COLUMN inherit_all boolean NOT NULL DEFAULT false;
ALTER TABLE inventory.channel_exposure_policy_versions
  DROP CONSTRAINT channel_exposure_policy_versions_value_chk,
  ADD CONSTRAINT channel_exposure_policy_versions_value_chk CHECK (
    inherit_all OR source_fulfillment_node_ids IS NOT NULL
    OR allocation_semantics IS NOT NULL OR eligible IS NOT NULL OR share_bps IS NOT NULL
    OR holdback_sellable_units IS NOT NULL OR max_publish_mode IS NOT NULL OR min_publish_sellable_units IS NOT NULL
  ),
  ADD CONSTRAINT channel_exposure_policy_versions_inherit_chk CHECK (
    NOT inherit_all OR (scope_type <> 'channel' AND source_fulfillment_node_ids IS NULL
      AND allocation_semantics IS NULL AND eligible IS NULL AND share_bps IS NULL
      AND holdback_sellable_units IS NULL AND max_publish_mode IS NULL
      AND max_publish_sellable_units IS NULL AND min_publish_sellable_units IS NULL)
  ),
  ADD CONSTRAINT channel_exposure_policy_versions_supply_chk CHECK (
    source_fulfillment_node_ids IS NULL OR (scope_type <> 'channel'
      AND cardinality(source_fulfillment_node_ids) BETWEEN 1 AND 100
      AND array_ndims(source_fulfillment_node_ids) = 1
      AND array_position(source_fulfillment_node_ids,NULL) IS NULL)
  );

CREATE FUNCTION inventory.guard_channel_policy_supply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.lifecycle_status<>'draft' OR NEW.lifecycle_status<>'draft')
    AND (NEW.source_fulfillment_node_ids IS DISTINCT FROM OLD.source_fulfillment_node_ids
      OR NEW.inherit_all IS DISTINCT FROM OLD.inherit_all) THEN
    RAISE EXCEPTION 'Sealed channel supply and inheritance are immutable' USING ERRCODE='55000';
  END IF;
  -- Retiring historical definitions must remain possible after a source retires.
  -- Their FK references stay intact; only draft/sealed usability is checked here.
  IF NEW.lifecycle_status<>'retired' AND NEW.source_fulfillment_node_ids IS NOT NULL AND (
    (SELECT count(DISTINCT warehouse_id) FROM warehouse.fulfillment_nodes
      WHERE id=ANY(NEW.source_fulfillment_node_ids) AND lifecycle_status<>'retired')
      <> cardinality(NEW.source_fulfillment_node_ids)
  ) THEN
    RAISE EXCEPTION 'Channel supply must reference distinct usable warehouses' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_policy_supply_guard BEFORE INSERT OR UPDATE
  ON inventory.channel_exposure_policy_versions FOR EACH ROW EXECUTE FUNCTION inventory.guard_channel_policy_supply();

-- PostgreSQL cannot put a foreign key on each member of an array. This
-- trigger-maintained reference index supplies real FK enforcement (including
-- concurrent DELETE and older transaction snapshots), not a second editable
-- source selection. The version-owned array above is the only write authority.
CREATE TABLE inventory.channel_policy_source_node_references (
  policy_id integer NOT NULL REFERENCES inventory.channel_exposure_policy_versions(id) ON DELETE CASCADE,
  fulfillment_node_id integer NOT NULL REFERENCES warehouse.fulfillment_nodes(id) ON DELETE RESTRICT,
  PRIMARY KEY (policy_id, fulfillment_node_id)
);
CREATE INDEX channel_policy_source_node_references_node_idx
  ON inventory.channel_policy_source_node_references(fulfillment_node_id);
CREATE FUNCTION inventory.guard_channel_policy_source_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' OR pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'Channel supply references are maintained by their policy version' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_policy_source_references_guard BEFORE INSERT OR UPDATE OR DELETE
  ON inventory.channel_policy_source_node_references FOR EACH ROW EXECUTE FUNCTION inventory.guard_channel_policy_source_references();
CREATE TRIGGER channel_policy_source_references_no_truncate BEFORE TRUNCATE
  ON inventory.channel_policy_source_node_references FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_channel_policy_source_references();
CREATE FUNCTION inventory.sync_channel_policy_source_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.source_fulfillment_node_ids IS NOT DISTINCT FROM OLD.source_fulfillment_node_ids THEN
    RETURN NEW;
  END IF;
  DELETE FROM inventory.channel_policy_source_node_references WHERE policy_id=NEW.id;
  INSERT INTO inventory.channel_policy_source_node_references(policy_id,fulfillment_node_id)
    SELECT NEW.id,node_id FROM unnest(NEW.source_fulfillment_node_ids) AS node_id ORDER BY node_id;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_policy_source_references_sync AFTER INSERT OR UPDATE OF source_fulfillment_node_ids
  ON inventory.channel_exposure_policy_versions FOR EACH ROW EXECUTE FUNCTION inventory.sync_channel_policy_source_references();

CREATE TABLE inventory.channel_definition_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 100),
  occurred_at timestamptz NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review)='object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  CHECK (receipt ? 'channelId' AND (receipt->>'channelId') IS NOT NULL
    AND (receipt->>'channelId')::integer=channel_id)
);
CREATE INDEX channel_definition_applications_channel_idx ON inventory.channel_definition_applications(channel_id,id DESC);
CREATE FUNCTION inventory.guard_channel_definition_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Channel definition receipts are immutable' USING ERRCODE='55000'; END IF;
  PERFORM inventory.assert_cutover_admission_fence_owner();
  RETURN NEW;
END $$;
CREATE TRIGGER channel_definition_application_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory.channel_definition_applications
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_channel_definition_application();
CREATE TRIGGER channel_definition_application_no_truncate BEFORE TRUNCATE ON inventory.channel_definition_applications
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_channel_definition_application();
COMMIT;
