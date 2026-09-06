-- Vendor draft prices are separate from queued/published listing snapshots.
-- A null override is a durable reset to the catalog default, not a deleted row.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_conn_owner_identity_idx
  ON dropship.dropship_store_connections (id, vendor_id);

CREATE TABLE dropship.dropship_listing_price_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  previous_revision_id integer,
  override_price_cents integer CONSTRAINT dropship_listing_price_revision_cents_chk CHECK (override_price_cents IS NULL OR override_price_cents > 0),
  idempotency_key varchar(200) NOT NULL CONSTRAINT dropship_listing_price_revision_key_chk CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]+$'),
  request_hash varchar(64) NOT NULL CONSTRAINT dropship_listing_price_revision_hash_chk CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id varchar(255) NOT NULL CONSTRAINT dropship_listing_price_revision_actor_chk CHECK (btrim(actor_id) <> ''),
  created_at timestamptz NOT NULL,
  CONSTRAINT dropship_listing_price_revision_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_listing_price_revision_identity_uk UNIQUE (id, vendor_id, store_connection_id, product_variant_id),
  CONSTRAINT dropship_listing_price_revision_previous_fk FOREIGN KEY
    (previous_revision_id, vendor_id, store_connection_id, product_variant_id)
    REFERENCES dropship.dropship_listing_price_revisions(id, vendor_id, store_connection_id, product_variant_id),
  CONSTRAINT dropship_listing_price_revision_idempotency_uk UNIQUE (vendor_id, idempotency_key)
);
CREATE INDEX dropship_listing_price_revision_target_idx
  ON dropship.dropship_listing_price_revisions(store_connection_id, product_variant_id, id);

CREATE TABLE dropship.dropship_listing_price_settings (
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  revision_id integer NOT NULL,
  override_price_cents integer CONSTRAINT dropship_listing_price_setting_cents_chk CHECK (override_price_cents IS NULL OR override_price_cents > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (store_connection_id, product_variant_id),
  CONSTRAINT dropship_listing_price_setting_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_listing_price_setting_revision_fk FOREIGN KEY
    (revision_id, vendor_id, store_connection_id, product_variant_id)
    REFERENCES dropship.dropship_listing_price_revisions(id, vendor_id, store_connection_id, product_variant_id)
);
CREATE INDEX dropship_listing_price_setting_vendor_idx
  ON dropship.dropship_listing_price_settings(vendor_id, store_connection_id);

CREATE FUNCTION dropship.guard_listing_price_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Listing price revisions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER dropship_listing_price_revision_immutable
  BEFORE UPDATE OR DELETE ON dropship.dropship_listing_price_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_price_revision_immutable();

CREATE FUNCTION dropship.guard_listing_price_setting_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR revision.created_at IS DISTINCT FROM NEW.updated_at THEN
    RAISE EXCEPTION 'Listing price setting must match its exact revision' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- PostgreSQL executes INSERT triggers before ON CONFLICT UPDATE triggers.
  -- Validate predecessor against the current target for both operation forms.
  IF revision.previous_revision_id IS DISTINCT FROM (
    SELECT revision_id FROM dropship.dropship_listing_price_settings
    WHERE store_connection_id = NEW.store_connection_id AND product_variant_id = NEW.product_variant_id
  ) THEN
    RAISE EXCEPTION 'Listing price revision predecessor does not match the current setting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dropship_listing_price_setting_coherence
  BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_listing_price_settings
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_price_setting_coherence();
