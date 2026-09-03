# Inventory Availability Phase 5M — Cycle-Count Claim Reconciliation

## Scope and activation status

This slice closes the Phase 5J cycle-count claim-repair blocker. It routes every
inventory-bearing cycle-count approval path through the persisted inventory runtime authority and
adds an exact canonical reconciliation transaction. It does not activate canonical
authority, change the authority row, publish inventory, change ATP/configuration,
or mutate production data during deployment. The canonical path remains inactive
while runtime authority is `legacy`; the legacy path gains atomic adjustment,
reservation repair, and approval behavior immediately after deployment.

Migration `0651_inventory_transaction_mill_costs.sql` adds nullable
`unit_cost_mills` and `total_cost_mills` columns to the existing inventory
transaction ledger. Existing cycle-count items, canonical claim commands, and
canonical claim events supply the remaining durable lineage. The nullable
columns preserve compatibility with historical ledger rows while new canonical
cycle-count rows retain the exact mill-cost evidence already carried by lots.

## Caller contract

`reconcileCycleCountInventory` receives one complete counted-item fact:

- cycle-count and cycle-count-item IDs;
- product-variant and warehouse-location IDs;
- nonnegative counted quantity;
- reason code, actor, and audit reason.

All IDs and quantities are bounded PostgreSQL integers. The cycle-count item is
the natural idempotency identity. The locked row must still match every submitted
identity and the counted quantity.

Manual approval, bulk approval, and within-tolerance auto-approval of items with
a resolved product variant and counted quantity all use this same command.
Items without that inventory identity can still be approved as non-inventory
workflow records. Auto-approval first persists the observation as a reviewable
variance; a failed reconciliation therefore does not hide the count or fall back
to a direct inventory adjustment.

An approved, adjusted, or resolved item cannot be counted again under the same
item identity. The record-count boundary also verifies that the item belongs to
the cycle count named by the request and that the parent remains `in_progress`,
preserving the item as a stable retry key. Manual approval likewise rejects a
route/item parent mismatch before entering the authority boundary.

Transfer matching remains advisory in the reconciliation preview. Bulk approval
does not execute those suggestions: a detected move is not authority to commit a
separate transfer before the counted facts reconcile, and the existing transfer
writer does not own canonical claim movement. Each counted location is therefore
reconciled independently through the selected inventory authority.

The result reports the locked quantity before the count, counted quantity,
delta, the first exact adjustment-evidence transaction ID, deterministically
displaced order IDs, and whether the result was an approved-item replay. A
zero-delta inventory-bearing approval writes a durable item-keyed no-op ledger
row, so every new inventory-bearing approval has replay evidence even when no
physical quantity changes.

## Legacy authority

Legacy routing retains the deployed adjustment and orphan-reallocation algorithms,
but places the inventory adjustment, reservation-counter repair, reallocation, and
cycle-item approval in one transaction. Unexpected reallocation failures roll the
whole operation back instead of leaving an approved item after a partial mutation.
Inventory and channel effects are registered for post-commit execution when a
caller owns the surrounding transaction.

That transaction locks the parent cycle count before the item and requires the
parent to remain `in_progress`. A cancelled or completed count therefore cannot
race a late legacy inventory adjustment.

New legacy cycle-count adjustments identify both the cycle count and exact
cycle-count item. Replay also accepts older `reference_type=cycle_count` ledger
rows when the item already points at that exact transaction, preserving retries
for historical approved items.

The legacy historical-reservation heuristic is not used after canonical activation.
It remains a compatibility path only while runtime authority is `legacy`.

## Canonical authority

The canonical transaction runs at `SERIALIZABLE` isolation and requires the
locked runtime-authority row to be canonical. It then:

1. locks the parent cycle count, then locks and verifies the cycle-count item;
2. returns verified ledger/claim-command evidence when the item is already approved;
3. locks active transformation and legacy-reservation advisory namespaces in
   ascending product order;
4. locks planning policy heads;
5. identifies the minimum deterministic set of active claims whose ownership
   must move when `reserved_qty > counted_qty`;
6. locks affected orders, then selected claims, then every relevant inventory
   level and lot in canonical sorted order;
7. proves that aggregate `reserved_qty` equals exact open canonical ownership;
8. releases each selected whole-order claim, including open build handoffs;
9. applies the physical count from unreserved FIFO lots and records one exact
   adjustment transaction per affected lot, or one no-op transaction when the
   quantity is unchanged, all with `reference_type=cycle_count_item`;
10. replans and reserves each displaced whole order from the post-count snapshot;
11. records replacement commands/events and approves the cycle-count item; and
12. commits once.

Exact open ownership at the counted level is:

```text
open claim quantity = claimed_qty - released_qty - consumed_qty - picked_qty
```

The sum must equal `inventory_levels.reserved_qty`. A mismatch is treated as an
integrity failure; the transaction rolls back without changing inventory or the
count-item status.

When a shortage requires displacement, claims are selected newest claim ID first
until releasing those whole claims makes aggregate ownership fit within the counted
quantity. Selected claims are then replanned in ascending claim ID order, preserving
priority among the affected set. A supply shortage can produce a valid partial
replacement plan; it does not prevent recording the physical count. A planner
`blocked` result means policy/model evidence is invalid, so the entire transaction
fails closed and the observed variance remains available for review.

Claim repair is still performed when the counted quantity equals recorded
`variant_qty`. That equality means no physical adjustment is needed; it does not make
an existing `reserved_qty > counted_qty` ownership conflict safe to ignore.

The command bounds one reconciliation to 1,000 displaced claims. Larger incidents
fail explicitly for operational intervention rather than creating an unbounded
transaction.

## Physical inventory and cost behavior

`variant_qty` is the physical on-hand quantity at the location. Picked stock has
already left that quantity and is not subtracted again.

For a negative count delta, the canonical writer removes only:

```text
unreserved lot quantity = qty_on_hand - qty_reserved
```

from oldest physical lots first. Claim release occurs before this mutation, so any
ownership that no longer fits has already been removed from both aggregate and lot
reservation counters. Before either a positive or negative adjustment, locked lot
on-hand and reserved totals must exactly match the inventory-level totals. Drift or
insufficient FIFO evidence aborts the transaction rather than compounding it.

For a positive count delta, the writer creates an item-keyed adjustment lot using
the existing cost waterfall (`last_paid`, `standard`, `avg`, then unresolved) and
marks that inferred cost provisional. Its transaction points to the created lot.
For a negative count delta, each FIFO lot consumption receives its own transaction
row, preserving that lot's exact `unit_cost_mills` and `total_cost_mills` rather
than blending cost evidence into one aggregate row. Every row records its running
before/after quantity, delta, location direction, cycle-count ID,
cycle-count-item reference, actor, reason, and timestamp.

An unchanged physical count creates no lot or inventory-level mutation. It does
create one zero-delta transaction whose source and destination are both the
counted location. This row is durable retry evidence, not an inventory movement.

## Concurrency and replay

The lock order deliberately matches other canonical claim mutations:

1. runtime authority;
2. parent cycle count;
3. cycle-count item;
4. product advisory/model heads;
5. policy heads;
6. affected WMS orders;
7. selected claims;
8. inventory levels ordered by location, variant, and ID;
9. inventory lots ordered by location, variant, receipt time, and ID.

After the level lock is held, non-displaced claims at that level are read without
row locks. Canonical ownership mutations must acquire the same level lock, so this
validates the full owner set without inverting the claim-to-level lock order against
an unrelated order. Evidence changes and PostgreSQL serialization/deadlock errors
receive at most three bounded attempts.

Approved-item replay validates the complete ordered adjustment transaction
sequence, its quantity chain, locations, cycle-count lineage, final count, and
canonical replacement-command prefix. Historical rows that identify only the
cycle count remain replayable only when the approved item points to that exact
single transaction. An approved inventory-bearing item without a transaction
pointer fails closed because its result cannot be reconstructed exactly. Replay
performs no inventory or claim write and returns the original displaced-order set.

Parent status is enforced for mutations: a new reconciliation requires the
locked count to remain `in_progress`. An already-approved item may still replay
after the parent count becomes completed or cancelled because replay is
evidence-only.

## Verification

Focused coverage proves:

- manual and within-tolerance approvals invoke the authority boundary;
- an auto-approval failure leaves the persisted variance and performs no direct
  adjustment fallback;
- legacy and canonical runtime selection never fall back across authorities;
- canonical caller-owned transactions are rejected;
- unchanged counts approve without lot or level mutation and retain durable
  no-op replay evidence;
- approved retries validate and replay adjustment/displacement evidence;
- inactive canonical authority fails before reading the count item;
- negative adjustments consume only unreserved FIFO quantities and preserve
  reserved lot ownership, with one exact-cost ledger row per affected lot;
- a counted shortage releases displaced ownership before adjustment, replans
  each affected whole order after adjustment, and rolls the transaction back
  when replacement reservation fails; and
- transfer matches remain preview-only during bulk approval; and
- the source-level transaction contract preserves release-before-adjust-before-replan
  ordering and the canonical lock order.

The disposable-PostgreSQL integration suite now also exercises the production SQL
for a counted shortage, including aggregate quantity, FIFO lots, mill-precision
consumption, and exact cycle-count-item ledger lineage. It runs only when both
`ECHELON_TEST_DATABASE_URL` and `ECHELON_TEST_DATABASE_DISPOSABLE=true` are set.

## Remaining activation blockers

Canonical authority is still prohibited. Phase 5M closes only cycle-count claim
repair. Phase 5N subsequently closes canonical reservation-status projection. The
remaining documented blockers are transaction-aware deployed picker routing,
complete canonical publisher coverage, concurrency/crash-recovery verification,
provider readback, external reservation-status consumer verification, and the
separately reviewed and explicitly authorized production activation operation.
