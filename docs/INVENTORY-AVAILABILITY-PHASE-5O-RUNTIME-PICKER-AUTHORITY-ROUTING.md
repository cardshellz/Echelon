# Inventory Availability Phase 5O — Runtime Picker Authority Routing

## Scope and activation status

This slice closes the deployed picker transaction-boundary blocker. It routes
completed physical picks and their corresponding unpicks through the same
persisted runtime authority used by ATP and reservation operations. It does not
activate canonical authority, change configuration, publish channel inventory,
backfill production data, or mutate any production record.

The deployed HTTP endpoints remain unchanged:

- `PATCH /api/picking/items/:id` calls `PickingUseCases.pickItem`;
- `POST /api/picking/items/:id/unpick` calls `PickingUseCases.unpickItem`.

The composition root now gives `PickingUseCases` the exact
`PostgresInventoryAvailabilityRuntimeClaimExecutor` instance used by the
authority-aware reservation service. There is one authority decision per
physical mutation.

## Legacy authority

The runtime executor exposes the Drizzle database handle bound to its pinned
repeatable-read authority transaction. The picker uses that handle for its
existing order lock, order-item lock, legacy inventory movement, shipment-bin
backfill, and WMS progress update. The authority lock is therefore held until
the complete legacy picker mutation commits.

The deployed stale-row guard is retained: an active WMS row whose picked
quantity already equals its line quantity remains an idempotent legacy no-op.
That guard is evaluated inside the locked authority transaction.

## Canonical physical pick

After canonical authority is selected, `PickingUseCases.completeCanonicalPick`
does not call `InventoryUseCases.pickItem`. It resolves the selected active,
pickable, unfrozen bin in the order warehouse and requires the latest order
claim to be active. It then invokes the existing canonical claim command in
this order:

1. `strict` when the selected bin already owns enough open claim inventory;
2. `reconcile_recorded_stock` only after a strict location shortfall;
3. `reconcile_picker_observation` only when recorded stock cannot support the
   rebinding and the picker supplied the required physical observation.

Malformed locations, wrong warehouses, unavailable bins, insufficient claim
ownership, invalid lineage, and unrelated reconciliation failures remain
fail-closed. No canonical failure falls back to the legacy inventory writer.

`PostgresInventoryAvailabilityClaimRepository.pickClaimLine` commits all of
the following in its existing serializable transaction:

- exact claim-resource and FIFO-lot pick balances;
- the physical inventory and COGS movement;
- a compare-and-set transition of the WMS line to its full completed quantity;
- the selected bin on unresolved planned or queued shipment items;
- immutable command, movement, and event evidence.

If the WMS status or picked quantity changed after the request snapshot, the
compare-and-set fails and the claim, inventory, COGS, and WMS transaction rolls
back together.

## Canonical unpick

`PickingUseCases.completeCanonicalUnpick` finds the newest canonical claim that
still owns a positive picked balance for the order item. The claim can be
active, released, or superseded because exact pick lineage survives later claim
lifecycle transitions.

The command identity includes the latest immutable pick-movement identifier.
That cursor prevents a later pick/unpick lifecycle from replaying an older
receipt that happens to use the same order item, quantity, actor, and WMS
states. It is not a client request token; response-loss retry behavior remains
part of the concurrency and crash-recovery activation proof.

`PostgresInventoryAvailabilityClaimRepository.unpickClaimLine` reverses the
latest unreversed FIFO movements and COGS, repairs claim balances, updates the
WMS line, and recomputes the WMS order rollup in one serializable transaction.
An active claim regains reserved ownership; an inactive historical claim
returns stock as released inventory, matching the existing canonical unpick
contract.

## Non-inventory items

A non-shipping line with no catalog inventory identity, or a mapped variant with
`requiresShipping=false` or `trackInventory=false`, is a WMS-only picker
transition. Pick and unpick lock the order and item but invoke neither the legacy
inventory writer nor a canonical claim command. A physical shippable line with
no active catalog variant instead fails closed because the picker cannot prove
that inventory tracking is inapplicable.

If a catalog mapping disappears after a canonical pick, unpick still follows
the exact claim and immutable movement lineage. Reversing inventory already
owned by that lineage does not depend on reconstructing its identity from the
current SKU mapping.

## Replenishment boundary

The deployed post-pick replenishment path is a legacy physical-inventory
writer. Running it after a canonical pick could change stock without repairing
the exact claim resources and FIFO allocations that now own that stock.
Therefore a successful canonical pick deliberately does not invoke legacy
automatic replenishment.

Canonical authority must remain inactive until replenishment execution is
routed through claim-aware resource and lot lineage or is otherwise proven
unable to mutate claim-owned stock. This is an explicit activation blocker, not
a silent degradation.

## Verification contract

Focused tests prove:

- the legacy picker receives and uses the authority transaction database;
- canonical physical picks use strict, recorded-stock, then observation
  reconciliation without invoking legacy inventory;
- canonical picker observations do not create a duplicate asynchronous review;
- canonical physical unpick follows the claim and movement that own the pick;
- a second partial unpick continues through canonical lineage after the WMS
  line changes from `completed` to `in_progress`;
- digital unpick changes WMS progress without inventory mutation;
- WMS compare-and-set failure rolls the entire canonical pick transaction back;
- claim and pick-movement cursors used for deterministic command identities are
  loaded from validated database evidence.

## Remaining activation blockers

Canonical authority remains prohibited. This slice closes the deployed
pick/unpick transaction boundary only. Claim-aware replenishment execution,
complete canonical publisher coverage, concurrency and crash-recovery
verification, provider readback, external endpoint consumer verification, and
the separately reviewed and explicitly authorized production activation
operation remain open.
