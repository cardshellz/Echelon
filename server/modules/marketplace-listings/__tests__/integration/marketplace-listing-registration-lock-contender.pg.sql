\set ON_ERROR_STOP on
\set VERBOSITY verbose

SET lock_timeout = '750ms';
BEGIN;
SELECT scope.id
FROM marketplace.listing_scopes AS scope
JOIN marketplace.channel_listing_scopes AS binding
  ON binding.scope_id = scope.id
WHERE binding.channel_id = 11
  AND scope.product_id = 101
FOR UPDATE OF scope;
ROLLBACK;
