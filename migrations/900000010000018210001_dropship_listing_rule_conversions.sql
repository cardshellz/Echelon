-- The record of one move of a store's older group rules into category and
-- product settings (Listing settings redesign, PR 11, plan section 12): one
-- row per applied conversion, by the vendor or by the system job. The row is
-- inserted first in the conversion's transaction, so its unique key claims
-- the request key (plan D12): a retry under the same key is answered from
-- the row, and a second use for another plan or store is refused. It keeps
-- the plan and writes hashes and the counts, never the report (plan D15);
-- each write keeps its own audit row with before and after.
--
-- The database refuses what must never be recorded (plan D1): a system
-- conversion that was not clean or changed a size. Every count is an integer
-- (sizes, categories and products up to the 10,000-size selection cap, removed
-- rules up to the profiles' 100); there is no money column. The one-time
-- notice (plan D19) is the only thing that changes later: a guard trigger
-- refuses every DELETE and every UPDATE except notice_seen_at and
-- notice_seen_by going from null to values, once, on a system row.
--
-- Nothing changes for live data: the table is new and starts empty, and no
-- existing table is altered. Code deployed before this file never reads or
-- writes it.
--
-- Locks: the foreign key takes SHARE ROW EXCLUSIVE on the store connection
-- table until commit. That holds off store connection inserts, updates and
-- deletes (not reads, and not the FOR SHARE row locks the listing writers
-- take) for the release transaction. The executor's 15 s lock timeout bounds
-- this file's wait for it, and the executor retries the file after it. No
-- other table is referenced, so no other lock is taken.
--
-- The release executor owns the transaction, including its migration record.
-- Additive and re-runnable: the table and index are created if missing, the
-- guard function is replaced, and the trigger is dropped if present and
-- created again.

CREATE TABLE IF NOT EXISTS dropship.dropship_listing_rule_conversions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  plan_hash varchar(64) NOT NULL,
  writes_hash varchar(64) NOT NULL,
  clean boolean NOT NULL,
  changed_size_count integer NOT NULL,
  category_count integer NOT NULL,
  product_count integer NOT NULL,
  pricing_groups_removed integer NOT NULL,
  content_groups_removed integer NOT NULL,
  ebay_rules_removed integer NOT NULL,
  actor_type varchar(20) NOT NULL,
  actor_id varchar(255) NOT NULL,
  -- The application's injected clock stamps the row; there is no DEFAULT now().
  created_at timestamptz NOT NULL,
  notice_seen_at timestamptz,
  notice_seen_by varchar(255),
  CONSTRAINT dropship_listing_rule_conversion_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  -- A vendor's key names one conversion, whatever store it was for.
  CONSTRAINT dropship_listing_rule_conversion_key_uk UNIQUE (vendor_id, idempotency_key),
  CONSTRAINT dropship_listing_rule_conversion_key_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  CONSTRAINT dropship_listing_rule_conversion_hash_chk
    CHECK (request_hash ~ '^[a-f0-9]{64}$' AND plan_hash ~ '^[a-f0-9]{64}$' AND writes_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dropship_listing_rule_conversion_count_chk
    CHECK (changed_size_count BETWEEN 0 AND 10000 AND category_count BETWEEN 0 AND 10000
      AND product_count BETWEEN 0 AND 10000),
  CONSTRAINT dropship_listing_rule_conversion_removed_chk
    CHECK (pricing_groups_removed BETWEEN 0 AND 100 AND content_groups_removed BETWEEN 0 AND 100
      AND ebay_rules_removed BETWEEN 0 AND 100),
  CONSTRAINT dropship_listing_rule_conversion_actor_chk
    CHECK (actor_type IN ('vendor', 'system')),
  CONSTRAINT dropship_listing_rule_conversion_actor_id_chk
    CHECK (btrim(actor_id) <> ''),
  -- A clean conversion changed no size, whoever applied it.
  CONSTRAINT dropship_listing_rule_conversion_clean_chk
    CHECK (NOT clean OR changed_size_count = 0),
  -- Plan D1 at the database: the system applies only a clean store.
  CONSTRAINT dropship_listing_rule_conversion_system_clean_chk
    CHECK (actor_type <> 'system' OR (clean AND changed_size_count = 0)),
  -- The notice is seen at once by someone, never blank, and only a system conversion has one.
  CONSTRAINT dropship_listing_rule_conversion_notice_chk
    CHECK ((notice_seen_at IS NULL) = (notice_seen_by IS NULL)
      AND (notice_seen_by IS NULL OR btrim(notice_seen_by) <> '')
      AND (actor_type = 'system' OR notice_seen_at IS NULL))
);

CREATE INDEX IF NOT EXISTS dropship_listing_rule_conversion_store_idx
  ON dropship.dropship_listing_rule_conversions (store_connection_id, id);

-- Every column but the two notice columns is compared as one value, so a
-- column added later is guarded with no change here.
CREATE OR REPLACE FUNCTION dropship.guard_listing_rule_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Listing rule conversions are kept; they cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'notice_seen_at' - 'notice_seen_by') IS DISTINCT FROM (to_jsonb(OLD) - 'notice_seen_at' - 'notice_seen_by') THEN
    RAISE EXCEPTION 'A listing rule conversion cannot change; only its notice can be marked seen' USING ERRCODE = '23514';
  END IF;
  IF OLD.actor_type <> 'system' OR OLD.notice_seen_at IS NOT NULL OR OLD.notice_seen_by IS NOT NULL
     OR NEW.notice_seen_at IS NULL OR NEW.notice_seen_by IS NULL THEN
    RAISE EXCEPTION 'A system conversion''s notice is marked seen once, and nothing else changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listing_rule_conversion_guard
  ON dropship.dropship_listing_rule_conversions;
CREATE TRIGGER listing_rule_conversion_guard
  BEFORE UPDATE OR DELETE ON dropship.dropship_listing_rule_conversions
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_listing_rule_conversion();
