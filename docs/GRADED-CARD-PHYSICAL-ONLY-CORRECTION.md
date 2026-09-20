# Graded-card physical-only correction tooling

## Purpose and deployment boundary

Retain the reviewed correction helper and database regression tests for graded
cards whose certificate-specific SKUs were incorrectly treated as interchangeable
pack sizes. `physical_only` makes each SKU promise only its own physical stock;
the correction does not change the ATP formula or create a new ATP engine.

This is **manual operator tooling**, not a migration, application startup hook,
scheduled job, or automatic graded-card classifier. Merging or deploying it does
not execute a correction. The owner-approved September 20, 2026 production
correction has already been executed; do not rerun it as a deployment step.

## Contract

Implementation: `scripts/lib/graded-card-policy-correction.ts`,
`GradedCardPolicyCorrection`.

1. Construct the helper with an explicitly selected PostgreSQL pool and clock.
   The caller owns credentials and must close its pool. There is no default
   target database, embedded credential, or embedded product selection.
2. Call `preview(selection)` with 1–200 unique, explicitly verified product IDs,
   SKUs, and names. Product names are identity checks, not classification rules.
   The read-only repeatable-read preview requires legacy runtime authority,
   inactive approved draft models, active/shippable/sellable one-unit variants,
   and no build recipes or recipe bindings.
3. Persist the entire preview, including its configuration fingerprint. Review
   the exact scope and obtain explicit authorization before constructing the
   command with a stable `operationId`, truthful `actor`, and `reason`.
4. Call `apply(command)` only after approval. Persist its result and progress
   events. Reuse the **identical command** for recovery; changing its fields
   while retaining its key is rejected. Do not generate a replacement preview
   or fresh operation ID merely to bypass a stale-state error.
5. Independently read back the selected catalog strategies, current draft
   definitions, reviews, variant flags, audit records, and authority. A fulfilled
   call is not evidence of third-party channel state.

## Writes and safeguards

`correctCatalog(command)` is the atomic first stage: it pins legacy authority,
locks the operation receipt, locks owner heads and products in ascending ID
order, locks variant references, and rechecks the complete frozen configuration.
It changes only the selected products' strategy to `physical_only` and
`updated_at`, recording before/after audit events and a durable receipt in the
same transaction. Audit failure rolls back the entire catalog batch. Eligibility
is checked again on supplied commands; a matching hash alone is not approval.

`apply(command)` then uses the existing master-data and review services to create
zero-path, zero-binding, non-building successor drafts. Old versions, conversion
paths, and reviews remain historical evidence. Inventory-managed successors are
reviewed; wholly untracked products remain `excluded_unmanaged` without an
ineligible approval. Tracking flags are never silently enabled.

Successor/review commands are separately transactional and idempotent. A failure
after the catalog stage leaves the completed physical-only catalog correction in
place and unfinished drafts requiring recovery; the whole workflow is **not** a
single transaction. A concurrent catalog command can receive PostgreSQL `40001`;
retry the same command after the conflicting transaction completes. Connection
or commit uncertainty likewise requires same-command recovery, not a new key.
If eligibility, identity, configuration, or authority changed, stop for review.

The helper does not write stock balances, lots, reservations, orders, variant
fields, recipe contents, safety stock, channel controls, publication outbox
entries, active model pointers, or runtime authority. It calls no provider API.
Changing the live legacy strategy can change ATP consumed by existing scheduled
channel publication; this is not a guarantee that remote quantities stay fixed.

This helper does **not** prevent future imports from misclassifying new graded
cards. Future data still needs the appropriate catalog inventory strategy.

## Verification

`server/modules/inventory-planning/__tests__/integration/inventory-availability-foundation.integration.test.ts`
contains the `graded-card correction` regressions, using a disposable PostgreSQL
database and migration-defined model/review constraints. They exercise actual
legacy ATP isolation, unchanged stock and tracking, historical preservation,
idempotent replay, partial-run recovery, invalid and stale inputs, concurrent
catalog calls, key reuse rejection, and audit-failure rollback. This suite is
already included in `scripts/ci/postgres-test-manifest.ts`.

The fixture drops/recreates its own schemas. Never point it at an operational
database: it requires both `ECHELON_TEST_DATABASE_URL` and
`ECHELON_TEST_DATABASE_DISPOSABLE=true`, and rejects the configured application
database URL. Server-test typechecking also compiles the imported helper.
