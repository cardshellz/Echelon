# Physical-line shipping authority: order 63085 regression

## Outcome and scope

Code fix only. No production orders, shipment history, inventory, Shopify records,
emails, retry rows, or deployed configuration were changed by this work.

The change is isolated on `codex/physical-line-shipping-authority`, updated to
`d195bad00` before publishing. Unrelated catalog changes in the primary checkout
were not included.

A sales-channel fulfillment is a commercial receipt. It cannot, by itself, create
a warehouse package or prove that physical order lines shipped. Exact matches to
shipping-engine package evidence continue through the existing fulfillment path.
This follows the requested authority boundary, not an inferred business rule.

## Confirmed failure path

The retained investigation for order 63085 found four physical lines with no picks
or shipment records. Its nonshipping donation had been fulfilled by Shopify Flow.
The former `findOrCreateLegacyPackage` fallback in
`server/modules/oms/channel-fulfillment-ingress.repository.ts` created a shipped
compatibility package from that donation receipt. The former
`recomputeOrderStatusFromShipments` in `server/modules/orders/shipment-rollup.ts`
looked only at existing shipment headers, not uncovered physical order lines.
That let one donation package make the entire WMS order appear shipped.

The retained retry evidence separately showed an earlier OMS/WMS handoff failure:
"Authority-aware inventory reservation failed before shipment processing."
The underlying cause was not retained. This change does not claim to identify or
fix that unknown cause, or to prove that order 63085 is now exported.

## Changes and contracts

- `prepareReceipt` in `channel-fulfillment-ingress.repository.ts` retains donation
  and other nonshipping receipt lines without creating warehouse packages.
  Physical receipts with no matching engine evidence go to the existing review
  exception path; they cannot invent picks, cancel engine shipments, or move stock.
  Old channel-created packages are not accepted as engine proof on a new callback.
- Mixed receipts match their physical subset against engine evidence while
  retaining every original receipt line. `attachPhysicalShipment` requires a
  physical binding for physical lines, not for the donation. A missing or invalid
  physical binding still rolls back.
  An approved replay can attach previously missing engine bindings, but cannot
  change receipt quantities, order-line identities or existing package bindings.
- `deriveWmsShippingProgress` in `shared/wms-shipping-progress.ts` requires shipped
  coverage on every remaining physical line. Extra units on one line cannot cover
  another; a missing/cancelled/voided package cannot discharge a backorder. Actual
  cancelled/refunded quantities are excluded using existing line authority.
  Legacy lines without OMS authority retain their WMS quantity requirement.
- `wmsShippingProgressQuery` reads only affected orders, using indexed item/plan
  lineage. Canonical package quantities supersede compatibility source quantities
  instead of adding to them, including voided or corrected-to-zero packages.
  Channel-created receipt packages and replacement-only items are excluded.
- `recomputeOrderStatusFromShipments` and `projectPhysicalShipmentToWms` use that
  same line policy and evidence reader. They lock affected orders before reading
  coverage, so concurrent package updates cannot overwrite completion using an
  older snapshot. The projector preserves pick history when shipping quantities
  are corrected; it does not perform an inventory adjustment or automatic unpick.
- `getPickQueueOrders` in `server/modules/orders/orders.storage.ts` no longer
  marks orders shipped or cancels packages from a page read. Other existing pick
  lifecycle repair behavior is unchanged; this is not a rewrite of every page.
- `describeWmsSyncFailure` and the OMS/WMS retry worker retain bounded nested error
  codes/messages instead of losing the reservation cause. Query text, parameters,
  credential URLs and credential assignments are redacted.

No migration, new review page, new job, notification policy, carrier-possession
rule, inventory-authority cutover, or sales-channel label-time policy was added.
Unused legacy convenience status APIs are not reworked in this change; this is
not a database-wide prohibition on every privileged status writer.

## Validation

- Full unit command (`vitest run unit --maxWorkers=4`) on base `583713b02`:
  13,972 passed, 39 skipped; no failures. Two unchanged migration files were temporarily normalized to LF
  for their pre-existing exact-newline assertions on Windows; no migration
  content change is included.
- Final focused pass after the last validation/projection refinements: 627 passed
  across 44 files, including the shared domain policy and real database regression.
- Four PostgreSQL suites: 155 passed, none skipped. Breakdown: 16 physical-line
  progress, 17 receipt preparation, 16 exact/mixed echo preparation, and 106
  package-allocation ledger tests. These include actual migration-defined package
  constraints and effective-quantity views, split quantities, partial refunds,
  duplicate suppression, zero corrections, real lock contention and rollback.
- The new database suite is in the CI PostgreSQL manifest and shard guard.
- Publishing check on current main (`d195bad00`): 427 focused tests passed,
  none skipped, including migration-prefix, writer-ownership and CI shard guards.
- Final production and server-test TypeScript checks passed. The production
  client/server/job build passed (existing large-client-chunk warning remains).

The PostgreSQL tests use local disposable databases, never production credentials.
Provider HTTP behavior is mocked in the existing shipping ledger tests; passing
tests are not production deployment or provider readback evidence.

## Deployment and recovery boundary

1. Merge/deploy the code and confirm the deployed revision.
2. Read current order 63085, its physical line quantities, engine records, and retry
   evidence again. Do not reuse the historical snapshot as proof of current state.
3. Prepare an exact repair preview for its false header and failed handoff. Obtain
   approval before any production recovery. Preserve receipt/package audit
   history; do not fabricate picks, shipping proof, inventory movements or emails.
4. Verify the actual engine request and its physical line coverage after recovery.
   If the reservation fails again, use the newly retained cause to address the
   actual blocker rather than bypassing reservation or inventing stock.

Behavior change to watch: physical channel receipts lacking local engine evidence
now remain review exceptions. Their engine evidence must be reconciled through
the existing review/replay workflow; merely receiving the channel event again
does not automatically reopen a terminal review receipt.
