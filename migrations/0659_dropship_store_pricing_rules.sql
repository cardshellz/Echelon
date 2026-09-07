-- Nullable mode preserves immutable legacy revisions without backfilling them.
-- Legacy non-null price = fixed; legacy null price = explicit catalog default.
ALTER TABLE dropship.dropship_listing_price_revisions ADD COLUMN pricing_mode text;
ALTER TABLE dropship.dropship_listing_price_settings ADD COLUMN pricing_mode text;
ALTER TABLE dropship.dropship_listing_price_revisions ADD CONSTRAINT listing_price_revision_mode_chk CHECK
  (pricing_mode IS NULL OR (pricing_mode IN ('fixed','catalog_default','rules') AND
    ((pricing_mode = 'fixed') = (override_price_cents IS NOT NULL))));
ALTER TABLE dropship.dropship_listing_price_settings ADD CONSTRAINT listing_price_setting_mode_chk CHECK
  (pricing_mode IS NULL OR (pricing_mode IN ('fixed','catalog_default','rules') AND
    ((pricing_mode = 'fixed') = (override_price_cents IS NOT NULL))));

CREATE OR REPLACE FUNCTION dropship.guard_listing_price_setting_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision dropship.dropship_listing_price_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reset a listing price with a new revision, not deletion' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id IS DISTINCT FROM NEW.vendor_id
     OR OLD.store_connection_id IS DISTINCT FROM NEW.store_connection_id
     OR OLD.product_variant_id IS DISTINCT FROM NEW.product_variant_id) THEN
    RAISE EXCEPTION 'Listing price target identity cannot change' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO revision FROM dropship.dropship_listing_price_revisions WHERE id = NEW.revision_id;
  IF NOT FOUND OR revision.vendor_id <> NEW.vendor_id
     OR revision.store_connection_id <> NEW.store_connection_id
     OR revision.product_variant_id <> NEW.product_variant_id
     OR revision.override_price_cents IS DISTINCT FROM NEW.override_price_cents
     OR revision.pricing_mode IS DISTINCT FROM NEW.pricing_mode
     OR revision.created_at IS DISTINCT FROM NEW.updated_at THEN
    RAISE EXCEPTION 'Listing price setting must match its exact revision' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF revision.previous_revision_id IS DISTINCT FROM (
    SELECT revision_id FROM dropship.dropship_listing_price_settings
    WHERE store_connection_id = NEW.store_connection_id AND product_variant_id = NEW.product_variant_id
  ) THEN
    RAISE EXCEPTION 'Listing price revision predecessor does not match the current setting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE dropship.dropship_pricing_profile_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  previous_revision_id integer,
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object' AND profile ? 'defaultRecipe' AND profile ? 'groups'),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (id, vendor_id, store_connection_id),
  FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id),
  FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_pricing_profile_revisions(id, vendor_id, store_connection_id)
);
CREATE TABLE dropship.dropship_pricing_profiles (
  store_connection_id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  revision_id integer NOT NULL,
  FOREIGN KEY (revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_pricing_profile_revisions(id, vendor_id, store_connection_id)
);
CREATE FUNCTION dropship.guard_pricing_profile_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pricing profiles cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id) THEN
    RAISE EXCEPTION 'Pricing profile ownership cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  SELECT previous_revision_id INTO predecessor FROM dropship.dropship_pricing_profile_revisions WHERE id = NEW.revision_id;
  IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = NEW.store_connection_id) THEN
    RAISE EXCEPTION 'Pricing profile predecessor conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pricing_profile_coherence BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_pricing_profiles
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_pricing_profile_coherence();
CREATE TRIGGER pricing_profile_revision_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_pricing_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_price_revision_immutable();

CREATE TABLE dropship.dropship_pricing_reviews (
  id uuid PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) <= 10000),
  review_hash text NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (id, vendor_id, store_connection_id),
  FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id)
);
CREATE INDEX pricing_review_store_idx ON dropship.dropship_pricing_reviews(store_connection_id, created_at);
CREATE TRIGGER pricing_review_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_pricing_reviews
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_price_revision_immutable();
CREATE TABLE dropship.dropship_pricing_applications (
  review_id uuid PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  revision_id integer NOT NULL,
  idempotency_key varchar(200) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]+$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (vendor_id, idempotency_key),
  FOREIGN KEY (review_id, vendor_id, store_connection_id) REFERENCES dropship.dropship_pricing_reviews(id, vendor_id, store_connection_id),
  FOREIGN KEY (revision_id, vendor_id, store_connection_id) REFERENCES dropship.dropship_pricing_profile_revisions(id, vendor_id, store_connection_id)
);
CREATE TRIGGER pricing_application_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_pricing_applications
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_price_revision_immutable();
