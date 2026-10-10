-- 0736: a vendor's own listing settings for one Card Shellz product
-- (Listing settings redesign, M3 / PR 8).
--
-- A null value means "follow the default": for price, eBay category and
-- description an older group rule that matches comes first; then the
-- product's category setting (0737), else the store default. Every value
-- lives on an immutable revision. The current row only points at its
-- revision (the 0660 pattern), and a trigger refuses deletes, identity
-- changes and stale predecessors, so going back to the default is a new
-- revision with that value null. A request that changes many products at
-- once is recorded once in an append-only ledger (the 0728 pattern), so a
-- retried request is answered from its first outcome and is never applied
-- twice.
--
-- Each value group is all or none. PostgreSQL accepts a row when a CHECK
-- evaluates to NULL, so every group counts its columns with num_nonnulls,
-- and every "set" branch tests IS NOT NULL before it compares.
--
-- Nothing changes for live data: the three tables are new and start empty,
-- and no existing table is altered. Code deployed before this file never
-- reads or writes them.
--
-- Lock order: the ledger is created first, because revisions reference it.
-- In statement order the foreign keys take SHARE ROW EXCLUSIVE on the vendor
-- table, then the store connection table, then the Card Shellz products
-- table, until commit. That blocks writes to those tables (not the FOR SHARE
-- row locks listing writers take) for the release transaction, up to the
-- executor's lock timeout, and the executor retries on a lock timeout.
--
-- The release executor owns the transaction, including its migration record.
-- Additive and re-runnable.

CREATE TABLE IF NOT EXISTS dropship.dropship_product_listing_setting_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  -- The store is referenced together with its vendor (the owner FK below), never alone.
  store_connection_id integer NOT NULL,
  operation varchar(60) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  -- The rows the request wrote: changed products for a bulk change,
  -- acknowledged marks for an acknowledge. Zero is a request that changed nothing.
  product_count integer NOT NULL,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255) NOT NULL,
  -- The application's injected clock stamps the row; there is no DEFAULT now().
  created_at timestamptz NOT NULL,
  CONSTRAINT dropship_product_listing_setting_requests_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  -- Revisions written by a request point at it through this triple.
  CONSTRAINT dropship_product_listing_setting_requests_identity_uk UNIQUE (id, vendor_id, store_connection_id),
  CONSTRAINT dropship_product_listing_setting_requests_operation_chk
    CHECK (operation IN ('product_settings_bulk', 'category_settings_clear', 'category_moves_acknowledge')),
  CONSTRAINT dropship_product_listing_setting_requests_count_chk
    CHECK (product_count BETWEEN 0 AND 10000),
  CONSTRAINT dropship_product_listing_setting_requests_key_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  CONSTRAINT dropship_product_listing_setting_requests_hash_chk
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dropship_product_listing_setting_requests_actor_chk
    CHECK (actor_type IN ('vendor', 'admin', 'system')),
  CONSTRAINT dropship_product_listing_setting_requests_actor_id_chk
    CHECK (btrim(actor_id) <> '')
);

-- A vendor's key names one request, whatever store it was for.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_product_listing_setting_requests_key_idx
  ON dropship.dropship_product_listing_setting_requests (vendor_id, idempotency_key);
CREATE INDEX IF NOT EXISTS dropship_product_listing_setting_requests_store_idx
  ON dropship.dropship_product_listing_setting_requests (store_connection_id, created_at);

CREATE TABLE IF NOT EXISTS dropship.dropship_product_listing_setting_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  product_id integer NOT NULL,
  previous_revision_id integer,
  -- Set only for a revision written by a many-products request.
  request_id bigint,
  price_basis varchar(20),
  price_markup_bps integer,
  price_flat_cents integer,
  price_rounding varchar(10),
  ebay_category_id varchar(20),
  ebay_category_name varchar(200),
  ebay_category_path jsonb,
  shelf_mode varchar(10),
  shelf_ids jsonb,
  shelf_names jsonb,
  -- Policy names are display only and may be unknown (null) while the id is set.
  fulfillment_policy_id varchar(100),
  fulfillment_policy_name varchar(200),
  return_policy_id varchar(100),
  return_policy_name varchar(200),
  payment_policy_id varchar(100),
  payment_policy_name varchar(200),
  text_above_mode varchar(10),
  text_above text,
  text_below_mode varchar(10),
  text_below text,
  -- Own main text with the product-level catalog hash it was written against;
  -- both null means the Card Shellz text.
  body_text text,
  body_catalog_hash varchar(64),
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT dropship_product_listing_setting_revision_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_product_listing_setting_revision_product_fk FOREIGN KEY (product_id)
    REFERENCES catalog.products(id),
  CONSTRAINT dropship_product_listing_setting_revision_identity_uk UNIQUE (id, vendor_id, store_connection_id, product_id),
  -- The chain stays inside one vendor, store and product.
  CONSTRAINT dropship_product_listing_setting_revision_previous_fk
    FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id, product_id)
    REFERENCES dropship.dropship_product_listing_setting_revisions(id, vendor_id, store_connection_id, product_id),
  CONSTRAINT dropship_product_listing_setting_revision_request_fk FOREIGN KEY (request_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_product_listing_setting_requests(id, vendor_id, store_connection_id),
  CONSTRAINT dropship_product_listing_setting_revision_key_uk UNIQUE (vendor_id, idempotency_key),
  -- Price recipe: all four or none, with the bounds of the pricing recipe
  -- contract (integer basis points and integer cents; the largest listing price).
  CONSTRAINT dropship_product_listing_setting_revision_price_chk CHECK (
    num_nonnulls(price_basis, price_markup_bps, price_flat_cents, price_rounding) = 0
    OR (num_nonnulls(price_basis, price_markup_bps, price_flat_cents, price_rounding) = 4
        AND price_basis IN ('product_cost', 'catalog_retail')
        AND price_markup_bps BETWEEN 0 AND 1000000
        AND price_flat_cents BETWEEN 0 AND 2147483647
        AND price_rounding IN ('cent', 'up_99'))),
  -- eBay category: all three or none, with the bounds of the eBay category contract.
  CONSTRAINT dropship_product_listing_setting_revision_ebay_category_chk CHECK (
    num_nonnulls(ebay_category_id, ebay_category_name, ebay_category_path) = 0
    OR (num_nonnulls(ebay_category_id, ebay_category_name, ebay_category_path) = 3
        AND ebay_category_id ~ '^[1-9][0-9]{0,19}$'
        AND btrim(ebay_category_name) <> ''
        AND jsonb_typeof(ebay_category_path) = 'array'
        AND jsonb_array_length(ebay_category_path) BETWEEN 1 AND 12)),
  -- Shelf: follow (all null), none (the mode only), or own with one or two
  -- shelf ids and as many names.
  CONSTRAINT dropship_product_listing_setting_revision_shelf_chk CHECK (
    ((shelf_mode IS NULL OR shelf_mode = 'none') AND shelf_ids IS NULL AND shelf_names IS NULL)
    OR (shelf_mode IS NOT NULL AND shelf_mode = 'own'
        AND shelf_ids IS NOT NULL AND shelf_names IS NOT NULL
        AND jsonb_typeof(shelf_ids) = 'array' AND jsonb_array_length(shelf_ids) BETWEEN 1 AND 2
        AND jsonb_typeof(shelf_names) = 'array'
        AND jsonb_array_length(shelf_names) = jsonb_array_length(shelf_ids))),
  -- A policy name only with its id; ids and names never blank. Every part
  -- tests IS NULL or IS NOT NULL first, so none evaluates to NULL.
  CONSTRAINT dropship_product_listing_setting_revision_policy_chk CHECK (
    (fulfillment_policy_id IS NOT NULL OR fulfillment_policy_name IS NULL)
    AND (return_policy_id IS NOT NULL OR return_policy_name IS NULL)
    AND (payment_policy_id IS NOT NULL OR payment_policy_name IS NULL)
    AND (fulfillment_policy_id IS NULL OR btrim(fulfillment_policy_id) <> '')
    AND (return_policy_id IS NULL OR btrim(return_policy_id) <> '')
    AND (payment_policy_id IS NULL OR btrim(payment_policy_id) <> '')
    AND (fulfillment_policy_name IS NULL OR btrim(fulfillment_policy_name) <> '')
    AND (return_policy_name IS NULL OR btrim(return_policy_name) <> '')
    AND (payment_policy_name IS NULL OR btrim(payment_policy_name) <> '')),
  -- Text above and text below, each on its own: follow (both null), none
  -- (the mode only), or own text of 1 to 4,000 characters.
  CONSTRAINT dropship_product_listing_setting_revision_text_chk CHECK (
    (((text_above_mode IS NULL OR text_above_mode = 'none') AND text_above IS NULL)
      OR (text_above_mode IS NOT NULL AND text_above_mode = 'own' AND text_above IS NOT NULL
          AND length(btrim(text_above)) > 0 AND length(text_above) <= 4000))
    AND (((text_below_mode IS NULL OR text_below_mode = 'none') AND text_below IS NULL)
      OR (text_below_mode IS NOT NULL AND text_below_mode = 'own' AND text_below IS NOT NULL
          AND length(btrim(text_below)) > 0 AND length(text_below) <= 4000))),
  -- Main text: own text of 1 to 20,000 characters with its catalog hash, or neither.
  CONSTRAINT dropship_product_listing_setting_revision_body_chk CHECK (
    (body_text IS NULL AND body_catalog_hash IS NULL)
    OR (body_text IS NOT NULL AND body_catalog_hash IS NOT NULL
        AND length(btrim(body_text)) > 0 AND length(body_text) <= 20000
        AND body_catalog_hash ~ '^[a-f0-9]{64}$')),
  CONSTRAINT dropship_product_listing_setting_revision_key_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  CONSTRAINT dropship_product_listing_setting_revision_hash_chk
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dropship_product_listing_setting_revision_actor_chk
    CHECK (actor_type IN ('vendor', 'admin', 'system')),
  CONSTRAINT dropship_product_listing_setting_revision_actor_id_chk
    CHECK (btrim(actor_id) <> '')
);

CREATE INDEX IF NOT EXISTS dropship_product_listing_setting_revision_target_idx
  ON dropship.dropship_product_listing_setting_revisions (store_connection_id, product_id, id);
CREATE INDEX IF NOT EXISTS dropship_product_listing_setting_revision_request_idx
  ON dropship.dropship_product_listing_setting_revisions (request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dropship.dropship_product_listing_settings (
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  product_id integer NOT NULL,
  revision_id integer NOT NULL,
  CONSTRAINT dropship_product_listing_setting_pk PRIMARY KEY (store_connection_id, product_id),
  CONSTRAINT dropship_product_listing_setting_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_product_listing_setting_product_fk FOREIGN KEY (product_id)
    REFERENCES catalog.products(id),
  -- The current row points at a revision of the same vendor, store and product.
  CONSTRAINT dropship_product_listing_setting_revision_fk
    FOREIGN KEY (revision_id, vendor_id, store_connection_id, product_id)
    REFERENCES dropship.dropship_product_listing_setting_revisions(id, vendor_id, store_connection_id, product_id)
);

CREATE INDEX IF NOT EXISTS dropship_product_listing_setting_vendor_idx
  ON dropship.dropship_product_listing_settings (vendor_id, store_connection_id);

CREATE OR REPLACE FUNCTION dropship.guard_product_listing_setting_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Product listing setting revisions are immutable; create a new revision' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS product_listing_setting_revision_immutable
  ON dropship.dropship_product_listing_setting_revisions;
CREATE TRIGGER product_listing_setting_revision_immutable
  BEFORE UPDATE OR DELETE ON dropship.dropship_product_listing_setting_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_product_listing_setting_revision_immutable();

CREATE OR REPLACE FUNCTION dropship.guard_product_listing_setting_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reset product listing settings with a new revision, not deletion' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id
     OR OLD.product_id <> NEW.product_id) THEN
    RAISE EXCEPTION 'Product listing setting identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  -- PostgreSQL runs INSERT triggers before ON CONFLICT UPDATE triggers, so
  -- both forms check the predecessor against the current row.
  SELECT previous_revision_id INTO predecessor
    FROM dropship.dropship_product_listing_setting_revisions WHERE id = NEW.revision_id;
  IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_product_listing_settings
      WHERE store_connection_id = NEW.store_connection_id AND product_id = NEW.product_id) THEN
    RAISE EXCEPTION 'Product listing setting predecessor does not match the current setting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_listing_setting_coherence
  ON dropship.dropship_product_listing_settings;
CREATE TRIGGER product_listing_setting_coherence
  BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_product_listing_settings
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_product_listing_setting_coherence();

CREATE OR REPLACE FUNCTION dropship.guard_product_listing_setting_request_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Product listing setting requests are append-only: rows cannot be updated or deleted' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS product_listing_setting_request_append_only
  ON dropship.dropship_product_listing_setting_requests;
CREATE TRIGGER product_listing_setting_request_append_only
  BEFORE UPDATE OR DELETE ON dropship.dropship_product_listing_setting_requests
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_product_listing_setting_request_append_only();
