# Purchasing Hardening Handoff - 2026-07-14

This continues:

- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`
- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-13.md`

The July 13 quote-pricing work is merged in PR #914. PR #917 subsequently
merged durable transactional command results for ordinary PO-line mutations
and browser retries that preserve one key per user intent. This document now
also records the next local slice: atomic PO plus optional vendor-catalog
persistence.

## Working state

- Worktree: `Echelon-purchasing-hardening`
- Branch: `codex/purchasing-po-catalog-atomic-2026-07-14`
- Base and current `origin/main`: `60e67587`
- Base hardening slice: merged PR #917
- Deployment status: PR #917 is live on Heroku release v2377; this new slice is not deployed
- Migration 136 status: applied and verified in production
- Commit/PR status: atomic PO/catalog changes are local; not committed, pushed, or opened as a PR

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

## Recommended next implementation order

1. Review and publish the atomic PO/catalog slice as one focused PR.
2. Execute the still-outstanding real-PostgreSQL command-ledger integration gate.
3. Add a durable PO-email outbox with immutable content snapshots, deduplication,
   leased workers, retry/backoff, provider message identity, dead-letter visibility,
   and operator replay. Current lifecycle `send` does not itself deliver email, while
   the separate email route performs a synchronous SMTP call and records history
   afterward.
4. Migrate the next financial commands to the ledger in small reviewed groups.
5. Add command-ledger operator monitoring, retention, and dead-letter replay tooling.
6. Run the controlled low-risk automatic-purchasing pilot from the earlier handoffs.

Keep manual quote pricing marked `manual` even when the same quote is optionally
saved to the vendor catalog. Extended-total quotes remain PO-specific and must not be
written as reusable catalog economics.

## Resume prompt

> Read the purchasing handoffs dated July 12, 13, and 14. Pull current `origin/main`,
> verify the branch/PR/deployment state, and continue from the highest-priority
> unverified item. Migration 136 is live, but never infer that the disposable
> PostgreSQL integration suite passed from local unit/build evidence. Do not mutate
> production without explicit owner approval.
