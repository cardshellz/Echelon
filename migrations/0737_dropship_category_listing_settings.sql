-- 0737: a vendor's listing settings for one Card Shellz category, and the
-- category marks behind "Card Shellz updated products" (Listing settings
-- redesign, M5 / PR 8).
--
-- Category settings are keyed by the Card Shellz category id, never its name:
-- Card Shellz can rename a category and the id stays. A null value means "use
-- the store default". A category sets what a product sets except the main
-- text (product only, 0736), so there are no body columns, and a category
-- save is never part of a many-products request, so there is no request id.
-- The revisions keep the category's name at save for the audit trail; readers
-- show the current name. Same pattern and value checks as 0736: immutable
-- revisions, a current row that only points at its revision, a trigger that
-- refuses deletes, identity changes and stale predecessors, and value groups
-- that are all or none without relying on a NULL CHECK result.
--
-- A category mark holds the Card Shellz category a chosen product was in when
-- the vendor last confirmed it (null: no category). A mark is derived history,
-- so it has no foreign key to any catalog table: it never blocks a catalog
-- delete and is never deleted by one, and readers join the products table, so
-- a mark left by a deleted product is never shown. Marks are never deleted;
-- an acknowledge moves one forward and its time never moves back.
--
-- Nothing changes for live data: the three tables are new and start empty,
-- and no existing table is altered.
--
-- Lock order: in statement order the foreign keys take SHARE ROW EXCLUSIVE on
-- the vendor table, then the store connection table, then the Card Shellz
-- categories table, until commit. This file references the products table
-- nowhere, so it takes no lock on it. A category rename writes the category,
-- then its products, so there is no cycle with this order.
--
-- The release executor owns the transaction, including its migration record.
-- Additive and re-runnable.

CREATE TABLE IF NOT EXISTS dropship.dropship_category_listing_setting_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  category_id integer NOT NULL,
  -- The category's name when saved (as wide as the catalog column).
  category_name varchar(100) NOT NULL,
  previous_revision_id integer,
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
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT dropship_category_listing_setting_revision_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_category_listing_setting_revision_category_fk FOREIGN KEY (category_id)
    REFERENCES catalog.product_categories(id),
  CONSTRAINT dropship_category_listing_setting_revision_identity_uk UNIQUE (id, vendor_id, store_connection_id, category_id),
  -- The chain stays inside one vendor, store and category.
  CONSTRAINT dropship_category_listing_setting_revision_previous_fk
    FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id, category_id)
    REFERENCES dropship.dropship_category_listing_setting_revisions(id, vendor_id, store_connection_id, category_id),
  CONSTRAINT dropship_category_listing_setting_revision_key_uk UNIQUE (vendor_id, idempotency_key),
  CONSTRAINT dropship_category_listing_setting_revision_category_name_chk
    CHECK (btrim(category_name) <> ''),
  -- Price recipe: all four or none, with the bounds of the pricing recipe
  -- contract (integer basis points and integer cents; the largest listing price).
  CONSTRAINT dropship_category_listing_setting_revision_price_chk CHECK (
    num_nonnulls(price_basis, price_markup_bps, price_flat_cents, price_rounding) = 0
    OR (num_nonnulls(price_basis, price_markup_bps, price_flat_cents, price_rounding) = 4
        AND price_basis IN ('product_cost', 'catalog_retail')
        AND price_markup_bps BETWEEN 0 AND 1000000
        AND price_flat_cents BETWEEN 0 AND 2147483647
        AND price_rounding IN ('cent', 'up_99'))),
  -- eBay category: all three or none, with the bounds of the eBay category contract.
  CONSTRAINT dropship_category_listing_setting_revision_ebay_category_chk CHECK (
    num_nonnulls(ebay_category_id, ebay_category_name, ebay_category_path) = 0
    OR (num_nonnulls(ebay_category_id, ebay_category_name, ebay_category_path) = 3
        AND ebay_category_id ~ '^[1-9][0-9]{0,19}$'
        AND btrim(ebay_category_name) <> ''
        AND jsonb_typeof(ebay_category_path) = 'array'
        AND jsonb_array_length(ebay_category_path) BETWEEN 1 AND 12)),
  -- Shelf: follow (all null), none (the mode only), or own with one or two
  -- shelf ids and as many names.
  CONSTRAINT dropship_category_listing_setting_revision_shelf_chk CHECK (
    ((shelf_mode IS NULL OR shelf_mode = 'none') AND shelf_ids IS NULL AND shelf_names IS NULL)
    OR (shelf_mode IS NOT NULL AND shelf_mode = 'own'
        AND shelf_ids IS NOT NULL AND shelf_names IS NOT NULL
        AND jsonb_typeof(shelf_ids) = 'array' AND jsonb_array_length(shelf_ids) BETWEEN 1 AND 2
        AND jsonb_typeof(shelf_names) = 'array'
        AND jsonb_array_length(shelf_names) = jsonb_array_length(shelf_ids))),
  -- A policy name only with its id; ids and names never blank. Every part
  -- tests IS NULL or IS NOT NULL first, so none evaluates to NULL.
  CONSTRAINT dropship_category_listing_setting_revision_policy_chk CHECK (
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
  CONSTRAINT dropship_category_listing_setting_revision_text_chk CHECK (
    (((text_above_mode IS NULL OR text_above_mode = 'none') AND text_above IS NULL)
      OR (text_above_mode IS NOT NULL AND text_above_mode = 'own' AND text_above IS NOT NULL
          AND length(btrim(text_above)) > 0 AND length(text_above) <= 4000))
    AND (((text_below_mode IS NULL OR text_below_mode = 'none') AND text_below IS NULL)
      OR (text_below_mode IS NOT NULL AND text_below_mode = 'own' AND text_below IS NOT NULL
          AND length(btrim(text_below)) > 0 AND length(text_below) <= 4000))),
  CONSTRAINT dropship_category_listing_setting_revision_key_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  CONSTRAINT dropship_category_listing_setting_revision_hash_chk
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dropship_category_listing_setting_revision_actor_chk
    CHECK (actor_type IN ('vendor', 'admin', 'system')),
  CONSTRAINT dropship_category_listing_setting_revision_actor_id_chk
    CHECK (btrim(actor_id) <> '')
);

CREATE INDEX IF NOT EXISTS dropship_category_listing_setting_revision_target_idx
  ON dropship.dropship_category_listing_setting_revisions (store_connection_id, category_id, id);

CREATE TABLE IF NOT EXISTS dropship.dropship_category_listing_settings (
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  category_id integer NOT NULL,
  revision_id integer NOT NULL,
  -- The owner FK already pins the vendor, so the store and category name the row.
  CONSTRAINT dropship_category_listing_setting_pk PRIMARY KEY (store_connection_id, category_id),
  CONSTRAINT dropship_category_listing_setting_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_category_listing_setting_category_fk FOREIGN KEY (category_id)
    REFERENCES catalog.product_categories(id),
  -- The current row points at a revision of the same vendor, store and category.
  CONSTRAINT dropship_category_listing_setting_revision_fk
    FOREIGN KEY (revision_id, vendor_id, store_connection_id, category_id)
    REFERENCES dropship.dropship_category_listing_setting_revisions(id, vendor_id, store_connection_id, category_id)
);

CREATE INDEX IF NOT EXISTS dropship_category_listing_setting_vendor_idx
  ON dropship.dropship_category_listing_settings (vendor_id, store_connection_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_product_category_seen (
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  -- No foreign key: a mark never blocks, and never follows, a catalog delete.
  product_id integer NOT NULL,
  -- The Card Shellz category last confirmed; null is no category. No foreign key either.
  category_id integer,
  seen_at timestamptz NOT NULL,
  CONSTRAINT dropship_product_category_seen_pk PRIMARY KEY (store_connection_id, product_id),
  CONSTRAINT dropship_product_category_seen_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id)
);

CREATE OR REPLACE FUNCTION dropship.guard_category_listing_setting_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Category listing setting revisions are immutable; create a new revision' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS category_listing_setting_revision_immutable
  ON dropship.dropship_category_listing_setting_revisions;
CREATE TRIGGER category_listing_setting_revision_immutable
  BEFORE UPDATE OR DELETE ON dropship.dropship_category_listing_setting_revisions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_category_listing_setting_revision_immutable();

CREATE OR REPLACE FUNCTION dropship.guard_category_listing_setting_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reset category listing settings with a new revision, not deletion' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id
     OR OLD.category_id <> NEW.category_id) THEN
    RAISE EXCEPTION 'Category listing setting identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  -- PostgreSQL runs INSERT triggers before ON CONFLICT UPDATE triggers, so
  -- both forms check the predecessor against the current row.
  SELECT previous_revision_id INTO predecessor
    FROM dropship.dropship_category_listing_setting_revisions WHERE id = NEW.revision_id;
  IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_category_listing_settings
      WHERE store_connection_id = NEW.store_connection_id AND category_id = NEW.category_id) THEN
    RAISE EXCEPTION 'Category listing setting predecessor does not match the current setting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS category_listing_setting_coherence
  ON dropship.dropship_category_listing_settings;
CREATE TRIGGER category_listing_setting_coherence
  BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_category_listing_settings
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_category_listing_setting_coherence();

-- A mark is history: it is never deleted, its identity never changes, and it
-- only moves forward in time. Inserting first marks needs no guard (they are
-- written ON CONFLICT DO NOTHING and never change an existing mark).
CREATE OR REPLACE FUNCTION dropship.guard_product_category_seen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Category marks are kept; acknowledge to move them forward' USING ERRCODE = '23514';
  END IF;
  IF OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id
     OR OLD.product_id <> NEW.product_id THEN
    RAISE EXCEPTION 'Category mark identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.seen_at < OLD.seen_at THEN
    RAISE EXCEPTION 'A category mark cannot move back in time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_category_seen_guard
  ON dropship.dropship_product_category_seen;
CREATE TRIGGER product_category_seen_guard
  BEFORE UPDATE OR DELETE ON dropship.dropship_product_category_seen
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_product_category_seen();
