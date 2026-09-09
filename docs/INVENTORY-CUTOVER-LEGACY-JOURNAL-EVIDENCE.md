# Inventory cutover: legacy journal evidence boundaries

## What this batch changes

The inventory-owned reconstruction reader takes one bounded SQL statement snapshot of the non-voided, non-canonical reservation/pick/shipment journals and their direct foreign-key links. The database hashes complete original journal rows and linked evidence; only compact facts and digests leave PostgreSQL. A pure domain function then groups exact signed quantities and diagnoses unknown evidence.

It can complete a NULL order ID through an existing journal item FK. It can complete a NULL item ID through an existing shipment-item FK only when the ordinary customer-fulfillment source, header, item, variant, location, warehouse and any already recorded IDs agree. A recorded direct shipment header is checked independently of the shipment-item path. Replacements, corrections, unsafe source lifecycles, missing links and conflicts never become guessed customer ownership.

Completion changes the captured interpretation, not the stored journal, order, stock, cost or shipment. It does not manufacture missing quantities or original lot ownership. Original and linked evidence changes invalidate the grouped hash. Unknown journals still block even when their known deltas net to zero.

Implementation: `server/modules/inventory/infrastructure/inventory-cutover-reconstruction.reader.ts`, `readInventoryCutoverReconstruction`; `server/modules/inventory/domain/inventory-cutover-journal-evidence.ts`, `aggregateCutoverJournalEvidence` / `resolveOwner`; `shared/types/inventory-cutover-reconstruction.ts`, `cutoverReconstructionJournalSchema`; `server/modules/inventory-planning/domain/inventory-cutover-reconstruction.ts`, `planCutoverReconstruction`.

## What existing writers prove, and what they do not

These are current checked-in writer semantics, not proof that a particular historical row used that exact code version.

| Evidence | What is recorded | What remains unproven |
| --- | --- | --- |
| Legacy reservation rows with NULL `reserved_qty_delta` | An event and sometimes an exact owner | The quantity originally reserved or released. Migration `116_reservation_ledger_qty.sql` explicitly documents missing pre-migration quantities. `ReservationService.releaseOrderReservation` in `server/modules/channels/reservation.service.ts` uses a conservative estimate from current order quantity; an estimate is not cutover evidence. |
| `reserve_move` | Both bins, aggregate moved reserved quantity and aggregate before/after reservation values | Which order lines' promises moved. `InventoryUseCases.transferInventory` in `server/modules/inventory/application/inventory.use-cases.ts` and the transfer implementation in `server/modules/inventory/infrastructure/inventory.repository.ts` do not record per-owner transfer deltas. `repointPendingWmsOrderItemsForInventoryTransfer` in `server/modules/wms/order-item-commands.ts` updates eligible current bin text, not immutable per-line quantity lineage. |
| Legacy direct/mixed shipment | Total shipped quantity; source state; on-hand before/after snapshots; optional source IDs | `InventoryUseCases.recordShipmentInsideTransaction` can consume picked plus on-hand stock and release an aggregate reservation counter, but does not record that reservation delta on its shipment journal. Before/after on-hand can describe the physical split for that writer, but cannot establish which reservation or original lot was consumed. The current importer deliberately retains its existing unknown-custody classification. |
| Negative stock adjustment | On-hand adjustment and stock snapshots | `InventoryUseCases.adjustInventory` can also reduce `reservedQty` via `adjustReserved`, without adding that reservation delta to the adjustment journal. Such a stock event cannot by itself explain current per-order ownership. This batch does not reinterpret or post adjustments. |
| Existing original COGS | `oms.order_item_costs` links order/item/lot/quantity and exact mills | `InventoryLotService.shipFromLots` in `server/modules/inventory/lots.service.ts` consumes picked lots at the bin in FIFO order, not by an immutable per-order shipment movement. Current cost rows plus package contents do not uniquely prove historic shipped-lot ownership when several owners coexist. `unpickFromLots` also deletes cost rows; absence is not proof of zero original cost. |

The existing cross-bin release path in `server/modules/channels/reservation.service.ts` can select currently reserved levels in descending reserved quantity while writing a particular item owner. Therefore a negative owner balance at one bin must not be netted against an unrelated owner or location merely because the SKU matches.

An unsupported ordinary-fulfillment link is not automatically corrupt data.
`loadValidatedInventoryShipmentItems` loads `COALESCE(osi.order_item_id, osi.replacement_for_order_item_id)`
as the inventory item owner in `server/modules/oms/shipstation.service.ts`.
A valid replacement can therefore have a recorded journal item owner while the
source's ordinary `order_item_id` is NULL. It remains in the unsupported-purpose
category for this ordinary-demand importer, not a fabricated foreign-key conflict.
Different causes and owner/position groups may overlap; counts are not quantities
of missing stock or counts of unique bad orders.

## Boundaries and remaining resolution work

- Raw journal census: maximum 100,000 rows in one statement; maximum 50,000 owner/position groups. No paging across READ COMMITTED snapshots and no silent truncation. Oversize input fails as incomplete evidence before any result is usable.
- Diagnostic examples: at most ten exact transaction IDs per cause; the count and evidence hash still cover every contributing row.
- Historical missing quantities, transferred owner identity, unexplained current counters and missing original costs remain explicit blockers. Source FK completion does not waive any of those checks.
- A follow-up reconciliation needs case-specific recorded owner/movement evidence, or an explicitly reviewed correction through the owning module. Current order quantities, current FIFO, current bin text and matching provider contents are not replacements for missing historical records.
- A projected readiness result is not permission to activate. No production stock, reservation, cost or authority mutation is part of this batch.

## Tests

`inventory-cutover-journal-evidence.test.ts` covers NULL completion, contradictory direct/source FKs, unsafe lifecycles, missing quantities, exact signed bigint aggregation, deterministic hashes, immutable inputs, bounded examples and incomplete-census failure. `inventory-cutover-journal-reader.test.ts` guards the single-statement bound and absence of returned raw JSON payloads. The PostgreSQL reconstruction suite exercises actual joins and confirms no stored IDs are repaired, linked/original row changes alter evidence, unresolved costs remain blocked, and voided/canonical rows remain excluded. Existing composition tests continue to cover rollback, replay and atomic authority/publication behavior.
