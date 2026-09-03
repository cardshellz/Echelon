# Inventory Availability Phase 5G: Picker Observation Reconciliation

## Scope

This slice adds an inactive, explicitly audited command for the case where a picker
finds claim-owned stock in a different bin from the bin recorded by the system. It
does not construct the canonical claim repository in runtime services, route a picker
request to it, activate canonical authority, change ATP, publish inventory, change a
channel setting, or mutate production data. The command continues to fail closed
unless the separately controlled runtime authority is already `canonical`.

## Confirmed legacy gap

`PickingUseCases._deductInventory` currently permits a trusted scan or confirmation
to call `inventoryCore.adjustInventory` for the selected-bin shortage immediately
before the pick. That physical adjustment participates in the pick transaction, but
`PickingUseCases.recordInlineInventoryReview` is called after that transaction and is
fire-and-forget. The physical adjustment and pick can therefore commit without a
durable review row.

The canonical `reconcile_recorded_stock` command from Phase 5F closes only the case
where the selected bin already contains enough recorded unreserved stock. It correctly
refuses to invent missing recorded stock.

## Command contract

`locationStrategy=reconcile_picker_observation` requires all normal canonical pick
fields plus:

- an observation kind of `validated_item_scan` or
  `picker_confirmed_physical_stock`;
- the exact selected location code;
- an observed physical quantity at least as large as the requested pick; and
- optional device and session evidence.

The observation does not assert a full shelf count. It authorizes only the exact
shortage required to complete this pick. A selected bin that already owns enough open
claim quantity must use a strict pick. A selected bin whose recorded unreserved stock
can cover the entire rebind must use `reconcile_recorded_stock`.

## Conservative physical correction

The command never adds net warehouse on-hand. For the portion of the requested pick
that the selected bin does not already own:

```text
claimRebindQty = requestedPickQty - selectedBinOpenClaimQty

recordedTargetAvailable = min(
  max(targetLevel.variantQty - targetLevel.reservedQty, 0),
  sum(max(targetLot.qtyOnHand - targetLot.qtyReserved, 0))
)

recordedRebindQty = min(claimRebindQty, recordedTargetAvailable)
observedRelocationQty = claimRebindQty - recordedRebindQty
```

The recorded portion releases source claim ownership and reserves existing target-bin
FIFO stock. The observed portion relocates the same quantity of exact claim-owned,
reserved source FIFO lots to the selected bin. Each relocated lot preserves its
mill-precision cost components, provisional-cost marker, receipt time, PO/receipt/
inbound provenance, and build provenance. The inventory levels move together:

```text
source.variantQty  -= observedRelocationQty
source.reservedQty -= observedRelocationQty
target.variantQty  += observedRelocationQty
target.reservedQty += observedRelocationQty
```

Warehouse on-hand is unchanged by the correction. The immediately following canonical
pick then removes the picked quantity from on-hand and reservation and adds it to the
picked bucket. If stock really existed in both the recorded source and observed target
bins, the correction temporarily understates inventory until warehouse review; it
does not overpromise inventory that has not been counted.

Physical relocation is permitted only between active claim resources and the selected
pick location in the same warehouse. Cross-warehouse observation is rejected because
a picker finding stock in one building is not evidence that recorded stock in another
building is absent.

## Atomic evidence and idempotency

`PostgresInventoryAvailabilityClaimRepository.pickClaimLine` owns one serializable
transaction. The observation path records all of the following before commit:

1. source claim-lot release and target claim-lot ownership;
2. exact source-lot decrement and lineage-preserving target lot creation;
3. target/source level relocation;
4. paired `transfer` and `reserve_move` inventory-ledger rows;
5. the normal canonical pick, COGS, and pick-movement evidence;
6. a `wms.allocation_exceptions` row in `needs_review` state; and
7. the immutable `pick_observation` command receipt and claim event.

The request hash is part of the deterministic relocated-lot identity. An identical
idempotency replay returns the original command result; a changed request under the
same key is rejected.

## Lock order

The Phase 5F canonical lock order remains authoritative. A missing target level is
first inserted at zero with `ON CONFLICT DO NOTHING`; this never updates or
pre-locks an existing target level. A concurrent insert that is not visible in the
current serializable snapshot triggers the bounded transaction retry. Within the
physical observation writer, every affected inventory level is then locked in
location, variant, and ID order before any affected lot is locked in location,
variant, receipt-time, and ID order. The source release, target reservation,
relocation, claim-lineage updates, review row, and pick all reuse those rows inside
the same serializable transaction.

## Built-output boundary

This command is a location correction and pick, not an unbuild. When its exact source
lot came from a completed claim build, the relocated lot retains `build_order_id` and
`build_run_id`. Generic build release, cancellation, execution, and reversal remain
blocked for claim-owned builds. A completed build is still never automatically
reversed when a claim is released.

A future claim-aware build-reversal command, if operations needs one, must be a
separately authorized command. It must prove the latest build output is fully
untouched, reverse exact output and component FIFO layers atomically, repair claim
operation/output ownership, and append compensating cost and inventory evidence. A
picker observation is intentionally insufficient authority for that action.

## Comparison with the migration plan

This slice preserves the migration plan's non-negotiable contracts:

- physical stock remains exact by SKU, lot, warehouse, and location;
- ATP never materializes virtual package supply as physical stock;
- atomic claim ownership governs the shared resource graph;
- cost is transferred from exact source lots and is never synthesized; and
- activation evidence and production cutover remain separate.

The implementation is deliberately more conservative than the legacy picker behavior.
The legacy path increases target on-hand from the observation without decreasing a
recorded source. This contract treats the issue as a same-warehouse location mismatch
and transfers exact claim-owned stock. That change is recommended because it prevents
an observation from temporarily increasing ATP or total physical inventory.

## Remaining blockers before activation

1. Decide whether operations needs the separately authorized claim-aware reversal of
   an already-completed build; the current release contract correctly leaves real
   completed output in stock.
2. Add atomic active-claim replacement when accepted order demand changes.
3. Construct the canonical services and add authority-aware runtime routing for ATP,
   order acceptance, reservation/release, picker completion/unpick, and publishers.
4. Run the separately reviewed Step C activation and full publication under explicit
   production authorization.
