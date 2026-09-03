# Inventory Availability Phase 5F: Claim Pick and Unpick

## Scope

This slice adds the inactive transactional contract for picking and unpicking inventory
owned by a canonical whole-order claim. It does not register the claim repository in
runtime services, route picker requests, activate canonical authority, change ATP,
publish inventory, change channel settings, or mutate production data. The commands
fail closed unless the separately controlled runtime authority is already `canonical`.

## Why `picked` is a separate claim balance

Claim resources previously had only released and consumed balances. Conversion/build
execution consumes input inventory permanently, while a warehouse pick moves finished
inventory from reserved on-hand into a reversible picked bucket. Treating both as
`consumed` would make an order edit or cancellation unable to distinguish inventory
that can be unpicked from inventory already transformed into another SKU.

Migration 0647 therefore adds:

- `picked_target_qty` to claim lines;
- `picked_qty` to claim resources and exact lot allocations; and
- an append-only `availability_claim_pick_movements` ledger connecting every pick and
  compensating unpick to its claim resource, exact FIFO lot, command receipt, and COGS
  row.

Every balance enforces:

`released + consumed + picked <= claimed/planned`.

## Pick contract

`PostgresInventoryAvailabilityClaimRepository.pickClaimLine` owns one serializable
transaction. It verifies idempotency and canonical authority; locks the transformation
graph, order, active claim, line, final resources, and exact lot allocations; validates
the selected warehouse location; and then invokes the physical inventory writer in the
same transaction.

The physical writer moves only exact claim-owned quantities:

- level: `variant_qty -= qty`, `reserved_qty -= qty`, `picked_qty += qty`;
- lot: `qty_on_hand -= qty`, `qty_reserved -= qty`, `qty_picked += qty`;
- COGS: append one exact mill-precision row per picked FIFO allocation; and
- inventory ledger: append one claim-identified `pick` transaction per FIFO allocation.

The claim repository then increments the matching lot, resource, and line picked
balances and appends the command, movement, and event evidence before commit.

## Recorded-stock location reconciliation

A claim can own finished units at a reserve or alternate bin while a picker uses a
different active, pickable bin. With `locationStrategy=reconcile_recorded_stock`, the
same pick transaction may move reservation ownership to the selected bin, but only
when that bin already has enough recorded unreserved stock. The command:

1. releases exact open claim ownership from other locations;
2. reserves exact FIFO stock at the selected location;
3. updates relational claim lineage without changing line demand; and
4. appends a `claim_pick_location_reconciled` event before the pick.

The physical rows are locked globally as levels first and lots second before either
side writes. `locationStrategy=strict` rejects the mismatch instead.

This is not a count adjustment. A picker observation that physical stock exists but
the selected inventory level does not contain it requires a distinct, explicitly
audited discrepancy command. This slice does not invent stock or cost evidence.

## Unpick contract

`unpickClaimLine` locks the same claim hierarchy plus all append-only movements and
their COGS rows. It reverses the latest unreversed pick quantities and restores the
same levels and FIFO lots.

- For an active claim, the units return to reserved on-hand and claim ownership remains
  open for the order.
- For a released, cancelled, superseded, or failed claim, the units return to
  unreserved on-hand and the claim's released balance increases by the same quantity.

Unpick never deletes COGS. It appends a negative compensating COGS row and an unpick
movement referencing the original pick movement. Packing, packed, and shipped orders
cannot unpick through this contract.

## Lock order

1. transformation graph product locks;
2. legacy reservation product locks;
3. WMS order and order items;
4. claim;
5. selected warehouse location for pick;
6. claim line, final resources, and exact lot allocations;
7. prior pick movements and COGS rows for unpick;
8. inventory levels ordered by location, variant, and ID;
9. inventory lots ordered by location, variant, receipt time, and ID.

Claim location reconciliation acquires all affected levels and lots before releasing or
reserving either side.

## Remaining blockers before activation

1. A nonblocking, explicitly audited picker-observation discrepancy command for stock
   that physically exists but is absent from recorded inventory, plus a deliberate
   corrective contract for already-built output.
2. Atomic active-claim replacement when accepted order demand changes.
3. Runtime construction and authority-aware routing for ATP, order acceptance,
   reservation/release, picker completion/unpick, and every publisher.
4. A reviewed Step C activation and full publication run under separate production
   authorization.
