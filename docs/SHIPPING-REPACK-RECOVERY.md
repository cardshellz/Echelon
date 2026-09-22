# Shipping repack and independent void recovery

## Scope

One shipping-only batch. No inventory cutover, stock adjustments, catalog changes,
historical backfill, production writes, or new review page. Changes are isolated
on `codex/shipping-repack-recovery` using the clean-worktree workflow.

## Allocation contract

`planLabelReplacement` computes a connected package replacement set from exact
canonical source-item IDs, provider-order lineage, quantities and explicit voids.
For example, old A(2) can become B(1) + C(1), and the reverse also works.
The first half waits without moving units. Independent matching lineages remain
separate; changed provider-order identities can be admitted as a whole cohort
only when every predecessor is voided and all source totals balance.

`reconcileEbayLabelReplacement` discovers complete connected old packages and new
labels, locks all source rows in ID order, revalidates evidence, checks carrier
possession and Shopify cancellation receipts, and materializes the entire set in
one transaction. The historical function/table names serve both Shopify and eBay.
Bounds are 100 new labels, 500 source/items and 20 discovery expansions. Exceeding
a bound produces review, never admission from a truncated set.

Migration `0697_shipping_repack_recovery.sql` adds an immutable applied batch ID.
Deferred constraints balance negative predecessor adjustments against all targets
for each source, fulfillment-plan line, order item and request item. The positive
side is checked too. No negative-only, half-finished or inflated transfer commits.
Original physical rows, quantities and request reservations remain auditable.
Old one-to-one receipts remain supported during rolling deployment. The obsolete
single-label quantity decision helper is replaced by the batch planner.

## eBay writeback contract and limits

Commands use their granted package quantities, not the whole WMS header quantity.
The adapter receives every active package in the same immutable batch, scoped to
the originating order/account, and only predecessor tracking from that batch.
Order-level advisory serialization covers normal and replacement command writes.

The original proven single-package/full-order amendment remains compatible.
Multi-package amendments use `CompleteSale.OrderLineItemID`, never `OrderID`.
Trading IDs come from `GetOrders`; REST and Trading lines must map uniquely through
the same provider listing ID and purchased quantity within the exact order.
No SKU/title matching or synthesized transaction identity is used. All unaffected
tracking on an amended line is retained. The full before/after REST package and
quantity set must match; an HTTP/XML acknowledgement alone is not success. Lost
responses are retried by reading first. Unsent batches use normal fulfillment
creation one member at a time after live quantity-capacity proof.

Important provider limit: CompleteSale marks the addressed line shipped. A line
with remaining unshipped/backordered units must not be amended this way. Such a
case is explicit `EBAY_TRACKING_PARTIAL_LINE_UNSUPPORTED` review. Missing package
quantities or ambiguous cross-API line identities also remain reviewable. These
are deliberate no-write boundaries, not fabricated successful fulfillment.

Provider references:

- [CompleteSale](https://developer.ebay.com/devzone/xml/docs/reference/ebay/CompleteSale.html)
- [GetOrders](https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetOrders.html)
- [Fulfillment API package limitations](https://www.developer.ebay.com/api-docs/sell/static/orders/handling-unfulfilled-lineitems.html)

External API calls cannot be one atomic transaction or lock out a seller editing
eBay independently. The adapter rereads before writing and verifies afterward;
changed or incomplete results stay retry/review, never acknowledged as complete.
The new contract is covered with mocked provider responses, not a claim of live
eBay sandbox or production acceptance.

## Sweeper recovery contract

The void scan commits each page's discovered label/order identities to
`oms.shipstation_label_recovery_work` in the same transaction as its checkpoint.
The queue also retains the tracking number so retries use ShipStation's documented
tracking filter, then select the exact shipment ID. The API does not document a
shipment-ID filter; an unrelated or truncated response never proves recovery.
[ShipStation List Shipments contract](https://www.shipstation.com/docs/api/shipments/list/).
Discovery can then continue independently of any one order's provider failure,
oversized history, invalid evidence or downstream processing failure.

Workers claim at most ten jobs per run using fenced five-minute leases and
`SKIP LOCKED`. Each order read is bounded to five pages of 100 labels; only one
order's raw contents are retained at a time. Completed void IDs avoid duplicate
order fetches within the run. Attempts are append-only and include actor, time,
outcome and a safe error code; raw provider payloads and credentials are not saved.
Transient failures back off from five minutes, capped at six hours. After eight
failed attempts, or an explicit size/invalid-page failure, the job stops for review.
Lease/receipt failures do not mark success or stall other jobs. An expired lease
can be reclaimed and safely replayed through the existing idempotent intake.

`SHIPSTATION_LABEL_RECOVERY_BLOCKED` appears in the existing Operations Tower
waterfall with ShipStation order ID, shipment ID, tracking and error code. A healthy
discovery checkpoint does not hide a failed job. Review receipts are not silently
reset by the daily overlap; investigate the exact error before any approved
operational recovery. Do not clear receipts or mark work complete merely to remove
an alert.

## Validation and release

Validated on 2026-09-22, with the shipping branch based on main `8d2cb07a4`:

- Full non-integration suite: **16,685 passed, 23 skipped, zero failures**.
- Full shipping allocation PostgreSQL suite: **132 passed**, no skipped cases.
  The final recovery-waterfall tracking read also passed a focused rerun.
- Application and server-test TypeScript checks passed; `git diff --check` passed.
- Migration-prefix and writer-ownership guards passed. Main already owns `0696`;
  this batch uses `0697`, which was free at the last main refresh.

The local Windows checks used ignored test configs to resolve exact locked
dependencies without modifying the shared `node_modules`. Seven untouched files
were temporarily normalized to LF for existing source-text assertions, then
restored to their original CRLF bytes; none belong to this change. The disposable
PostgreSQL process has been stopped. Production and external provider writes were
not run. No assumption that mocked eBay acceptance proves live acceptance is made.

Tests cover split/merge, full connected cohorts, untouched siblings, incomplete
batches, invalid quantities, late voids, carrier possession, duplicate events,
transaction rollback, concurrent admission, provider readback, lost responses,
backorders, XML validation, independent retry/backoff, expired leases, atomic
discovery handoff, immutable audit rows and real waterfall SQL.

Before opening a PR, refresh main and check the migration prefix again. Apply the
migration before starting the new release. Do not drop/reverse the migration or
delete immutable allocation history during rollback. An older app may not process
new eBay portion batches; retained review/retry evidence is preferable to an unsafe
quantity rewrite. After deployment, validate a controlled relabel/repack on each
channel against exact provider line quantities and tracking. No production
reprocessing or customer notifications are authorized by this implementation.
