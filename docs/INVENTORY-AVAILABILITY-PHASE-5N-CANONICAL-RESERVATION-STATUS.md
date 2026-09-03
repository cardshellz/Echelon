# Inventory Availability Phase 5N — Canonical Reservation Status

## Scope and activation status

This slice closes the canonical reservation-status projection blocker. It adds a
read-only, versioned projection of active canonical claim ownership and routes the
existing order reservation-status endpoint to that projection only when persisted
runtime authority is already `canonical`.

It does not activate canonical authority, change the authority row, write claim or
inventory state, publish channel quantities, change configuration, or mutate
production data. No schema migration is required because the projection reads the
claim, operation, resource, pick, and build-handoff lineage already installed by
Phases 5B through 5M.

## Transitional endpoint contract

`GET /api/orders/:id/reservation` remains unchanged while runtime authority is
`legacy`: it returns the deployed legacy array of flattened per-item reservation
status objects. This preserves all behavior before cutover.

When runtime authority is `canonical`, the same route returns
`inventory_availability_reservation_status_v1`. The versioned object includes the
selected authority revision and activation run plus either:

- `claim: null`, proving the order exists but has no active canonical ownership; or
- the one active claim, its hashed planning identity, scope, exact line balances,
  physical resource balances, transformation/build operations, and any build
  handoff.

Repository search found no in-repository client of this endpoint. External clients
remain unknown and must be verified before activation because the response changes
from the legacy array to the versioned canonical object at cutover.

The canonical response deliberately does not synthesize legacy `reservedQty`,
`promisedQty`, `isReserved`, or `isPromised` fields. Those fields cannot preserve
the difference between direct finished inventory, inputs owned for a transformation,
produced intermediate/finished resources, picked target units, and build ownership.

All canonical quantities are PostgreSQL-bigint decimal strings. This prevents JSON
number rounding and retains the exact persisted evidence.

## Exact balances

For each claim line:

```text
openPlannedQty = plannedQty
               - releasedTargetQty
               - consumedTargetQty
               - pickedTargetQty
```

`shortfallQty` remains separate. It is unplanned demand, not owned inventory and not
an unfinished promise.

For each physical claim resource:

```text
openQty = claimedQty - releasedQty - consumedQty - pickedQty
```

For each transformation or build operation:

```text
remainingExecutions = plannedExecutions
                    - executedExecutions
                    - releasedExecutions
```

The projection exposes both `consumerOperationKey` and `producerOperationKey` on
resources. A null producer identifies stock owned when the plan was claimed. A
non-null producer identifies inventory physically created by that exact operation.
A component-build handoff includes its claim operation, build order, build system
number, lifecycle status, and adopted reservation quantity.

## Snapshot and integrity behavior

The PostgreSQL repository owns one `REPEATABLE READ` transaction. It first reads the
runtime-authority singleton `FOR SHARE`, requires canonical authority, proves the
order exists, and then reads the active claim and all child evidence from the same
snapshot. Caller-owned legacy Drizzle transactions are rejected on the canonical
path.

The read fails closed and rolls back when any of these checks fail:

- the active plan payload no longer matches its stored SHA-256 hash;
- relational claim lines differ from the hashed planner lines;
- operation identities, quantities, inputs, or parentage differ from the hashed
  planner operations;
- original resource identities or claimed quantities differ from the hashed planner
  resource claims;
- a resource references an unknown or different-line producer/consumer operation;
- released, consumed, and picked counters exceed their original quantity;
- a produced resource differs from its producer's committed output, warehouse,
  location, destination variant, or parent consumer; or
- executed-operation output evidence is missing or duplicated.

These are evidence reads only. `FOR SHARE` protects the authority decision; the
transaction performs no insert, update, delete, inventory mutation, or provider call.

## Verification

Focused tests prove:

- application input and output contracts reject malformed data;
- legacy authority continues to delegate the deployed status read unchanged;
- canonical authority invokes only the canonical projection and never falls back;
- caller-owned transactions fail closed after canonical selection;
- an order without an active claim returns explicit null ownership;
- line, resource, operation, and build-handoff balances retain exact identifiers and
  bigint quantities; and
- tampered relational line evidence aborts the snapshot and rolls back.

## Remaining activation blockers

Canonical authority remains prohibited. This slice closes reservation status only.
Phase 5O subsequently closes transaction-aware deployed picker routing.
Claim-aware replenishment execution, complete canonical publisher coverage,
concurrency and crash-recovery verification, provider readback, external endpoint
consumer verification, and the separately reviewed and explicitly authorized
production activation operation remain open.
