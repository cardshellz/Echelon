-- stock_links: the shared stock-link engine's operational state (Channels PR2,
-- PLAN-CH2 v4.1 §3). Inventory-planning owns both tables; nothing else writes them.
--
-- inventory.stock_link_checks: one row per (destination, size) the engine looks
-- after: is it linked, waiting for a store item, flagged for a person, or stopped
-- on an error; when to look again; who holds it now (lease). It is operational
-- state, not history: who linked what and why lives in public.audit_events and
-- the append-only mapping versions, so deleting a size deletes its check rows
-- (ON DELETE CASCADE, unlike 0633's RESTRICT on the mapping tables).
--
-- inventory.stock_link_destinations: one row per destination: the audited
-- automatic-link switch, the pause / halt / retire-hold state, the discovery
-- cursors and the runner heartbeat. recent_cursor_raw keeps the feed's own
-- zone-less channel_feeds.updated_at value as read; it is only ever compared
-- with that column, never with a clock (TST-8).
--
-- Neither table joins the cutover fence manifest: they are not semantic
-- inventory configuration, and the runner writes heartbeats without the fence.
-- No mapping, outbox or catch-up table changes here.
--
-- Locks. Both tables are new and empty, so their indexes build at once. Their
-- foreign keys take SHARE ROW EXCLUSIVE on inventory.inventory_publication_targets
-- and catalog.product_variants until commit: writers of those tables wait for
-- this file, which waits at most the executor's lock timeout per attempt and
-- retries a lock timeout or a deadlock (migrations/migration-executor.ts).
-- Readers and FOR SHARE / FOR UPDATE lockers are not blocked.
--
-- Nothing changes for live data: no UPDATE, INSERT or DELETE, and no statement
-- raises by design. Applied once by the release runner, in one transaction; it
-- is not written to be re-run.

CREATE TABLE inventory.stock_link_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id integer NOT NULL
    CONSTRAINT stock_link_checks_target_fk REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL
    CONSTRAINT stock_link_checks_variant_fk REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL
    CONSTRAINT stock_link_checks_status_chk CHECK (status IN ('waiting', 'linked', 'flagged', 'error')),
  reason_code varchar(120)
    CONSTRAINT stock_link_checks_reason_code_chk CHECK (reason_code IS NULL OR (reason_code = btrim(reason_code) AND reason_code <> '')),
  error_class varchar(16)
    CONSTRAINT stock_link_checks_error_class_chk CHECK (error_class IN ('transient', 'permanent', 'fatal')),
  message varchar(1000),
  attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT stock_link_checks_attempt_count_chk CHECK (attempt_count >= 0),
  -- Start of the current transient-failure streak.
  first_failure_at timestamptz,
  -- Start of the current busy streak (a busy outcome counts no attempt) [v4.1 TST-9].
  busy_since timestamptz,
  -- When to look again; NULL only while the row is stopped on an error (Check again clears it).
  next_check_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  -- The store item a WAITING_FOR_FREED_ITEM or F4 row waits on; the freeing command wakes it [v4.1 SAF-5].
  waiting_item_id varchar(240),
  -- The store SKU last seen on the linked item (V6 grandfathering). Never set from a SKU over 100 characters [v4.1 TST-12].
  observed_sku varchar(100),
  revision bigint NOT NULL DEFAULT 1
    CONSTRAINT stock_link_checks_revision_chk CHECK (revision >= 1),
  -- Written by the engine from its injected clock; no database default.
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT stock_link_checks_pair_uq UNIQUE (publication_target_id, product_variant_id),
  CONSTRAINT stock_link_checks_lease_chk CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT stock_link_checks_next_chk CHECK ((status = 'error') = (next_check_at IS NULL)),
  CONSTRAINT stock_link_checks_reason_chk CHECK (status NOT IN ('flagged', 'error') OR reason_code IS NOT NULL)
);

-- The runner's due scan, per destination (rows stopped on an error are never due).
CREATE INDEX stock_link_checks_due_idx ON inventory.stock_link_checks (publication_target_id, next_check_at, id)
  WHERE status <> 'error';
-- The freed-item wake: the rows of a destination waiting on one store item.
CREATE INDEX stock_link_checks_waiting_item_idx ON inventory.stock_link_checks (publication_target_id, waiting_item_id)
  WHERE waiting_item_id IS NOT NULL;
-- The variant key's cascade finds a deleted size's rows by size (the pair key leads
-- with the destination); same reason as inventory_publication_target_variant_holds_variant_idx.
CREATE INDEX stock_link_checks_variant_idx ON inventory.stock_link_checks (product_variant_id);

CREATE TABLE inventory.stock_link_destinations (
  publication_target_id integer PRIMARY KEY
    CONSTRAINT stock_link_destinations_target_fk REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  -- The per-store switch for automatic linking (on unless a person turned it off).
  auto_link_enabled boolean NOT NULL DEFAULT true,
  -- A destination-wide pause (store refused the login, store frozen, store not answering): all or none.
  paused_until timestamptz,
  paused_code varchar(120),
  paused_since timestamptz,
  -- A destination-wide halt on a fatal error, until Check again: both or neither.
  halted_at timestamptz,
  halted_code varchar(120),
  -- A person's Continue after the daily retire hold: both or neither.
  retires_released_at timestamptz,
  retires_released_by varchar(100),
  -- Discovery cursor: the raw zone-less channel_feeds.updated_at value and feed id last read [v4.1 TST-8].
  recent_cursor_raw timestamp,
  recent_cursor_id bigint,
  sweep_cursor_variant_id integer,
  dead_letter_cursor_at timestamptz,
  heartbeat_at timestamptz,
  revision bigint NOT NULL DEFAULT 1
    CONSTRAINT stock_link_destinations_revision_chk CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT stock_link_destinations_pause_chk CHECK (
    (paused_until IS NULL AND paused_code IS NULL AND paused_since IS NULL)
    OR (paused_until IS NOT NULL AND paused_code IS NOT NULL AND paused_code = btrim(paused_code) AND paused_code <> ''
      AND paused_since IS NOT NULL)),
  CONSTRAINT stock_link_destinations_halt_chk CHECK (
    (halted_at IS NULL AND halted_code IS NULL)
    OR (halted_at IS NOT NULL AND halted_code IS NOT NULL AND halted_code = btrim(halted_code) AND halted_code <> '')),
  CONSTRAINT stock_link_destinations_release_chk CHECK (
    (retires_released_at IS NULL AND retires_released_by IS NULL)
    OR (retires_released_at IS NOT NULL AND retires_released_by IS NOT NULL
      AND retires_released_by = btrim(retires_released_by) AND retires_released_by <> ''))
);
