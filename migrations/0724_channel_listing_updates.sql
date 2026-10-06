-- Durable, reviewed edits to existing listings. No inventory or provider writes.
CREATE TABLE marketplace.channel_listing_updates (
  id uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  account_key text NOT NULL CHECK (length(account_key) BETWEEN 1 AND 500),
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 50),
  review_hash text NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  state text NOT NULL CHECK (state IN ('reviewed','queued','sending','processing','accepted','needs_attention','uncertain')),
  command_key uuid,
  submission_id text CHECK (length(submission_id) BETWEEN 1 AND 200),
  message text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  UNIQUE(channel_id, command_key),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'reviewed') = (command_key IS NULL)),
  CHECK (state NOT IN ('processing','accepted') OR submission_id IS NOT NULL)
);
-- Unknown outcomes remain exclusive until a correlated provider receipt is resolved.
CREATE UNIQUE INDEX channel_listing_updates_active_sku_idx ON marketplace.channel_listing_updates(account_key, sku)
  WHERE state IN ('queued','sending','processing','uncertain');
CREATE INDEX channel_listing_updates_due_idx ON marketplace.channel_listing_updates(next_attempt_at)
  WHERE state IN ('queued','sending','processing');
CREATE INDEX channel_listing_updates_channel_idx ON marketplace.channel_listing_updates(channel_id, created_at DESC);
CREATE INDEX channel_listing_updates_accepted_item_idx ON marketplace.channel_listing_updates(account_key, sku, updated_at DESC, id DESC)
  WHERE state='accepted';
CREATE TABLE marketplace.channel_listing_update_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  update_id uuid NOT NULL REFERENCES marketplace.channel_listing_updates(id),
  version integer NOT NULL CHECK (version > 0),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  action text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE(update_id, version)
);
CREATE FUNCTION marketplace.guard_channel_listing_update_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.channel_id,NEW.account_key,NEW.sku,NEW.review_hash,NEW.intent,NEW.created_by,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.account_key,OLD.sku,OLD.review_hash,OLD.intent,OLD.created_by,OLD.created_at,OLD.expires_at)
    OR (OLD.command_key IS NOT NULL AND NEW.command_key IS DISTINCT FROM OLD.command_key)
    OR (OLD.submission_id IS NOT NULL AND NEW.submission_id IS DISTINCT FROM OLD.submission_id) THEN
    RAISE EXCEPTION 'Listing update intent and receipts are immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='reviewed' AND NEW.state='queued') OR
    (OLD.state='queued' AND NEW.state IN ('sending','needs_attention')) OR
    (OLD.state='sending' AND NEW.state IN ('processing','needs_attention','uncertain')) OR
    (OLD.state='processing' AND NEW.state IN ('accepted','needs_attention'))
  ) THEN RAISE EXCEPTION 'Invalid listing update transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_listing_update_intent BEFORE UPDATE ON marketplace.channel_listing_updates
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_update_intent();
CREATE TRIGGER channel_listing_updates_no_delete BEFORE DELETE ON marketplace.channel_listing_updates
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
CREATE TRIGGER channel_listing_update_events_immutable BEFORE UPDATE OR DELETE ON marketplace.channel_listing_update_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
