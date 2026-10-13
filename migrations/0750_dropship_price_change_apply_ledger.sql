-- 0750: the listing settings request ledger (0738) records W7's price apply
-- (Listing settings redesign, PR 9, plan D5): one ledger row per applied
-- price check, tied to the one stored review it applies. A review id is set
-- exactly on a price_change_apply row, it names a review of the same vendor
-- and store, and one review is applied at most once.
--
-- Nothing changes for live data: the new column is null on every existing
-- row, and every existing row has one of 0738's operations, so both CHECKs
-- and the foreign key hold for them. Code deployed before this file never
-- writes a price_change_apply row and never reads the new column.
--
-- The ledger holds only W6 and W12 (and possibly W13) rows, a vendor's own
-- requests. The index build and the CHECK and foreign key validation scan it
-- once, while ACCESS EXCLUSIVE holds every listing-settings write, the replay
-- probe included. Only rows with a review id are indexed, and none exist yet.
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on the ledger until commit. The
-- foreign key takes SHARE ROW EXCLUSIVE on the reviews table, which holds off
-- review inserts (W1's store default reviews) until the release transaction
-- commits. The executor's 15 s lock timeout bounds this file's own wait for
-- either lock, and the executor retries the file after it. No cycle: W1
-- never touches the ledger, and the ledger writers never touch reviews.
--
-- Row triggers do not fire for ALTER TABLE, so the ledger's append-only
-- trigger needs no change.
--
-- The release executor owns the transaction, including its migration record,
-- so the unique index is not built concurrently (that cannot run inside a
-- transaction). Re-runnable: the column is added if missing, each constraint
-- is dropped if present and added again, and the index is created if missing.

ALTER TABLE dropship.dropship_product_listing_setting_requests ADD COLUMN IF NOT EXISTS review_id uuid;

ALTER TABLE dropship.dropship_product_listing_setting_requests
  DROP CONSTRAINT IF EXISTS dropship_product_listing_setting_requests_operation_chk;
ALTER TABLE dropship.dropship_product_listing_setting_requests
  ADD CONSTRAINT dropship_product_listing_setting_requests_operation_chk
  CHECK (operation IN ('product_settings_bulk', 'category_settings_clear', 'category_moves_acknowledge', 'price_change_apply'));

ALTER TABLE dropship.dropship_product_listing_setting_requests
  DROP CONSTRAINT IF EXISTS dropship_product_listing_setting_requests_review_chk;
ALTER TABLE dropship.dropship_product_listing_setting_requests
  ADD CONSTRAINT dropship_product_listing_setting_requests_review_chk
  CHECK ((operation = 'price_change_apply') = (review_id IS NOT NULL));

ALTER TABLE dropship.dropship_product_listing_setting_requests
  DROP CONSTRAINT IF EXISTS dropship_product_listing_setting_requests_review_fk;
ALTER TABLE dropship.dropship_product_listing_setting_requests
  ADD CONSTRAINT dropship_product_listing_setting_requests_review_fk
  FOREIGN KEY (review_id, vendor_id, store_connection_id)
  REFERENCES dropship.dropship_pricing_reviews (id, vendor_id, store_connection_id);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_product_listing_setting_requests_review_idx
  ON dropship.dropship_product_listing_setting_requests (review_id) WHERE review_id IS NOT NULL;
