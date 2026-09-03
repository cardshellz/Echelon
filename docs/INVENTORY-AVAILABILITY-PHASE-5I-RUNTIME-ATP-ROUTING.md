# Inventory Availability Phase 5I: Authority-Aware Runtime ATP Routing

## Scope

This slice installs one operational ATP read boundary and routes every production
construction of the legacy ATP calculator through it. It does not expose an
activation command, change the runtime authority row, edit inventory, create or
release claims, change channel configuration, or call a marketplace provider.

Migration `0638_inventory_availability_cutover.sql` initialized the singleton
runtime authority to `legacy`. While that row remains `legacy`, the new boundary
executes the deployed legacy calculator on the same pinned database transaction.
Deployment therefore preserves current ATP behavior except for the separately
corrected eBay and dropship registration/preview paths described below.

## Atomic read contract

`PostgresInventoryAvailabilityRuntimeAtpExecutor.execute`:

1. opens one repeatable-read transaction;
2. reads `inventory.availability_runtime_authority` and holds a shared row lock;
3. validates the authority, revision, and activation-run lineage;
4. constructs the selected legacy or canonical reader on that same PostgreSQL
   client;
5. commits only after the complete ATP read finishes; and
6. rolls back and fails closed if authority evidence, calculation, or commit fails.

The shared row lock prevents a cutover transaction from changing authority while
an already-authorized legacy read is still running. A canonical read captures only
active transformation, location-promise, and safety-policy heads on the same
transaction. Draft-preferred admin shadows remain isolated from runtime.

## Canonical ATP behavior

When the separately controlled authority eventually becomes `canonical`, these
variant APIs call `projectCanonicalAtp` for every active customer-sellable SKU:

- network ATP;
- warehouse-scoped ATP; and
- the legacy-named direct-variant warehouse seam used by older synchronizers.

The direct-variant compatibility seam deliberately returns canonical target-SKU
ATP after cutover; it cannot bypass directed transformations, safety stock,
promise-location eligibility, or active claims merely because its old method name
contains `Direct`.

Canonical projections that contain configuration blockers emit a structured
`canonical_atp_projection_blocked` warning with product, SKU, scope, authority
revision, activation run, and blocker codes. The planner's path-local fail-closed
quantity remains visible, so malformed conversion authority cannot erase valid
exact-SKU physical availability.

## Scalar and channel fail-closed rules

The canonical model does not define one fungible product-wide ATP number. The
runtime boundary therefore rejects these legacy decision seams after cutover:

- product strategy as reservation authority;
- product base ATP and warehouse product base ATP;
- bulk product base ATP; and
- a channel ATP read that has not resolved active source bindings and channel
  exposure policy.

Backward-compatible inventory summary pages receive canonical per-SKU values. Any
display-only aggregate uses the largest represented target capacity and is marked
non-additive in code. Promise, claim, allocation, and publication decisions must
consume the exact SKU rows rather than that compatibility field.

## eBay and dropship correction

The following paths previously requested a product base quantity and divided it by
`unitsPerVariant`, which bypassed target-SKU transformation authority:

- Channels-owned eBay marketplace registration;
- dropship catalog selection preview;
- dropship listing preview; and
- dropship eBay marketplace registration.

They now request exact authoritative ATP by `(productId, productVariantId)`. Digital
or otherwise inventory-unmanaged variants still publish/register as zero. Missing
exact target rows also fail closed to zero. Vendor quantity caps remain reductions
of the returned SKU ATP and cannot increase it.

All eBay listing and synchronization routes continue to share the same exported
ATP instance from `ebay-utils.ts`; that instance is now authority-aware. The main
service container, dropship factories, vendor catalog route, and Channels eBay
registration repository construct the same boundary. The manual live-sync,
single-channel sync, Canada sync, dry-run, and ATP diagnostic scripts use it as
well; the legacy factory is no longer exported from the inventory module or
service barrel.

## Deliberate boundaries

- Runtime authority remains `legacy`; this slice has no authority writer.
- Legacy reservation/release is not yet replaced by canonical whole-order claim
  routing. In canonical mode its attempt to read legacy inventory strategy fails
  closed.
- The old allocation engine and legacy channel-allocation UI are not canonical
  channel policy. Canonical unallocated `getAtpForChannel` calls fail closed until
  the active exposure/source-binding runtime service replaces those paths.
- Existing provider publication remains on the legacy allocation engine. The
  canonical publication outbox is not activated by this slice.
- Picker completion/unpick and order demand-change callers are not routed in this
  slice; their canonical repository commands remain inactive.
- No schema migration is required.

## Remaining blockers before activation

1. Add the authority-aware whole-order reservation/release and demand-change
   service, then route OMS, WMS, dropship acceptance, cancellations, and picker
   reconciliation through it.
2. Add the active channel exposure/source-binding runtime allocator and route
   Shopify, direct eBay, dropship/eBay registration, listing previews, and every
   publisher through that allocator rather than raw canonical ATP.
3. Retire the legacy allocation UI and its scalar product-base reads after the new
   preview UI covers the operational workflows.
4. Complete publisher/outbox runtime routing and the full-catalog activation
   readiness proof.
5. Run the separately reviewed and explicitly authorized Step C cutover and full
   provider publication.

## Verification

- TypeScript full-project typecheck.
- Unit coverage for legacy delegation, active canonical transformation projection,
  warehouse scope, fail-closed scalar/channel seams, summary compatibility, and
  quantity-range validation.
- PostgreSQL executor coverage for repeatable-read authority locking, commit,
  rollback, singleton validation, and connection release.
- Exact-SKU dropship provider coverage, including multi-product grouping, missing
  target zeroing, conflicting ownership, and invalid quantity rejection.
- eBay and dropship registration/preview regression coverage.
- Source-contract coverage that every production ATP composition seam uses the
  authority-aware factory and that no corrected registration path performs
  product-base division.
