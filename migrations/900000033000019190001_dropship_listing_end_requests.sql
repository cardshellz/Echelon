-- dropship_listing_end_requests: the eBay listings Card Shellz ends because a
-- vendor removed their sizes in Catalog step 1 (PR C, PLAN-C v4.1 §3).
--
-- One row per end of one listing (one size on one store). The step 1 save is
-- the only inserter: it records the request in the transaction that removes
-- the vendor's picks. The end worker claims a 'pending' row ('ending'), ends
-- the listing on eBay and finishes it ('ended'), or stops it for review
-- ('failed', still open: stock 0 and pushes fenced until staff retry or
-- resolve it). A re-pick before the claim supersedes it ('superseded'); staff
-- close a failed one ('resolved' or 'ended'). Each state change and staff
-- action bumps version and writes a dropship_audit_events row in the same
-- transaction; the worker's side writes (withdraw fields, deferrals) change no
-- state and leave version as it is.
--
-- No foreign key to the catalog (FID-6): a key check takes FOR KEY SHARE on
-- the catalog row, which waits on retirement's FOR UPDATE held across eBay
-- calls. The listing key pins the size (a listed size cannot be deleted, 0086),
-- and a statement trigger proves the size and the product against the listing
-- and the catalog with plain reads. Vendor, store and listing keys cascade,
-- because those rows cascade today (0086) and a NO ACTION key here would block
-- those cascades.
--
-- Stock reads open ends, so a state change re-plans the product: one
-- statement-level UPDATE trigger, for state changes only (FID-7). There is no
-- INSERT invalidation: every end a save inserts belongs to a product whose
-- pick the same transaction deletes, and the picks' DELETE statement trigger
-- already re-plans it (*_dropship_vendor_selected_variants.sql). No selection
-- gate either, like the listings (0743's manifest leaves them ungated).
--
-- Locks. The table is new and empty, so its indexes build at once. Its foreign
-- keys take SHARE ROW EXCLUSIVE on the referenced tables until commit, in
-- column order (vendors, listings, selection revisions), then the store owner
-- key (store connections): writers of those tables wait for this file, which
-- waits at most the executor's lock timeout per attempt and retries a lock
-- timeout or a deadlock (migration-executor.ts). Readers and FOR SHARE /
-- FOR UPDATE lockers are not blocked.
--
-- Nothing changes for live data: no UPDATE, INSERT or DELETE, and no statement
-- raises by design; only the consistency and identity triggers raise, on bad
-- rows written later. This file is applied once by the release runner, in one
-- transaction; it is not written to be re-run (the runner never re-runs an
-- applied file and rolls back a failed one whole).

CREATE TABLE dropship.dropship_listing_end_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL
    CONSTRAINT dropship_end_vendor_fk REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL,
  listing_id integer NOT NULL
    CONSTRAINT dropship_end_listing_fk REFERENCES dropship.dropship_vendor_listings(id) ON DELETE CASCADE,
  -- No catalog key (above): the listing key pins the size, the consistency trigger proves both ids.
  product_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  selection_revision_id integer NOT NULL
    CONSTRAINT dropship_end_revision_fk REFERENCES dropship.dropship_vendor_selection_rule_set_revisions(id),
  reason varchar(30) NOT NULL
    CONSTRAINT dropship_end_reason_chk CHECK (reason IN ('size_removed', 'product_removed')),
  state varchar(20) NOT NULL
    CONSTRAINT dropship_end_state_chk CHECK (state IN ('pending', 'ending', 'ended', 'failed', 'superseded', 'resolved')),
  -- At the save: { externalListingId, externalOfferId, externalAccountId, providerEnvironment } (ids may be null).
  requested_identity jsonb NOT NULL
    CONSTRAINT dropship_end_requested_identity_chk CHECK (jsonb_typeof(requested_identity) = 'object'),
  -- At the claim: the listing member identity the retirement view builds, plus the store's facts.
  resolved_identity jsonb
    CONSTRAINT dropship_end_resolved_identity_chk CHECK (resolved_identity IS NULL OR jsonb_typeof(resolved_identity) = 'object'),
  code varchar(100),
  message text,
  -- Structured error context (CLAUDE.md §6): lastCode, attemptIds, evidence, requiresReview, parse errors.
  context jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT dropship_end_context_chk CHECK (jsonb_typeof(context) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT dropship_end_attempt_count_chk CHECK (attempt_count >= 0),
  deferral_count integer NOT NULL DEFAULT 0
    CONSTRAINT dropship_end_deferral_count_chk CHECK (deferral_count >= 0),
  next_attempt_at timestamptz,
  withdraw_call_count integer NOT NULL DEFAULT 0
    CONSTRAINT dropship_end_withdraw_call_count_chk CHECK (withdraw_call_count BETWEEN 0 AND 3),
  withdraw_requested_at timestamptz,
  withdraw_returned_at timestamptz,
  withdraw_outcome varchar(60),
  decided_at timestamptz,
  ended_at timestamptz,
  staff_action varchar(20)
    CONSTRAINT dropship_end_staff_action_chk CHECK (staff_action IS NULL OR staff_action IN ('retry', 'resolve_ended', 'resolve_left')),
  staff_action_key varchar(200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1
    CONSTRAINT dropship_end_version_chk CHECK (version > 0),
  CONSTRAINT dropship_end_store_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id) ON DELETE CASCADE,
  CONSTRAINT dropship_end_ended_at_chk CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  -- pending/ending are the worker's; every other state is never picked up by it (no retry of permanent failures, CLAUDE.md §6).
  CONSTRAINT dropship_end_due_chk CHECK ((state IN ('pending', 'ending')) = (next_attempt_at IS NOT NULL)),
  CONSTRAINT dropship_end_decided_chk CHECK ((state IN ('ended', 'failed', 'superseded', 'resolved')) = (decided_at IS NOT NULL)),
  -- A new withdraw call resets returned_at/outcome, so "requested, not returned" always means the newest call.
  CONSTRAINT dropship_end_withdraw_chk CHECK (withdraw_returned_at IS NULL
    OR (withdraw_requested_at IS NOT NULL AND withdraw_returned_at >= withdraw_requested_at)),
  CONSTRAINT dropship_end_ending_identity_chk CHECK (state <> 'ending' OR resolved_identity IS NOT NULL),
  -- A staff key is stored with the action it answered, so a key is never replayed for another action (TST-5).
  CONSTRAINT dropship_end_staff_key_chk CHECK ((staff_action IS NULL) = (staff_action_key IS NULL))
);
-- One open end per listing; a failed end stays open (stock 0, pushes fenced) until staff retry or resolve it.
CREATE UNIQUE INDEX dropship_end_one_open_idx ON dropship.dropship_listing_end_requests (listing_id)
  WHERE state IN ('pending', 'ending', 'failed');
-- The worker's due rows.
CREATE INDEX dropship_end_due_idx ON dropship.dropship_listing_end_requests (next_attempt_at, id)
  WHERE next_attempt_at IS NOT NULL;
-- The save's supersede lookup (open ends of the products it re-adds).
CREATE INDEX dropship_end_vendor_product_open_idx ON dropship.dropship_listing_end_requests (vendor_id, product_id)
  WHERE state IN ('pending', 'ending', 'failed');
-- Breakers and the canary (decided ends per store, newest first).
CREATE INDEX dropship_end_store_decided_idx ON dropship.dropship_listing_end_requests (store_connection_id, decided_at DESC)
  WHERE state IN ('ended', 'failed');
-- Withdraw caps (per store and global, last hour).
CREATE INDEX dropship_end_withdraw_started_idx ON dropship.dropship_listing_end_requests (store_connection_id, withdraw_requested_at)
  WHERE withdraw_requested_at IS NOT NULL;
-- The fence's "ended since this item was queued" read.
CREATE INDEX dropship_end_listing_ended_idx ON dropship.dropship_listing_end_requests (listing_id, ended_at DESC)
  WHERE state = 'ended';
-- Staff list.
CREATE INDEX dropship_end_state_idx ON dropship.dropship_listing_end_requests (state, id);

-- Identity: what was asked, for which listing and why, never changes. The trigger fires only when an UPDATE names one
-- of these columns and changes its value, so a state change pays nothing for it.
CREATE FUNCTION dropship.refuse_listing_end_request_identity_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'DROPSHIP_LISTING_END_REQUEST_IDENTITY_IMMUTABLE';
END;
$$;
CREATE TRIGGER listing_end_request_identity_immutable
  BEFORE UPDATE OF vendor_id, store_connection_id, listing_id, product_id, product_variant_id, selection_revision_id, reason,
    requested_identity, created_at
  ON dropship.dropship_listing_end_requests FOR EACH ROW
  WHEN (OLD.vendor_id IS DISTINCT FROM NEW.vendor_id OR OLD.store_connection_id IS DISTINCT FROM NEW.store_connection_id
    OR OLD.listing_id IS DISTINCT FROM NEW.listing_id OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.product_variant_id IS DISTINCT FROM NEW.product_variant_id
    OR OLD.selection_revision_id IS DISTINCT FROM NEW.selection_revision_id OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.requested_identity IS DISTINCT FROM NEW.requested_identity OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION dropship.refuse_listing_end_request_identity_change();

-- Consistency (replaces the two catalog keys): once per INSERT statement, refuse (23514) any new row whose listing belongs to
-- another vendor, store or size, or whose size belongs to another product. Plain reads: no row locks.
CREATE FUNCTION dropship.check_listing_end_request_rows() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_ends n
      JOIN dropship.dropship_vendor_listings l ON l.id = n.listing_id
      LEFT JOIN catalog.product_variants v ON v.id = n.product_variant_id
      WHERE l.vendor_id <> n.vendor_id OR l.store_connection_id <> n.store_connection_id
        OR l.product_variant_id <> n.product_variant_id OR v.id IS NULL OR v.product_id <> n.product_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DROPSHIP_LISTING_END_REQUEST_INCONSISTENT';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER listing_end_request_consistency
  AFTER INSERT ON dropship.dropship_listing_end_requests REFERENCING NEW TABLE AS new_ends
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.check_listing_end_request_rows();

-- Stock reads open ends (§7), so a state change re-plans the product. Once per UPDATE statement, only for rows whose state
-- changed (a save can supersede thousands; PR B measured ~0.45 ms per row of per-row invalidation). PostgreSQL does not
-- allow transition tables on a trigger with a column list, hence the join on OLD/NEW instead of UPDATE OF state; the
-- worker's side writes change no state and re-plan nothing.
CREATE FUNCTION dropship.invalidate_listing_end_state_changes() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE affected integer;
BEGIN
  FOR affected IN SELECT DISTINCT n.product_id FROM new_ends n JOIN old_ends o ON o.id = n.id
      WHERE o.state IS DISTINCT FROM n.state ORDER BY n.product_id
  LOOP PERFORM inventory.invalidate_publication_selection_product(affected); END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER publication_selection_invalidation
  AFTER UPDATE ON dropship.dropship_listing_end_requests REFERENCING OLD TABLE AS old_ends NEW TABLE AS new_ends
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.invalidate_listing_end_state_changes();
