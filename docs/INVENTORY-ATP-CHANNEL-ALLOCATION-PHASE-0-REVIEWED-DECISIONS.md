# Inventory ATP And Channel Allocation Phase 0 Reviewed Decisions

## Authority And Scope

- Review date: 2026-08-25
- Evidence baseline: `origin/main` at
  `3fca50c107c122bf954f70c75c3edcceb899ed75`
- Evidence report:
  `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-REPORT.md`
- Scope: Phase 0 decisions and corrections only

This addendum records the decisions made during review of the Phase 0 report. It
supersedes any conflicting recommendation in the evidence report or migration
plan. The evidence tables, current-code traces, confirmed facts, hypotheses, and
unknowns remain in the evidence report.

This document does not authorize implementation, deployment, production data
changes, inventory changes, recipe activation, reservation changes, ATP changes,
channel publication, or channel-setting changes.

## 1. Physical Inventory And Custody

- `inventory_levels.variant_qty` is authoritative physical on-hand at a bin.
- Any separate `onHandQty` concept is retired rather than becoming a second
  physical authority.
- Picking decrements `variant_qty` and increments picked custody.
- Packing and shipping move custody. Picked and packed quantities are not
  subtracted from `variant_qty` again.
- Creating an order-owned supply claim reduces ATP.
- Picking an already claimed unit consumes that claim in the same transaction,
  so ATP does not decrease a second time.
- `reserved_qty` is not ownership authority. During cutover it may exist only as
  a compatibility projection of durable order-owned claims. It is retired after
  every legacy consumer is removed.

The custody transition must preserve this example:

```text
before pick:
  variant_qty = 100
  active claimed units = 10
  ATP = 90

after pick:
  variant_qty = 90
  active claimed units = 0
  picked custody = 10
  ATP = 90
```

## 2. Promise-Eligible Locations

- `directly_pickable` and `promise_eligible` are separate properties.
- Default location behavior:
  - pick: directly pickable and promise-eligible
  - reserve/backstock: not directly pickable and promise-eligible
  - receiving/staging/quarantine: not promise-eligible
  - inactive or frozen: not promise-eligible
- Reserve/backstock inventory contributes to ATP unless an explicit active
  policy excludes it.

## 3. Safety Stock And Days Of Cover

- Safety stock belongs to the inventory domain.
- It is deducted before transformation planning and channel policy.
- A channel cannot override inventory safety stock.
- Resolution hierarchy:
  1. business-wide default
  2. per-SKU override
  3. optional warehouse/SKU override
- Fulfillment-network scope is explicit. Warehouse and network floors cannot be
  applied to the same physical inventory twice.

Each resolved safety policy uses one explicit mode:

- `inherit`
- `off`
- `fixed_units`
- `days_of_cover`

`days_of_cover` is a business-wide input across all SKUs with per-SKU and
optional warehouse/SKU overrides.

```text
trusted demand:
  protected units = ceil(trustedDailyDemand * daysOfCover)

untrusted demand:
  protected units = configured fixed fallback
```

The fixed fallback is not also applied as a minimum when demand is trusted.
`off` produces a safety floor of zero for the resolved SKU and scope.

Demand trust is determined by the system from freshness, sample sufficiency,
history, and forecast-quality evidence. It is not an ordinary operator toggle.
Any exceptional trust override must be audited, time-limited, and tied to a
specific snapshot.

Demand includes legitimate irreversible external consumption:

- customer shipments from every channel
- replacements and concessions
- component consumption for component safety
- other explicitly classified recurring external consumption

Demand excludes:

- picking and packing
- replenishment and warehouse transfers
- package conversions
- cycle-count corrections
- returns to vendor
- one-off damage or disposal

Received returns add supply but do not erase historical demand. Recurring shrink
may be modeled separately only when explicitly classified.

## 4. Directed Transformations

- Immutable, versioned, directed transformation paths are authority.
- Each path independently records:
  - source SKU
  - destination SKU
  - input quantity
  - output quantity
  - operation type
  - exact recipe-version binding when applicable
- Reverse authority requires a separate path.
- Groups may organize related SKUs in the UI but grant no conversion authority.
- A multi-step projection is allowed only when every directed path in the route
  is complete, valid, active, and feasible.

The previously proposed reversible equivalence-group authority is rejected.

Direct physical inventory counts for its own SKU. Inventory in another form
contributes only through a complete, active, directed path.

For 100 physical EA and 10 physical P5:

| Active valid paths | EA ATP | P5 ATP |
| --- | ---: | ---: |
| None | 100 | 10 |
| EA -> P5 only | 100 | 30 |
| P5 -> EA only | 150 | 10 |
| Both directions | 150 | 30 |

A missing, disabled, incomplete, or malformed EA -> P5 path contributes zero EA
capacity to P5. It does not erase the 10 physical P5. An invalid configured path
must be visible in draft/shadow validation and cannot silently grant conversion
authority.

These quantities are alternative projections of shared physical capacity. They
are not additive promises.

## 5. Build-To-Promise

- Build-to-promise is enabled or disabled per product/SKU, not per channel.
- There is no item-level partition of shared transformation capacity. A customer
  must be able to purchase the full feasible quantity of one package SKU.
- Build lead time, throughput, queue capacity, and channel promise horizons are
  out of scope for the current model.
- Existing break, assemble, and build executors remain execution mechanisms.
  They operate only through explicit active transformation authority and durable
  resource claims.

The Supply & Transformations UI is source-column-centric. A source SKU column
lists every outbound capability from that SKU. Allowed/blocked state appears
under the source column. A reversible UI shortcut may update two explicit paths
but does not create implicit reversibility.

## 6. Whole-Order And Future Basket Planning

The canonical claim planner plans every line of an order together so the same
shared resource cannot be consumed twice inside one order.

Example with 100 available underlying pieces:

```text
cart/order demand:
  4 C25 = 100 pieces
  20 P5 = 100 pieces
  combined demand = 200 pieces

result:
  insufficient shared capacity
```

The internal order plan returns per-line and per-resource evidence and persists
the claim result atomically.

A future read-only basket-validation adapter may use the same internal planning
contract to block an over-capacity cart before checkout. It is a channel adapter,
not another ATP formula.

- No public cart-validation endpoint is created until an authenticated caller is
  implemented.
- No Shopify checkout is blocked until the complete Shopify Function path is
  built, tested, run in shadow, reviewed, and explicitly activated.
- Deploying planner code or an inactive Function cannot block checkout.
- Dropship orders operationally arrive through eBay. The exact deployed
  eBay-to-dropship intake mapping remains a required read-only verification.

## 7. Order-Owned Claims And Picking

- A supply claim is owned by an order line and an exact warehouse/resource.
- A supply claim is separate from a WMS pick-bin allocation.
- A later WMS allocation assigns an exact bin.
- Replenishment may move inventory between reserve and pick locations without
  releasing or recreating the order's supply claim.
- Claim, release, conversion, build, and pick paths use one deterministic lock
  order.
- Cancellation and release are idempotent and release each owned allocation
  exactly once.

Required lock order:

1. Graph-product advisory locks, ascending product ID.
2. Active model and policy heads.
3. Order, order item, and existing claim.
4. Inventory resources and levels sorted by warehouse, location, and variant.
5. Build demands and claim allocations.
6. Recompute and persist claims, projections, audit evidence, and outbox records.
7. Commit before any external provider call.

## 8. Shortfalls And Physical Discrepancies

- A claim shortfall is an ATP exception, not a hard physical-pick block.
- Available lines may continue while an unavailable line is explicitly marked as
  short.
- A picker who physically finds inventory may scan the SKU and bin and choose a
  discrepancy action.

A discrepancy pick records:

- expected system quantity
- observed-at-least quantity
- warehouse and bin
- order and line
- picker and timestamp
- reason
- affected claims
- before/after evidence

An explicit audited positive correction and the pick occur in one transaction.
Because the found unit is added and immediately moved into picked custody, ATP is
not falsely increased. The system creates a cycle-count task for the bin.

If the physical pick conflicts with another order's claim, custody is still
recorded. The deterministic claim resolver identifies the displaced claim and
the shipment enters an inventory-exception state. The picker does not choose
which order loses the claim.

## 9. Warehouse-Aware ATP And Multi-Warehouse Fulfillment

- ATP is calculated per SKU and warehouse.
- Transformations use resources inside one warehouse. Inventory from separate
  warehouses cannot be combined to create one physical transformed unit.
- Network ATP sums only warehouses that can fulfill the item for the applicable
  fulfillment scope.
- Planned transfers do not contribute before receipt.
- Channel warehouse assignments define planner scope; they do not define another
  ATP formula.

Multi-warehouse fulfillment is part of the target design:

- one customer/OMS order
- one or more warehouse fulfillment groups
- separate claims, WMS work, shipments, and tracking per warehouse
- order-level `warehouse_id` is not allocation authority

Routing priority is:

1. Exclude warehouses that cannot serve the channel, destination, SKU, or
   service commitment.
2. Prefer a single warehouse; otherwise minimize the number of
   warehouses/shipments.
3. Apply configured warehouse-routing priority.
4. Use a deterministic warehouse-ID tie-breaker.

Trustworthy comparable shipping-cost optimization may be added later. It cannot
override fulfillment eligibility or service requirements.

## 10. Channel Quantity Policy

Shopify, eBay, dropship/eBay registration, future TikTok, admin views, order
acceptance, and reservation consume the same canonical planner. Channel policy
may only reduce canonical ATP.

Both channel semantics are supported per product/SKU:

- `exposure`: independent channel views may total more than canonical ATP
- `partitioned`: hard channel budgets cannot total more than canonical ATP

Field resolution is:

1. SKU override
2. product default
3. channel default
4. safe zero

Missing required explicit configuration cannot silently publish raw ATP.

The agreed channel formula is:

```text
if not eligible:
  published = 0
else:
  shared = floor(canonicalAtpUnits * shareBps / 10_000)
  afterHoldback = max(0, shared - holdbackUnits)
  capped = min(afterHoldback, maxPublishUnits or infinity)
  published = capped < minPublishThresholdUnits ? 0 : capped
```

Invariants:

```text
0 <= published <= canonicalAtpUnits
all absolute dials use sellable SKU units
minimum publish quantity is a cutoff and never raises quantity
channel policy cannot override safety stock
```

The evidence report's earlier formula applied holdback before share. This
addendum corrects the order: share first, then channel holdback, then maximum,
then minimum cutoff.

## 11. Durable Publication

Publication uses a durable outbox with:

- absolute desired quantities, never deltas
- monotonic revisions
- unique identity per revision, channel, SKU, and provider location
- per-key serialization
- idempotency
- retry leases and classified failures
- dead-letter state
- provider acknowledgement and quantity readback
- drift evidence

A zero quantity can never be discarded behind an older positive quantity. An
activation remains incomplete or drifted until required provider readback is
verified.

## 12. Activation And Cutover

- Editing and activation are separate abilities assigned to roles.
- No two-person approval is required.
- Activation records actor, reason, before/after versions, preview hash, and
  timestamp.
- The complete planner is deployed inactive and runs in shadow across the entire
  live catalog.
- There are no required canary cohorts.
- After full-catalog review, one controlled catalog-wide activation changes all
  ATP readers, order acceptance, claims, admin views, and publishers together.

First-cutover sequence:

1. Build and validate drafts.
2. Run full-catalog shadow comparison.
3. Review every conversion, safety result, ATP result, channel quantity, and
   blocker.
4. Conservatively publish each provider key to
   `min(currentProviderQty, newDesiredQty)`.
5. Verify provider readback.
6. Atomically make the new planner authoritative.
7. Publish and verify full new desired quantities.

The first cutover never rolls back to legacy ATP. A post-cutover failure keeps
the new planner authoritative and retries safe publication. Later revisions may
roll back only to a previously provider-verified version of the new model.

Implementation slices and pull requests do not imply separate ATP activation
deployments.

## 13. UI And Legacy Retirement

Target navigation:

- Inventory -> Availability
- Inventory -> Promise Policies
- Inventory -> Supply & Transformations
- Channels -> Inventory Exposure
- Operations -> Inventory Publication

Product Detail becomes a read-only summary with deep links. The legacy Product
Detail strategy and channel writers, Channels -> Reserves, legacy reserve values,
legacy channel-product allocations, and their APIs remain only until the full
new model is authoritative and verified.

Legacy values are not imported, preserved as policy, or interpreted because they
are known to be wrong. They are removed only after cutover; they are not removed
before the replacement is live.

## 14. Corrections To The Evidence Report

This addendum makes the following explicit corrections:

1. Directed transformation paths replace reversible equivalence-group authority.
2. Channel share is applied before channel holdback.
3. Build-to-promise is per product/SKU and has no build-time or channel-horizon
   model.
4. Shared alternative SKU projections are not partitioned by item.
5. Whole-order planning is internal now; public Shopify basket validation is a
   future adapter and cannot block checkout before explicit activation.
6. Network ATP supports future multi-warehouse fulfillment groups.
7. The rollout uses full-catalog shadow review and one activation, not required
   canary cohorts.
8. The first cutover cannot reactivate legacy ATP after authority changes.
9. Safety policy includes `inherit`, `off`, `fixed_units`, and `days_of_cover`
   initially; fixed fallback applies only when demand is untrusted.

## 15. Remaining Unknowns And Required Read-Only Checks

- Current deployed application commit and applied migration set.
- Runtime-active channels, `syncEnabled`, `syncMode`, allocation rules,
  warehouse assignments, and legacy reserve rows.
- Provider readback support and current per-location Shopify/eBay quantities.
- Count of live reservation/pick-bin mismatches and affected orders.
- Actual business-default, SKU, and warehouse safety-stock configuration values.
- Whether Shopify Function network access is available for the future
  pre-checkout validator.
- Exact deployed eBay-to-dropship order-ingress mapping.
- Whether TikTok or another externally managed publisher exists outside this
  repository.
- Multi-warehouse fulfillment schema and provider behavior required before
  network ATP may authorize a split fulfillment.

Phase 0 Gate 0 remains unapproved until the required runtime checks are completed
and this reviewed design is explicitly approved for implementation.
