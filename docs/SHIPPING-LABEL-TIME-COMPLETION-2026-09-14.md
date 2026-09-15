# Label-time Shopify fulfillment: current completion checkpoint

## Outcome and boundary

The shipping finish line is reliable fulfillment of each package on its
originating sales channel when its outbound label is created. Carrier possession
is a separate event. Ordinary split orders, partial shipments and backorders are
normal cases, not one-off exceptions to repair individually.

This branch fixes a general label-time split gap and its transaction race. It
does not claim the production backlog is corrected. No production records,
inventory, provider fulfillments, flags or credentials were changed in this turn.
The original dirty checkout remains untouched; implementation is isolated on
`codex/shopify-label-split-completion-20260915`, based on main
`b099a84dd639ee767ab03efadfaf2b88532cacbf`.

## Proven code path and correction

1. `createShipStationService.processShipNotify` in
   `server/modules/oms/shipstation.service.ts` requests shipment items, records
   the label and calls `PackageAllocationLabelCommercialFulfillmentService.process`.
   It does not require a carrier-possession event for commercial fulfillment.
2. `resolvePackageAllocationAuthority` in
   `server/modules/shipping/package-allocation-authority-resolution.domain.ts`
   previously recognized later split portions only from persisted WMS split-child
   evidence. The legacy split creation path runs later through dispatch handling;
   a newly created label can already identify an exact portion before those rows
   exist. That is a general timing gap, not an order-number-specific rule.
3. `labelSplitContinuation` now accepts exact authoritative outbound ShipStation
   label contents for a subsequent portion. It uses source item identity, never
   SKU similarity. Total accepted portions cannot exceed the original source
   quantity. Existing contradictory split evidence still blocks; it is not
   silently replaced. Equal label timestamps are deterministic when exact
   quantities fit.
4. `createPackageAllocationLabelCommercialWorkflow` in
   `server/services/package-allocation-label-commercial-workflow.ts` owns one
   SERIALIZABLE transaction for plan persistence, physical/OMS/WMS projections,
   command materialization and activation. The concurrent-label regression
   exposed stale-plan rejection and stranded shadow commands when these steps
   committed separately. A failure now rolls back the whole unit; serialization
   conflicts/deadlocks retry the whole unit at most three times.
5. `0674_label_time_package_portions.sql` independently checks exact saved provider
   evidence and immutable allocation/command lineage at the database boundary.
   It retains historical WMS split validation and quantity limits. This migration
   replaces a validation function only; it contains no operational data backfill.
6. The existing channel worker executes committed commands through the existing
   exact-package provider adapter. No provider request is allowed inside the new
   database transaction. Replaying a label does not create another fulfillment.

The existing store/account, warehouse-location, cancellation, provider readback,
retry and review safeguards remain in force. Inventory posting is not added to
the label path. Missing contents or conflicting identity remains in the existing
Operations Tower workflow; no new review page or export button is introduced.

## Validation completed locally

- Full unit suite: 1,088 files passed, one skipped; 12,957 tests passed, 39 skipped.
- Shipping-ledger PostgreSQL integration suite: all 46 tests passed in a fresh,
  explicitly disposable local PostgreSQL 17 database, stopped after the run.
- TypeScript check and production build passed; diff whitespace check passed.
- Latest main was fetched after validation. Its final four-digit migration was
  `0673_shipstation_split_lineage.sql`; `0674` was free at this checkpoint. Recheck
  immediately before publishing/merging because other work continues concurrently.

The new database scenarios run raw ShipStation label handling through real owner
SQL and OMS/WMS projection into exact Shopify API requests. External ShipStation
and Shopify transports are mocked, not the activation transaction. They cover:

- Two one-unit packages for a two-unit order, in sequential, reversed and
  simultaneous arrival order; no carrier event or legacy split child is present.
- Two shipped units out of four ordered, with the remainder still unfulfilled.
- Replayed labels without additional provider requests or doubled projections.
- An injected failure after activation but before commit, complete rollback,
  then successful retry.
- A third unit beyond a two-unit order blocked from provider execution.
- Database rejection of missing provider contents, wrong source and wrong quantity.
- Zero inventory transactions; exact Echelon fulfilled quantities and partial/full
  order status after label processing.

Existing tests still exercise historical split proof, stored/live Shopify mapping,
same-SKU identity isolation, replacement/void handling and immutable replay.
The build chunk-size warning and PostgreSQL concurrent-client-query deprecation
warning remain visible; neither caused a test/build failure. These are local
results, not remote CI or live-provider acceptance.

## Broader production census, not just two orders

A read-only repeatable-read census was captured at
`2026-09-15T02:08:49.393Z` (September 14 local time). It examined the last 30 days
of active outbound ShipStation labels whose saved exact item identities resolve
to Shopify OMS orders:

| Echelon evidence | Labels | Distinct orders in that category |
| --- | ---: | ---: |
| No canonical Shopify command | 84 | 43 |
| Command exists, no recorded success | 9 | 9 |
| Canonical success recorded | 1,499 | 1,234 |

Separately, Shopify commands created in that window included 1,511 successes,
five `channel_fulfillment_lineage_mismatch` reviews and four
`shopify_push_package_state_conflict` reviews. Command and label cohorts are
different; these counts must not be added together. Orders can span categories.

The 84 labels are investigation candidates, **not 84 proven missing Shopify
fulfillments**. Legacy writeback may already have fulfilled some, and a missing
canonical command does not identify its cause. This census did not read live
Shopify. It also excludes older labels and labels without resolvable exact item
identity, so it is not a complete historical inventory of failures. Existing
open review rows can outlive successful command execution and are not reliable
missing-fulfillment counts on their own.

## Remaining acceptance and recovery

The user explicitly requested the backfill alongside PR publication on September
15. Recovering verified missing historical Shopify updates is required to close
this effort; deploying the forward fix alone is not completion. The backfill must
run after the corrected code and migration are verified live, not as a migration
side effect while the application is deploying.

1. Publish this one coherent patch, pass CI, merge/deploy, and verify the deployed
   commit and migration. No PR number or deployed SHA has been assigned here.
2. Observe real ordinary split labels before carrier pickup. Verify exact store,
   order line, quantity and tracking in Shopify itself, prompt command processing,
   and replay with no extra fulfillment. Do not use a previous successful replay
   as proof of a new label's end-to-end behavior.
3. Read back the broader candidate cohort against Shopify, including the known
   examples; group actual missing/blocked packages by cause. Retain legitimate
   unshipped/backordered quantities. Do not assume every candidate shares this bug.
4. Produce one grouped, exact recovery preview through the existing owner APIs.
   Obtain production-write approval for the identified records before applying.
   Repair only missing channel effects, not inventory or already-counted WMS
   shipped quantities. Re-read Shopify after recovery and reconcile stale reviews.

Historical unactivated shadow plans remain guarded; this change does not
retroactively authorize them or blindly requeue terminal reviews. Production
credentials, API timing, real backlog completion and cancellation behavior are
not proven by the local mocks. Those are acceptance checks, not another unrelated
system to build or a reason to detour into inventory/Dropship work.

### Backfill execution boundaries

- Read back each candidate package in its originating Shopify account using
  order-line identity, quantity and tracking. An existing exact fulfillment is a
  reconciliation case, not permission to send another fulfillment.
- Separate missing commands from existing failed/review commands. Replaying label
  evidence, creating missing canonical authority and retrying a reviewed command
  are different owner operations; do not substitute one for another blindly.
- `scripts/backfill-channel-fulfillment-authority.ts` defaults to a bounded
  dry-run but only discovers already-shipped legacy WMS packages. Its
  `buildCandidateQuery` does not cover every label-only candidate, and its
  `runBackfill` does not perform live Shopify readback. Do not treat this legacy
  script's output as a complete or provider-validated backfill preview.
- `previewChannelFulfillmentReviewRetry` in
  `server/modules/oms/channel-fulfillment-review-retry.domain.ts` explicitly
  reports `providerValidation: "not_performed"`. It supports only named review
  reasons. Unsupported cases remain classified for separate exact resolution;
  do not force their status to pending with SQL.
- Present the grouped preview in ordinary order/shipment/tracking terms, with
  exact item quantities and resulting changes. The user is not expected to read
  JSON or manually inspect every inventory lot.
- Apply approved missing channel effects through their audited owner operations
  in bounded batches, then read Shopify again. Preserve unshipped/backordered
  units, inventory balances and already-counted WMS fulfilled quantities.
