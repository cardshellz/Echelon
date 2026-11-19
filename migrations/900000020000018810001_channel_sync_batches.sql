-- A batch owns selection and durable handoff keys, never provider execution state.
CREATE TABLE marketplace.channel_sync_batches (
  id uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  destination jsonb NOT NULL CHECK(jsonb_typeof(destination)='object'
    AND destination ?& ARRAY['channelId','provider','connectionId','accountId','environment','marketplaceId']
    AND jsonb_typeof(destination->'channelId')='number' AND (destination->>'channelId')::integer=channel_id),
  actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),
  member_count integer NOT NULL CHECK(member_count BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL,
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  admission_completed_at timestamptz,
  admission_error text CHECK(length(admission_error)<=1000),
  admission_refusal jsonb CHECK(admission_refusal IS NULL OR (admission_completed_at IS NOT NULL
    AND jsonb_typeof(admission_refusal)='object' AND admission_refusal ?& ARRAY['code','message']
    AND jsonb_typeof(admission_refusal->'code')='string' AND jsonb_typeof(admission_refusal->'message')='string'
    AND length(admission_refusal->>'code') BETWEEN 1 AND 100
    AND length(admission_refusal->>'message') BETWEEN 1 AND 1000)),
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(admission_completed_at IS NULL OR lease_token IS NULL)
);
CREATE INDEX channel_sync_batches_recent ON marketplace.channel_sync_batches(channel_id,created_at DESC,id DESC);
CREATE INDEX channel_sync_batches_due ON marketplace.channel_sync_batches(next_attempt_at,id)
  WHERE admission_completed_at IS NULL;
CREATE TABLE marketplace.channel_sync_batch_members (
  batch_id uuid NOT NULL REFERENCES marketplace.channel_sync_batches(id),
  product_id integer NOT NULL REFERENCES catalog.products(id),
  command_key uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 500),
  sku text CHECK(length(sku)<=250),
  PRIMARY KEY(batch_id,product_id)
);
CREATE FUNCTION marketplace.guard_channel_sync_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Sync batches are retained' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.channel_id,NEW.destination,NEW.actor,NEW.member_count,NEW.created_at,NEW.owner_transaction_id)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.destination,OLD.actor,OLD.member_count,OLD.created_at,OLD.owner_transaction_id)
    OR OLD.admission_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sync batch selection and completed admission are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_sync_batch_guard BEFORE UPDATE OR DELETE ON marketplace.channel_sync_batches
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_sync_batch();
CREATE FUNCTION marketplace.guard_channel_sync_batch_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM marketplace.channel_sync_batches b
    WHERE b.id=NEW.batch_id AND b.owner_transaction_id=pg_current_xact_id() AND b.admission_completed_at IS NULL) THEN
    RAISE EXCEPTION 'Sync selection must be saved atomically and cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_sync_batch_member_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace.channel_sync_batch_members
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_sync_batch_member();
CREATE FUNCTION marketplace.check_channel_sync_batch_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_count<>(SELECT count(*) FROM marketplace.channel_sync_batch_members WHERE batch_id=NEW.id) THEN
    RAISE EXCEPTION 'Sync batch must save every selected product' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER channel_sync_batch_members_complete AFTER INSERT ON marketplace.channel_sync_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION marketplace.check_channel_sync_batch_members();
CREATE FUNCTION marketplace.reject_channel_sync_batch_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Sync batch history is retained' USING ERRCODE='23514'; END $$;
CREATE TRIGGER channel_sync_batches_no_truncate BEFORE TRUNCATE ON marketplace.channel_sync_batches
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_channel_sync_batch_truncate();
CREATE TRIGGER channel_sync_batch_members_no_truncate BEFORE TRUNCATE ON marketplace.channel_sync_batch_members
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_channel_sync_batch_truncate();
