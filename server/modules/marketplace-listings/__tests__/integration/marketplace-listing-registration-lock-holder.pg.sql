\set ON_ERROR_STOP on

-- The advisory lock is a readiness signal for the harness. It is acquired
-- only after the same scope row used by registration has been locked.
BEGIN;
SELECT scope.id
FROM marketplace.listing_scopes AS scope
JOIN marketplace.channel_listing_scopes AS binding
  ON binding.scope_id = scope.id
WHERE binding.channel_id = 11
  AND scope.product_id = 101
FOR UPDATE OF scope;
SELECT pg_advisory_lock(6080001);
SELECT pg_sleep(8);
SELECT pg_advisory_unlock(6080001);
ROLLBACK;
