# Purchasing Hardening Handoff - 2026-07-14

This continues:

- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`
- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-13.md`

The July 13 quote-pricing work is merged in PR #914. This document records the
next local slice: durable transactional command results for ordinary PO-line
mutations and browser retries that preserve one key per user intent.

## Working state

- Worktree: `Echelon-purchasing-hardening`
- Branch: `codex/purchasing-command-idempotency-2026-07-14`
- Base and current `origin/main`: `e7a389a7`
- Base release fix: PR #913, Heroku `binpackingjs` startup recovery
- Deployment status: not deployed
- Migration 136 status: not applied
- Commit/PR status: local changes; not committed, pushed, or opened as a PR

Do not apply migration 136 or deploy this branch without owner approval. The
application code depends on the new table, so the release-phase migration must
succeed before new web dynos boot.

## Production recovery verified before this slice

Read-only checks on July 14 confirmed:

- Heroku release v2376 runs commit `e7a389a7`.
- `web.1` remained up after the PR #913 release.
- The live root URL returned HTTP 200.
- Recent logs showed normal work rather than the earlier restart loop.
- No production data or configuration was mutated during this continuation.

This verifies recovery from the startup incident; it does not verify the local
command-results implementation.

## Implemented locally

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

## Rollout and observability requirements

Before production:

1. Run the seven command-result integration tests against a disposable PostgreSQL 16
   database.
2. Review the migration lock/DDL plan and confirm the Heroku release phase applies
   migration 136 before web startup.
3. Deploy during a monitored window and smoke-test fresh success, exact success
   replay, exact rejected replay, payload conflict, and active-lease retry.
4. Monitor `claimed`, `retryable`, and `dead` rows plus lease age and attempt count.
5. Add a scheduled retention purge for rows past `expires_at`; the schema has the
   retention timestamp/index, but no purge worker exists yet.
6. Add an operator view/replay procedure for dead commands before migrating more
   financial routes.

Do not run the new integration suite against production.

## Recommended next implementation order

1. Review and publish this command-results slice as one focused PR.
2. Execute its real-PostgreSQL integration gate and deployment rehearsal.
3. Make PO creation/update plus optional vendor-catalog save one server transaction.
   The client should send one catalog directive, and the server should derive catalog
   economics from the authoritative PO line rather than accept a duplicate payload.
4. Add a durable PO-email outbox with immutable content snapshots, deduplication,
   leased workers, retry/backoff, provider message identity, dead-letter visibility,
   and operator replay. Current lifecycle `send` does not itself deliver email, while
   the separate email route performs a synchronous SMTP call and records history
   afterward.
5. Migrate the next financial commands to the ledger in small reviewed groups.
6. Run the controlled low-risk automatic-purchasing pilot from the earlier handoffs.

Keep manual quote pricing marked `manual` even when the same quote is optionally
saved to the vendor catalog. Extended-total quotes remain PO-specific and must not be
written as reusable catalog economics.

## Resume prompt

> Read the purchasing handoffs dated July 12, 13, and 14. Pull current `origin/main`,
> verify the branch/PR/deployment state, and continue from the highest-priority
> unverified item. Never infer that migration 136 ran or that the PostgreSQL suite
> passed from the local unit/build evidence. Do not mutate production without explicit
> owner approval.
