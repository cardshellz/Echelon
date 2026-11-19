-- Read retry scheduling is independent of uncertain provider write ownership.
ALTER TABLE channels.ebay_listing_sync_jobs
  ADD COLUMN read_failure_count integer NOT NULL DEFAULT 0 CHECK(read_failure_count>=0),
  ADD COLUMN read_retry_paused boolean NOT NULL DEFAULT false;
