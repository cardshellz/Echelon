-- 0728: a revision on each store's listing config, so store defaults save one
-- at a time without overwriting each other (docs: Listing settings redesign,
-- M2 / PR 6).
--
-- Today every writer upserts the whole config with no version, so two saves
-- that both started from the same read silently drop one of them. Writers now
-- send the revision they read and the save is a compare-and-set on it.
--
-- The revision is owned by the database, not by the application:
--   * an INSERT always starts at 1;
--   * an UPDATE that changes what the config says (any column below other
--     than id, store_connection_id, created_at, updated_at) adds exactly 1;
--   * an UPDATE that changes nothing (or only updated_at) keeps it.
-- Owning it here means every writer bumps it, including code deployed before
-- this migration (the release phase runs while old dynos still serve) and
-- older data migrations (215, 216) that sort after this file on a fresh
-- database. A value sent by the application is ignored, so a revision can
-- never move backwards or skip.
--
-- Keyed requests (the vendor's eBay setup save and the ship-from repair) are
-- recorded once in an append-only ledger, so a retried request is answered
-- from its first outcome and is never applied twice.
--
-- Lock order: the ledger is created first. Its foreign keys lock the vendor
-- and store connection tables before anything here locks the listing
-- configs, the same order connecting a store takes them (store connection
-- write, then the default listing config insert). The other order can
-- deadlock with a store connect running on an old dyno during the release.
--
-- The release executor owns the transaction, including its migration record.
-- Additive and re-runnable.

CREATE TABLE IF NOT EXISTS dropship.dropship_listing_config_requests (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  operation varchar(60) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  -- sha256 of the operation, the store and the normalized request, including
  -- the revision it was made against: the same key with another body is refused.
  request_hash varchar(64) NOT NULL,
  actor_type varchar(40) NOT NULL,
  -- Keyed requests always come from a person (today, the vendor's member).
  actor_id varchar(255) NOT NULL,
  revision_before integer NOT NULL,
  revision_after integer NOT NULL,
  outcome varchar(20) NOT NULL,
  created_at timestamptz NOT NULL,

  -- The store belongs to this vendor, as in the other keyed dropship ledgers
  -- (0657 dropship_listing_price_revision_owner_fk).
  CONSTRAINT dropship_listing_config_requests_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  CONSTRAINT dropship_listing_config_requests_actor_id_chk
    CHECK (btrim(actor_id) <> ''),
  CONSTRAINT dropship_listing_config_requests_operation_chk
    CHECK (operation IN ('ebay_listing_setup_save', 'ebay_ship_from_repair')),
  CONSTRAINT dropship_listing_config_requests_key_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  CONSTRAINT dropship_listing_config_requests_hash_chk
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dropship_listing_config_requests_actor_chk
    CHECK (actor_type IN ('vendor', 'admin', 'system')),
  -- One save changes the config by exactly one revision, or not at all.
  CONSTRAINT dropship_listing_config_requests_outcome_chk
    CHECK (
      revision_before > 0
      AND (
        (outcome = 'changed' AND revision_after = revision_before + 1)
        OR (outcome = 'unchanged' AND revision_after = revision_before)
      )
    )
);

-- A vendor's key names one request, whatever store it was for.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_config_requests_key_idx
  ON dropship.dropship_listing_config_requests(vendor_id, idempotency_key);
CREATE INDEX IF NOT EXISTS dropship_listing_config_requests_store_idx
  ON dropship.dropship_listing_config_requests(store_connection_id, created_at);

CREATE OR REPLACE FUNCTION dropship.dropship_listing_config_requests_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dropship_listing_config_requests is append-only: rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_listing_config_requests_guard_trg
  ON dropship.dropship_listing_config_requests;
CREATE TRIGGER dropship_listing_config_requests_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_listing_config_requests
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_listing_config_requests_guard();

ALTER TABLE dropship.dropship_store_listing_configs
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE dropship.dropship_store_listing_configs
  DROP CONSTRAINT IF EXISTS dropship_store_listing_config_revision_chk;
ALTER TABLE dropship.dropship_store_listing_configs
  ADD CONSTRAINT dropship_store_listing_config_revision_chk CHECK (revision > 0);

COMMENT ON COLUMN dropship.dropship_store_listing_configs.revision IS
  'Compare-and-set version of the listing config. Set by trigger: 1 on insert, +1 on every update that changes the config (migration 0728).';

CREATE OR REPLACE FUNCTION dropship.dropship_store_listing_config_revision()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.listing_mode IS DISTINCT FROM OLD.listing_mode
     OR NEW.inventory_mode IS DISTINCT FROM OLD.inventory_mode
     OR NEW.price_mode IS DISTINCT FROM OLD.price_mode
     OR NEW.marketplace_config IS DISTINCT FROM OLD.marketplace_config
     OR NEW.required_config_keys IS DISTINCT FROM OLD.required_config_keys
     OR NEW.required_product_fields IS DISTINCT FROM OLD.required_product_fields
     OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_store_listing_config_revision_trg
  ON dropship.dropship_store_listing_configs;
CREATE TRIGGER dropship_store_listing_config_revision_trg
  BEFORE INSERT OR UPDATE ON dropship.dropship_store_listing_configs
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_store_listing_config_revision();
