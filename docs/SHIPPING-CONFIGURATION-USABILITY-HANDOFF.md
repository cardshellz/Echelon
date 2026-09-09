# Shipping configuration usability follow-up

Original implementation base: `75c6159dbfc0e0fbe0f7a87d55521c8da7b2652a` (PR 1427).
Publication base: `4231b8dc21d18057cd1b2712b3eb9e74e27e7439` (PR 1429).
Branch: `codex/shipping-configuration-usability`.

## Implemented locally

- Box suites is a separate Shipping Settings tab, not a new navigation item.
- Box catalog defines packaging; suites only group existing packaging.
- Suite search, edit, duplicate, archive and restore. Imported suites are labelled.
- Archiving an assigned suite is blocked. Revision history remains immutable.
- Suite usage links navigate to Channel routing > Packaging assignments.
- Channel packaging uses prefilled row editors, visible defaults/inheritance,
  searchable warehouses, bounded tables and pagination.
- Dropship shows effective pricing and packaging for all warehouse scopes at once.
- Program and suite editors retain selections and errors; unchanged values disable
  Save only inside an editor whose saved value is visible.
- Program/suite warehouse overrides can return to an available channel default.
- Successful edits invalidate both shared shipping and Dropship configuration
  queries. Program names link to the exact program's detail/Used by display.
- Service selection remains populated after save.
- Migration 239 adds lifecycle flags and preserves assignment revision tombstones.
  It flushes migration 238's deferred constraints for fresh installs which apply
  both in one transaction. No legacy box or suite history is deleted.

## Validation

- 2,088 unit tests passed (shipping, cartonization, Dropship, portal and writer ratchet).
- 217 integration/client tests passed (shipping and Dropship PostgreSQL suites plus
  shipping UI model tests); includes 17 shared-configuration database tests.
- 14 browser cases passed across desktop/mobile: program change/reload, preservation
  of another warehouse, error/retry command identity, inheritance reset, suite
  duplicate/archive/restore, membership edits and charge edits.
- TypeScript and production build passed. Build retains the existing large-chunk warning.
- Screenshots inspected; mobile assignment columns were subsequently spaced and
  responsive source labels added, with the browser suite rerun for final verification.

## Not completed: multi-warehouse fulfillment runtime

The configuration work must NOT be described as completing multi-warehouse order
fulfillment. No order-processing, wallet, inventory reservation, or OMS writer
behavior was changed by this patch.

Confirmed trace:

1. `DropshipOrderProcessingService.processIntake` passes
   `requireDefaultWarehouseId(claim)` to the order quote.
2. `DropshipOrderAcceptanceWorkflowService.acceptOrderForMember` also requires
   a store default warehouse before quoting.
3. `DropshipListingShippingEstimateService.estimateForMember` uses the same
   store-default origin, not a multi-warehouse plan.
4. `PgDropshipOrderAcceptanceRepository` validates stock only at the quoted
   warehouse and debits the wallet. It intentionally does not reserve stock;
   reservation belongs to WMS sync (do not reintroduce double reservation).
5. `wms-sync.service.ts` invokes `fulfillmentRouter.routeOrder` separately.
6. Existing `channels.channel_warehouse_assignments` supports enabled/priority
   per channel and warehouse. Do not create a competing eligibility store.
7. `FulfillmentRouterService.routeOrder` returns one warehouse, not split groups.

Pending user policy choice: when no single eligible warehouse can fill the whole
order, automatically split it and charge per shipment, or hold it for review?
An asynchronous question was sent; no answer had arrived when this note was written.

Next implementation must resolve a shared, validated fulfillment plan before
quoting and carry that same plan through acceptance and WMS reservation. Split
groups, if authorized, need per-shipment quotes, consistent order-level fees,
idempotent debit/acceptance, and no partial reservation/debit on failure. Existing
canonical inventory/OMS ownership boundaries must be respected; do not add
direct inventory writers or weaken the writer baseline.

## Deployment boundaries

No production configuration changed and no orders or listings published.
Publishing this configuration-only PR does not complete or activate multi-warehouse fulfillment.
Migration 239 is required with this code. UI/API deployment should be coordinated.
Permanent deletion is not exposed: archive/restore removes unused suites from
selection while keeping financial/shipment audit references intact.
