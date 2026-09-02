# Inventory Availability Phase 5C: Claim-Owned Package Execution

## Scope

This slice adds the inactive execution contract for canonical package transformations.
It does not register the claim repository in runtime services, route order acceptance,
change ATP authority, publish inventory, execute a production transformation, or alter
picker behavior. Every claim and execution entry point still fails closed unless the
single runtime authority row is already `canonical`.

## Execution ambiguity closed

The Phase 5B planner persisted total physical operation output but did not persist the
portion of that output committed to its parent operation or order line. Those quantities
can differ when a recipe or conversion must execute an indivisible batch. For example,
an operation may physically produce four units to satisfy demand for three.

The planner DTO now carries both:

- `outputQty`: total physical units produced by the planned executions;
- `committedOutputQty`: exact units owned by the parent operation or order line.

The database enforces `0 < committed_output_qty <= output_qty` for new evidence. The
column remains nullable only so migration 0642 is additive and does not rewrite any
pre-existing claim rows. A null value is never executable; the order must be replanned.

## Exact cost and output lineage

New claim lot allocations snapshot normalized PO, packaging, landed, and total unit cost
in integer mills. The database requires those components to reconcile. Pre-0642 all-null
cost breakdowns remain readable but are not executable.

Every output resource records `producer_operation_key`. Its existing
`consumer_operation_key` points to the parent operation, or remains null when the output
is finished inventory for the order line. This creates a durable chain from leaf FIFO
lots, through every operation, to the exact finished claim resource.

## Package execution transaction

`PostgresInventoryAvailabilityClaimRepository.executePackageOperation`:

1. starts a serializable transaction and checks the exact idempotency receipt;
2. requires canonical runtime authority;
3. loads the active claim, verifies its planner payload against `plan_hash`, and locks
   every graph product using the established transformation-then-legacy lock order;
4. locks the order, claim, requested operation, claim resources, and claim lot
   allocations;
5. compares relational operation/input evidence to the hashed planner payload and
   requires all child operations to be complete;
6. requires exact open resource quantities to equal exact open FIFO lot allocations and
   the operation input contract;
7. calls the inventory module through the transaction-aware mutation port;
8. records consumed input resources/lots, the produced output resource/lots, completed
   operation state, an idempotent command receipt, and an append-only event in the same
   transaction.

`PostgresCanonicalClaimInventoryRepository.executePackageOperation` owns every physical
write. It locks all participating inventory levels before all source lots in deterministic
location/variant/id order, validates live lot cost against the claim snapshot, consumes
only the exact reserved lots, creates exact mill-cost output layers, and updates the
inventory journal.

Only `committedOutputQty` is reserved for the claim. Any indivisible batch surplus is
created as ordinary unreserved on-hand inventory. Cost layers are split at the ownership
boundary when needed, so no output lot is partly claim-owned and partly surplus.

## Deliberate blockers still in place

- No live service constructs or calls the canonical claim repository.
- Component-build operations reject the package executor and require a separate
  claim-to-build handoff.
- The existing build workflow cannot safely adopt an arbitrary canonical component
  claim yet: `BuildRepository.createOrder` accepts one source location per component,
  while the canonical planner may claim the same component across multiple eligible
  locations.
- Picker deduction still selects generic reserved FIFO inventory rather than exact
  claim-owned output and therefore is not yet routed to this contract.
- Partial order-item release still requires atomic claim replacement and replan.
- ATP/reservation routing, Step C activation, and publication remain blocked.

## Required next slices

1. Define and implement claim-to-build handoff with multi-location component ownership
   and no second reservation.
2. Define claim-aware pick, unpick, discrepancy, and reconciliation commands.
3. Implement atomic claim replacement for changed or partially released order demand.
4. Route ATP readers and reservation callers through the authority switch only after all
   execution consumers are ready.
5. Review and run the separately authorized Step C activation and full publication.
