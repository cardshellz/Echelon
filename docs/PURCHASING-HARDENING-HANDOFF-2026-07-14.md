# Purchasing Hardening Handoff - 2026-07-14

This continues:

- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`
- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-13.md`

The July 13 quote-pricing work is merged in PR #914. PR #917 subsequently
merged durable transactional command results for ordinary PO-line mutations,
PR #918 made optional PO/catalog capture atomic, and PR #921 added durable
purchase-order email delivery. This document now also records the next local
slice: disposable PostgreSQL hardening gates in CI.

## Working state

- Worktree: `Echelon-purchasing-hardening`
- Branch: `codex/purchasing-postgres-ci-2026-07-14`
- Base and current `origin/main`: `46edf8cc`
- Base hardening slice: merged PR #921
- Deployment status: PR #921 is live on Heroku release v2381
- Migration 136 status: applied and verified in production
- Migration 138 status: applied and verified in production
- Commit/PR status: pushed in draft PR #922; the latest-main PostgreSQL and standard CI jobs passed

Do not deploy this branch without owner approval.

## PR #917 production verification

Read-only checks after merge confirmed:

- Heroku release v2377 runs commit `60e67587`.
- The live application returned HTTP 200.
- `_migrations` records `136_financial_command_results.sql`.
- `public.financial_command_results` exists.
- the immutable-row trigger `financial_command_results_update_guard` exists.
- the ledger was empty at verification time, which is expected until a covered
  command is used.

No production data or configuration was intentionally changed during these
checks.

## Atomic PO plus vendor-catalog slice

The three split browser flows are now one server command:

- quick PO creation no longer creates the PO and then separately bulk-upserts
  the catalog;
- the full PO editor no longer writes the catalog before attempting the PO;
- PO Detail no longer adds the line and then fire-and-forgets a catalog upsert.

Each selected product line now sends only this directive:

```json
{ "catalogWrite": { "mode": "upsert", "setPreferred": false } }
```

The client does not duplicate catalog pricing, pack economics, product identity,
or quote metadata in a second payload. The server derives all reusable catalog
economics from the validated authoritative PO line and commits the catalog row,
catalog audit event, PO header/line changes, PO event, and—on hardened direct-line
routes—the durable command result inside one database transaction.

Safety rules enforced at both HTTP and service boundaries:

- catalog capture requires explicit reusable quote pricing;
- quantity-specific `extended_total` quotes cannot be saved as catalog economics;
- a real `quotedAt` value is required;
- the directive is strict and accepts only `mode` plus optional `setPreferred`;
- catalog capture is valid only when the current PO consumes the quote as
  `manual`;
- saving the quote for future automation never relabels the current PO line as
  `vendor_catalog`;
- the persisted catalog row id is linked back to the PO line without changing
  that provenance;
- deterministic catalog failures on durable direct-line commands are translated
  into replayable rejected command results rather than transient retries.

The existing catalog batch writer now accepts an internal caller transaction.
Standalone catalog administration still opens its own transaction, while PO
commands pass their existing transaction so there is no nested or split commit.

### Validation evidence for the atomic slice

Local results on July 14:

- `npm.cmd run check`: passed
- production build: passed; 3,595 client modules transformed and server bundle built
- focused atomic gate: 5 files, 88 tests passed
- procurement plus PO-editor regression gate: 77 files, 725 tests passed; 14 skipped
- repository-wide gate: 397 files and 4,070 tests passed; 29 skipped; 8 todo
- `git diff --check`: passed, with Windows line-ending notices only

The unfiltered repository command still has the same four unrelated/environmental
failures documented below: three PostgreSQL integration suites require
`ECHELON_TEST_DATABASE_URL`, and the unchanged fulfillment-reconciliation test
expects `on_hold` while unchanged production logic returns `partially_shipped`.

## Production recovery verified before this slice

Read-only checks on July 14 confirmed:

- Heroku release v2376 runs commit `e7a389a7`.
- `web.1` remained up after the PR #913 release.
- The live root URL returned HTTP 200.
- Recent logs showed normal work rather than the earlier restart loop.
- No production data or configuration was mutated during this continuation.

This verifies recovery from the startup incident; it does not verify the local
command-results implementation.

## PR #917 implementation (merged)

### Durable command-results ledger

Migration `136_financial_command_results.sql` adds
`public.financial_command_results`, a scoped command ledger with:

- actor, HTTP method, route template, resource, and idempotency-key scope
- canonical SHA-256 HTTP payload identity
- persistent command name and contract version
- claimed, succeeded, rejected, retryable, and dead states
- database-timed leases, retry due times, attempt counts, and bounded diagnostics
- exact JSON response body plus original HTTP status for terminal replay
- immutable command identity and terminal rows
- guarded state transitions and due-time enforcement
- indexes for active leases, retry work, retention, and result lookup

The stable payload hash intentionally excludes internal command name/version.
Completed requests therefore remain replayable after a compatible internal rename,
while unfinished requests still require the exact execution contract.

The old `idempotency_keys` middleware remains for routes not migrated yet. Do not
stack it on a transactional-command route.

### Transaction model

The new repository uses two phases:

1. Reserve a short durable lease in its own transaction.
2. Lock the owned claim and commit the domain mutation, PO event, header totals,
   and succeeded result in one business transaction.

If the business transaction rejects deterministically, its domain writes roll back
and the exact 4xx response is then finalized as a durable rejected result. Unexpected
failures become retryable with exponential backoff, then dead after five attempts.
A stale lease owner cannot execute or overwrite the newer owner's result.

The fifth-attempt boundary was explicitly hardened: an active fifth claim remains
in progress; only a failed fifth attempt or an expired fifth claim becomes dead.

### First purchasing integration

These already-strict PO-line commands now use the ledger:

- `POST /api/purchase-orders/:id/lines`
- `POST /api/purchase-orders/:id/lines/bulk`
- `PATCH /api/purchase-orders/lines/:lineId`
- `DELETE /api/purchase-orders/lines/:lineId`

Each route requires `Idempotency-Key`, rejects conflicting standard/legacy key
headers, hashes route parameters/query/body, and returns `Idempotency-Replayed`.
The existing line/header locks, optimistic concurrency, pricing calculations,
recommendation ownership guard, downstream-link guard, totals, and immutable PO
event remain inside the same transaction as the succeeded result.

The non-idempotent service wrappers still validate IDs and bodies before opening a
database transaction. The new HTTP command wrappers reserve first so deterministic
invalid/rejected requests themselves can be replayed exactly.

### Browser retry automation

PO Detail add, update, and cancel actions now capture an immutable URL, body, and
idempotency key per effective user intent. The client:

- reuses the same key for automatic retries
- retries transport failures, unreadable/invalid successful responses, HTTP 5xx,
  HTTP 429, active-command conflicts, and stale-owner commit ambiguity
- honors `Retry-After`, capped at five minutes
- retains a key after an ambiguous final failure only while the effective payload is
  unchanged
- rotates the key when the payload changes or a definitive 4xx settles the intent
- clears it after success
- preserves structured server error code/details for the UI
- disables both delete buttons while cancellation is pending

This closes the important commit-plus-lost-response case: retry replays the stored
result instead of issuing a second financial mutation under a new key.

## Validation evidence

Local results on July 14:

- `npm.cmd run check`: passed
- production build: passed; 3,595 client modules transformed and server bundle built
- focused hardening gate: 103 passed
- writer-ratchet: passed after registering the single intended ledger writer
- broad regression gate: 396 files, 4,043 tests passed; 29 skipped; 8 todo
- `git diff --check`: passed, with Windows line-ending notices only

The unfiltered repository test command still reports four unrelated/environmental
failures:

- three existing integration suites require missing `ECHELON_TEST_DATABASE_URL`
- the unchanged fulfillment-reconciliation test expects `on_hold` while unchanged
  production logic returns `partially_shipped`

The latter files are byte-for-byte unchanged from `origin/main` in this branch.

### Real PostgreSQL test status

An opt-in integration suite now exercises migration 136 and the real Drizzle/PG
repository using a random disposable probe table. It covers:

- atomic domain effect plus succeeded result
- rollback of a domain effect plus durable rejected result
- exact replay, including after an internal command rename
- simultaneous same-key execution only once
- same-scope key reuse with a different payload hash
- active versus expired fifth claims
- stale-token finalize protection after reclaim
- database-trigger rejection of early lease/retry reclamation

It only runs with an explicit `ECHELON_TEST_DATABASE_URL`, refuses an exact match
with `DATABASE_URL` or `EXTERNAL_DATABASE_URL`, and cleans only its random probe and
actor-owned rows. This laptop has no Docker, `psql`, or configured test database, so
all seven tests currently skip cleanly. They have not yet executed against PostgreSQL.

## Outstanding PR #917 operational follow-up

Although PR #917 is live, these hardening follow-ups remain:

1. Run the seven command-result integration tests against a disposable PostgreSQL 16
   database.
2. Smoke-test fresh success, exact success
   replay, exact rejected replay, payload conflict, and active-lease retry.
3. Monitor `claimed`, `retryable`, and `dead` rows plus lease age and attempt count.
4. Add a scheduled retention purge for rows past `expires_at`; the schema has the
   retention timestamp/index, but no purge worker exists yet.
5. Add an operator view/replay procedure for dead commands before migrating more
   financial routes.

Do not run the new integration suite against production.

## Durable PO-email outbox slice

The old `POST /api/purchase-orders/:id/send-email` path performed SMTP inline and
then wrote `po_status_history` in a separate call. Provider acceptance followed by
a database failure could therefore create a real but invisible vendor email, and a
request retry could send it again.

Migration 138 and the new procurement-owned outbox replace that split path with:

- an immutable recipient, subject, HTML, text, and PO-document snapshot;
- PO-scoped idempotency keys and canonical request hashes;
- strict email/body validation and exact replay of the original queued delivery;
- `queued`, leased `processing`, `sent`, `partially_sent`, and `dead_letter` states;
- `FOR UPDATE SKIP LOCKED` claims that are safe across multiple web dynos;
- bounded attempts, lease recovery, exponential backoff, and terminal diagnostics;
- one stable RFC Message-ID reused for automatic retries;
- SMTP timeouts and provider acceptance metadata;
- atomic outbox completion plus `po_status_history` append after provider acceptance;
- explicit partial-recipient handling that suppresses unsafe automatic duplicates;
- delivery status polling in the PO email modal; and
- idempotent operator replay that creates a new queued row from a dead letter without
  mutating the terminal source snapshot.

The web process starts the worker after listening, using the repository's existing
scheduler-disable contract plus `PO_EMAIL_OUTBOX_WORKER_DISABLED`. Claim leases,
not in-memory process state, are the cross-dyno concurrency authority.

SMTP cannot provide mathematical exactly-once delivery across the provider/database
commit boundary. If provider acceptance succeeds and the database completion
transaction fails, the row is retried with the same Message-ID. This is honest
at-least-once delivery with a provider deduplication aid, durable visibility, and
operator recovery—not a false exactly-once claim.

Local validation on July 14:

- `npm.cmd run check`: passed
- focused outbox/route tests: 4 files, 43 passed
- procurement hardening gate: 78 files, 715 passed, 14 skipped
- production build: passed; 3,595 client modules transformed and server bundle built
- writer-ratchet: updated for the intended procurement-owned outbox writer
- repository-wide gate: 402 files and 4,105 tests passed; 29 skipped; 8 todo

The repository-wide command retains the same four unrelated/environmental failures:
three existing integration suites require `ECHELON_TEST_DATABASE_URL`, and the
unchanged fulfillment reconciliation fixture expects `on_hold` while unchanged
production logic returns `partially_shipped`.

Migration constraints, real concurrent claims, lease recovery, and SMTP commit
ambiguity still need a disposable PostgreSQL/SMTP test environment before this is
described as production-proven.

## Disposable PostgreSQL CI slice

The normal CI job still runs typecheck and unit tests. A second focused job now
starts PostgreSQL 16 and executes the self-contained hardening suites that do not
require a fully bootstrapped application database:

- the seven migration, transaction, rollback, exact-replay, lease, concurrency,
  fifth-attempt, and stale-owner tests for `financial_command_results`; and
- three real-PostgreSQL tests for migration 138 covering database idempotency and
  snapshot guards, concurrent `SKIP LOCKED` claims, stable Message-ID delivery, and
  atomic outbox completion plus PO history.

The outbox suite requires both `ECHELON_TEST_DATABASE_URL` and the explicit
`ECHELON_TEST_DATABASE_DISPOSABLE=true` acknowledgment. It refuses a URL matching
`DATABASE_URL` or `EXTERNAL_DATABASE_URL`, creates only minimal dependency schemas
inside the disposable CI database, and removes them afterward. This prevents the
test from silently running against production or a shared developer database.

The three older channel/inventory integration suites remain outside this focused job.
Their shared bootstrap builds obsolete unqualified public tables while current
Drizzle schemas use named schemas, so adding them would create a misleading red gate
rather than prove the purchasing invariants in this slice.

### PostgreSQL CI evidence

GitHub Actions run `29358756510`, on the branch after merging current `main`, passed:

- `PostgreSQL hardening tests` in 48 seconds, including both the financial-command
  and PO-email outbox steps; and
- `Typecheck + unit tests` in 2 minutes 25 seconds.

This is the first recorded execution of these purchasing guarantees against real
PostgreSQL 16 rather than injected repositories or skipped local integration tests.

## Recommended next implementation order

1. Review the PostgreSQL CI results and merge the focused disposable-database gate.
2. Migrate the next financial commands to the ledger in small reviewed groups.
3. Add command-ledger operator monitoring, retention, and dead-letter replay tooling.
4. Repair the broader named-schema integration harness before enabling its old suites.
5. Run the controlled low-risk automatic-purchasing pilot from the earlier handoffs.

Keep manual quote pricing marked `manual` even when the same quote is optionally
saved to the vendor catalog. Extended-total quotes remain PO-specific and must not be
written as reusable catalog economics.

## Resume prompt

> Read the purchasing handoffs dated July 12, 13, and 14. Pull current `origin/main`,
> verify the branch/PR/deployment state, and continue from the highest-priority
> unverified item. Migrations 136 and 138 are live, but verify the focused disposable
> PostgreSQL CI result before describing the database guarantees as exercised. Do not mutate
> production without explicit owner approval.
