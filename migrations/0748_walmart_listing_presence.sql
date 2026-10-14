-- Remote existence is independent of the retained catalog/ATP SKU identity and
-- of the operator's explicit unpublish/remove command.
CREATE SCHEMA IF NOT EXISTS marketplace;
CREATE TABLE marketplace.channel_listing_presence (
  account_key text NOT NULL,
  sku varchar(100) NOT NULL CHECK (btrim(sku) <> ''),
  state text NOT NULL CHECK (state IN ('present', 'missing')),
  external_product_id varchar(120),
  checked_at timestamptz NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (account_key, sku)
);
CREATE TABLE marketplace.channel_listing_presence_events (
  account_key text NOT NULL,
  sku varchar(100) NOT NULL,
  version bigint NOT NULL,
  actor text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (account_key, sku, version),
  FOREIGN KEY (account_key, sku) REFERENCES marketplace.channel_listing_presence(account_key, sku)
);
CREATE FUNCTION marketplace.guard_listing_presence_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Listing presence history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER channel_listing_presence_events_immutable
  BEFORE UPDATE OR DELETE ON marketplace.channel_listing_presence_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_presence_event();
CREATE TRIGGER channel_listing_presence_events_no_truncate
  BEFORE TRUNCATE ON marketplace.channel_listing_presence_events
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.guard_listing_presence_event();
