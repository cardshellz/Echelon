# Inventory Availability Phase 5Q: Active Runtime Channel Exposure

## Outcome

This slice adds the missing canonical calculation boundary between target-SKU
ATP and an exact external publication destination. It does not call a provider,
enqueue an outbox row, expose canonical activation, change runtime authority, or
change inventory or channel configuration.

`InventoryChannelExposureRuntimeService.planProduct` calculates what each live,
Echelon-owned publication target would publish from one immutable database view.
It is intentionally not wired into the deployed publisher yet. Runtime authority
therefore remains legacy and production behavior is unchanged by this slice.

## Exact-target calculation contract

For each physical, inventory-managed, active sellable SKU and exact publication
target, the service:

1. reads only sealed definitions selected by active heads;
2. resolves the target's active fulfillment-node binding to exact warehouses;
3. projects canonical ATP independently in each bound warehouse;
4. sums those non-overlapping warehouse quantities;
5. resolves policy fields SKU, then product, then channel;
6. applies share, holdback, maximum, and minimum cutoff in that order; and
7. attaches the active provider inventory identity required for an absolute
   quantity write.

Digital and other non-shipping or inventory-unmanaged variants are excluded at
the database boundary. Draft configuration is never consulted. A target must be
both `live` and `publication_authority = 'echelon'` to enter the runtime plan.

The output is a validated snapshot-bound DTO containing authority revision,
activation lineage, supply fingerprint, target revision, binding evidence,
policy evidence, mapping evidence, exact warehouse ATP, and all intermediate
calculation quantities. The DTO explicitly records that no provider write or
outbox enqueue occurred.

## Fail-closed behavior

The target is not publishable when active evidence is incomplete or unsafe,
including:

- no active source binding;
- an inactive fulfillment node;
- duplicate source warehouses;
- a source warehouse absent or inactive in the canonical snapshot;
- an incomplete SKU/product/channel policy resolution;
- no active provider identity for any managed SKU; or
- overlapping partitioned channel shares above 100 percent for a SKU and
  warehouse.

Provider mapping remains mandatory even when policy resolves the desired
quantity to zero. Without the identity, the future publisher cannot clear a
stale positive provider quantity.

Canonical planner blockers remain visible as structured warnings alongside the
planner's path-local fail-closed quantity. This preserves valid exact-SKU
physical availability when a conversion path is malformed or unavailable; the
invalid path contributes zero rather than erasing unrelated physical supply.

Every database error, invalid authority row, malformed active definition,
quantity overflow, and transaction failure aborts the full plan. There is no
partial provider side effect to compensate.

## Transaction and authority contract

`PostgresInventoryChannelExposureRuntimeExecutor.execute`:

1. opens a repeatable-read transaction;
2. locks the singleton runtime-authority row `FOR SHARE`;
3. returns immediately with no canonical reads while authority is legacy;
4. under canonical authority, captures active supply plus active target,
   binding, policy, and mapping evidence on the same PostgreSQL client;
5. commits only after the complete deterministic calculation succeeds; and
6. rolls back and releases the client on every failure.

The shared authority loader is the same validated loader used by operational ATP
reads. No `draft_*` pointer or draft-preferred `COALESCE` appears in this runtime
repository.

## Deliberate boundaries and next slice

This is the calculation engine, not the publication cutover. The next slice must:

1. generalize exact publication-target ownership so a dropship store connection
   can be represented alongside a Channels connection;
2. route Shopify, direct eBay, and eBay-backed dropship registration, listing,
   and inventory synchronization through this exact-target result;
3. enqueue one durable absolute-quantity outbox revision from the same authority
   decision and prevent any later legacy write from overwriting it;
4. add the dropship provider adapter and provider readback contract; and
5. keep the existing legacy allocation engine as the only behavior while runtime
   authority remains legacy.

Canonical activation remains prohibited until those publisher paths, external
consumers, concurrency/crash recovery, and full-catalog readiness are proven and
the separately authorized activation operation exists.

## Verification

- Full TypeScript project typecheck.
- Unit coverage for legacy isolation, exact multi-warehouse ATP, transformation
  capacity, digital exclusion, active policy math, zero-quantity provider
  identity, missing bindings, and partitioned-share overlap.
- PostgreSQL executor contract coverage for authority locking, legacy short
  circuit, active-only queries, physical managed-SKU filtering, transaction
  commit/rollback, malformed evidence, and client release.
- Existing channel-exposure and runtime ATP regression suites.
