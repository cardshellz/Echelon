-- 0713: what a .ops cost increase did to the vendor's listings when it took
-- effect (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, part C5).
--
-- Three tables. Every live listing of an increase's variant gets one action
-- row under the policy in force (repriced through a push job, left for the
-- vendor's review, judged to cover the cost, or under water and recorded,
-- warned about or paused). The entry row is written in the same transaction
-- once every listing is decided, and is what marks the increase as done. A
-- pause is an inventory-planning publication hold; its row lives until the
-- price covers the cost in force again, and is released exactly once.

CREATE TABLE IF NOT EXISTS dropship.dropship_cost_change_listing_holds (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id),
  -- The increase that put the listing under water.
  entry_id bigint NOT NULL REFERENCES dropship.dropship_cost_schedule_entries(id),
  listing_price_cents bigint NOT NULL,
  unit_cost_cents bigint NOT NULL,
  hold_idempotency_key varchar(200) NOT NULL,
  held_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason varchar(40),
  -- What the release did at inventory planning: its SKU hold has one holder
  -- and any release deletes it, so a hold another actor now owns is left in
  -- place, and one already gone needs no command.
  release_detail varchar(40),
  release_idempotency_key varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_change_listing_holds_price_chk
    CHECK (listing_price_cents > 0 AND unit_cost_cents > 0 AND listing_price_cents < unit_cost_cents),
  CONSTRAINT dropship_cost_change_listing_holds_release_chk
    CHECK (
      (released_at IS NULL AND release_reason IS NULL AND release_detail IS NULL AND release_idempotency_key IS NULL)
      OR (released_at IS NOT NULL AND released_at >= held_at
          AND release_reason IN ('price_covers_cost', 'listing_inactive')
          AND release_detail IN ('released', 'held_by_other', 'not_held')
          AND release_idempotency_key IS NOT NULL)
    )
);

-- One live hold per listing.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_listing_holds_active_idx
  ON dropship.dropship_cost_change_listing_holds(store_connection_id, product_variant_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS dropship_cost_change_listing_holds_vendor_idx
  ON dropship.dropship_cost_change_listing_holds(vendor_id, held_at);

-- A hold is released once; nothing else about it changes, and it is never deleted.
CREATE OR REPLACE FUNCTION dropship.dropship_cost_change_listing_holds_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dropship_cost_change_listing_holds rows cannot be deleted';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'dropship_cost_change_listing_holds: a released hold cannot change';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
     OR NEW.store_connection_id IS DISTINCT FROM OLD.store_connection_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
     OR NEW.listing_price_cents IS DISTINCT FROM OLD.listing_price_cents
     OR NEW.unit_cost_cents IS DISTINCT FROM OLD.unit_cost_cents
     OR NEW.hold_idempotency_key IS DISTINCT FROM OLD.hold_idempotency_key
     OR NEW.held_at IS DISTINCT FROM OLD.held_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'dropship_cost_change_listing_holds: only the release of a live hold may be recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_change_listing_holds_guard_trg
  ON dropship.dropship_cost_change_listing_holds;
CREATE TRIGGER dropship_cost_change_listing_holds_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_listing_holds
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_change_listing_holds_guard();

CREATE TABLE IF NOT EXISTS dropship.dropship_cost_change_listing_actions (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entry_id bigint NOT NULL REFERENCES dropship.dropship_cost_schedule_entries(id),
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id),
  -- The listing as it was judged.
  listing_status varchar(40) NOT NULL,
  price_source varchar(40) NOT NULL,
  listing_price_cents bigint,
  -- The increase's cost per unit, what the listing was judged against.
  unit_cost_cents bigint NOT NULL,
  action varchar(40) NOT NULL,
  -- Why a reprice was refused (the store's access code), when it was.
  detail varchar(120),
  -- What the action created, when it created something.
  push_job_id integer REFERENCES dropship.dropship_listing_push_jobs(id),
  hold_id bigint REFERENCES dropship.dropship_cost_change_listing_holds(id),
  policy_id integer REFERENCES dropship.dropship_cost_change_policies(id),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_change_listing_actions_source_chk
    CHECK (price_source IN ('rules_cost', 'rules_retail', 'fixed', 'catalog_default', 'saved_listing', 'unavailable')),
  CONSTRAINT dropship_cost_change_listing_actions_action_chk
    CHECK (action IN ('reprice_queued', 'reprice_refused', 'awaiting_review', 'price_covers_cost', 'below_cost_recorded', 'below_cost_warned',
                      'below_cost_paused', 'skipped_inactive_listing', 'skipped_price_unavailable')),
  -- A refusal says why; nothing else carries a detail.
  CONSTRAINT dropship_cost_change_listing_actions_detail_chk
    CHECK ((action = 'reprice_refused') = (detail IS NOT NULL)),
  CONSTRAINT dropship_cost_change_listing_actions_cost_chk
    CHECK (unit_cost_cents > 0),
  CONSTRAINT dropship_cost_change_listing_actions_price_chk
    CHECK (listing_price_cents IS NULL OR listing_price_cents > 0),
  -- A reprice names its push job; a pause names its hold; nothing else names either.
  CONSTRAINT dropship_cost_change_listing_actions_refs_chk
    CHECK (
      (action = 'reprice_queued' AND push_job_id IS NOT NULL AND hold_id IS NULL)
      OR (action = 'below_cost_paused' AND hold_id IS NOT NULL AND push_job_id IS NULL)
      OR (action NOT IN ('reprice_queued', 'below_cost_paused') AND push_job_id IS NULL AND hold_id IS NULL)
    )
);

-- One decision per increase and listing; the pass replays safely on it.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_listing_actions_entry_listing_idx
  ON dropship.dropship_cost_change_listing_actions(entry_id, listing_id);
CREATE INDEX IF NOT EXISTS dropship_cost_change_listing_actions_vendor_idx
  ON dropship.dropship_cost_change_listing_actions(vendor_id, decided_at);

CREATE OR REPLACE FUNCTION dropship.dropship_cost_change_listing_actions_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dropship_cost_change_listing_actions is append-only: rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_change_listing_actions_guard_trg
  ON dropship.dropship_cost_change_listing_actions;
CREATE TRIGGER dropship_cost_change_listing_actions_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_listing_actions
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_change_listing_actions_guard();

-- One row per increase once every listing of its variant has been decided.
-- Its absence is what the pass looks for; the listing rows above are its detail.
CREATE TABLE IF NOT EXISTS dropship.dropship_cost_change_entry_actions (
  entry_id bigint PRIMARY KEY REFERENCES dropship.dropship_cost_schedule_entries(id),
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  listing_count integer NOT NULL CHECK (listing_count >= 0),
  -- Counts by action, as recorded: {"reprice_queued": 2, ...}.
  action_counts jsonb NOT NULL,
  -- Set when a later increase was already in force by the time the pass
  -- reached this one, so no listing was judged against it.
  superseded_by_entry_id bigint REFERENCES dropship.dropship_cost_schedule_entries(id),
  policy_id integer REFERENCES dropship.dropship_cost_change_policies(id),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_change_entry_actions_counts_chk
    CHECK (jsonb_typeof(action_counts) = 'object'),
  CONSTRAINT dropship_cost_change_entry_actions_superseded_chk
    CHECK (superseded_by_entry_id IS NULL OR listing_count = 0)
);

CREATE INDEX IF NOT EXISTS dropship_cost_change_entry_actions_vendor_idx
  ON dropship.dropship_cost_change_entry_actions(vendor_id, decided_at);

CREATE OR REPLACE FUNCTION dropship.dropship_cost_change_entry_actions_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dropship_cost_change_entry_actions is append-only: rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_change_entry_actions_guard_trg
  ON dropship.dropship_cost_change_entry_actions;
CREATE TRIGGER dropship_cost_change_entry_actions_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_entry_actions
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_change_entry_actions_guard();
