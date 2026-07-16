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
dispute, and void transitions. PR #927 added command-ledger monitoring,
retention, and audited dead-command recovery; PR #929 repaired the named-schema
integration harness; PR #931 added the controlled one-SKU automatic-purchasing
pilot; PR #933 fixed its production CLI dependency loading; and PR #935 added
read-only automatic-purchasing candidate discovery and readiness ranking. PR #936
then made supplier-readiness blockers directly remediable without guessing supplier
data, and PR #939 hardened the recommendation review queue with exact demand evidence
and fail-closed operator attestations. PR #941 merged the optional PO quote capture
correction, PRs #943 and #944 recovered exact historical supplier evidence without
timezone drift, and PR #945 added database guards for PO supplier-product identity.
The current continuation repairs the remaining legacy PO receive-configuration
snapshots with reviewed, attributable automation.

## Working state

- Worktree: `Echelon-purchasing-hardening`
- Branch: `codex/legacy-po-receive-variant-remediation-2026-07-16`
- Base and current `origin/main`: `fca07306`
- Base hardening slice: merged PR #945
- Deployment status: PR #945 deployed as Heroku v2408 at `fca07306`
- Migration 136 status: applied and verified in production
- Migration 138 status: applied and verified in production
- Migration 140 status: merged in PR #927; production state was not re-audited in
  this July 15 readiness continuation
- Migration 146 status: applied and verified in production
- Commit/PR status: legacy PO receive-configuration remediation is local and not
  yet published

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
  database; CI runs 30 cases serially against PostgreSQL 16
- `git diff --check`: passed, with Windows line-ending notices only

GitHub Actions run `29427512682` passed the final merge candidate:

- `PostgreSQL hardening tests` passed in 45 seconds, including all 30
  named-schema channel/inventory cases; and
- `Typecheck + unit tests` passed in 1 minute 58 seconds.

PR #929 merged as `2dd60733`. Both required checks passed on the final merge
candidate, including all 30 named-schema PostgreSQL cases.

## Controlled automatic-purchasing pilot controls

The next slice adds a dedicated exact-SKU pilot path around the existing automatic
handoff. It does not change the scheduler or the existing Purchasing UI trigger.

The operator command is dry-run by default. Its preflight loads current production
recommendation inputs and prints the exact recommendation, supplier/receive IDs,
piece quantity, quote basis, quoted unit mills, normalized per-piece mills, cents
mirror, exact extended mills, product-cost cents, pricing remainder,
demand/candidate evidence, approval policy, and structured blockers without creating
an auto-draft lifecycle row or any domain mutation.

Execution requires `--execute`, an attributable `--actor`, and a SKU that matches
exactly one recommendation. Scheduler-triggered pilot calls, missing actors, zero or
ambiguous SKU matches, review-only mode, policy rejection, and handoff-validation
failure all fail closed. A successful pilot passes exactly one item to the existing
atomic handoff, which bounds the result to one PO and one product line. The result
returns durable accepted-decision, handoff-decision, PO, and PO-line IDs; stale
recommendation snapshots are reported as skipped rather than drafted.

The complete operating procedure and evidence queries are in
`docs/AUTOMATIC-PURCHASING-PILOT-RUNBOOK.md`.

Current local evidence:

- `npm.cmd run check`: passed
- focused pilot gate: 16 tests passed
- expanded procurement/writer gate: 81 files and 738 tests passed; 1 file and 17
  tests skipped
- production build: passed; 3,596 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only

PR #931 merged as `50c6ef02`. PR #933 subsequently fixed production packaging by
making local `dotenv` loading optional when the runtime already provides a database
URL; it merged as `9fe4860c` and deployed on Heroku release v2395.

## July 15 production verification and readiness continuation

The deployed read-only exact-SKU command now runs successfully. A preflight for
`QUAD-BOX-TOP` returned one current recommendation and made no writes. It was
correctly ineligible under `high_confidence_only`: the recommendation had medium
confidence, score 59, blocked band, no preferred vendor/vendor product/current quote,
product-level lead-time fallback, and coupon-discounted demand in its evidence.

Read-only durable-evidence checks immediately afterward found:

- zero automatic-draft lifecycle runs;
- zero automatic purchase orders; and
- zero recommendation-to-PO handoffs.

A broader read-only audit found 278 current recommendations and zero policy-eligible
candidates. The dominant conditions were product lead-time fallback (278), missing
vendor (248), no recent demand (154), and discounted/free demand mix (92). The 25
strongest repair candidates had no vendor-product catalog rows. A hypothetical
in-memory supplier-data simulation still produced no high-confidence candidate because
demand-review blockers remained. No production data, configuration, policy, or PO was
changed.

PR #935 turned that one-off audit into a bounded reusable command:

```text
npm run procurement:automatic-purchasing-pilot -- --list --limit=25
```

It is read-only, performs no lifecycle or domain writes, excludes routine
non-actionable inventory noise, ranks the useful candidates deterministically, and
maps supplier/demand blockers to explicit next actions. It separately reports item
approval-policy eligibility, execution eligibility, and global review-only mode so an
operator cannot confuse an automation-mode decision with a bad recommendation.

Its production run on Heroku release v2397 completed successfully and reported:

- 278 recommendations analyzed;
- 32 relevant readiness candidates and 25 returned by the display limit;
- zero approval-policy or execution-eligible candidates;
- all 32 classified as requiring both configuration and demand review;
- all 32 missing a preferred vendor and using product-level lead-time fallback;
- 20 with discounted/free demand mix, 16 with thin history, 4 with new demand,
  and 1 with falling demand.

The report performed no lifecycle or PO writes. PR #936 changes the existing Supplier
Setup Gaps actions from generic `/suppliers` links
into exact task links carrying product, receive variant, recommendation, known vendor,
and known vendor-product identity. Suppliers locks the task target, preselects
preferred status for missing-vendor setup, opens a known mapping for quote/lead-time
repair, invalidates purchasing diagnostics after save, and returns the operator to
Purchasing. Supplier identity and commercial values still require verified human
evidence; nothing is inferred or fabricated.

Current local evidence for the supplier-remediation slice:

- `npm.cmd run check`: passed
- focused server/client contract gate: 3 files and 31 tests passed
- expanded procurement/supplier/writer gate: 83 files and 760 tests passed; 14 skipped
- production build: passed; 3,597 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only

PR #936 merged as `25e42129` and deployed on Heroku release v2399. Current
production release v2400 contains subsequent merged PR #937. A post-deploy browser
smoke reached the Echelon sign-in screen, but no authenticated production browser
session was available; no credentials were guessed or entered and no production
write was attempted. The authenticated Purchasing-to-Suppliers UI smoke remains
outstanding.

## Exact demand-evidence review slice

The existing Recommendation Review Queue already records durable operator decisions,
but the browser previously allowed `reviewed`, `accepted_for_po`, `deferred`, and
`dismissed` decisions from a one-click menu with no rationale or confirmation. The
current slice keeps that ledger and hardens its input contract:

- review and forecast-gap links carry the exact recommendation id instead of opening
  a broad candidate bucket;
- the API can filter to one bounded recommendation and returns the demand window,
  paid/discounted/free mix, order and active-day sample, trend, velocity, and forecast
  trust evidence used by the engine;
- the browser highlights and scrolls to the exact task and presents the evidence in a
  decision dialog;
- every operator disposition requires a substantive note and explicit confirmation;
- `reviewed` and `accepted_for_po` additionally require acknowledgment of every live
  quality control plus an explicit statement that the decision does not change
  automatic-purchasing eligibility or bypass approval policy;
- the server rejects missing, stale, duplicate, or invented control acknowledgments
  and stores the reviewed controls and contract version with the recommendation
  snapshot; and
- accepting an item still means manual PO review only. It does not clear engine
  blockers, raise confidence, or make the SKU eligible for automatic drafting.

The Forecast Input Gaps dashboard now makes each displayed sample an exact action,
while aggregate action buckets remain aggregate.

Current local evidence:

- `npm.cmd run check`: passed
- procurement, supplier-catalog, and PO-editor regression gate: 84 files and 768
  tests passed; 14 skipped
- production build: passed; 3,604 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only

PR #939 merged as `e6a51464` on July 16 and deployed as Heroku v2401. Current
production v2402 contains subsequent merged PR #938. The authenticated UI smoke
remains outstanding.

## Verified supplier-evidence import slice

The readiness report found 32 useful candidates that all need supplier configuration,
but verified vendor quotes still had to be entered one mapping at a time. The current
slice adds a bounded CSV intake on Suppliers without guessing or sourcing commercial
values:

- one import file is explicitly scoped to one active supplier;
- the template accepts exact Echelon SKU, vendor SKU, quote basis, exact dollar quote
  with up to four decimal places, purchase UOM and pieces per UOM, quote reference and
  dates, MOQ in base pieces, lead time, and preferred status;
- CSV parsing is strict, supports quoted commas, rejects unknown/missing columns,
  incoherent per-piece/UOM fields, invalid dates/integers/booleans, files over 1 MB,
  and batches over 200 rows;
- preview is read-only and resolves an exact active receive variant or an unambiguous
  product-level SKU. Product SKUs with active variants fail closed and require the
  exact variant SKU;
- the preview shows creates, updates, inactive-row reactivations, all preferred-vendor
  demotions, exact normalized mills, quote evidence, lead time, MOQ, and warnings;
- the preview hash includes normalized requested values plus the current target and
  competing preferred mapping fingerprints, so changed evidence or catalog state
  requires another preview;
- apply requires the exact preview hash, an idempotency key, purchasing-edit
  permission, and an explicit browser confirmation;
- apply reuses the existing single-supplier catalog batch writer, so reference locks,
  quote validation, preferred demotion, reactivation, creates/updates, and structured
  audit events commit atomically; and
- the import never creates a purchase order, changes approval policy, or treats an
  extended line total as reusable supplier pricing.

The preview loads only vendor mappings for the resolved product ids rather than the
entire supplier catalog.

Current local evidence:

- `npm.cmd run check`: passed
- focused import/server/client contract gate: 4 files and 34 tests passed
- procurement, supplier-catalog, and PO-editor regression gate: 86 files and 778
  tests passed; 14 skipped
- production build: passed; 3,606 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only

## Historical PO supplier-evidence recovery slice

The production database already contains completed purchase orders with actual
supplier, product/variant, received quantity, and unit-cost evidence. The current
slice uses those records rather than requiring operators to re-enter known history.

The backfill is preview-only by default. Apply requires all of:

- `--execute`;
- an existing application user supplied through `--actor`;
- the exact SHA-256 hash returned by the current preview; and
- the same explicit vendor exclusions used during preview.

The preview hash fingerprints the selected PO evidence, current vendor-product
mapping/evidence state, line links, conflicts, and exclusions. Apply recomputes that
state under a transaction-scoped advisory lock and rolls back if anything changed.

For each active supplier/product/configuration key, the backfill:

- selects the latest completed received/closed PO;
- weights exact unit mills by actual received quantity;
- preserves sub-cent prices, including values whose compatibility cents mirror is
  zero;
- rejects actual zero/placeholder costs;
- creates a missing mapping as active, non-preferred `legacy_unknown` evidence
  without inventing quote basis, quote dates, UOM, MOQ, lead time, or preference;
- updates only `last_purchased_at`, exact `last_cost_mills`, and the rounded
  `last_cost_cents` compatibility mirror on existing mappings;
- links only currently unlinked completed PO lines;
- never overwrites a conflicting legacy line link; and
- writes attributable audit evidence in the same transaction.

Migration 144 adds exact `vendor_products.last_cost_mills`, backfills existing cents,
and enforces a database mills/cents mirror constraint. Recommendation economics now
prefer exact last-paid mills for `legacy_unknown` mappings while continuing to prefer
a verified explicit per-piece or per-UOM quote when one exists.

The CLI accepts repeated `--exclude-vendor-id=ID` flags. Production preview excludes
vendor 101, named `Test Vendor`, without hardcoding that identity into application
logic.

### Production read-only preview

The final read-only preview on July 16 returned:

- 21 validated supplier/product/configuration targets;
- 5 mappings to create;
- 16 existing mappings to update with last-purchase evidence;
- 16 unlinked historical PO lines to link;
- 2 conflicting legacy line links left untouched and explicitly reported; and
- 1 zero-cost placeholder target excluded.

The two conflicts are:

- PO line 153: product 5 / variant 206 is linked to vendor-product 25 for product 102;
- PO line 163: product 103 / variant 207 is linked to vendor-product 11 for product 39.

PR #943 merged as `b59398f8`, passed both CI jobs, and deployed as Heroku v2405.
Migration 144, `last_cost_mills`, and the validated precision constraint were
verified in production.

The owner then approved the fresh post-deploy preview hash with vendor 101 excluded.
The production apply committed:

- 5 mappings created;
- 16 mappings updated with exact last-purchase evidence;
- 16 historical PO lines linked;
- 2 conflicting legacy links skipped;
- 1 zero-cost placeholder line excluded; and
- 21 attributable source-evidence audit events.

The first post-apply verification exposed a four-hour shift in
`last_purchased_at`. All relevant source and target columns are PostgreSQL
`timestamp without time zone`; converting the source through a JavaScript `Date`
and then writing an ISO timestamp changed the stored database wall-clock value on
this Eastern-time workstation.

The repair was bounded to the exact 21 vendor-product IDs written by the approved
backfill. One advisory-locked transaction recomputed each timestamp from its audited
source PO/line columns, corrected all 21 rows, and wrote 21
`vendor_catalog.historical_purchase_timestamp_repaired` audit events. Read-only
verification then reported 21 evidence rows, zero timestamp mismatches, and 21
repair audits. Costs, mappings, PO-line links, exclusions, and conflicts were not
changed by the repair.

The follow-up code bumps the backfill contract to version 2 and serializes source and
current `timestamp without time zone` values as canonical database wall-clock text.
Preview hashes and apply parameters are therefore deterministic across workstation
and Heroku timezones, and no JavaScript timezone conversion occurs.

After PR #944 deployed, the two remaining vendor/product conflicts were reviewed
against their PO headers, line products, receive variants, receipts, invoices,
receiving rows, landed-cost snapshots, and the newly created exact mappings. They
were the only vendor/product mismatches in production. One locked transaction
repointed:

- PO line 153 from vendor-product 25 to 125; and
- PO line 163 from vendor-product 11 to 124.

Both changes were recorded as
`purchase_order_line.vendor_product_link_repaired`. The old mappings remain in use
by their correct products on other POs and were not changed. Post-repair verification
reported zero vendor/product mismatches and a contract-v2 backfill preview with zero
conflicts and zero pending writes.

Migration 146 adds database enforcement matching the application command boundary:

- a PO line may link only an active mapping for the PO vendor, line product, and
  selected receive configuration;
- changing a PO vendor cannot invalidate linked supplier provenance; and
- a linked vendor-product mapping cannot be reassigned to another vendor, product,
  or incompatible variant.

Production also contains 11 separate legacy lines whose vendor and product are
correct but whose product-level PO rows do not persist the variant-specific receive
configuration carried by their vendor-product mappings. Migration 146 does not
rewrite those historical rows. It prevents new writes from repeating that state;
the 11-row receive-configuration remediation remains a separate reviewed slice.

## Legacy PO receive-configuration remediation slice

The new command is preview-only by default:

```text
npm run procurement:remediate-legacy-po-receive-config
```

Apply requires `--execute`, an existing application user through `--actor`, and the
exact SHA-256 preview hash. It recomputes the full evidence under a transaction-scoped
advisory lock and rolls back if any line, supplier mapping, catalog variant, receipt,
or replacement mapping changed.

The command distinguishes the PO's expected supplier configuration from what was
actually received:

- an active linked supplier mapping is the expected receive configuration even when
  a partial receipt arrived in a different pack size;
- an archived variant remains valid historical PO identity when no receipt supersedes
  it;
- an archived mapping is relinked only when non-cancelled receiving rows, exact
  base-piece receipt quantities, ordered-quantity divisibility, one active variant,
  and one active supplier mapping all identify the same replacement; and
- inactive supplier mappings, cross-product variants, invalid pack quantities,
  ambiguous receipt variants, incomplete receipt arithmetic, and missing replacement
  mappings fail closed.

Each successful line update writes
`purchase_order_line.receive_configuration_recovered` with before/after state, the
approved preview hash, decision basis, supplier mapping identities, exact receiving
evidence, and warnings in the same transaction.

The production read-only preview on Heroku v2408 found exactly 11 candidates:

- 11 safe and zero blocked;
- 10 lines to stamp from their linked supplier mapping;
- 1 line to relink from archived 700-count mapping `1` to the existing active
  750-count mapping `67`, supported by 432 received cases and exactly 324,000 base
  pieces;
- 1 partial receipt where the PO expected 1,000-count cases but the shipment arrived
  in 500-count cases; the command preserves the expected 1,000-count PO configuration
  and leaves the actual receipt untouched;
- 1 open line whose 1,000-count expected variant is now archived; the archived
  identity is preserved because no receipt or successor mapping contradicts it; and
- 5 lines without receiving evidence, all with active linked mappings and order
  quantities exactly divisible by their mapped pack size.

Preview hash at investigation time:
`5648249b62f8da26818a0cef626c0e9a993a35017e2dd5595577c10aa409c67d`.
This hash is evidence only and must be regenerated after deployment before any apply.
No production rows were changed during development.

Current local evidence for this remediation slice:

- `npm.cmd run check`: passed;
- focused CLI/service gate: 2 files and 7 tests passed;
- procurement regression gate: 84 files and 744 tests passed; 21 skipped;
- writer-ratchet gate: 2 tests passed;
- production build: passed; 3,605 client modules transformed and the server bundle
  built;
- `git diff --check`: passed, with Windows line-ending notices only; and
- a disposable PostgreSQL 16 integration suite is wired into CI to apply migration
  146 over legacy fixtures and prove the guarded 10-stamp/1-relink transaction,
  exact audits, and zero-candidate postcondition. It compiles and intentionally skips
  locally without the explicit disposable-database environment.

### Validation evidence

- `npm.cmd run check`: passed
- focused service, CLI, migration, recommendation, writer-ratchet, and
  migration-prefix gate: passed
- procurement regression gate: 85 files and 760 tests passed; 19 skipped
- production build: passed; 3,605 client modules transformed and server bundle built
- `git diff --check`: passed, with Windows line-ending notices only
- a disposable PostgreSQL 16 integration suite is wired into CI to apply migration
  144 and prove exact sub-cent evidence, zero-cost exclusion, atomic mapping/link/audit
  writes, and database mirror enforcement; it compiles and intentionally skips
  locally without the explicit disposable-database environment

## Recommended next implementation order

1. Review and merge the legacy PO receive-configuration remediation workflow.
2. Verify the deploy and run a fresh production preview.
3. With explicit owner approval, apply the exact reviewed hash once, then verify
   zero remaining candidates, all 11 line snapshots, the single mapping relink,
   unchanged receipt rows, and 11 audit events.
4. Complete an authenticated read-only
   smoke of Purchasing -> Supplier Setup Gaps ->
   exact Suppliers task and Purchasing -> Forecast Input Gaps -> exact review task.
5. Use the verified import or exact single-mapping tasks to correct supplier catalog,
   lead-time, quote, receive-variant, and demand-evidence gaps only from verified
   business evidence; do not weaken approval policy.
6. When the readiness report identifies a genuinely eligible low-risk SKU, run and
   save its exact-SKU preflight and obtain explicit owner approval.
7. Execute the one-SKU pilot once and complete the verification/lifecycle runbook
   before considering any wider unattended purchasing policy.

Autonomous dead-command replay remains deferred. Encrypted request snapshots and a
versioned executor registry do not currently justify replacing the safer exact-caller
retry model.

Keep manual quote pricing marked `manual` even when the same quote is optionally
saved to the vendor catalog. Extended-total quotes remain PO-specific and must not be
written as reusable catalog economics.

## Resume prompt

> Read the purchasing handoffs dated July 12, 13, and 14. Pull current `origin/main`,
> verify the branch/PR/deployment state, and continue from the highest-priority
> unverified item. PR #939 is merged and deployed as Heroku v2401; current production
> has subsequently advanced to v2402. The production readiness report found 32
> candidates, zero eligible, and no automatic-purchasing writes; all 32 require
> supplier configuration plus demand review. Review the merged supplier-remediation
> and exact demand-review flows, the current verified supplier-evidence import branch,
> and the pilot runbook. Do not invent supplier data, weaken policy, or execute a
> production pilot without an eligible exact-SKU preflight and explicit owner
> approval.
