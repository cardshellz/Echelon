# Dropship eBay token lifecycle

## Confirmed failure mechanism

Before this change, orders, returns, tracking, cancellations, listing push, and
registration each refreshed the same store credential independently. Some sent
only fulfillment scopes; others omitted Store scopes. The next consumer reused
that shared access token until its recorded expiry, even when it no longer
carried the permission that consumer needed. Catalog read failures were then
presented as a request for the customer to authorize again.

This code path demonstrates a self-inflicted loss of access-token permissions.
It does not prove which job caused any particular historical production warning;
that attribution requires the corresponding sanitized request/job logs.

## Authority and concurrency

- `DropshipEbayTokenOwner.loadFreshForStoreConnection` is the only dropship eBay
  refresh implementation. Initial consent/code exchange remains separate.
- Refresh requests omit `scope`. eBay documents that omission retains the original
  consent scope set; requesting a subset narrows the resulting access token.
  See [eBay authorization documentation](https://developer.ebay.com/develop/guides/sell/authorization).
- Fresh tokens are reused. An expired/near-expiry token is refreshed with the
  existing grant. A safe read that rejects a still-fresh token can request repair
  by passing that exact access-token reference.
- The PostgreSQL repository serializes refreshes per store across processes using
  a session advisory lock. The callback uses the same leased session for short
  credential transactions, so refresh does not need a second pool connection.
  No transaction stays open during eBay HTTP calls.
  Auth-failure notifications run after the session is released, and a lost
  database session during HTTP invalidates the refresh attempt safely.
- The owner rereads credentials after acquiring the lock. Success and failure
  writes compare both access and refresh vault references under a row lock.
  Stale results cannot overwrite or revoke newer consent. Paused, disconnected,
  grace-period, and consent-required connections cannot be resurrected by refresh.
- Credential reads use one repeatable-read snapshot for references and encrypted
  token rows; concurrent replacement cannot produce a split-snapshot missing token.
- OAuth HTTP requests have a 20-second deadline, a 64-KiB response limit, and reject
  redirects. Lock acquisition and cleanup are bounded; uncertain sessions are discarded.

## Recovery and customer messages

`withEbaySafeReadRecovery` retries a rejected read once after asking the token
owner for a replacement. Listing setup discovery retries as a whole read pass;
policy reads, Store categories, and the initial managed-location GET also use it.
No provisioning, listing publication, tracking submission, or cancellation is
automatically replayed by this recovery helper.

| Failure | Result |
| --- | --- |
| Cached access token rejected, replacement succeeds | Retry the read once; no customer consent |
| Another worker already replaced the rejected token | Use the winning token without another refresh |
| Persistent API 401/403 after repair | Access/support error, not proof of disconnection; no repeated consent prompt |
| Current refresh grant explicitly rejected with HTTP 400 `invalid_grant`, missing, or expired | Consent required for the connected store |
| Timeout, network failure, rate limit, server failure | Retain the refresh grant; surface an availability failure |
| OAuth app configuration or scope failure | Retain the grant; support/configuration action, not guessed revocation |
| Concurrent consent/disconnect wins | Discard the old outcome; use a valid winner or stop |

Diagnostics retain internal failure codes, resource names, HTTP status, operation,
store identity, and bounded numeric eBay error IDs. Raw token responses and provider
descriptions are not persisted or returned by the refresh path.

## Verification

Focused suites include:

- `dropship-ebay-token-owner.test.ts`: original scopes, forced repair, missing
  coordination, stale success/failure, disabled state, invalid response, and redaction.
- `dropship-ebay-token-consumers.test.ts`: all six entry points use the owner;
  concurrent consumers over repeated expirations refresh once per generation.
  An order-worker renewal followed by Inventory, Account, and Store reads retains
  all permissions; a legacy narrowed token repairs once across concurrent reads.
- `dropship-marketplace-credentials.integration.test.ts`: real PostgreSQL CAS,
  callback/refresh races, snapshot coherence, lock contention/cleanup, and pool safety.
- `dropship-ebay-safe-read-recovery.test.ts`: one retry only, genuine consent failure,
  persistent denial, transient failures, and no automatic provisioning-write replay.

Database tests require both `ECHELON_TEST_DATABASE_URL` and
`ECHELON_TEST_DATABASE_DISPOSABLE=true`. Use a dedicated disposable database;
the integration suite creates and drops an isolated synthetic schema. Never point
these tests at a live store database.

## Post-deployment acceptance

Local validation on 2026-09-06: the repository unit run passed 8,628 tests
(37 skipped). After the final recovery/connection-loss changes, the complete
dropship unit/UI suite, credential PostgreSQL suite, and architecture guards
passed 1,286 tests, including 21 PostgreSQL tests. Fresh non-incremental TypeScript
checking and the production client/server build passed. The build reports a
large-client-chunk warning. The synthetic database was stopped and removed;
production eBay behavior and hosted CI have not been exercised by this local run.

1. Open Catalog for the existing eBay store. Use **Refresh options** without
   reauthorizing first. Policies and Store categories should load if its refresh
   grant remains valid; existing policy assignments must remain unchanged.
2. Revisit after background order/return processing and a normal access-token
   renewal. Inventory, Account, and Store reads must still work without consent.
3. If the grant was actually removed or revoked before this repair, one deliberate
   authorization of the connected store may still be necessary. This change does
   not reconstruct deleted tokens or add permissions never granted by the seller.
4. A persistent access error needs support inspection of resource/status/error IDs,
   app scopes, and seller API eligibility. Do not repeatedly send the seller through
   consent or assume a successful deployment proves the live grant is healthy.

No schema migration, credential rotation, listing publication, or live settings
change is required by this implementation. Switching to a different OAuth client
is a separate migration and is not handled by this change.
