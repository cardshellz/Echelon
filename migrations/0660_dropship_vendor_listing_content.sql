-- Vendor-owned description drafts never update the shared product catalog.
CREATE TABLE dropship.dropship_content_profile_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  previous_revision_id integer,
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object' AND profile ? 'defaultTemplate' AND profile ? 'groups'),
  idempotency_key varchar(200) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]+$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (vendor_id, idempotency_key),
  UNIQUE (id, vendor_id, store_connection_id),
  FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id),
  FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_content_profile_revisions(id, vendor_id, store_connection_id)
);
CREATE TABLE dropship.dropship_content_profiles (
  store_connection_id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  revision_id integer NOT NULL,
  FOREIGN KEY (revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_content_profile_revisions(id, vendor_id, store_connection_id)
);
CREATE TABLE dropship.dropship_listing_content_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  previous_revision_id integer,
  custom_text text CHECK (custom_text IS NULL OR (length(btrim(custom_text)) > 0 AND length(custom_text) <= 20000)),
  catalog_hash text NOT NULL CHECK (catalog_hash ~ '^[a-f0-9]{64}$'),
  profile_revision_id integer,
  idempotency_key varchar(200) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]+$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (vendor_id, idempotency_key),
  UNIQUE (id, vendor_id, store_connection_id, product_variant_id),
  FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id),
  FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id, product_variant_id)
    REFERENCES dropship.dropship_listing_content_revisions(id, vendor_id, store_connection_id, product_variant_id),
  FOREIGN KEY (profile_revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_content_profile_revisions(id, vendor_id, store_connection_id)
);
CREATE TABLE dropship.dropship_listing_content_settings (
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  revision_id integer NOT NULL,
  PRIMARY KEY (store_connection_id, product_variant_id),
  FOREIGN KEY (revision_id, vendor_id, store_connection_id, product_variant_id)
    REFERENCES dropship.dropship_listing_content_revisions(id, vendor_id, store_connection_id, product_variant_id)
);
CREATE FUNCTION dropship.guard_content_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Content revisions are immutable; create a new revision' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER content_profile_revision_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_content_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_content_revision_immutable();
CREATE TRIGGER listing_content_revision_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_listing_content_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_content_revision_immutable();

CREATE FUNCTION dropship.guard_content_profile_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Reset content templates with a new revision' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id) THEN
    RAISE EXCEPTION 'Content profile identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  SELECT previous_revision_id INTO predecessor FROM dropship.dropship_content_profile_revisions WHERE id = NEW.revision_id;
  IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_content_profiles WHERE store_connection_id = NEW.store_connection_id) THEN
    RAISE EXCEPTION 'Content profile predecessor conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_profile_coherence BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_content_profiles
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_content_profile_coherence();
CREATE FUNCTION dropship.guard_listing_content_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Reset listing descriptions with a new revision' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id OR OLD.product_variant_id <> NEW.product_variant_id) THEN
    RAISE EXCEPTION 'Listing content identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  SELECT previous_revision_id INTO predecessor FROM dropship.dropship_listing_content_revisions WHERE id = NEW.revision_id;
  IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_listing_content_settings
      WHERE store_connection_id = NEW.store_connection_id AND product_variant_id = NEW.product_variant_id) THEN
    RAISE EXCEPTION 'Listing content predecessor conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listing_content_coherence BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_listing_content_settings
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_content_coherence();
