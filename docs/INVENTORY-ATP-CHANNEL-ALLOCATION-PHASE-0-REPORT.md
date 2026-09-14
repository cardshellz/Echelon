# Inventory ATP And Channel Allocation Phase 0 Report

## Status And Authority

- Investigation date: 2026-08-25
- Repository: `cardshellz/Echelon`
- Verified `origin/main`: `3fca50c107c122bf954f70c75c3edcceb899ed75`
- Migration-plan baseline: `c58c092115bd3b1dc074e186cbdf74db7cce0321`
- PR #1262 merge commit: `7cc2b35d0d22448f03390791a3fa5812d5020d8d`
- Scope: Phase 0 investigation and design only
- Phase 0 Gate 0: not yet approved; required runtime checks remain

This report is a planning and investigation record. It does not authorize code
deployment, production inventory writes, reservation changes, recipe activation,
configuration changes, ATP changes, Shopify or marketplace quantity publication,
or channel-setting changes.

No code, production data, inventory, reservations, configuration, or channel
quantity was changed during this investigation.

## Executive Result

Echelon does not currently have one authoritative ATP contract. The same inventory
can produce different answers depending on which API, screen, order path, or
channel invokes it.

The target flow is:

```text
promise-eligible physical on-hand
− active owned claims
− resolved safety stock
→ transformation planner
→ canonical ATP per SKU/fulfillment scope
→ channel policy that may only reduce ATP
→ durable publication outbox
```

## Baseline Verification

- PR [#1262](https://github.com/cardshellz/Echelon/pull/1262) is merged as commit
  [`7cc2b35d`](https://github.com/cardshellz/Echelon/commit/7cc2b35d0d22448f03390791a3fa5812d5020d8d).
  Git verifies that this commit is an ancestor of current `origin/main`.
- Refreshed `origin/main` is
  [`3fca50c`](https://github.com/cardshellz/Echelon/commit/3fca50c107c122bf954f70c75c3edcceb899ed75).
- The migration document was written against `c58c092`. The
  [baseline comparison](https://github.com/cardshellz/Echelon/compare/c58c092115bd3b1dc074e186cbdf74db7cce0321...3fca50c107c122bf954f70c75c3edcceb899ed75)
  contains the migration document itself, dropship OAuth work, and
  shipment-package allocation audit work. It contains no later change to the
  core ATP, reservation, or channel-allocation implementation.
- `AGENTS.md` is absent from both the workspace and `origin/main`. The
  instructions supplied directly in the investigation prompt were followed.

## Issue 1: Physical Inventory And ATP Equations

Confirmed physical quantities are:

```text
physical bin on-hand = inventory_levels.variant_qty

physical custody =
    variant_qty
  + picked_qty
  + packed_qty
```

`variantQty` is explicitly defined as physical on-hand. `pickedQty` and
`packedQty` are separate custody buckets
([`inventory.schema.ts:25-37`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/shared/schema/inventory.schema.ts#L25-L37)).

Picking moves quantity from `variantQty` to `pickedQty`; it does not leave the
quantity in both buckets
([`InventoryUseCases.pickItem:440-503`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/application/inventory.use-cases.ts#L440-L503)).
Reserving changes only `reservedQty`; physical on-hand remains unchanged
([`reserveForOrder:1016-1088`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/application/inventory.use-cases.ts#L1016-L1088)).

Therefore, picked and packed quantities must not be subtracted from `variantQty`
again.

The target physical-resource equation, using current code variables, is:

```text
eligibleOnHandBase =
  SUM(inventoryLevels.variantQty
      * productVariants.unitsPerVariant)
  for promise-eligible locations

claimedBase =
  SUM(open claim allocations in base units)

protectedBase =
  resolved warehouse/resource safety-stock floor

availableResourceBase =
  MAX(0, eligibleOnHandBase - claimedBase - protectedBase)
```

The transformation planner determines the maximum feasible target-SKU quantity
without reusing any resource twice:

```text
canonicalAtpUnits =
  FLOOR(maxFeasibleTargetBase / targetVariant.unitsPerVariant)
```

The current canonical fungible method correctly uses `onHand - reserved`
([`getTotalBaseUnits/getAtpBase:180-217`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L180-L217)).
However, four other paths subtract picked and packed quantities again:

- Inventory-item summary:
  [`atp.service.ts:664-698`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L664-L698)
- Bulk ATP, including dropship:
  [`atp.service.ts:715-755`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L715-L755)
- Warehouse summary:
  [`inventory.routes.ts:740-783`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/inventory.routes.ts#L740-L783)
- Recipe snapshot:
  [`recipe-capacity.service.ts:177-190`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/recipe-capacity.service.ts#L177-L190)

## Issue 2: Reserve And Backstock Promise Eligibility

Canonical ATP sums every inventory level without filtering location status, type,
cycle-count freeze, or promise eligibility
([`getTotalBaseUnits:180-194`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L180-L194)).

Reserve inventory contributes today only because every location contributes.
Receiving, staging, inactive, and frozen locations can contribute for the same
reason.

`isPickable` is described as “contributes to ATP,” but operational UI rules permit
it only for pick locations
([`warehouse.schema.ts:143-167`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/shared/schema/warehouse.schema.ts#L143-L167),
[`SlottingSetup.tsx:129-172`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/SlottingSetup.tsx#L129-L172)).

Recommended separate properties:

- `directly_pickable`: operational picking property.
- `promise_eligible`: ATP property.

Recommended defaults:

- Pick: directly pickable and promise-eligible.
- Reserve/backstock: not directly pickable, promise-eligible.
- Receiving/staging/quarantine: not promise-eligible.
- Frozen: temporarily excluded from promise.

Every eligibility exclusion or activation must carry a reason, actor, version, and
ATP-impact preview.

## Issue 3: Reservations Are Not Durable Resource Claims

Physical reservation chooses an assigned or fallback location and intentionally
does not require stock in that bin
([`ReservationService.reserveForOrderLocked:228-299`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/reservation.service.ts#L228-L299)).

Picking can select an explicit, assigned, or alternative pickable location
([`picking.use-cases.ts:1887-1929`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/orders/picking.use-cases.ts#L1887-L1929)).
`pickItem()` releases only the anonymous reservation counter on the actual pick
bin.

If the reservation and pick occur in different bins:

```text
actual bin on-hand decreases
original bin reservation can remain
global ATP can decrease twice
```

This is a confirmed structural possibility. Whether specific live orders currently
exhibit it is not proven.

Physical-only ATP also clamps each bin before aggregation:

```sql
SUM(GREATEST(variant_qty - reserved_qty, 0))
```

([`atp.service.ts:261-337`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L261-L337)).

That is incorrect when over-reservation is intentionally allowed as a replenishment
signal
([`migration 0614`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/migrations/0614_drop_over_reservation_constraint_qualified.sql#L1-L16)).
Aggregation must occur before the single final clamp.

### Reservation And Build-Promise Caller Inventory

| Entry point | Production callers |
| --- | --- |
| `ReservationService.reserveOrder()` | Manual inventory API ([`inventory.routes.ts:1052`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/inventory.routes.ts#L1052)); OMS repair ([`oms-flow-reconciliation.service.ts:913`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/oms-flow-reconciliation.service.ts#L913)); OMS delegation ([`oms.service.ts:539-594`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/oms.service.ts#L539-L594)); WMS creation and reassignment ([`wms-sync.service.ts:1270`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/wms-sync.service.ts#L1270), [`2269-2273`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/wms-sync.service.ts#L2269-L2273)) |
| Channel order ingress | eBay ingestion calls OMS reserve ([`ebay-order-ingestion.ts:591`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/ebay-order-ingestion.ts#L591), [`732`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/ebay-order-ingestion.ts#L732)); Shopify paid webhook follows the same OMS path ([`oms-webhooks.ts:1061`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/oms-webhooks.ts#L1061)) |
| `releaseOrderReservation()` | Manual release, OMS cancellation and reconciliation, WMS reassignment, common WMS cancellation helper, and legacy Shopify cancellation ([`inventory.routes.ts:1069`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/inventory.routes.ts#L1069), [`oms-webhooks.ts:432`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/oms/oms-webhooks.ts#L432), [`cancel-wms-order.ts:107`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/orders/cancel-wms-order.ts#L107), [`shopify.routes.ts:644`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/routes/shopify.routes.ts#L644)) |
| Recipe build promise | `reserveForOrder()` calls `claimOrderItem`; release calls `cancelOrderDemands` ([`reservation.service.ts:137-156`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/reservation.service.ts#L137-L156), [`451-461`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/reservation.service.ts#L451-L461)); build completion calls `reconcileBuildCompletion` ([`services/index.ts:130-148`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/services/index.ts#L130-L148)) |
| Orphan reallocation | Cycle-count reconciliation calls `reallocateOrphaned()` ([`cycle-count.use-cases.ts:359`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/application/cycle-count.use-cases.ts#L359)) |
| Apparently unused | `autoReserveOnSync()` has no production caller in the repository-wide scan. |

## Issue 4: ATP Readers And Calculators

| Reader or calculator | Current consumers and conclusion |
| --- | --- |
| `getAtpBase()` | Core global fungible pool. Directly used by eBay registration, channel inspection, and inventory status ([`eBay registration:82-125`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/adapters/ebay/ebay-marketplace-registration-owner.pg-repository.ts#L82-L125), [`channels.routes.ts:1556`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/channels.routes.ts#L1556), [`inventory.routes.ts:659`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/inventory.routes.ts#L659)). Migrate behind the planner facade. |
| `getAtpBaseByWarehouse()` and `getDirectVariantAtpByWarehouse()` | Used by per-warehouse projection and channel publishing ([`atp.service.ts:231-337`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L231-L337)). Replace with explicit planner warehouse/network scope. |
| `getAtpPerVariant()` and `getAtpPerVariantByWarehouse()` | Current strategy switch and main reader used by allocation, reservation, inventory views, sync, and direct eBay listing ([`atp.service.ts:345-458`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L345-L458), [`allocation-engine.service.ts:198-220`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/allocation-engine.service.ts#L198-L220), [`reservation.service.ts:186-299`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/reservation.service.ts#L186-L299)). This becomes the compatibility adapter to the planner. |
| Recipe capacity | Snapshot plus `planDemand()` and maximum feasible capacity ([`recipe-capacity.service.ts:155-251`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/recipe-capacity.service.ts#L155-L251), [`311-345`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/recipe-capacity.service.ts#L311-L345), [`recipe-capacity.domain.ts:370-452`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/domain/recipe-capacity.domain.ts#L370-L452)). Keep recipe logic but consume the unified snapshot/resource graph. |
| `getInventoryItemSummary()` and `getBulkAtp()` | Inventory screens, channel matrix, and dropship. Both contain divergent formula behavior ([`atp.service.ts:606-755`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/atp.service.ts#L606-L755)). Retire as calculators; keep planner-backed DTO projections only. |
| Inventory-level API and client helper | Server canonicalizes only recipe products; the client recursively derives availability for other strategies ([`inventory-levels.query.ts:55-112`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/application/inventory-levels.query.ts#L55-L112), [`inventory-availability.ts:9-37`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/lib/inventory-availability.ts#L9-L37)). Remove client calculation. |
| No production callers found | `getAtpForChannel()` and `getProductSummary()` are defined but unused. Retire or replace with explicit planner and channel DTOs. |

## Issue 5: Channel Allocation Is Fragmented

The live allocation engine treats every channel independently. Tests explicitly
allow Shopify 80% plus eBay 80%, exposing 160% of the same pool
([`allocation-engine test:578-607`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/__tests__/unit/allocation-engine.service.test.ts#L578-L607)).

That can be valid only if labeled **exposure**, where all channels compete for the
same ATP. It is not protected channel allocation.

Current live rule fields are `mirror/share/fixed`, percentage, fixed quantity,
floor cutoff, ceiling, and eligibility
([`channels.schema.ts:439-470`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/shared/schema/channels.schema.ts#L439-L470)).
Current `floorAtp` is only a “publish zero below this threshold” rule; it is not
safety stock
([`allocation-engine.service.ts:581-660`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/allocation-engine.service.ts#L581-L660)).

The robust per-SKU/channel formula is:

```text
if !eligible:
  published = 0
else:
  afterHoldback = max(0, canonicalAtpUnits - holdbackUnits)
  shared = floor(afterHoldback * shareBps / 10_000)
  capped = min(shared, maxPublishUnits or infinity)
  published = capped < minPublishThresholdUnits ? 0 : capped
```

Required invariants:

```text
0 <= published <= canonicalAtpUnits
all absolute dials use sellable SKU units
channel policy never overrides safety stock
```

Two explicit semantics are required:

- `exposure`: independent views; channel totals may exceed ATP.
- `partitioned`: hard channel budgets; total active budgets and claims must not
  exceed ATP.

### Confirmed Bypasses

| Path | Evidence |
| --- | --- |
| Dropship order acceptance | Locks raw inventory rows and locally evaluates exact-variant `max(0, variant_qty-reserved_qty)` ([`acceptance:203-277`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts#L203-L277), [`878-903`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts#L878-L903), [`1243-1263`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts#L1243-L1263)). It bypasses transformations and channel policy. The repository is wired through the production dropship order route and factory. |
| Dropship selection and listing | Uses product-level `getBulkAtp()` and divides by UOM instead of consuming Dropship channel allocation ([`dropship-atp.provider.ts:3-15`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/dropship/infrastructure/dropship-atp.provider.ts#L3-L15), [`dropship-selection-atp-service.ts:233-257`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/dropship/application/dropship-selection-atp-service.ts#L233-L257)). That quantity is carried into eBay listing intent. |
| eBay marketplace registration | Uses global `getAtpBase()` divided by each variant UOM, skipping allocation rules and assigned warehouses ([`registration repository:82-125`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/adapters/ebay/ebay-marketplace-registration-owner.pg-repository.ts#L82-L125)). |
| Direct eBay listing and sync routes | Use `getAtpPerVariant()` but skip channel allocation ([`ebay-listings.routes.ts:585-604`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/routes/ebay/ebay-listings.routes.ts#L585-L604), [`1007-1026`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/routes/ebay/ebay-listings.routes.ts#L1007-L1026), [`ebay-sync-helpers.ts:459-525`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/routes/ebay/ebay-sync-helpers.ts#L459-L525)). |
| eBay test listing | Hardcodes quantity `1`. This is a test action, not the normal inventory publisher ([`ebay-settings.routes.ts:567-599`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/routes/ebay-settings.routes.ts#L567-L599)). |
| TikTok | Only Shopify and eBay adapters are registered ([`services/index.ts:254-270`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/services/index.ts#L254-L270)). No TikTok inventory adapter exists. Whether a TikTok channel is configured or active at runtime is unknown. |

### Canonical Publisher Path

The intended path is:

```text
AllocationEngine.allocateProduct()
→ EchelonSyncOrchestrator.syncInventoryForProduct()
→ Shopify or eBay adapter
```

Evidence:

- [`AllocationEngine.allocateProduct:198-416`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/allocation-engine.service.ts#L198-L416)
- [`EchelonSyncOrchestrator.syncInventoryForProduct:241-288`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/echelon-sync-orchestrator.service.ts#L241-L288)
- [`ShopifyAdapter.pushInventory:123-204`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/adapters/shopify.adapter.ts#L123-L204)
- [`EbayAdapter.pushInventory:229`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/adapters/ebay.adapter.ts#L229)

Confirmed problems:

- Inventory-change publication is an in-memory `Set` plus `setTimeout`, not an
  outbox
  ([`services/index.ts:282-308`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/services/index.ts#L282-L308)).
- Allocation selects every active channel and does not enforce `syncEnabled` or
  `syncMode`
  ([`allocation-engine.service.ts:215-220`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/allocation-engine.service.ts#L215-L220)).
- Warehouse-assignment changes never trigger resync.
- Rule create and update fire-and-forget a resync only when `productId` is
  present. Global and channel-default changes and deletes do not
  ([`channels.routes.ts:2419-2531`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/channels/channels.routes.ts#L2419-L2531)).
- Aggregate `lastSyncedQty` can hide per-location Shopify drift.

## Issue 6: UI And Configuration Writers

| UI or configuration writer | Current result | Recommendation |
| --- | --- | --- |
| Product Detail inventory strategy | Writes `inventoryStrategy` through product update ([`ProductDetail.tsx:1603-1653`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/ProductDetail.tsx#L1603-L1653), [`catalog.routes.ts:928-1037`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/catalog/catalog.routes.ts#L928-L1037)). | Replace with a read-only Supply & Transformations summary. |
| Product Detail channel controls | Writes legacy `channel_product_allocation` and `channel_reservations` while its Sync button publishes through the orchestrator ([`ProductDetail.tsx:1994-2096`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/ProductDetail.tsx#L1994-L2096)). | Remove writers and deep-link to the canonical policy page. |
| Channels → Reserves | Writes `reserveBaseQty`, minimum, maximum, and override ([`Reserves.tsx:82-141`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/Reserves.tsx#L82-L141)). No live allocation reader consumes `reserveBaseQty`. | Retire. Do not auto-convert it into safety stock. |
| Channel Allocation | Writes live rules and warehouse assignments immediately ([`ChannelAllocation.tsx:212-258`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/ChannelAllocation.tsx#L212-L258), [`393-458`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/ChannelAllocation.tsx#L393-L458)). | Replace immediate saves with draft, preview, and activation. |
| Locations and Slotting | Writes type and pickability but has no promise-eligibility control. | Add separate directly-pickable and promise-eligible fields with an ATP-impact preview. |
| Build Recipe editor | Creates and patches active recipe definitions directly ([`BuildRecipeCreate.tsx:120-238`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/BuildRecipeCreate.tsx#L120-L238), [`build.routes.ts:87-124`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/inventory/build.routes.ts#L87-L124)). | Bind immutable recipe versions into draft transformation models. |
| Inventory screen | Displays client-derived “Available” and hides the distinction between custody, eligibility, safety stock, and canonical ATP ([`Inventory.tsx:1422-1474`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/client/src/pages/Inventory.tsx#L1422-L1474)). | Replace with server-owned evidence columns. |

Recommended navigation:

- Inventory → **Availability**
- Inventory → **Promise Policies**
- Inventory → **Supply & Transformations**
- Channels → **Inventory Exposure**
- Operations → **Inventory Publication**

Each channel and SKU row should show canonical ATP, resolved policy, proposed
quantity, published quantity, provider readback, drift, and “Why this quantity?”

## Final Proposed Contracts

### Schema Authorities

| Proposed aggregate | Purpose |
| --- | --- |
| `inventory.transformation_model_versions` and `transformation_model_heads` | Immutable definition versions plus one atomic runtime-authority pointer. |
| `inventory.transformation_equivalence_groups` and `transformation_equivalence_group_members` | Explicit reversible finished-resource groups. Prefer this over pairwise relationship rows. |
| `inventory.transformation_recipe_bindings` | Exact immutable recipe versions and directional conversions. |
| `inventory.location_promise_policy_versions` | Promise eligibility independent from pickability. |
| `inventory.promise_safety_stock_policy_versions` | Business-default, warehouse, or fulfillment-network resource floors. A warehouse override wins; a business default is fallback, not additive. |
| `inventory.supply_claims` and `inventory.supply_claim_allocations` | Order-owned direct, equivalence, component, and build claims. `reserved_qty` becomes a projection, not ownership authority. |
| `inventory.planner_shadow_results` and `inventory.transformation_activation_runs` | Immutable comparison and activation evidence. |
| `channels.channel_quantity_policy_versions` and policy heads | `eligible`, `semantics`, `share_bps`, `holdback_units`, `min_publish_units`, `max_publish_units`, and warehouse distribution. All absolute quantities are sellable SKU units. |
| `channels.channel_partition_budgets` | Only for explicitly partitioned channels. |
| `inventory.inventory_publication_outbox` and `inventory.inventory_publication_delivery_attempts` | Durable absolute desired quantities, attempts, acknowledgements, provider readback, and drift. |

### Planner DTOs

- `SupplySnapshotDto`: exact inventory levels, UOMs, active claims, location
  eligibility, safety policies, graph and model versions, warehouse/network
  scope, and fingerprint.
- `AtpProjectionRequestDto`: target variant and explicit fulfillment scope. It
  contains no channel concerns.
- `AtpProjectionDto`: canonical units and base units; direct, equivalent, and
  buildable evidence; protected safety quantity; claims; model and policy
  hashes; and snapshot fingerprint.
- `ClaimPlanDto`: target demand, exact resource allocations, component claims,
  build demands, source and output locations, shortfall, and idempotency key.
- `ChannelQuantityPlanDto`: canonical ATP, resolved channel policy, and desired
  quantity per provider location.
- `PublicationEventDto`: absolute desired quantity, channel, location, variant,
  model/policy/snapshot revisions, and idempotency key.

### Locking Order

Every claim and build path must use the same order:

1. Graph-product advisory locks, ascending product ID.
2. Active model, location-policy, safety-policy, and channel-policy heads.
3. Order, then order item, then existing claim.
4. Inventory resource and level rows sorted by warehouse, location, and variant.
5. Build demands and claim allocations.
6. Recompute, persist claims, projections, audit evidence, and outbox records;
   then commit.
7. External channel calls occur only after commit.

Current recipe promise locks the order and item before graph products
([`recipe-build-promise.service.ts:199-270`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/server/modules/wms/application/recipe-build-promise.service.ts#L199-L270)).
That order must be reversed.

### Activation State Machine

```text
draft
→ shadow
→ ready
→ conservative_queued
→ conservative_verified
→ authority_activated
→ full_publication_queued
→ provider_verified
→ complete
```

A pre-activation failure leaves legacy authority untouched. A post-activation
failure enters `rollback_required`, followed by conservative publication,
prior-head reactivation, full republish, and provider verification.

### Publication Outbox Contract

- Publish absolute quantities, never deltas.
- Use unique identity per revision, channel, variant, and provider location.
- Enforce per-key serialization and monotonic revision checks.
- Record retry leases, classified errors, and dead-letter state.
- Store separate delivery-attempt rows with request hash, response hash and
  status, provider acknowledgement, and provider readback.
- Treat Shopify warehouse locations as independent delivery records.
- Never drop or coalesce a zero quantity behind an older positive quantity.

## Recommended Changes To The Migration Document

Keep its one-planner, explicit-transformation, shadow-first, claim,
conservative-publication, rollback, and outbox direction
([`core principles:142-169`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/docs/INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md#L142-L169)).

Recommended changes:

1. Change “Exact physical stock is always eligible” to “Exact physical stock is
   eligible only when its location and disposition policy permits promise”
   ([`current wording:154-155`](https://github.com/cardshellz/Echelon/blob/3fca50c107c122bf954f70c75c3edcceb899ed75/docs/INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md#L154-L155)).
2. Add explicit location promise eligibility and safety-stock policies before
   ATP.
3. Replace pairwise reversible relationships with equivalence groups and
   members.
4. Add exposure versus partitioned channel semantics and composable per-SKU
   dials.
5. Make order-owned claims authoritative and retain `reserved_qty` as a
   compatibility projection.
6. Make fulfillment scope and network explicit in every planner request.
7. Include channel-policy and safety-policy revisions in activation and
   rollback.
8. Expand outbox evidence to every channel, variant, and provider-location
   delivery.
9. Add explicit cutover work for dropship acceptance, dropship listing, eBay
   registration, direct eBay listing, and future TikTok.
10. Split model-definition lifecycle from the atomic active-head pointer.

## Recommended Implementation Slices

1. Contract and invariant tests plus additive schemas; no behavior changes.
2. Unified snapshot and planner operating in shadow.
3. Planner-backed read APIs and UI plus bypass shadow comparisons.
4. Order-owned claims and deterministic locking.
5. Versioned channel dials, preview, activation, and durable outbox.
6. Explicit partition budgets if required.
7. Canary and cohort activation followed by legacy retirement.

## Confirmed Facts

- Multiple ATP formulas and authority paths exist.
- Dropship acceptance, dropship selection and listing, eBay registration, and
  direct eBay listing bypass channel allocation.
- Picked and packed quantities are double-subtracted in several readers.
- No explicit promise-eligibility or ATP safety-stock authority exists.
- Legacy channel controls remain writable but do not govern the live allocation
  engine.
- Publication is not generally backed by a durable outbox.
- No TikTok inventory adapter is registered.

## Hypotheses Requiring Runtime Evidence

- Existing orders may have reservation and pick-bin mismatches.
- Current provider quantities may differ by Shopify location even when aggregate
  sync state appears equal.
- Operators may believe legacy Reserves and Product Detail settings control
  publication.

## Unknowns And Required Next Checks

- Current deployed application commit and applied migration set.
- Runtime-active channels, `syncEnabled` and `syncMode` values, allocation rules,
  warehouse assignments, and legacy reserve rows.
- Provider readback capabilities and current Shopify/eBay quantities.
- Count of live mismatched reservations or claims and affected orders.
- Final safety-stock values and whether days-of-cover is required initially.
- Whether any TikTok or other externally managed publisher exists outside this
  repository.
- Required build lead-time and fulfillment-SLA treatment.

Because these runtime checks remain, Phase 0 Gate 0 is not approved.

## Worktree Boundary

The existing dirty checkout was preserved.

The previously created `inventory-transformation-phase0` worktree contains parked,
uncommitted experimental files and was six commits behind current `origin/main` at
the time of this report. It was not used or modified during this investigation.

Future implementation must begin in a fresh clean worktree from the then-current
`origin/main` after this report is reviewed and Phase 0 is explicitly approved.
