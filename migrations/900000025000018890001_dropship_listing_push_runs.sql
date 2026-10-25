-- dropship_listing_push_runs: batch publishing for Catalog step 3 (step 1
-- plan S2-5, PR A, stage 2), and the process heartbeats later releases read.
--
-- A run is one vendor press of "Publish": the server's own snapshot of the
-- vendor's selection on one store (never a client list), up to 10,000 sizes,
-- sent 500 at a time. Each target is one size of the run with the chunk it
-- belongs to and what became of it. The existing push sweep expands one chunk
-- of a run at a time into an ordinary listing push job (run_id and
-- run_chunk_index name the chunk the job carries out) and copies each job
-- item's outcome back to its target. A job also learns when it may next be
-- tried (next_attempt_at) and how many times in a row it paused because eBay
-- was busy or not answering (consecutive_pause_count).
--
-- The process heartbeats record which catalog code version every running
-- process runs, on the database clock; the catalog code versions record when
-- each version first ran. Nothing in this release reads them for a decision:
-- later releases wait on them so that old and new code never decide the same
-- thing two ways during a deploy.
--
-- A finished run also records when its one notice step was done, so a
-- process that dies between the finish and its email leaves the email for a
-- later sweep instead of losing it.
--
-- Nothing changes for live data: four tables are new and start empty; the
-- push jobs gain three nullable columns and one with a constant default, so
-- every existing job reads exactly as before (no run, no backoff, no pauses).
-- No stock or selection reader reads any of this, and no table here is in the
-- publication selection manifest (0743): adding columns to the push jobs fires
-- no publication trigger, which fires only on UPDATE OF vendor_id,
-- store_connection_id or status.
--
-- Lock order. The first statement takes ACCESS EXCLUSIVE on the push jobs,
-- which the ALTER TABLE needs anyway; taking it first means no weaker lock on
-- that table is ever upgraded inside this file. Then, in statement order, the
-- new foreign keys take SHARE ROW EXCLUSIVE on the vendors, the store
-- connections, the vendor selection revisions, the Card Shellz sizes
-- (catalog.product_variants) and the push job items until commit. Those
-- conflict only with writes to those tables; references from other writers
-- (foreign key checks, FOR SHARE reads) are compatible. The code that serves
-- while this file runs (the previous release) either writes job items alone or
-- locks the job first (claim and stale recovery, finalize, job creation, the
-- staff retry), so no transaction of it holds an item lock while it waits for
-- the jobs this file already holds. A writer of the Card Shellz sizes that then
-- reads the push jobs in the same transaction could deadlock with this file;
-- none was found (INSUFFICIENT EVIDENCE that none exists), and the executor
-- retries a lock timeout or a deadlock (migration-executor.ts), each attempt
-- holding the jobs lock at most its 15 s lock timeout while it waits.
--
-- Time under the jobs lock is kept to what cannot be avoided: the three new
-- job CHECKs are added NOT VALID, so they need no scan of the jobs table
-- (every existing job has the new columns NULL or 0, which they hold for by
-- construction) and still check every row written from here on; only the
-- partial unique index reads the table (measured locally on 3,000,000 rows:
-- the ALTER 386 ms with valid CHECKs, 1.4 ms NOT VALID; the index 240 ms).
--
-- This file is applied once by the release runner, in one transaction; it is
-- not written to be re-run (the runner never re-runs an applied file and rolls
-- back a failed one whole).

LOCK TABLE dropship.dropship_listing_push_jobs IN ACCESS EXCLUSIVE MODE;

CREATE TABLE dropship.dropship_listing_push_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer NOT NULL,
  -- 'not_live': only the selected sizes not live on this store; 'all': every selected size.
  scope varchar(20) NOT NULL
    CONSTRAINT dropship_push_run_scope_chk CHECK (scope IN ('not_live', 'all')),
  status varchar(20) NOT NULL
    CONSTRAINT dropship_push_run_status_chk CHECK (status IN ('processing', 'completed', 'partial', 'failed', 'cancelled')),
  stop_reason varchar(30)
    CONSTRAINT dropship_push_run_stop_reason_chk CHECK (stop_reason IS NULL OR stop_reason IN ('vendor_stop', 'provider_unavailable')),
  -- The vendor's selection revision the snapshot was taken at; null when the vendor never saved a selection.
  selection_revision_id integer REFERENCES dropship.dropship_vendor_selection_rule_set_revisions(id),
  idempotency_key varchar(200) NOT NULL
    CONSTRAINT dropship_push_run_key_chk CHECK (btrim(idempotency_key) <> ''),
  request_hash varchar(64) NOT NULL
    CONSTRAINT dropship_push_run_hash_chk CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  target_count integer NOT NULL
    CONSTRAINT dropship_push_run_target_count_chk CHECK (target_count BETWEEN 1 AND 10000),
  chunk_size integer NOT NULL
    CONSTRAINT dropship_push_run_chunk_size_chk CHECK (chunk_size BETWEEN 1 AND 500),
  chunk_count integer NOT NULL
    CONSTRAINT dropship_push_run_chunk_count_chk CHECK (chunk_count >= 1),
  next_chunk_index integer NOT NULL DEFAULT 0
    CONSTRAINT dropship_push_run_next_chunk_chk CHECK (next_chunk_index >= 0),
  chunk_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT dropship_push_run_chunk_attempts_chk CHECK (chunk_attempts >= 0),
  actor_type varchar(20) NOT NULL
    CONSTRAINT dropship_push_run_actor_type_chk CHECK (actor_type IN ('vendor', 'admin', 'system')),
  actor_id varchar(255),
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  -- When the finish's notice step was done (sent, or not needed); a finished run without it is picked up again.
  notified_at timestamptz,
  CONSTRAINT dropship_push_run_vendor_key UNIQUE (vendor_id, idempotency_key),
  CONSTRAINT dropship_push_run_store_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id),
  -- Every chunk holds chunk_size targets except the last: the count follows from the two.
  CONSTRAINT dropship_push_run_chunk_math_chk
    CHECK (chunk_count = (target_count + chunk_size - 1) / chunk_size AND next_chunk_index <= chunk_count),
  CONSTRAINT dropship_push_run_finished_chk
    CHECK ((status IN ('completed', 'partial', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  -- Only a stop cancels a run, and a stop always names why.
  CONSTRAINT dropship_push_run_cancel_chk
    CHECK ((status <> 'cancelled' OR cancel_requested_at IS NOT NULL)
      AND (cancel_requested_at IS NULL OR stop_reason IS NOT NULL)),
  -- Only a finished run has had its notice step.
  CONSTRAINT dropship_push_run_notified_chk CHECK (notified_at IS NULL OR completed_at IS NOT NULL)
);
-- One unfinished publish per store: a second press is refused, never doubled.
CREATE UNIQUE INDEX dropship_push_run_one_active_idx
  ON dropship.dropship_listing_push_runs(store_connection_id)
  WHERE status = 'processing';
CREATE INDEX dropship_push_run_vendor_store_idx
  ON dropship.dropship_listing_push_runs(vendor_id, store_connection_id, id DESC);
-- Finished runs whose notice step is still to do: a handful at most, read every sweep.
CREATE INDEX dropship_push_run_notice_pending_idx
  ON dropship.dropship_listing_push_runs(completed_at)
  WHERE notified_at IS NULL AND status <> 'processing';

ALTER TABLE dropship.dropship_listing_push_jobs
  ADD COLUMN run_id bigint REFERENCES dropship.dropship_listing_push_runs(id),
  ADD COLUMN run_chunk_index integer,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN consecutive_pause_count integer NOT NULL DEFAULT 0,
  -- NOT VALID: no scan under the lock (see the header); new rows are checked.
  ADD CONSTRAINT dropship_listing_job_run_chunk_chk CHECK (run_chunk_index IS NULL OR run_chunk_index >= 0) NOT VALID,
  ADD CONSTRAINT dropship_listing_job_pause_count_chk CHECK (consecutive_pause_count >= 0) NOT VALID,
  ADD CONSTRAINT dropship_listing_job_run_pair_chk CHECK ((run_id IS NULL) = (run_chunk_index IS NULL)) NOT VALID;
-- A chunk is carried out by at most one job; the sweep adopts a chunk's job by this pair, never by its key.
CREATE UNIQUE INDEX dropship_listing_job_run_chunk_idx
  ON dropship.dropship_listing_push_jobs(run_id, run_chunk_index)
  WHERE run_id IS NOT NULL;

CREATE TABLE dropship.dropship_listing_push_run_targets (
  run_id bigint NOT NULL REFERENCES dropship.dropship_listing_push_runs(id),
  -- A size Card Shellz deletes takes its targets with it (a target is history of a press, never a reason to keep a
  -- size); a size with a pushed job item cannot be deleted anyway (the job item's own foreign key).
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL
    CONSTRAINT dropship_push_run_target_chunk_chk CHECK (chunk_index >= 0),
  outcome varchar(20) NOT NULL
    CONSTRAINT dropship_push_run_target_outcome_chk CHECK (outcome IN
      ('pending', 'queued', 'completed', 'failed', 'blocked', 'skipped', 'price_review', 'stale', 'cancelled')),
  code varchar(100),
  retryable boolean,
  job_id integer REFERENCES dropship.dropship_listing_push_jobs(id),
  job_item_id integer REFERENCES dropship.dropship_listing_push_job_items(id),
  decided_at timestamptz,
  PRIMARY KEY (run_id, product_variant_id),
  CONSTRAINT dropship_push_run_target_decided_chk CHECK ((outcome = 'pending') = (decided_at IS NULL)),
  CONSTRAINT dropship_push_run_target_job_chk CHECK (job_item_id IS NULL OR job_id IS NOT NULL)
);
CREATE INDEX dropship_push_run_target_chunk_idx
  ON dropship.dropship_listing_push_run_targets(run_id, chunk_index, outcome);
CREATE INDEX dropship_push_run_target_item_idx
  ON dropship.dropship_listing_push_run_targets(job_item_id)
  WHERE job_item_id IS NOT NULL;

-- Process heartbeats: one row per running process, written on the database clock.
CREATE TABLE dropship.dropship_process_heartbeats (
  process_key varchar(200) PRIMARY KEY
    CONSTRAINT dropship_process_heartbeat_key_chk CHECK (btrim(process_key) <> ''),
  catalog_code_version integer NOT NULL
    CONSTRAINT dropship_process_heartbeat_version_chk CHECK (catalog_code_version >= 1),
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX dropship_process_heartbeats_version_idx
  ON dropship.dropship_process_heartbeats(catalog_code_version, last_seen_at);

-- When each catalog code version first ran: one row per version, never deleted.
CREATE TABLE dropship.dropship_catalog_code_versions (
  catalog_code_version integer PRIMARY KEY
    CONSTRAINT dropship_catalog_code_version_chk CHECK (catalog_code_version >= 1),
  first_seen_at timestamptz NOT NULL
);
