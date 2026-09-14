# Inventory Availability Pre-Activation Completion Record

## Status And Evidence Snapshot

This record closes the repository implementation work that can be completed before a production cutover. It does not claim that production authority has changed, that provider quantities have been updated, or that post-cutover stabilization and legacy retirement have occurred.

- Refreshed PR base: `origin/main` at `fc37b77a6cc50833a256509bc21922fb991f2b66`.
- Pre-activation foundation snapshot: `105cc9f3025678307c0878e8e84ba55d6596bc8f`.
- Final WMS authority-fence snapshot: `0c14d8cff5fd4967234b8ca0b1538f84a82a5dda`.
- PR #1262 merge commit: `7cc2b35d0d22448f03390791a3fa5812d5020d8d`; it remains an ancestor of the refreshed base.
- Worktree: `.codex-worktrees/inventory-plan-completion-20260913` on `codex/inventory-plan-completion-20260913`.
- The original checkout and its unrelated local changes were not staged, reset, cleaned, or modified by this completion pass.
- No production database, inventory, recipe, ATP, reservation, Shopify, eBay, Dropship, channel, or configuration write was executed.

The committed Phase 0 baseline, reviewed decisions, and closure are:

- `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-REPORT.md`
- `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-REVIEWED-DECISIONS.md`
- `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-FINAL-REVIEW-CLOSURE.md`

Those documents describe the defects found on their historical baseline. The tables below record the final repository paths after the implementation, so the old bypass findings must not be read as the state of this branch.

## Outcome

The branch now contains one authority-routed inventory path for ATP reads, order claims, channel exposure, and quantity publication. Legacy implementations remain only as compatibility implementations selected by the runtime authority row before cutover. Canonical activation remains an explicit, role-gated production operation.

The repository work for migration Phases 0 through 5 is implemented through the pre-activation boundary. Phase 6 requires observation of a real activated production system. Phase 7 requires a later, separately approved removal after the retention and stability criteria are met. Those two phases cannot be truthfully completed in this PR.

## Final End-To-End Runtime Trace

```text
physical inventory and claim evidence
  -> immutable supply snapshot
  -> warehouse-aware canonical planner
  -> SKU-level canonical ATP
  -> channel exposure policy for an exact publication target
  -> absolute desired quantity and durable outbox row
  -> final quantity-publication admission fence
  -> provider adapter
  -> acknowledgement and exact provider readback
```

Order acceptance follows the same inventory authority:

```text
Shopify/eBay/Dropship order intake
  -> OMS order
  -> internal ready physical fulfillment: WMS order/items with explicit warehouse
  -> authority-aware ReservationService facade
  -> whole-order canonical claim when authority=canonical
  -> only after authority resolves: atomic shipment + provider outbox
  -> exact resource, transformation, and build-operation claims
  -> pick/assembly handoff/pack/ship consumption
  -> release or exact compensation on cancellation/failure

pending physical -> WMS order/items only until paid promotion
3PL physical -> explicit external-custody warehouse; no local claim/ShipStation work
digital-only -> completed WMS evidence; no warehouse, claim, shipment, or outbox
```

Evidence: runtime composition is in `server/services/index.ts:180-243,383-423`; inventory-change publication is wired at `server/services/index.ts:425-505`; the scheduled sweep calls the same coordinator at `server/index.ts:321-396`.

## ATP Reader And Calculator Census

| Reader or calculator | Final authority and consumers | Evidence |
| --- | --- | --- |
| `InventoryAvailabilityRuntimeAtpService.getAtpPerVariant()` and `.getAtpPerVariantByWarehouse()` | Public compatibility facade. It resolves the runtime authority once and selects legacy or canonical inside that boundary. Allocation, reservation, inventory views, sync compatibility, and eBay readers consume this facade. | `server/modules/inventory-planning/application/inventory-availability-runtime-atp.service.ts:56-64,162-194`; composition at `server/services/index.ts:180` |
| `PostgresInventoryAvailabilityRuntimeAtpRepository.execute()` | Transactional authority reader. It constructs the legacy calculator only inside the runtime boundary and captures the canonical snapshot in the same transaction. | `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts:31-65`; legacy construction at `:52` |
| `projectCanonicalAtp()` and `planCanonicalClaim()` | Canonical, warehouse-aware resource and transformation planner. It resolves promise safety before allocating each resource and aggregates exact, convertible, and buildable evidence without double-use. | `server/modules/inventory-planning/domain/inventory-availability-planner.ts:493-758,1052-1122,1150-1226` |
| `calculateChannelExposure()` | The sole channel-quantity formula over canonical ATP. It applies eligibility, basis-point share, holdback, maximum, and minimum threshold in sellable SKU units. | `server/modules/inventory-planning/domain/inventory-channel-exposure.ts:139-172` |
| `InventoryChannelQuantityRuntimeService.readProduct()` | Authority-aware product/channel reader used by listing, registration, and Dropship projections. It returns canonical channel exposure after cutover and the compatibility projection before cutover. | `server/modules/inventory-planning/application/inventory-channel-quantity-runtime.service.ts:77-206` |
| `EbayChannelQuantityReader.getAtpPerVariant()` | Exact eBay listing/registration reader. It calls `InventoryChannelQuantityRuntimeService`, not a route-local formula. | `server/modules/channels/adapters/ebay/ebay-channel-quantity.reader.ts:20-55`; settings consumer `server/routes/ebay-settings.routes.ts:606` |
| `DropshipAtpProvider` | Dropship selection/listing quantity reader. It uses the same runtime channel quantity service and exact publication target; that target's active source binding defines the permitted fulfillment warehouses/nodes. | `server/modules/dropship/infrastructure/dropship-atp.provider.ts:87-143`; factories `server/modules/dropship/infrastructure/dropship-listing-preview.factory.ts:37-40` and `server/modules/dropship/infrastructure/dropship-marketplace-registration.factory.ts:90-94` |
| `InventoryAvailabilityChannelPreviewRepository` and exposure admin preview | Read-only preview projections over the canonical planner/channel formula. They do not publish or activate. | `server/modules/inventory-planning/infrastructure/inventory-availability-channel-preview.repository.ts:75-91`; `server/modules/inventory-planning/infrastructure/inventory-channel-exposure-admin.repository.ts:1100-1140` |
| `createLegacyInventoryAtpService()` | Retained implementation, not a second selectable public authority. Repository-wide production construction occurs only inside the runtime ATP and claim repositories. | definition `server/modules/inventory/atp.service.ts:846`; constructions `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts:52` and `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-claim.repository.ts:369` |
| Browser availability math | Retired. The recursive client calculator and its tests are deleted; the UI displays server evidence. | deleted `client/src/lib/inventory-availability.ts`; server evidence UI `client/src/pages/Inventory.tsx:1350-1600`; browser contract `test/browser/inventory-availability.spec.ts:1-201` |

## Reservation, Release, And Build-Promise Caller Census

| Operation | Production callers | Final behavior and evidence |
| --- | --- | --- |
| `reservation.reserveOrder()` | Manual inventory API `server/modules/inventory/inventory.routes.ts:1066-1075`; OMS creation `server/modules/oms/oms.service.ts:561-584`; OMS repair `server/modules/oms/oms-flow-reconciliation.service.ts:933`; WMS creation/reconciliation `server/modules/oms/wms-sync.service.ts:1220-1239,1670-1757,2228-2305` | The exported reservation is the authority-aware runtime service composed at `server/services/index.ts:236-243`. Canonical mode creates a whole-order claim; legacy mode calls the retained reservation implementation within the boundary at `server/modules/inventory-planning/application/inventory-availability-runtime-claim.service.ts:107-158`. Explicit business shortfalls remain eligible for discrepancy picking; a thrown/unknown authority failure creates no internal shipment or provider outbox. |
| `reservation.releaseOrderReservation()` | Shopify cancellation `server/routes/shopify.routes.ts:633`; manual API `server/modules/inventory/inventory.routes.ts:1083-1092`; WMS cancel helper `server/modules/orders/cancel-wms-order.ts:109`; OMS cancellation/reconciliation `server/modules/oms/oms-webhooks.ts:437` and `server/modules/oms/oms-flow-reconciliation.service.ts:1670`; WMS reconciliation `server/modules/oms/wms-sync.service.ts:614` | The same runtime service selects canonical exact claim release or legacy release under the pinned authority. `server/modules/inventory-planning/application/inventory-availability-runtime-claim.service.ts:207-357`. |
| Order line build promise | `ReservationService.reserveForOrder()` invokes `claimOrderItem()` at `server/modules/channels/reservation.service.ts:330-338`; release invokes `cancelOrderDemands()` at `:648-655` | The recipe promise is retained only behind the runtime claim boundary before cutover. Canonical claims own build operations and assembly handoffs. Composition: `server/services/index.ts:220-243`; canonical persistence: `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:5749-5790`. |
| Build completion reconciliation | Build use cases call `recipeBuildPromise.reconcileBuildCompletion()` through the injected callback. | `server/services/index.ts:220-232`; implementation `server/modules/wms/application/recipe-build-promise.service.ts:430-517` |
| Orphan claim reallocation | Reservation reconciliation calls `reallocateOrphaned()`; the runtime service routes canonical and legacy outcomes explicitly. | `server/modules/channels/reservation.service.ts:1247,1593`; `server/modules/inventory-planning/application/inventory-availability-runtime-claim.service.ts:367-402` |
| Dropship acceptance | A durable `prepared -> inventory_claimed -> finalized` saga creates the OMS identity before inventory claiming, does not charge/confirm before the claim succeeds, and compensates a claimed stage on finalization failure. | schema `migrations/0667_dropship_canonical_acceptance_stages.sql:1-80`; application `server/modules/dropship/application/dropship-order-acceptance-service.ts:221-374`; repository `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:1110-1630` |

## Channel Allocation And Inventory Publisher Census

| Trigger or publisher | Final path | Evidence |
| --- | --- | --- |
| Inventory mutation | Variant change resolves affected products and calls `InventoryPublicationWorkCoordinator.syncProduct()`. | `server/services/index.ts:425-505` |
| Scheduled sweep | Calls `InventoryPublicationWorkCoordinator.syncAllProducts()`; the former direct `channelSync.syncAllProducts()` interval is replaced. | `server/index.ts:321-396`; scheduler `server/modules/channels/inventory-publication-sweep.scheduler.ts:24-151` |
| Manual full/product/channel sync | Manual runner and inventory routes call the same coordinator. | `server/modules/channels/manual-sync-runner.ts:53-69`; `server/modules/inventory/inventory.routes.ts:811-833,1121-1180` |
| Allocation-rule mutation compatibility trigger | Calls the coordinator after a successful allowed legacy rule mutation. | `server/modules/channels/channels.routes.ts:2520-2653` |
| eBay variant availability worker | Every claim enters `publishVariantAvailability()`. Canonical authority enqueues current absolute work and never calls the legacy callback; legacy authority reaches the eBay adapter, whose only API-client factory injects final quantity admission. | `server/modules/channels/variant-availability-sync.service.ts:86-171,220-280`; worker `server/index.ts:805-817`; authority branch `server/modules/inventory-planning/application/inventory-availability-runtime-publication.service.ts:186-220`; eBay choke point `server/modules/channels/adapters/ebay/ebay-api.client.ts:801-809,956-970` |
| Runtime publisher | `InventoryPublicationWorkCoordinator` checks the global control, resolves authority, then runs canonical outbox publication or the compatibility orchestrator. It never falls back from a failed canonical run to legacy. | `server/modules/inventory-planning/application/inventory-publication-work-coordinator.service.ts:42-128` |
| Canonical intent creation | Creates full absolute intents, including zero when the SKU is ineligible or has no usable conversion/build contribution. | `server/modules/inventory-planning/application/inventory-availability-runtime-publication.service.ts:190-347,350-442` |
| Durable delivery | Claims a leased outbox row, performs final admission, publishes absolute quantity, verifies response/readback, and records attempt state. Admission is a required constructor dependency. | `server/modules/inventory-planning/application/inventory-publication-outbox.service.ts:52-127`; repository `server/modules/inventory-planning/infrastructure/inventory-publication-outbox.repository.ts:62-177,182-340` |
| Shopify final I/O | Only the publication transport invokes the Shopify adapter's absolute inventory method; the admission fence runs immediately before it. | transport `server/modules/channels/channel-inventory-publication-transport.adapter.ts:26-44`; adapter `server/modules/channels/adapters/shopify.adapter.ts:131-204`; admission composition `server/services/index.ts:403-409` |
| eBay final I/O | Normal eBay channel publication goes through the same transport/admission boundary. Every adapter client is built by the admission-injecting factory, and the HTTP boundary rejects a quantity mutation if admission is absent. Listing and registration quantities use `EbayChannelQuantityReader`. | `server/modules/channels/adapters/ebay.adapter.ts:234-312,866-889`; `server/modules/channels/adapters/ebay/ebay-api.client.ts:801-809,956-970`; `server/modules/channels/adapters/ebay/ebay-channel-quantity.reader.ts:20-55` |
| Dropship eBay final I/O | Uses a target-scoped absolute publication adapter and the common admission owner. | `server/modules/dropship/infrastructure/dropship-ebay-inventory-publication.adapter.ts:97-139`; listing push invocation `server/modules/dropship/infrastructure/dropship-ebay-listing-push.provider.ts:490-505` |
| WMS shipment/provider handoff | Internal physical orders require a positive routed warehouse. WMS order/items commit first; the authority-aware whole-order reservation then resolves; only a `ready` order enters a second idempotent transaction that creates/links the shipment and its provider outbox. Pending, 3PL, and digital states are excluded from that internal provider path. | gates `server/modules/oms/wms-sync.service.ts:102-153,900-960`; create admission `:1015-1239`; atomic shipment/outbox `:1421-1649`; reconciliation admission `:2165-2305`; regression contract `server/modules/oms/__tests__/unit/wms-sync-claim-prerequisites.test.ts:1-218` |
| Retained `ChannelSyncService` raw Shopify helper | Not an active publisher entry point in the repository census. `syncProduct()` fails closed without its orchestrator and does not fall back. The private raw helper remains reachable only from the uncalled retained `syncAllProducts()` compatibility body. | `server/modules/channels/sync.service.ts:143-214,221-287,580-672`; production triggers above call the coordinator instead |

## Inventory Strategy And Configuration Writer Census

| Configuration authority | Writer entry points | Enforcement |
| --- | --- | --- |
| Transformation model drafts | Create/update routes in `server/modules/inventory-planning/interfaces/http/inventory-availability-master-data.routes.ts:115-152` | Versioned immutable model records and active-head validation are owned by `InventoryAvailabilityMasterDataService`; routes contain no business calculation. |
| Location promise policy drafts | `server/modules/inventory-planning/interfaces/http/inventory-availability-master-data.routes.ts:157-168` | Explicit location/disposition promise eligibility, versioned and reviewed before activation. |
| Promise safety policy drafts, including fixed units, days of cover, and per-SKU disable/override | `server/modules/inventory-planning/interfaces/http/inventory-availability-master-data.routes.ts:173-217` | `InventoryPromiseSafetyAdminService.updatePolicyDraft()` validates deterministic demand evidence and policy mode at `server/modules/inventory-planning/application/inventory-promise-safety-admin.service.ts:102-166`. |
| Channel exposure policy and exact target mappings | `server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts:91-222` | Product/SKU inheritance, exact target identity, preview, mapping, stop, and resume go through the inventory-planning application service. Activation/stop/resume require `inventory_planning:activate` at `:107-148`. |
| Global publication control | `PUT /api/inventory-planning/admin/publication-control` | Role-gated, idempotent, revision-checked, audited singleton command: route `server/modules/inventory-planning/interfaces/http/inventory-publication-global-control.routes.ts:19-49`; transaction `server/modules/inventory-planning/infrastructure/inventory-publication-global-control.repository.ts:34-158`. |
| Legacy `products.inventoryStrategy` | Product create/edit compatibility routes | Canonical mode rejects a mutation; an unchanged value may pass as a no-op. `server/modules/inventory/inventory.routes.ts:1768-1825,1889-1901`; control definition `server/modules/inventory-planning/application/inventory-legacy-admin-control.service.ts:30-76,110-151`. |
| Legacy reserve/allocation/warehouse assignment/feed/sync controls | Existing Channels, Reserves, allocation, warehouse-assignment, and sync routes | All writers execute through `InventoryLegacyAdminControlService`; canonical mode returns the canonical replacement instead of mutating the retired authority. `server/modules/channels/channels.routes.ts:73-151,1494-1615,1925-1960,2323-2406,2520-2653`; `server/modules/channels/sync-control.routes.ts:44-66,100-150,252-266`. |
| Legacy allocation reads and divergence tools | Existing read routes | Authority gate makes canonical evidence the supported surface and prevents the old UI from being mistaken for authority. `server/modules/inventory-planning/application/inventory-legacy-admin-control.service.ts:77-109,153-207`; `server/modules/inventory/inventory.routes.ts:1210-1245`. |

## Active Bypass Result

Confirmed repository result: no production-visible Shopify, eBay, Dropship, inventory-change, scheduled, or manual publication entry point was found that can select its own ATP formula after canonical authority is active. All identified active readers/publishers resolve through the runtime quantity or publication boundary, and provider I/O is guarded by final admission. Internal WMS shipment handoff also fails closed before any shipment/outbox work exists when warehouse routing or inventory authority is unknown; an explicit returned stock shortfall remains an operational pick discrepancy rather than an automatic order hold.

This is a static repository conclusion, not proof about external systems. The repository does not contain a direct TikTok adapter; TikTok currently inherits Shopify publication because it is routed through Shopify. A future direct TikTok integration must implement the same `InventoryPublicationTransport` contract and may not calculate quantity itself.

Unknown: an external script, marketplace automation, 3PL system, or provider-side rule outside this repository could still write a quantity. That requires provider/account and integration inventory during the production read-only preflight.

## Final Schema And Domain Contracts

The implemented schema follows the approved design:

- Immutable, versioned transformation models, directed paths, recipe bindings, location promise policies, promise safety policies, channel exposure policies, and active heads.
- Warehouse-aware inventory positions, exact order-owned claims, claim lines, resource and lot allocations, transformation/build operations, fulfillment groups, and immutable evidence hashes.
- Exact publication targets and provider identities, absolute desired revisions, activation runs, freezes, outbox deliveries, attempts, acknowledgements, readbacks, drift, target stops, and append-only resume reviews.
- Additive Dropship acceptance stages and claim-attempt evidence.
- Build orders pin transformation authority, activation run, model/version/hash, recipe binding/hash, actor, and time.
- The exact inventory-level identity `(product_variant_id, warehouse_location_id)` is enforced by versioned migration `0671_inventory_quantity_level_identity.sql` and the aligned Drizzle schema. The migration fails closed on duplicates and does not rewrite inventory.

The concrete planner DTO boundary is `SupplySnapshotDto`, `ClaimSupplySnapshotDto`, `AtpProjectionRequestDto`, `AtpProjectionDto`, `ClaimPlanRequestDto`, and `ClaimPlanDto` in `shared/types/inventory-availability-planner.ts:512-523`. Channel planning uses `ResolvedChannelExposurePolicy` and `InventoryChannelExposureRuntimePlan` in `shared/types/inventory-channel-exposure.ts:575-612`. Final provider delivery uses `AbsoluteInventoryPublicationRequest`, `AbsoluteInventoryReadRequest`, and `InventoryPublicationTransportAdapter` in `server/modules/inventory-planning/application/inventory-publication-transport.ts:1-65`.

## Locking Order

The canonical claim transaction uses the approved deterministic order:

1. Stable graph-product advisory locks in ascending product ID.
2. Transformation and planning-policy heads.
3. Order, order items, fulfillment groups, and existing claim.
4. Inventory resources/levels and lots in stable warehouse/location/variant/lot order.
5. Claim allocations and transformation/build operations.
6. Evidence, audit, and outbox writes before commit.
7. External provider calls only after commit.

Evidence: graph and policy locks are `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:798-861`; resource and lot locks are `:861-930`; whole-order claim revalidation and persistence are `:4163-4270`.

Publication uses an exact destination/item advisory owner and a global admission gate. Global stop acquires the exclusive gate before changing the singleton; target stop/resume acquire the exact target/SKU scope locks in stable order. Target stop supersedes its pending work; resume recomputes and enqueues a fresh full current snapshot. Evidence: `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:240-330`; `server/modules/inventory-planning/infrastructure/inventory-publication-global-control.repository.ts:40-158`; `server/modules/inventory-planning/infrastructure/inventory-publication-target-stop.repository.ts:36-215`; `server/modules/inventory-planning/infrastructure/inventory-publication-target-resume.repository.ts:179-363`.

## Activation And Target State Machines

Full-catalog activation remains:

```text
draft -> shadow -> ready
  -> conservative publication queued
  -> conservative provider acknowledgement/readback verified
  -> atomic authority switch to canonical
  -> full absolute publication queued
  -> provider verification
  -> complete
```

Before the authority switch, a failure leaves legacy authoritative and the prepared run may be aborted. The switch transaction revalidates the complete review, freezes configuration, advances the run to `activating`, updates the singleton authority by expected revision, advances the run to `active`, and queues full publication. Evidence: `server/modules/inventory-planning/infrastructure/inventory-availability-activation.repository.ts:85-180,211-303`; `server/modules/inventory-planning/infrastructure/inventory-cutover-commit.repository.ts:30-135`.

The target lifecycle is `disabled -> preview -> live -> disabled`. A stopped live target can resume only through `disabled -> preview -> live` after a fresh exact identity census, current canonical plan, recent matching provider readback, immutable readiness hash, revalidation under locks, full absolute zero-inclusive enqueue, audit, and idempotent receipt. Evidence: `migrations/0669_inventory_publication_global_control_singleton.sql:53-93`; `server/modules/inventory-planning/infrastructure/inventory-publication-target-resume.repository.ts:179-363,409-742,778-810`.

## Outbox Contract

- Absolute quantities only; no delta publication.
- Exact identity includes target revision, provider connection/location, external inventory item, variant, and desired revision.
- Zero is a first-class desired quantity and is never dropped behind an older positive row.
- Per-key serialization, leases, retry classification, bounded backoff, supersession, dead-letter state, request/response hashes, acknowledgement, and provider readback are durable.
- `QuantityPublicationAdmission` is structurally required by `InventoryPublicationOutboxService`; there is no direct-publish branch.
- Global stop prevents new provider admission while retaining durable catch-up work. Target stop supersedes its pending target rows; a later approved resume enqueues a fresh full-target snapshot rather than replaying stale quantities.

Evidence: `server/modules/inventory-planning/application/inventory-publication-outbox.service.ts:52-127`; `server/modules/inventory-planning/infrastructure/inventory-publication-outbox.repository.ts:62-177,182-340,361-606`; `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:240-330`.

## Intentional Legacy Compensation Rule

A build released or executed under canonical authority must carry exact pinned transformation evidence; missing, ambiguous, stale, or changed authority fails closed. Canonical claim-owned builds can be executed, cancelled, or reversed only through the claim-aware commands. Evidence: `server/modules/inventory/domain/transformation-execution-authority.ts:290-383,474-535`; `server/modules/inventory/infrastructure/build-execution.repository.ts:210-255,400-426`.

One compatibility rule is intentional: a build completed before cutover with all-null canonical authority columns may still be reversed through its exact durable build-run, component reservation, lot, source-location, and output-lot lineage. That is a compensating unwind of already-performed physical work, not authorization for a new conversion or promise. It fails if the exact lineage or current quantities cannot support the reversal. Evidence: additive-null migration contract `migrations/0668_build_order_transformation_authority.sql:1-65`; reversal validation and locks `server/modules/inventory/infrastructure/build-execution.repository.ts:1363-1435,1515-1675`.

## Comparison With The Migration Plan

The implementation preserves the migration document's core direction: one planner, explicit directed transformations, shadow evidence, whole-order claims, conservative publication before the authority switch, immutable activation evidence, a transactional outbox, and later legacy retirement.

The following Phase 0 recommendations are implemented amendments and should be treated as part of the authoritative plan:

1. Promise eligibility is determined by explicit location/disposition policy; physical stock is not automatically promiseable.
2. Safety stock supports business defaults, warehouse/SKU scopes, fixed units, trusted days-of-cover, fallbacks, and per-SKU disable/override.
3. Channel policy explicitly distinguishes independent exposure from partitioned budgets and uses composable per-SKU dials.
4. Fulfillment warehouse/network scope is explicit in planner and claim requests.
5. Order-owned claims replace anonymous reservation counters as canonical authority.
6. Dropship acceptance, eBay registration/listing, and all provider adapters use the same runtime planner/publication boundary.
7. Global and target emergency stops, exact target resume readiness, historical provider-identity census, and final-I/O admission are required cutover controls.
8. Transformation execution authority is pinned to builds and package conversions, not inferred from the current recipe or SKU hierarchy.
9. Activation is full catalog after preview; there are no required canary cohorts.
10. Basket planning remains a future caller of the whole-order contract and does not block checkout until a Shopify Function or equivalent integration invokes it.

Recommended document correction: the old plan's generic rollback language must not imply a first-cutover return to the known-wrong legacy formulas. Before first activation, abort leaves legacy untouched. After first activation, a rollback may select only a previously verified canonical model/version and must republish through the same outbox/readback controls.

## Confirmed Facts

- The implementation snapshot compiles, builds, passes the complete repository unit suite, passes the inventory browser suite, and passes the disposable PostgreSQL integration batch listed below.
- The canonical ATP is warehouse-aware, includes promise-eligible reserve/backstock, subtracts order-owned claims and resolved safety protection, and applies directed transformations without double-use.
- Dropship, eBay registration/listing, Shopify, manual, scheduled, and inventory-change paths share the runtime authority and publication boundaries.
- Digital or inventory-untracked variants are not admitted for quantity publication.
- Internal ready-to-pick WMS orders cannot create shipment/provider-outbox work until a positive warehouse is pinned and the authority-aware reservation call resolves. Pending physical, external 3PL, and digital-only orders do not enter that local shipment path.
- Legacy configuration surfaces remain available before cutover but their writes fail closed after canonical authority is active.
- Deployment of this branch is additive and inactive. None of migrations 0667-0671 switches runtime authority or invokes a provider.
- `0669` preserves the existing global enable value when its singleton exists and creates a disabled row only if none exists.

## Hypotheses

- Production preflight may find stale mappings, missing exact provider identities, old reservation drift, or incomplete readbacks. This is plausible from historical evidence but was not tested against production in this task.
- An integration outside this repository may publish inventory independently. The repository census cannot prove the absence of external automation.

## Unknowns

- The production application commit and applied migration set after this PR is deployed.
- Current provider quantities and readbacks for every Shopify/eBay account and location.
- Current production target mappings, fulfillment-node assignments, safety policies, transformation approvals, and open-order reconstruction blockers.
- The Canadian 3PL's receipt, inventory, order, fulfillment, cancellation, return, and reconciliation interfaces.
- The stability duration and completed order volume required before Phase 7 retirement. This requires an explicit business decision after Phase 6 evidence exists.

## Required Next Checks

1. Merge and deploy this PR with canonical authority still inactive.
2. Verify the deployed SHA and migration set read-only.
3. Run full-catalog production preflight, shadow planning, exact target/SKU identity census, and provider readbacks without publishing.
4. Resolve every reported master-data or mapping blocker through the role-gated canonical UI; do not infer missing conversions or fulfillment scope.
5. Obtain explicit activation approval, then execute conservative publication/readback and the atomic full-catalog authority switch.
6. Observe claim, pick, assembly, cancellation, zero-publication, retry, and provider-drift behavior during Phase 6.
7. Define the stability/order-volume gate and perform Phase 7 legacy deletion only in a later PR after that gate passes.

## Validation Evidence

- `npm.cmd test -- --no-file-parallelism --maxWorkers=1`: 1,244 test files passed, 93 skipped; 14,647 tests passed, 1,342 skipped.
- `npm.cmd run check`: passed.
- `npm.cmd run build`: passed; only the existing Vite chunk-size warning remained.
- `npx.cmd playwright test --config playwright.inventory.config.ts`: 18 of 18 desktop/mobile tests passed.
- Complete OMS unit suite: 137 files and 1,647 tests passed.
- Focused final WMS prerequisite batch: 10 files and 102 tests passed.
- Final disposable PostgreSQL batch: 8 integration files, 104 tests passed. It covered Dropship canonical acceptance, global publication control, target resume happy/rollback behavior, transformation execution authority, build-order authority, admission fencing, cutover opening, and cutover composition.
- Final focused unit batch: 10 files, 114 tests passed. It covered migration-prefix collision, writer ratchet, browser selection, PostgreSQL manifest, target resume, outbox, scheduler, sync effective state, and WMS gating.
- Exact inventory-level identity hardening: the migration/schema contract and migration-prefix guard passed (2 files, 3 tests), and `npm.cmd run check` passed on the refreshed combined tree.
- `git diff --cached --check`: passed before the implementation snapshot commit.

These are repository and disposable-database results. They are not production activation or provider-readback evidence.
