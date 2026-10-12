-- Durable per-account/SKU publication stops. Catalog and order history are kept.
CREATE TABLE marketplace.channel_listing_lifecycle (
  id uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  account_key text NOT NULL CHECK (length(account_key) BETWEEN 1 AND 500),
  account jsonb NOT NULL CHECK (jsonb_typeof(account)='object'),
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 50),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  action text NOT NULL CHECK (action IN ('unpublish','remove')),
  state text NOT NULL CHECK (state IN ('pending','retiring','retired','failed')),
  message text CHECK (length(message)<=2000),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 100),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  UNIQUE(account_key,sku),
  CHECK ((state='retired')=(next_attempt_at IS NULL))
);
CREATE INDEX channel_listing_lifecycle_due_idx ON marketplace.channel_listing_lifecycle(next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE TABLE marketplace.channel_listing_lifecycle_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES marketplace.channel_listing_lifecycle(id),
  version integer NOT NULL CHECK (version>0),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE(listing_id,version)
);
CREATE FUNCTION marketplace.guard_listing_lifecycle_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.channel_id,NEW.account_key,NEW.account,NEW.sku,NEW.title,NEW.requested_by,NEW.requested_at)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.account_key,OLD.account,OLD.sku,OLD.title,OLD.requested_by,OLD.requested_at)
    OR (OLD.action='remove' AND NEW.action<>'remove') OR (OLD.state='retired' AND NEW.state<>'retired') THEN
    RAISE EXCEPTION 'Listing lifecycle identity and completed retirement are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_listing_lifecycle_identity BEFORE UPDATE ON marketplace.channel_listing_lifecycle
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_lifecycle_identity();
CREATE TRIGGER channel_listing_lifecycle_no_delete BEFORE DELETE ON marketplace.channel_listing_lifecycle
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
CREATE TRIGGER channel_listing_lifecycle_events_immutable BEFORE UPDATE OR DELETE ON marketplace.channel_listing_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
