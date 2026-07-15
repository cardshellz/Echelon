# Purchasing Hardening Handoff - 2026-07-14

This continues:

- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`
- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-13.md`

The July 13 quote-pricing work is merged in PR #914. PR #917 subsequently
merged durable transactional command results for ordinary PO-line mutations,
PR #918 made optional PO/catalog capture atomic, and PR #921 added durable
purchase-order email delivery, PR #922 put the disposable PostgreSQL hardening
suites in CI, and PR #924 migrated cash-moving AP payment commands to the
durable transactional command ledger. PR #926 then migrated invoice approve,
dispute, and void transitions. The current local slice adds command-ledger
monitoring, retention, and audited dead-command recovery.

## Working state

- Worktree: `Echelon-purchasing-hardening`
- Branch: `codex/financial-command-operations-2026-07-14`
- Base and current `origin/main`: `061dbe51`
- Base hardening slice: merged PR #926
- Deployment status: PR #921 is live on Heroku release v2381
- Migration 136 status: applied and verified in production
- Migration 138 status: applied and verified in production
- Migration 140 status: local only; not applied in production
- Commit/PR status: financial-command operations slice is local and not yet published

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

## AP payment transactional-command slice

The cash-moving AP commands are the next small ledger group:

- `POST /api/ap-payments`
- `POST /api/ap-payments/:id/void`

They no longer use the legacy response-cache idempotency middleware. Each route
now creates the same actor/route/resource/payload command descriptor used by the
PO-line commands and returns the durable `Idempotency-Replayed` contract.

For a payment record, one caller-owned transaction now includes:

- row locks for every allocated invoice, acquired in deterministic ID order;
- vendor, invoice state, open-balance, duplicate-allocation, integer-money, and
  allocation-total validation;
- a transaction-scoped advisory lock around `PAY-YYYYMMDD-###` assignment;
- the payment and allocation rows;
- invoice balance/status and linked PO financial aggregate recomputation;
- the required AP command audit event; and
- the succeeded durable HTTP command result.

Voiding similarly commits the payment reversal, invoice/PO recomputation, AP
audit, and durable result together. Deterministic business failures become exact
replayable 4xx results; unknown infrastructure failures remain retryable without
persisting sensitive exception text.

All three browser payment entry points now use the shared financial-command
transport and intent store. An unchanged effective request retains one key across
network ambiguity, unreadable responses, active-command conflicts, HTTP 5xx/429,
and automatic retries. This corrects the previous pattern that generated a new
key inside each mutation invocation.

Current local evidence:

- `npm.cmd run check`: passed
- focused AP command, route, and atomic-side-effect gate: 20 tests passed
- repository unit gate: 352 files and 3,392 tests passed; 14 skipped; 8 todo
- production build: passed; 3,595 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only

PR #924 merged as `5bf413c5`. Its final merge-candidate CI run `29361866465`
passed both `Typecheck + unit tests` and `PostgreSQL hardening tests`.

## AP invoice lifecycle transactional-command slice

The next reviewed command group is:

- `POST /api/vendor-invoices/:id/approve`
- `POST /api/vendor-invoices/:id/dispute`
- `POST /api/vendor-invoices/:id/void`

Each route now uses a scoped durable financial-command descriptor and returns
the exact stored status/body with `Idempotency-Replayed`. The legacy response
cache is no longer stacked on these routes.

The caller-owned transaction now locks the invoice row before transition
validation and commits the invoice status, linked PO financial aggregates,
required AP audit event, and durable success result together. Missing invoices,
invalid states, missing reasons, already-voided invoices, and void attempts with
applied payments become durable replayable 4xx results. Unknown infrastructure
failures remain retryable without persisting raw exception details.

The obsolete `executeApLedgerCommand` orchestration path was removed after all
five AP invoice/payment commands moved to the durable wrappers. This prevents a
future caller from accidentally restoring the old split-commit audit behavior.

Invoice approval's variance-to-lot-to-COGS reconciliation remains an explicit
non-blocking post-commit hook. Exact command replay does not rerun it. The browser
uses the shared financial-command transport and intent store for approve,
dispute, and void, including retry classification and `Retry-After` handling.
Payment callers now also notify their intent stores on failure so definitive 4xx
responses clear retained keys while ambiguous outcomes keep them.

Current local evidence:

- `npm.cmd run check`: passed
- focused invoice/payment command, route, lock, atomic-audit, and replay gate: 30 tests passed
- repository unit gate: 355 files and 3,413 tests passed; 14 skipped; 8 todo
- production build: passed; 3,595 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only

PR #926 merged as `061dbe51`. Its final merge-candidate CI passed both
`Typecheck + unit tests` and `PostgreSQL hardening tests`.

## Financial-command operations slice

Migration 140 and the platform command-operations module make the existing
ledger operable without weakening its idempotency contract.

The Operations Control Tower system-health view now shows:

- counts for dead commands, expired claims, due retries, and retained terminal
  results;
- a filtered/searchable command list with attempt and recovery counts;
- sanitized operator-safe failure diagnostics; and
- a permission-gated `Re-arm once` action for dead commands.

Monitoring requires `operations:view`. Technical detail requires
`operations:view_technical`; operator recovery requires `operations:triage`.
The monitoring API intentionally omits request hashes, idempotency keys, stored
response bodies, and lease tokens.

Dead-command recovery is not a server-side payload replay. The ledger stores a
canonical payload hash, not the original request, so reconstructing a financial
request would be unsafe. Instead, recovery:

1. locks the dead command;
2. writes immutable evidence containing the operator, reason, previous error,
   completion time, and attempt budget;
3. increments the per-command limit by exactly one; and
4. transitions the same immutable command identity to retryable/due-now.

The database trigger rejects `dead -> retryable` unless the exact matching audit
row already exists in the same transaction. It still rejects every update to
succeeded/rejected results and any command identity rewrite. Concurrent recovery
requests serialize on the command row, so only one can grant the next attempt.

The originating browser retains a dead command's exact intent key without
automatically retrying. After recovery, that caller must resend the unchanged
payload and key. A page reload still loses the in-memory key; durable encrypted
request snapshots plus an executor registry would be required for autonomous
operator replay and are intentionally outside this slice.

The retention worker runs in bounded batches under the repository-wide scheduler
disable contract. It deletes only expired `succeeded` and `rejected` results.
Dead, claimed, and retryable rows are never automatically deleted. Recovered
audit evidence follows its terminal result only when that result eventually
qualifies for normal retention cleanup.

Current local evidence:

- `npm.cmd run check`: passed
- focused recovery, permission, retention, migration, and client-intent gate:
  37 tests passed
- writer-ownership ratchet: passed with the platform operations writer registered
- repository unit gate: 358 files and 3,426 tests passed; 14 skipped; 8 todo
- production build: passed; 3,596 client modules transformed and server bundle built
- expanded PostgreSQL suite: compiles locally and skips without the explicit
  disposable database; CI will run 10 cases against PostgreSQL 16
- `git diff --check`: passed, with Windows line-ending notices only

The Control Tower component was not exercised in a live local browser because
this laptop has no disposable application database and no local app server was
already running. Starting the full app against an unknown configured database
was intentionally avoided. The production client/server build passed.

PR #927 merged as `5fd643c7`. Its final merge-candidate CI passed both
`Typecheck + unit tests` and `PostgreSQL hardening tests`.

## Named-schema integration harness slice

The three older channel/inventory integration suites no longer build obsolete
unqualified `public` tables. Their shared harness now requires both
`ECHELON_TEST_DATABASE_URL` and the explicit
`ECHELON_TEST_DATABASE_DISPOSABLE=true` acknowledgment, rejects a URL matching
`DATABASE_URL` or `EXTERNAL_DATABASE_URL`, and rebuilds only its owned
`catalog`, `warehouse`, `inventory`, `channels`, and `wms` fixture schemas.

Cleanup is schema-qualified and the suites run without file parallelism so one
suite cannot truncate another suite's fixture. When the disposable database is
not configured, the suites skip instead of failing the repository-wide unit
gate during import.

The stale inventory concurrency test now uses the current warehouse/location
fields and the current `pickItem` boolean rejection contract. A fast unit test
compares every fixture table column with the corresponding Drizzle table, so
future named-schema column drift fails CI before reaching PostgreSQL.

Current local evidence:

- `npm.cmd run check`: passed
- fixture/Drizzle contract: 18 tests passed
- repository unit gate: 359 files and 3,446 tests passed; 14 skipped; 8 todo
- the three database suites compile and skip without the explicit disposable
  database; CI will run 30 cases serially against PostgreSQL 16
- `git diff --check`: passed, with Windows line-ending notices only

The PostgreSQL 16 result is still required before this slice is production-proven.

## Recommended next implementation order

1. Review and merge the named-schema integration harness slice after its PostgreSQL
   16 CI run is green.
2. Decide whether autonomous dead-command replay justifies encrypted request snapshots
   and a versioned executor registry; the current exact-caller-retry model is safer.
3. Run the controlled low-risk automatic-purchasing pilot from the earlier handoffs.

Keep manual quote pricing marked `manual` even when the same quote is optionally
saved to the vendor catalog. Extended-total quotes remain PO-specific and must not be
written as reusable catalog economics.

## Resume prompt

> Read the purchasing handoffs dated July 12, 13, and 14. Pull current `origin/main`,
> verify the branch/PR/deployment state, and continue from the highest-priority
> unverified item. PR #927 merged as `5fd643c7`; verify migration 140's production
> state separately. Verify the named-schema disposable PostgreSQL CI result before
> describing those three suites as exercised. Do not mutate production without
> explicit owner approval.
