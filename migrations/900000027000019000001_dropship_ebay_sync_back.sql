-- dropship_ebay_sync_back: what Card Shellz learns from a vendor's live eBay
-- listings, and the order fixes that ride with it (sync-back plan v4, §8).
--
-- Listings (dropship_vendor_listings) gain the sync state: when each was last
-- read from eBay, a set of open issue codes, when the vendor ended it on eBay,
-- the shipping policy eBay shows, and the quantity state. Echelon publishes
-- its ATP as today; a lower number the vendor sets on eBay, that sales cannot
-- explain, becomes the listing's vendor limit (vendor_quantity_limit), and
-- every later publish sends min(ATP, that limit). A number at ATP or above
-- clears it. The limit baseline and the saved observation are the inputs to
-- that decision. Nothing here stores a vendor's eBay title or description.
--
-- New tables, all empty: the sales ledger (every order line eBay showed on a
-- known listing, paid or not, so a sale is never read as a vendor lowering),
-- the item numbers a listing had before a relist, order lines parked on an
-- unknown item number, the per-store verdicts on live shipping policies, and
-- the vendor notice outbox (rows written in the transaction that made the
-- change, sent later with the batch key as the notification's idempotency key).
-- The store connections gain when the sales ledger started; the order intake
-- gains the bounded retry state and the marketplace cancellation facts.
--
-- One trigger changes: the publication selection invalidation on the listings
-- (0743) is recreated with vendor_quantity_limit in its watched columns, so
-- inventory planning re-plans a product when its limit changes. Its function
-- and every other watched column are unchanged.
--
-- Nothing changes for live data: there is no UPDATE, INSERT or DELETE. Every
-- new column is NULL or a constant default (an empty issue set, an attempt
-- count of 0), so every existing row reads as before: no limit, no observation,
-- no issue, never read from eBay. CHECKs on columns added to existing tables
-- are NOT VALID: every existing row holds them by construction (the columns are
-- new and NULL or default), so no table is scanned under its lock to prove it,
-- and they still check every row written from here on.
--
-- Lock order. The first statement takes ACCESS EXCLUSIVE on the three existing
-- tables this file alters, in the order the code that serves meanwhile (the
-- previous release) reaches them: store connection rows first (FOR SHARE in
-- the price, content and settings writers), then listings, then order intake.
-- Every ALTER, index, trigger and foreign key on them below needs at most that
-- lock, so no lock is upgraded inside the file. The new foreign keys reference
-- only those tables. A transaction of the previous release that holds a later
-- table and waits for an earlier one could still deadlock with this file; the
-- executor retries a deadlock or a lock timeout (migration-executor.ts), each
-- attempt waiting at most its lock timeout. While the locks are held, the
-- partial and GIN indexes and the two order intake indexes each read their
-- table once (INSUFFICIENT EVIDENCE of the production row counts; every new
-- partial index matches no row today).
--
-- This file is applied once by the release runner, in one transaction; it is
-- not written to be re-run (the runner never re-runs an applied file and rolls
-- back a failed one whole).

LOCK TABLE dropship.dropship_store_connections, dropship.dropship_vendor_listings,
  dropship.dropship_order_intake IN ACCESS EXCLUSIVE MODE;

-- Listings: sync state. Reused, already present: observed_marketplace_price_cents,
-- last_marketplace_sync_at, drift_detected_at.
ALTER TABLE dropship.dropship_vendor_listings
  -- NULL = due now: the sweep reads due listings first.
  ADD COLUMN marketplace_sync_attempted_at timestamptz,
  ADD COLUMN marketplace_issue_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN marketplace_ended_at timestamptz,
  ADD COLUMN observed_fulfillment_policy_id varchar(100),
  ADD COLUMN vendor_quantity_limit integer,
  ADD COLUMN marketplace_quantity_baseline integer,
  ADD COLUMN marketplace_quantity_baseline_at timestamptz,
  ADD COLUMN observed_marketplace_quantity integer,
  ADD COLUMN observed_marketplace_quantity_at timestamptz,
  ADD CONSTRAINT dropship_listing_marketplace_issue_codes_chk
    CHECK (marketplace_issue_codes <@ ARRAY['sku_changed','offer_missing','variation_listing_unsupported',
      'observation_unreadable','ended_out_of_stock','relisted_after_end','price_outside_card_shellz_limit',
      'quantity_restore_blocked','sync_requires_review']::text[]) NOT VALID,
  ADD CONSTRAINT dropship_listing_observed_policy_chk
    CHECK (observed_fulfillment_policy_id IS NULL OR btrim(observed_fulfillment_policy_id) <> '') NOT VALID,
  ADD CONSTRAINT dropship_listing_vendor_quantity_limit_chk
    CHECK (vendor_quantity_limit IS NULL OR vendor_quantity_limit >= 0) NOT VALID,
  ADD CONSTRAINT dropship_listing_qty_baseline_chk
    CHECK (marketplace_quantity_baseline IS NULL OR marketplace_quantity_baseline >= 0) NOT VALID,
  ADD CONSTRAINT dropship_listing_qty_baseline_pair_chk
    CHECK ((marketplace_quantity_baseline IS NULL) = (marketplace_quantity_baseline_at IS NULL)) NOT VALID,
  ADD CONSTRAINT dropship_listing_qty_observed_chk
    CHECK (observed_marketplace_quantity IS NULL OR observed_marketplace_quantity >= 0) NOT VALID,
  ADD CONSTRAINT dropship_listing_qty_observed_pair_chk
    CHECK ((observed_marketplace_quantity IS NULL) = (observed_marketplace_quantity_at IS NULL)) NOT VALID;
COMMENT ON COLUMN dropship.dropship_vendor_listings.vendor_quantity_limit IS
  'The number the vendor set on eBay, kept as this listing''s limit. Publishes send min(ATP, this); cleared when the vendor sets ATP or more.';
CREATE INDEX dropship_listing_marketplace_sync_due_idx ON dropship.dropship_vendor_listings
  (store_connection_id, marketplace_sync_attempted_at NULLS FIRST, id)
  WHERE platform = 'ebay' AND external_offer_id IS NOT NULL;
CREATE INDEX dropship_listing_marketplace_issues_idx ON dropship.dropship_vendor_listings
  USING gin (marketplace_issue_codes) WHERE marketplace_issue_codes <> '{}';

-- Inventory planning must re-plan when a limit changes (0743 lists the watched columns).
DROP TRIGGER publication_selection_invalidation ON dropship.dropship_vendor_listings;
CREATE TRIGGER publication_selection_invalidation
  AFTER INSERT OR DELETE OR UPDATE OF vendor_id, store_connection_id, product_variant_id, status,
    external_listing_id, external_offer_id, vendor_quantity_limit
  ON dropship.dropship_vendor_listings FOR EACH ROW
  EXECUTE FUNCTION inventory.notify_publication_selection_change('variant',
    'vendor_id,store_connection_id,product_variant_id,status,external_listing_id,external_offer_id,vendor_quantity_limit');

-- When the order poll's sales ledger started for the store (set once, by the
-- first poll success of this release). Quantity decisions need a baseline the
-- ledger has covered.
ALTER TABLE dropship.dropship_store_connections
  ADD COLUMN marketplace_sales_ledger_since timestamptz;

-- Every order line eBay showed on a known listing, paid or not. The store comes
-- from the listing's own row when written.
CREATE TABLE dropship.dropship_listing_marketplace_sales (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id) ON DELETE CASCADE,
  external_order_id varchar(255) NOT NULL,
  external_line_item_id varchar(255) NOT NULL,
  quantity integer NOT NULL,
  ordered_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  CONSTRAINT dropship_listing_sale_order_chk CHECK (btrim(external_order_id) <> ''),
  CONSTRAINT dropship_listing_sale_line_chk CHECK (btrim(external_line_item_id) <> ''),
  CONSTRAINT dropship_listing_sale_quantity_chk CHECK (quantity > 0),
  CONSTRAINT dropship_listing_sale_line_uk UNIQUE (store_connection_id, external_order_id, external_line_item_id)
);
CREATE INDEX dropship_listing_sale_window_idx ON dropship.dropship_listing_marketplace_sales (listing_id, ordered_at);

-- The eBay item numbers a listing had before it was relisted or republished.
CREATE TABLE dropship.dropship_listing_previous_marketplace_ids (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id) ON DELETE CASCADE,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  external_listing_id varchar(255) NOT NULL,
  reason varchar(40) NOT NULL,
  replaced_at timestamptz NOT NULL,
  CONSTRAINT dropship_listing_prev_external_chk CHECK (btrim(external_listing_id) <> ''),
  CONSTRAINT dropship_listing_prev_reason_chk CHECK (reason IN ('relisted','republished')),
  CONSTRAINT dropship_listing_prev_store_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id) ON DELETE CASCADE,
  CONSTRAINT dropship_listing_prev_id_uk UNIQUE (store_connection_id, external_listing_id)
);
CREATE INDEX dropship_listing_prev_listing_idx ON dropship.dropship_listing_previous_marketplace_ids (listing_id);

-- Order lines on an item number no listing has, whose custom label is one of the store's listing SKUs.
CREATE TABLE dropship.dropship_unmatched_marketplace_orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  external_order_id varchar(255) NOT NULL,
  external_line_item_id varchar(255) NOT NULL,
  external_listing_id varchar(255) NOT NULL,
  sku varchar(255) NOT NULL,
  candidate_listing_id integer REFERENCES dropship.dropship_vendor_listings(id) ON DELETE SET NULL,
  status varchar(30) NOT NULL,
  reason varchar(80) NOT NULL,
  ordered_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_checked_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT dropship_unmatched_identity_chk CHECK (btrim(external_order_id) <> '' AND btrim(external_line_item_id) <> ''
    AND btrim(external_listing_id) <> '' AND btrim(sku) <> ''),
  CONSTRAINT dropship_unmatched_status_chk CHECK (status IN ('open','relinked','cancelled','fulfilled_elsewhere','expired')),
  CONSTRAINT dropship_unmatched_reason_chk CHECK (reason ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT dropship_unmatched_store_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id) ON DELETE CASCADE,
  CONSTRAINT dropship_unmatched_order_line_uk UNIQUE (store_connection_id, external_order_id, external_line_item_id),
  CONSTRAINT dropship_unmatched_resolved_chk CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX dropship_unmatched_open_item_idx ON dropship.dropship_unmatched_marketplace_orders
  (store_connection_id, external_listing_id) WHERE status = 'open';
CREATE INDEX dropship_unmatched_open_age_idx ON dropship.dropship_unmatched_marketplace_orders (first_seen_at)
  WHERE status = 'open';
CREATE INDEX dropship_unmatched_candidate_idx ON dropship.dropship_unmatched_marketplace_orders (candidate_listing_id);

-- The latest verdict on each shipping policy a store's live listings use, and the verdict last told.
CREATE TABLE dropship.dropship_ebay_fulfillment_policy_checks (
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  fulfillment_policy_id varchar(100) NOT NULL,
  compatible boolean NOT NULL,
  issue_codes text[] NOT NULL DEFAULT '{}',
  verdict_hash varchar(64) NOT NULL,
  notified_verdict_hash varchar(64),
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (store_connection_id, fulfillment_policy_id),
  CONSTRAINT dropship_ebay_policy_check_policy_chk CHECK (btrim(fulfillment_policy_id) <> ''),
  CONSTRAINT dropship_ebay_policy_check_verdict_chk CHECK (verdict_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT dropship_ebay_policy_check_notified_chk
    CHECK (notified_verdict_hash IS NULL OR notified_verdict_hash ~ '^[0-9a-f]{64}$')
);

-- Vendor notices, written in the transaction that made the change; sent on the
-- next tick in batches (one per store and kind) whose key is the
-- notification's idempotency key. A batch the notification service refuses for
-- good is dead-lettered with the refusal's code and never sent again (a person
-- reviews it; ops health counts it).
CREATE TABLE dropship.dropship_marketplace_sync_notices (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  kind varchar(60) NOT NULL,
  subject_key varchar(200) NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  batch_key varchar(200),
  sent_at timestamptz,
  dead_lettered_at timestamptz,
  failure_code varchar(120),
  CONSTRAINT dropship_sync_notice_kind_chk CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT dropship_sync_notice_subject_chk CHECK (subject_key ~ '^[A-Za-z0-9:_-]+$'),
  CONSTRAINT dropship_sync_notice_payload_chk CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT dropship_sync_notice_batch_chk CHECK (batch_key IS NULL OR batch_key ~ '^[A-Za-z0-9:_-]+$'),
  CONSTRAINT dropship_sync_notice_store_owner_fk FOREIGN KEY (store_connection_id, vendor_id)
    REFERENCES dropship.dropship_store_connections(id, vendor_id) ON DELETE CASCADE,
  CONSTRAINT dropship_sync_notice_subject_uk UNIQUE (store_connection_id, kind, subject_key),
  CONSTRAINT dropship_sync_notice_sent_chk CHECK (sent_at IS NULL OR batch_key IS NOT NULL),
  CONSTRAINT dropship_sync_notice_dead_letter_chk CHECK ((dead_lettered_at IS NULL) = (failure_code IS NULL)
    AND (dead_lettered_at IS NULL OR (batch_key IS NOT NULL AND sent_at IS NULL))
    AND (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,120}$'))
);
CREATE INDEX dropship_sync_notice_pending_idx ON dropship.dropship_marketplace_sync_notices (created_at)
  WHERE sent_at IS NULL AND dead_lettered_at IS NULL;

-- Order intake: bounded retries and eBay cancellations of orders already taken in.
ALTER TABLE dropship.dropship_order_intake
  ADD COLUMN processing_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN next_processing_attempt_at timestamptz,
  ADD COLUMN marketplace_cancelled_at timestamptz,
  ADD COLUMN marketplace_status_checked_at timestamptz,
  ADD CONSTRAINT dropship_order_intake_attempt_count_chk CHECK (processing_attempt_count >= 0) NOT VALID;
CREATE INDEX dropship_order_intake_retry_due_idx ON dropship.dropship_order_intake (next_processing_attempt_at, id)
  WHERE status = 'retrying';
CREATE INDEX dropship_order_intake_accepted_check_idx ON dropship.dropship_order_intake
  (store_connection_id, marketplace_status_checked_at NULLS FIRST, id) WHERE status = 'accepted';
