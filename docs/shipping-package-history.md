# Historical packages and ongoing capture

## Ownership and scope

`PackageHistoryWorker.run` captures original outbound package facts for configured
Shopify channels using ShipStation. `createPackageHistorySource` reads OMS line
identity, the existing Shopify snapshot reader, and bounded ShipStation GET
requests. It does not run a return review or replay fulfillment ingestion.

`buildPackageHistory` requires exact native order/customer/line identities,
tracking, a unique active outbound label, and conservation of the whole native
fulfillment quantity. Owned `wms-item-*` aliases support normal engine shipments;
exact native line IDs support legacy shipments without repaired WMS links.
Matching a SKU alone is insufficient. Memberships do not acquire physical boxes.

This implementation covers Shopify orders represented in OMS and ShipStation
shipments identifiable by native tracking and line evidence. It cannot recover
deleted/unavailable provider facts, guess missing sizes, or prove shipments from
other providers. Those gaps remain visible in status, rather than being counted
as verified measurements.

## Durable flow

1. `PackageHistoryBackfillRepository.seed` fixes a channel/run high-water order ID
   and creates at most 200 jobs per transaction. Its cursor advances in the same
   transaction. Repeating the command resumes without duplicating jobs.
2. `PostgresPackageHistoryStore.claim` leases at most two jobs per normal sweep.
   Source events and initial history each receive capacity; either can borrow an
   unused slot. Concurrent workers use row locks and skip leased work.
3. The worker rechecks native and local facts after provider reads. Renewed leases,
   generations and pending source events prevent a superseded result publishing.
4. `complete` atomically writes an immutable evidence event and current pointer.
   Repeated identical evidence reuses the same unique event. A failed publication
   rolls back the event and pointer together. Cache invalidation calls the
   customer-account module's published `invalidateCustomerOrderActions` API with
   the same transaction, so the owning module remains the only queue writer and
   invalidation failure rolls back the shipping publication too.
5. `projectHistoricalReturnBoxes` verifies that saved evidence still matches the
   current native package facts and local line ownership. It supplies the existing
   return box-options contract. Existing canonical packages retain precedence.

Facts in this projection never enter picking, shipment/inventory posting,
financial journals, points, carrier dispatch, or channel writeback. The separate
shipping dimension ingestion already retains provider-reported measurements on
ordinary shipping labels. History can reuse those verified measurements when a
later provider response omits them; explicit invalid measurements cannot be
overridden with an older value.

## Future shipments

The migration installs source-event invalidations for orders and lines, provider
labels/events/links, physical packages/items, native fulfillment receipts and
channel connection changes. They append queue events without locking a derived
job row. The normal server scheduler drains them; future orders do not need a
historical seed command. This respects the application's existing scheduler
disable control and requires configured ShipStation credentials.

Original box measurements do not expire on a daily timer. Source changes enqueue
reverification; current native facts and known local label contradictions guard
return reads. Delivery timestamps remain in evidence but do not change package
identity or contents. Return eligibility and command authorization remain owned
by the existing returns flow.

## Failures and retries

Transient API/source-change failures use bounded exponential retries, up to eight
attempts. Crashed workers lose their lease after five minutes. Ambiguous identity,
quantity mismatch, invalid source evidence, and exhausted retries enter `review`
with a `PACKAGE_HISTORY_*` code. No dimensions are offered from pending, invalid,
superseded or contradictory evidence. The customer can enter their actual box
dimensions instead.

`retry-review` explicitly requeues a reviewed channel/run scope after its source
problem is corrected. It does not edit the order, repair WMS relationships or
adjust a balance. New source events also requeue affected jobs.

`status` returns a consistent read-only database snapshot with cursor, source
coverage, unseeded orders, active leases, ready/pending/retry/review counts,
measurement quality and error codes. `seeded` means scanning has finished, not
that every package has verified dimensions. An order with zero package evidence
is reported separately from an order with measured packages.

## Operator commands

The following are templates. Replace the explicit channel and actor values only
after verifying the target environment. Commands without `--execute` only validate
arguments and print scope; they do not open the database or contact a provider.

```powershell
npx tsx scripts/backfill-shipping-package-history.ts --channel-id CHANNEL_ID --actor OPERATOR --mode seed --run-key history-v1 --batches 10
```

After deployment and approval for the target database, add `--execute` to seed.
The normal worker processes the queue; `--mode run --batches 10 --execute` can
process bounded batches explicitly in the selected channel. Use
`--mode status --execute` to inspect coverage and `--mode retry-review --execute`
to requeue reviewed gaps. Batches are bounded to 1–1000. A new run key takes a new
high-water snapshot; existing jobs remain shared and are not duplicated.

Before claiming historical completion, inspect unseeded/pending/retry/review and
measurement counts, resolve every recoverable gap, and sample saved evidence
against provider facts. A code deployment, seeded cursor, or green fixture test
alone does not establish live historical coverage.

## Validation boundary

The integration suite uses a dedicated disposable PostgreSQL database and
fictional Shopify/ShipStation records. It exercises the real migration, source
adapter, queue repository, worker, saved read port and live returns service.
Protected fixture tables reject source/balance writes, and fingerprints verify
they remain unchanged. The balance sentinels are synthetic, not a claim of testing
against a live Club ledger.

The suite covers cursor rollback/resume, exact legacy and owned line mapping,
multiple shipments, provider throttling, replay, concurrent workers, expired
leases, stale generations, immutable evidence, publication rollback, source
invalidations, scoped retries, fair scheduling and return box defaults. Browser
tests exercise the compiled account bundle with intercepted fictional APIs.
These checks establish local staging behavior; live completeness and actual
provider availability require a separate approved rollout and coverage audit.
