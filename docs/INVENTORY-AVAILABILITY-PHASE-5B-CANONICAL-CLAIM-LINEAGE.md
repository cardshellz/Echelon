# Inventory Availability Phase 5B: Canonical Claim Lineage

## Scope

This slice adds the inactive transactional substrate required before canonical ATP can
become runtime authority. Deployment does not switch authority, route order acceptance,
publish inventory, execute transformations, or change existing claims.

The repository refuses every claim/release command unless
`inventory.availability_runtime_authority.authority = 'canonical'`. Migration 0640 only
creates schema, constraints, indexes, comments, and append-only evidence guards.

## Confirmed legacy gaps closed by this slice

The legacy inventory reservation path stores an aggregate `reserved_qty` counter and
reserves/releases FIFO lots without order or transformation ownership. That is not
sufficient for a transformation claim because a later release could return a different
lot or a later conversion could consume inventory that was reserved for another plan.

The canonical planner previously identified leaf inventory resources and operations,
but did not state which operation consumed each leaf or the exact required input for
each operation. The planner contract now records:

- `consumerOperationKey` on every leaf resource claim (`null` means direct finished
  inventory for the order line);
- `parentOperationKey` on every transformation/build operation;
- exact `inputs[]` with source variant and required quantity for each operation.

## Durable claim contract

Migration 0640 adds:

- `availability_claims`: one versioned active whole-order claim;
- `availability_claim_lines`: target demand and target-unit lifecycle counters;
- `availability_claim_operations` and `availability_claim_operation_inputs`: the
  versioned execution DAG and exact inputs;
- `availability_claim_resources`: exact inventory-level ownership;
- `availability_claim_lot_allocations`: exact FIFO lot ownership and authoritative
  unit-cost-mills snapshot;
- `availability_claim_commands`: idempotent command receipts;
- `availability_claim_events`: append-only lifecycle evidence.

Commands and events reject updates/deletes. Quantity constraints prevent released plus
consumed quantity from exceeding claimed quantity. Composite foreign keys keep lines,
operations, resources, and lots inside one claim.

## Claim transaction

The inactive `PostgresInventoryAvailabilityClaimRepository`:

1. starts a serializable transaction and checks an exact idempotency receipt;
2. fails closed unless canonical runtime authority is active;
3. resolves the active transformation graph and locks graph products in ascending order;
4. takes the existing per-product reservation lock so an in-flight legacy reservation
   cannot overlap a canonical claim;
5. locks the order/items, active model heads, inventory levels, and FIFO lots in
   deterministic order;
6. recaptures an active-head-only supply snapshot and replans the complete order once;
7. persists claim/line/operation/resource/lot evidence;
8. invokes the inventory module through a transaction-aware mutation port; that owning
   module increments only guarded level/lot reservation counters and writes one
   inventory journal reserve row per exact resource;
9. persists the command receipt and append-only event in the same transaction.

Digital, non-shipping, untracked, fully picked, completed, short, shipped, and cancelled
lines do not create inventory claims. A tracked physical line targeting an inactive or
internal-only variant fails the whole claim closed. Order-line variant identity resolves
through the case-insensitive active SKU invariant used by fulfillment. A populated legacy
`wms.order_items.product_id` is accepted only when it matches either the resolved
variant or its parent product; any other value fails closed instead of claiming the
wrong stock. Concurrent reuse of the same idempotency key retries against the committed
receipt rather than duplicating reservations.

## Release and cancellation

Full-order release/cancellation locks the same graph, order, claim, every level, and
every exact claim-owned lot in one deterministic batch. It verifies that every open
resource quantity equals its open lot allocations and that aggregate physical balances
can satisfy the release before changing any counter. Any mismatch rolls back the
transaction. Release is idempotent and writes exact unreserve journal rows, a command
receipt, and an event. The planning module owns claim lifecycle rows; only the inventory
module writes physical levels, lots, and inventory transactions. Release reconstructs
the advisory-lock product set from every persisted line, resource, operation input, and
operation output, so leaf inventory without its own transformation model remains
serialized against the legacy reservation path during the eventual cutover window.

## Deliberate blockers still in place

This slice does not expose the repository through `ReservationService`; legacy remains
the only reachable runtime path. It also does not execute `break_pack`, `assemble_pack`,
`directed_conversion`, or `component_build` operations. The existing conversion and
replenishment methods are not suitable substitutes because they select generic on-hand
or legacy hierarchy rather than the claim-owned operation/lot lineage.

The next slice must implement and test:

1. partial order-item release as atomic claim replacement/replan;
2. claim-owned package transformation execution with exact lot/cost transfer;
3. component-build handoff without double-reserving components;
4. picker consumption/reconciliation within claim constraints;
5. authority-aware ATP and reservation routing;
6. only then, the separately reviewed atomic Step C activation command and full
   publication outbox.

No production activation is authorized by this document or by deployment of this slice.
