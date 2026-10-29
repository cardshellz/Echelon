-- quantity_catchup_parking: catch-up retry classes and parking (Channels PR5,
-- PLAN-CH-v3 section 6 "Catch-up", M2).
--
-- inventory.quantity_publication_catchup (237) gains how its last failure was
-- classified, so the worker stops retrying every minute:
--   * parked: the stock update waits for a stock link (missing-link refusal).
--     It is re-checked once a day; a new link of the same item wakes it.
--   * paused: a lock or fence was busy; no attempt is counted.
--   * transient: attempt_count grows and the delay doubles (1 minute .. 1 hour).
--   * permanent: requires_review_at is set and the worker never retries it; a
--     newer stock event for the item (a new revision) starts it afresh.
-- Columns are nullable or defaulted: every existing row reads as "no failure
-- class yet, zero attempts", which is today's behaviour.
--
-- The due index is replaced by one that leaves review rows out (listDue never
-- reads them). Parked rows stay in it: their next_attempt_at is the daily
-- re-check. The table holds pending catch-up work only (its row count is
-- INSUFFICIENT EVIDENCE but bounded by distinct provider items), so the index
-- is built in this transaction, not CONCURRENTLY.
--
-- No UPDATE, INSERT or DELETE of live rows. Applied once by the release runner.

ALTER TABLE inventory.quantity_publication_catchup
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT quantity_publication_catchup_attempt_count_chk CHECK (attempt_count >= 0),
  ADD COLUMN failure_class text
    CONSTRAINT quantity_publication_catchup_failure_class_chk
    CHECK (failure_class IN ('paused', 'transient', 'permanent', 'parked')),
  ADD COLUMN parked_at timestamptz,
  ADD COLUMN parked_code text
    CONSTRAINT quantity_publication_catchup_parked_code_chk CHECK (char_length(parked_code) BETWEEN 1 AND 200),
  ADD COLUMN requires_review_at timestamptz,
  ADD CONSTRAINT quantity_publication_catchup_parked_pair_chk
    CHECK ((parked_at IS NULL) = (parked_code IS NULL)),
  ADD CONSTRAINT quantity_publication_catchup_parked_class_chk
    CHECK ((failure_class IS NOT DISTINCT FROM 'parked') = (parked_at IS NOT NULL)),
  ADD CONSTRAINT quantity_publication_catchup_review_class_chk
    CHECK ((failure_class IS NOT DISTINCT FROM 'permanent') = (requires_review_at IS NOT NULL));

CREATE INDEX quantity_publication_catchup_due_unreviewed
  ON inventory.quantity_publication_catchup (next_attempt_at, id)
  WHERE completed_revision < revision AND requires_review_at IS NULL;

DROP INDEX inventory.quantity_publication_catchup_due;
