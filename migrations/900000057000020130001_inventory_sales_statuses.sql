-- inventory_sales_statuses: one Selling/Stopped switch per product or SKU on
-- every sales channel at once, with optional per-channel exceptions (owner
-- decision 2026-11-07: "stop selling a SKU on ALL channels at once, with
-- per-channel overrides"). A change takes effect when it is saved; there is no
-- draft and no channel review.
--
-- A row is an explicit setting at one scope. No row means "inherit". A SKU
-- sells on a channel only if BOTH its product and the SKU are Selling there;
-- a stop always wins (owner decision 2026-11-07):
--   * a product stopped on a channel stops every SKU under it there, and no
--     SKU setting overrides it;
--   * within one level (product, or SKU) a channel exception beats the
--     all-channels setting ("stopped everywhere except Shopify");
--   * with nothing set, everything sells.
-- Selling on all channels is that default, so an all-channels row is always
-- Stopped; Selling exists only as a channel exception.
-- Stopped publishes 0 for the SKU on every live destination of the scope's
-- channel(s) and keeps the listing; canonical ATP is still calculated and
-- recorded, so resuming restores the calculated quantity.
--
-- This table is the operator's holder only. Automation keeps its own
-- per-destination holds (inventory.inventory_publication_target_variant_holds:
-- Dropship listing tiers and cost-change pauses, Walmart unpublish). Any holder
-- zeroes a SKU. Changing a sales status never deletes another holder's hold,
-- and releasing a hold never changes a sales status.
--
-- SKU rows store only the variant (product_id is NULL), so a SKU's status
-- follows the SKU; product rows store only the product.
--
-- Concurrency: every insert and update stamps `revision` from one sequence, so
-- a revision is never reused, even after a row is removed and re-created. A
-- command carrying the revision it saw is refused when the row changed.
--
-- History: inventory.sales_status_events is append-only (a trigger refuses
-- UPDATE, DELETE and TRUNCATE). One event per changed scope records
-- before/after, actor, time, note and the command's idempotency key. It has no
-- foreign keys so history outlives catalog cleanup.
--
-- Not part of the cutover configuration freeze: like the SKU holds this is an
-- operator safety control. The single-rule apply hashes the resolved stops in
-- its target snapshot and re-plans inside its own transaction, so a status
-- change between review and apply makes it refuse rather than publish.
--
-- New objects only. No existing row is read or written. Applied once by the
-- release runner, inside its transaction.

CREATE SEQUENCE inventory.sales_status_revision_seq AS bigint START WITH 1 NO CYCLE;

COMMENT ON SEQUENCE inventory.sales_status_revision_seq IS
  'Version stamps for inventory.sales_statuses. Shared by every row and never reused, so a stale expected revision is always detected.';

CREATE TABLE inventory.sales_statuses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer REFERENCES channels.channels(id) ON DELETE RESTRICT,
  product_id integer REFERENCES catalog.products(id) ON DELETE RESTRICT,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  status varchar(10) NOT NULL,
  note varchar(500),
  revision bigint NOT NULL,
  updated_by varchar(100) NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT sales_statuses_one_item_chk
    CHECK ((product_id IS NULL) <> (product_variant_id IS NULL)),
  CONSTRAINT sales_statuses_status_chk
    CHECK (status IN ('selling', 'stopped')),
  CONSTRAINT sales_statuses_all_channels_stop_chk
    CHECK (channel_id IS NOT NULL OR status = 'stopped'),
  CONSTRAINT sales_statuses_note_chk
    CHECK (note IS NULL OR (note = btrim(note) AND note <> '')),
  CONSTRAINT sales_statuses_actor_chk
    CHECK (updated_by = btrim(updated_by) AND updated_by <> ''),
  CONSTRAINT sales_statuses_revision_chk
    CHECK (revision > 0)
);

-- One explicit setting per scope. Channel ids are positive, so 0 stands for
-- "all channels". The leading item column also serves the planner's
-- per-product read.
CREATE UNIQUE INDEX sales_statuses_product_scope_key
  ON inventory.sales_statuses (product_id, (COALESCE(channel_id, 0)))
  WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX sales_statuses_variant_scope_key
  ON inventory.sales_statuses (product_variant_id, (COALESCE(channel_id, 0)))
  WHERE product_variant_id IS NOT NULL;
CREATE INDEX sales_statuses_channel_idx
  ON inventory.sales_statuses (channel_id)
  WHERE channel_id IS NOT NULL;

CREATE FUNCTION inventory.guard_sales_status_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SALES_STATUS_SCOPE_IMMUTABLE';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SALES_STATUS_REVISION_MUST_INCREASE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_statuses_write_guard
BEFORE UPDATE ON inventory.sales_statuses
FOR EACH ROW EXECUTE FUNCTION inventory.guard_sales_status_write();

COMMENT ON TABLE inventory.sales_statuses IS
  'Operator sales status (selling/stopped) per product or SKU, on one channel or on all channels (channel_id NULL). No row means inherit; Stopped publishes 0 and keeps the listing.';
COMMENT ON COLUMN inventory.sales_statuses.channel_id IS
  'NULL: every sales channel. Otherwise an exception for this channel only.';
COMMENT ON COLUMN inventory.sales_statuses.product_id IS
  'Set for a whole-product setting (every SKU, including SKUs added later). NULL for a SKU setting.';
COMMENT ON COLUMN inventory.sales_statuses.product_variant_id IS
  'Set for a SKU setting. NULL for a whole-product setting.';
COMMENT ON COLUMN inventory.sales_statuses.revision IS
  'Version stamp from inventory.sales_status_revision_seq; changes on every write and is never reused.';

CREATE TABLE inventory.sales_status_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key varchar(120) NOT NULL,
  request_hash char(64) NOT NULL,
  channel_id integer,
  -- The item's product when the change was made, for SKU settings too, so a
  -- product's whole history is one index read.
  product_id integer NOT NULL,
  product_variant_id integer,
  before_status varchar(10),
  after_status varchar(10),
  before_revision bigint,
  after_revision bigint,
  note varchar(500),
  actor varchar(100) NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT sales_status_events_status_chk
    CHECK ((before_status IS NULL OR before_status IN ('selling', 'stopped'))
      AND (after_status IS NULL OR after_status IN ('selling', 'stopped'))),
  CONSTRAINT sales_status_events_change_chk
    CHECK (before_status IS DISTINCT FROM after_status),
  CONSTRAINT sales_status_events_revision_pair_chk
    CHECK ((before_status IS NULL) = (before_revision IS NULL)
      AND (after_status IS NULL) = (after_revision IS NULL)),
  CONSTRAINT sales_status_events_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sales_status_events_note_chk
    CHECK (note IS NULL OR (note = btrim(note) AND note <> '')),
  CONSTRAINT sales_status_events_actor_chk
    CHECK (actor = btrim(actor) AND actor <> '')
);

CREATE INDEX sales_status_events_product_idx
  ON inventory.sales_status_events (product_id, occurred_at DESC);
CREATE INDEX sales_status_events_variant_idx
  ON inventory.sales_status_events (product_variant_id, occurred_at DESC)
  WHERE product_variant_id IS NOT NULL;
CREATE INDEX sales_status_events_key_idx
  ON inventory.sales_status_events (idempotency_key);

CREATE FUNCTION inventory.guard_sales_status_event_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SALES_STATUS_HISTORY_IMMUTABLE';
END;
$$;

CREATE TRIGGER sales_status_events_immutable
BEFORE UPDATE OR DELETE ON inventory.sales_status_events
FOR EACH ROW EXECUTE FUNCTION inventory.guard_sales_status_event_history();

CREATE TRIGGER sales_status_events_truncate_immutable
BEFORE TRUNCATE ON inventory.sales_status_events
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_sales_status_event_history();

COMMENT ON TABLE inventory.sales_status_events IS
  'Append-only history of sales status changes: one row per changed scope with before/after status and revision, actor, time, note and command key.';
