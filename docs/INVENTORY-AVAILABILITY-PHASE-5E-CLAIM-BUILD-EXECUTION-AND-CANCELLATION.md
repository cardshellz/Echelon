# Inventory Availability Phase 5E: Claim Build Execution and Cancellation

## Scope

This slice completes the inactive transactional contract for executing or cancelling a
claim-owned `component_build`. It does not register the canonical claim repository in
runtime services, route order acceptance, change ATP authority, publish inventory,
change picker behavior, or mutate production data. Every command still fails closed
unless the singleton runtime authority has already been separately activated as
`canonical`.

## Execution contract

`PostgresInventoryAvailabilityClaimRepository.executeBuildOperation` owns the command
and one serializable database transaction. It:

1. verifies the exact `execute_build` idempotency receipt before doing work;
2. requires canonical runtime authority;
3. locks the transformation graph, order, active claim, operation, handoff, exact claim
   resources, and exact claim lot allocations;
4. revalidates the persisted operation against the hashed planner payload;
5. invokes `PostgresCanonicalClaimBuildRepository.executeOperation` in the same
   transaction;
6. consumes the input claim resources and their lot allocations, creates the output
   claim resource and exact output lot allocations, completes the claim operation and
   build handoff, and appends the command receipt and event before commit.

The build repository revalidates the immutable build order and component snapshots,
the adopted reservation owner, claim identity, exact lot-allocation identity, and open
quantities. It records one deterministic full build run and its FIFO consumption
evidence. The canonical inventory writer then atomically:

- decrements `variant_qty` and `reserved_qty` on every exact source level and FIFO lot;
- increments `qty_consumed` on each source lot;
- creates build-linked `assemble` transactions;
- adds the full physical build output to `variant_qty`;
- reserves only `committed_output_qty` for the claim;
- leaves physical batch surplus unreserved; and
- preserves PO, packaging, landed, and total cost in integer mills on produced lots.

The command is all-or-nothing. A changed level, lot, reservation, component, build run,
operation, handoff, cost snapshot, or claim lineage causes the transaction to roll back.

## Cancellation contract

Whole-claim release or order cancellation now cancels each unexecuted open build
handoff before releasing physical claim resources. Claim-aware build cancellation:

- permits only a released build with zero completed builds and no build-run evidence;
- releases the adopted build-reservation rows as ownership evidence only;
- does not independently update inventory levels, inventory lots, or inventory
  transactions, because those physical reservations are still owned by the claim;
- marks the build order and handoff cancelled; and
- lets the surrounding claim release perform the one physical unreserve and record the
  final claim command and event atomically.

A completed build is not automatically unbuilt when its order claim is later released.
The produced units physically exist, so claim release removes only their reservation
and leaves them as available stock. Any corrective physical reversal requires a future
claim-aware discrepancy/reconciliation command; generic reversal is deliberately
blocked.

## Generic build-path guards

Claim-owned builds cannot use generic build release, execution, cancellation, or
reversal. The generic repository checks the handoff first, before locking the build
order, and returns a structured conflict. This prevents duplicate component
reservation, independent unreserve, multi-location execution through a single-location
contract, and reversal that would orphan claim-owned output.

Non-claim build behavior is unchanged.

## Lock order

The claim command uses this order:

1. transformation graph product locks;
2. order;
3. active claim;
4. claim operation and build handoff;
5. exact claim resources and claim lot allocations;
6. build order, components, and adopted build reservations;
7. inventory levels in deterministic ID order;
8. FIFO lots in deterministic location, variant, receipt, and ID order.

Generic build commands inspect and share-lock a claim handoff before locking the build
order, matching the handoff-before-build portion of the canonical order.

## Database change

Migration 0646 adds `execute_build` to the canonical command-type constraint. It does
not change runtime authority and contains no inventory, lot, transaction, reservation,
claim, recipe, configuration, ATP, channel, or Shopify data mutation.

## Remaining blockers before activation

1. Claim-aware pick, unpick, discrepancy, and reconciliation commands, including a
   deliberate corrective path for already-built output if one is needed.
2. Atomic active-claim replacement when accepted order demand changes.
3. Runtime construction and authority-aware routing for every ATP reader, reservation
   caller, order-acceptance path, and inventory publisher.
4. A reviewed Step C activation and full publication run under separate production
   authorization.
