-- Vendor eBay category rules, one ordered rule set per store connection
-- (docs/DROPSHIP-VENDOR-CATALOG-REDESIGN.md, section 7).
-- Mirrors 0660 content profiles: immutable revisions, one head row per store,
-- and a predecessor check so two saves can never silently overwrite each other.
CREATE TABLE dropship.dropship_ebay_category_rule_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  previous_revision_id integer,
  profile jsonb NOT NULL CHECK (
    jsonb_typeof(profile) = 'object'
    AND profile ? 'version' AND profile ? 'defaultCategory' AND profile ? 'rules'
    AND jsonb_typeof(profile -> 'rules') = 'array'
  ),
  idempotency_key varchar(200) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]+$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (vendor_id, idempotency_key),
  UNIQUE (id, vendor_id, store_connection_id),
  FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id),
  FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_ebay_category_rule_revisions(id, vendor_id, store_connection_id)
);
CREATE TABLE dropship.dropship_ebay_category_rule_profiles (
  store_connection_id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  revision_id integer NOT NULL,
  FOREIGN KEY (revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_ebay_category_rule_revisions(id, vendor_id, store_connection_id)
);
CREATE FUNCTION dropship.guard_ebay_category_rule_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'eBay category rule revisions are immutable; create a new revision' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ebay_category_rule_revision_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_ebay_category_rule_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_ebay_category_rule_revision_immutable();
CREATE FUNCTION dropship.guard_ebay_category_rule_profile_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Reset eBay category rules with a new revision' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id) THEN
    RAISE EXCEPTION 'eBay category rule profile identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  SELECT previous_revision_id INTO predecessor FROM dropship.dropship_ebay_category_rule_revisions WHERE id = NEW.revision_id;
  IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_ebay_category_rule_profiles
      WHERE store_connection_id = NEW.store_connection_id) THEN
    RAISE EXCEPTION 'eBay category rule profile predecessor conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ebay_category_rule_profile_coherence BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_ebay_category_rule_profiles
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_ebay_category_rule_profile_coherence();
