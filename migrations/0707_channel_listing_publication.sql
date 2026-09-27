-- Explicit drafts and durable asynchronous initial publication. This migration
-- does not select products, submit feeds, or enable inventory authority.
CREATE SCHEMA IF NOT EXISTS marketplace;

CREATE TABLE marketplace.channel_listing_drafts (
  channel_id integer PRIMARY KEY REFERENCES channels.channels(id),
  account_key text NOT NULL CHECK (length(account_key) BETWEEN 1 AND 500),
  revision integer NOT NULL CHECK (revision > 0),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 100),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL
);
CREATE TABLE marketplace.channel_listing_reviews (
  id uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  review_hash text NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  UNIQUE(id, channel_id)
);
CREATE INDEX channel_listing_reviews_channel_idx ON marketplace.channel_listing_reviews(channel_id, created_at DESC);
CREATE TABLE marketplace.channel_listing_operations (
  id uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  account_key text NOT NULL CHECK (length(account_key) BETWEEN 1 AND 500),
  command_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  review_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('queued','submitting','processing','completed','partially_completed','needs_attention','needs_reconciliation')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  progress jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object'),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(channel_id, command_key),
  FOREIGN KEY(review_id, channel_id) REFERENCES marketplace.channel_listing_reviews(id, channel_id),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX channel_listing_operations_due_idx ON marketplace.channel_listing_operations(next_attempt_at)
  WHERE state IN ('queued','submitting','processing');
CREATE INDEX channel_listing_operations_channel_idx ON marketplace.channel_listing_operations(channel_id, created_at DESC);
CREATE TABLE marketplace.channel_listing_item_claims (
  account_key text NOT NULL,
  external_sku text NOT NULL CHECK (length(external_sku) BETWEEN 1 AND 100),
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  operation_id uuid NOT NULL REFERENCES marketplace.channel_listing_operations(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_key, external_sku),
  UNIQUE(channel_id, product_variant_id)
);
CREATE TABLE marketplace.channel_listing_publication_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  operation_id uuid REFERENCES marketplace.channel_listing_operations(id),
  operation_version integer,
  action text NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE(operation_id, operation_version),
  CHECK ((operation_id IS NULL) = (operation_version IS NULL))
);
CREATE FUNCTION marketplace.guard_channel_listing_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Listing publication evidence is immutable';
END;
$$;
CREATE TRIGGER channel_listing_reviews_immutable BEFORE UPDATE OR DELETE ON marketplace.channel_listing_reviews
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
CREATE TRIGGER channel_listing_events_immutable BEFORE UPDATE OR DELETE ON marketplace.channel_listing_publication_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
CREATE TRIGGER channel_listing_claims_no_delete BEFORE DELETE ON marketplace.channel_listing_item_claims
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
CREATE FUNCTION marketplace.guard_channel_listing_claim_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_key,NEW.external_sku,NEW.channel_id,NEW.product_variant_id,NEW.created_at)
    IS DISTINCT FROM (OLD.account_key,OLD.external_sku,OLD.channel_id,OLD.product_variant_id,OLD.created_at)
    OR NEW.operation_id=OLD.operation_id OR NOT EXISTS (
      SELECT 1 FROM marketplace.channel_listing_operations o,
        jsonb_array_elements(o.progress->'items') i,
        jsonb_array_elements(o.progress->'batches') b
      WHERE o.id=OLD.operation_id AND (i->>'variantId')::integer=OLD.product_variant_id
        AND i->>'sku'=OLD.external_sku AND i->>'state'='needs_attention' AND i->>'canRetry'='true'
        AND b->>'state'='processed' AND b->'variantIds' @> to_jsonb(ARRAY[OLD.product_variant_id])
    ) THEN RAISE EXCEPTION 'Only a definitively rejected listing claim can transfer to a new review'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_listing_claim_transfer BEFORE UPDATE ON marketplace.channel_listing_item_claims
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_claim_transfer();
CREATE FUNCTION marketplace.guard_channel_listing_operation_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.channel_id, NEW.account_key, NEW.command_key, NEW.request_hash, NEW.review_id, NEW.snapshot, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.channel_id, OLD.account_key, OLD.command_key, OLD.request_hash, OLD.review_id, OLD.snapshot, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Listing publication intent is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_listing_operation_intent BEFORE UPDATE ON marketplace.channel_listing_operations
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_operation_intent();
CREATE TRIGGER channel_listing_operation_no_delete BEFORE DELETE ON marketplace.channel_listing_operations
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();
