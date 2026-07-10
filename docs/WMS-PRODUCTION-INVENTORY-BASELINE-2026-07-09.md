# WMS Production Inventory Baseline - 2026-07-09

## Scope And Method

This is the pre-remediation production baseline for the WMS inventory subsystem.
It was captured at `2026-07-09T23:40:54.311Z` with
`scripts/audit-wms-inventory-integrity.ts` against PostgreSQL 17.9.

The run used one `REPEATABLE READ, READ ONLY` transaction, bounded samples,
transaction-local timeouts, and an unconditional rollback. Before the data scan,
all 31 audit queries were prepared successfully against the production catalog.
No production row was inserted, updated, deleted, or locked for mutation.

The raw baseline is retained locally as
`%TEMP%\wms-inventory-baseline-2026-07-09.json`. It contains internal IDs and
must not be committed.

## Executive Result

The audit found 31 checks, 1,773 blocker rows, and 25,888 warning rows. Those
counts are not interchangeable: some are current materialized-balance failures,
some are missing database controls, and some are historical records that predate
the current ledger contracts.

Production data must not be bulk-corrected yet. Current writers must be made
owner-aware and replay-safe first, otherwise cleanup can either recur or release
inventory attributed to another order.

The gated execution plan is documented in
`docs/WMS-INVENTORY-STABILIZATION-AND-REMEDIATION-PLAN.md`.

### Durable Registry Watermark

Release `v2321` deployed the lifecycle registry. The first complete production
watermark was persisted as run `864c28b7-f8c8-4146-963d-1e89ae02e099` at snapshot
`2026-07-10T09:10:06.971Z`: 31 checks, 1,773 blockers, 25,888 warnings, and 27,661
findings. The immediate post-write dry-run classified all 27,661 as `unchanged` and
classified zero findings as new, worsened, recurred, or resolved. This is the baseline
for detecting discrepancies introduced after stabilization begins; it does not
authorize correction of historical rows.

## Current Material Risks

### 1. Terminal orders retain live reservation ownership

- 55 shipped WMS orders have 66 lines with 118 signed reservation units still open.
- Every affected order was updated between July 3 and July 9.
- 34 lines have no pick row (52 units).
- 23 lines have a pick row that consumed zero reservation (46 units).
- 9 lines consumed only part of their reservation (20 units).
- Signed reservation recording cut over at `2026-07-03T06:33:32.457Z`.
- The last unsigned reservation-affecting row was
  `2026-07-03T05:23:37.976Z`; there have been zero unsigned rows since July 4.

This is a current writer/lifecycle defect, not a pre-cutover artifact.

The code path explains the result:

- `InventoryUseCases.pickItem` consumes `min(level.reservedQty, pickQty)` from a
  shared location counter. It does not prove that the reservation belongs to the
  order item being picked.
- `ReservationService.releaseOrderReservation` computes an order-owned amount,
  but then searches every level for the variant and decrements shared counters;
  it does not materialize or lock an order-item/location allocation.
- `markOrderShipped` changes order status only. Cancellation and `completed`
  have release wrappers, but shipping has no equivalent residual-release path.

Required design change: introduce durable reservation allocations keyed by order,
order item, variant, warehouse, and location. Reserve, pick, unpick, release, and
terminalization must update that owner record, aggregate level counters, lots, and
the append-only ledger in one transaction. Shipping, cancellation, and completion
must all enforce a zero-open-reservation postcondition through one idempotent
terminalization use case.

### 2. FIFO lots do not reconcile to materialized inventory

- 141 variant/location cells differ between `inventory_levels` and the sum of
  `inventory_lots`.
- 41 cells differ on on-hand by 272 absolute units.
- 49 cells differ on reserved by 555 absolute units.
- 122 cells differ on picked by 1,164 absolute units.
- 15 lots have negative on-hand totaling -165 units.
- Materialized inventory levels themselves have zero negative quantity buckets.

`InventoryLotService` defines `inventory_levels` as the fast aggregate of all
lots and states that both are updated atomically. These rows violate that explicit
contract. The negative lots also make FIFO availability and COGS attribution
untrustworthy even where the aggregate level is non-negative.

Required design change: inventory mutations must pass through one transaction
boundary that locks the owner allocation, aggregate level, and affected lot rows;
applies guarded deltas; writes immutable movement events; and validates aggregate
equals lot sums before commit. Existing data can be compensated only after every
writer is on that path.

### 3. Database controls do not enforce the application contract

- Missing non-negative checks: `reserved_qty`, `picked_qty`, `packed_qty`, and
  `backorder_qty` on `inventory.inventory_levels`.
- The posted inventory journal has no immutable-row trigger.
- The existing non-negative `variant_qty` and reserved-at-most-on-hand checks are
  present, which is why aggregate levels remained non-negative while lot rows did
  not.

Constraints and immutability guards must be added only after compatible repair
operations use compensating entries rather than updating posted ledger rows.

### 4. Current conversion events are not operation-addressable

- 1,166 case-break/assembly adjustment rows have no shared operation identity.
- 100 of those rows were created in July, so this remains a current gap.

Source decrement, target increment, remainder, actor, and inherited cost cannot be
proved to belong to one conversion from the persisted rows. A conversion operation
header plus unique child events is required before conversion repair or replay.

### 5. Small but actionable workflow violations

- Two completed cycle counts still contain pending items.
- One blocked `inline` replenishment task remains open with `source_empty`.
- Two operator-controlled adjustments have no actor; one was created July 9.
- Two variant hierarchy links are invalid: one points from a 24-unit box to a
  100-unit case and one links equal 5,000-unit variants.
- Two products have multiple variants marked as active base units.

## Historical Or Classification-Required Findings

These rows require preservation and classification, but they do not by themselves
prove a current writer is still producing the same defect:

- 300 ledger arithmetic mismatches are all February pick rows whose
  `variant_qty_delta` is zero while before/after changed.
- 24,717 reservation-affecting rows lack `reserved_qty_delta`; all predate the
  July 3 signed-delta cutover.
- 357 active-status pick/ledger gaps are all `completed` orders; only one line was
  created in the last 30 days.
- 859 active-status pick/COGS gaps are all `completed` orders; only three lines
  were created in the last 30 days.
- 25 closed receipt/ledger gaps are concentrated in March through May; 22 are
  March cells, two April cells, and one May cell.
- One March receiving header reports 50 units while its lines total 40.

These should move to explicit historical exception records or be repaired with
audited compensating events after the current writer contracts are fixed. Direct
counter edits would destroy the evidence needed to distinguish actual stock from
legacy bookkeeping gaps.

## Checks With Zero Findings

The same production snapshot found zero:

- negative `inventory_levels` buckets;
- stock at missing/inactive warehouse locations;
- WMS line quantity bound violations;
- return quantity, entitlement, or duplicate-refund violations;
- cycle-count freeze ownership drift;
- stale in-progress cycle counts;
- duplicate active replenishment tasks;
- lot or order-item mills/cents mirror drift;
- duplicate lot numbers;
- receipt idempotency collision shapes.

The signed-only reservation aggregate check also returned zero, but it excludes
cells containing pre-cutover unsigned rows. It is not evidence that legacy-tainted
cells reconcile.

## Remediation Order

Detailed phase gates, rollout boundaries, repair-tool requirements, and exit criteria
are defined in `docs/WMS-INVENTORY-STABILIZATION-AND-REMEDIATION-PLAN.md`. The list
below is the summary only.

1. **Reservation ownership and terminalization:** add owner/location allocations,
   consume only the current order's allocation, and unify shipped/cancelled/
   completed cleanup. Add concurrency and replay tests before data repair.
2. **Lot/level single writer:** route every receive, transfer, adjustment, count,
   pick/unpick, ship, return, and conversion through one atomic mutation contract.
3. **Repair current reservation and lot drift:** dry-run classification first;
   use compensating events and explicit exception records, never direct silent edits.
4. **Install database guards:** non-negative bucket and lot checks, ownership
   uniqueness, immutable posted journal, and conversion/reservation idempotency keys.
5. **Classify historical gaps:** separate legacy exceptions from current operational
   work so dashboards and reconciliation do not treat old incomplete records as
   live warehouse tasks.
6. **Workflow cleanup:** resolve the two cycle counts, blocked inline replenishment,
   actorless adjustments, and invalid catalog hierarchy rows through audited tools.

## Exit Criteria For Remediation

- Zero terminal orders with open owner reservations.
- Zero negative lot or aggregate buckets.
- Zero level/lot drift for on-hand, reserved, picked, and packed state.
- Every posted mutation has actor, idempotency key, owner/reference, before/after,
  and an immutable event.
- Replaying owner allocations and lot movements reproduces materialized counters.
- Concurrent duplicate reserve, pick, unpick, receive, transfer, return, cancel,
  refund, and ship events are proven idempotent by integration tests.
