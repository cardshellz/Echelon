# Inventory ATP And Channel Allocation Phase 0 Final Review Closure

## Status And Authority

Status: **Phase 0 investigation and design review complete; implementation is not authorized by this document.**

This closure is the final authority for decisions made during the review. It supplements:

- `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-REPORT.md`, which contains the exhaustive static evidence and caller/writer tables.
- `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-REVIEWED-DECISIONS.md`, which contains the detailed ATP, safety-stock, transformation, claim, channel, activation, and UI contracts agreed earlier in the review.

If those documents conflict with this closure, this closure wins. No application code, inventory, recipes, channel configuration, ATP, reservations, Shopify quantities, eBay quantities, TikTok settings, or production records were changed during Phase 0. Production database checks used `BEGIN TRANSACTION READ ONLY` and ended with `ROLLBACK`.

## Final Baseline Verification

- PR #1262 is merged. Merge commit `7cc2b35d0d22448f03390791a3fa5812d5020d8d` is an ancestor of current `origin/main`.
- Final refreshed `origin/main`: `0748a6abb8a8092645cbf42ebc0630fcb07cb74f`.
- Commit: `Merge pull request #1277 from cardshellz/codex/historical-shipstation-unique-package-recovery`.
- Current Heroku release: `v2752`, status `succeeded`, description `Deploy 0748a6ab`, created `2026-08-26T13:39:35Z`.
- The deployed release therefore matches current `origin/main`.
- The final refresh advanced eleven commits beyond the last reviewed commit `c63508db`. The changed files concern scheduler infrastructure, dropship worker scheduling, shipping audit, and procurement unit-cost repair. None changes the ATP, allocation, reservation, recipe-capacity, channel UI, or provider-publication implementations cited in the Phase 0 conclusions. Dropship worker timing changed; the dropship acceptance ATP gate and listing quantity calculations did not.
- Production migration ledger: 331 applied migrations. Latest: `0620_vendor_invoice_unit_cost_mills_repair.sql`, applied `2026-08-25T23:44:07.590Z`.

## Current Runtime Evidence

Verified on the final deployed baseline with configuration/aggregate-only queries:

| Runtime object | Confirmed state |
|---|---|
| Shopify, channel 36 | active; sync enabled; live |
| Shopify Canada, channel 37 | active; sync enabled; live; legacy `allocation_pct=90` |
| eBay, channel 67 | active; sync enabled; live; no explicit warehouse assignment was present during the Phase 0 audit |
| Dropship OMS, channel 103 | active internal/manual channel; sync disabled; dry run; no provider adapter |
| LEON, warehouse 1 | active operations warehouse; internal inventory; Shopify location mapped; feed flag true |
| RTE-19, warehouse 2 | active bulk-storage warehouse; linked to LEON as hub; internal inventory; feed flag true |
| SM-WEST, warehouse 34 | inactive 3PL; manual inventory; Shopify location present; feed flag true |
| SM-CA, warehouse 35 | active 3PL; configured to source inventory from Shopify Canada; never synchronized; no Shopify location mapping; feed flag true |
| Last 24 hours of sync log | 754 rows, all `source=event`, all recorded as `status=pushed`; latest `2026-08-26T17:53:55.670Z` |

`status=pushed` is not provider verification. The current adapters record requested quantities after provider write acknowledgement and have no ordinary post-write inventory readback contract. Evidence: `server/modules/channels/channel-adapter.interface.ts:67-86,252-263`, `server/modules/channels/adapters/shopify.adapter.ts:123-204`, `server/modules/channels/adapters/ebay.adapter.ts:249-361`, and `server/modules/channels/echelon-sync-orchestrator.service.ts:714-745,1487-1555`.

Additional read-only observations made during Phase 0:

- `SM-CA` had one zero-quantity location and no recorded external inventory.
- Shopify Canada had five historical OMS orders in the queried data: four shipped and one pending. The four WMS rows had no warehouse assignment. This proves historical visibility exists, but not a current end-to-end 3PL custody workflow.
- Three active build recipes existed across one product and three output variants, with five component rows and no build orders.
- Active reservation evidence was exact for 211 of 212 active order lines; one line was short by one unit.
- For 75 active location/SKU keys with attributable claims, 58 matched the anonymous `reserved_qty` projection, 11 counters were below claims by 58 total units, and six counters were above claims by 23 total units.
- Historical terminal orders retained positive reservation-ledger balances. Those balances do not prove current physical holds because the anonymous counters and attributed ledger disagree.

## Final Agreed Domain Rules

### Physical inventory and custody

- `inventory.inventory_levels.variant_qty` is physical on-hand at the named location.
- Picking decrements `variant_qty` and increases picked custody. Picked/packed quantities are not subtracted from `variant_qty` again when calculating ATP.
- A claim reduces ATP when the claim is created. Picking an already claimed unit consumes the claim atomically and must not reduce ATP a second time.
- `reserved_qty` becomes a temporary compatibility projection derived from authoritative claims and is eventually retired.
- Promise eligibility is independent from direct pickability. Pick locations default to pickable/eligible; reserve and backstock default to non-pickable/eligible; receiving, staging, quarantine, inactive, and frozen locations default to ineligible.

### Warehouse aggregation

The current per-bin calculation is retired:

```text
SUM(max(bin.variant_qty - bin.reserved_qty, 0))
```

The target calculation aggregates eligible physical supply, subtracts warehouse/resource claims, applies the resolved promise-safety policy, and clamps once. A pick-bin deficit is a replenishment signal, not permission to discard the order's claim.

```text
eligiblePhysical = sum(variant_qty at promise-eligible locations in scope)
uncommittedPhysical = max(eligiblePhysical - activeResourceClaims, 0)
protectedPhysical = resolved Promise Safety Stock
directPhysicalCapacity = max(uncommittedPhysical - protectedPhysical, 0)
```

Transform/build planning then evaluates the complete directed resource graph without combining component resources across warehouses. Network ATP is the sum of independently fulfillable warehouse results; transfers do not contribute at the destination until receipt.

### Safety stock

- Promise safety stock is inventory-owned and applied before transformations and channel dials.
- Resolution order: business default, SKU override, optional warehouse/SKU override.
- Modes: `inherit`, `off`, `fixed_units`, `days_of_cover`.
- Trusted demand: `ceil(trustedDailyDemand * daysOfCover)`.
- Untrusted demand uses the configured fixed fallback; fixed and days-of-cover quantities are not combined through `max` or `min`.
- Demand trust is system-derived from validated demand history, not an ordinary operator toggle.
- Existing product `safetyStockDays` remains a procurement/reorder control and is renamed in the UI to **Purchasing Safety Buffer**. It is not the ATP promise floor.

### Directed transformations and recipes

- Every conversion is a versioned directed edge. Reverse conversion requires a separate edge.
- Physical stock counts directly for its own SKU.
- Another package SKU contributes only through a complete active directed path.
- Automatic sibling-variant pooling is retired. Evidence for the current pooling behavior: `server/modules/inventory/recipe-capacity.service.ts:155-251` and `server/modules/inventory/domain/recipe-capacity.domain.ts:200-215,303-320`.
- Every plan preserves actual source variant, warehouse, location/resource, quantity, and required transformation/build step.
- A claim backed by another package claims the real source resource; it does not create a synthetic target reservation at a location where the target does not physically exist.
- Recipe creation always starts as draft. Edits create draft versions. Activation requires validation, preview, an authorized role, actor, reason, version, and hash.
- The three current active recipes remain authoritative until cutover, are imported as draft candidates with legacy provenance, are manually reviewed, and are not automatically trusted or activated.

### Order planning and claims

- One internal whole-order planner jointly plans every line and returns warehouse fulfillment groups and resource claim segments.
- Shopify checkout validation remains a future adapter. No public basket endpoint is activated until the authenticated Shopify caller and complete nonblocking rollout are ready.
- Order claims are owned by order/item at warehouse/resource level; later pick-bin allocation is separate.
- Multi-warehouse fulfillment uses one customer/OMS order with multiple fulfillment groups, claims, execution work, shipments, and tracking records.
- Shortfalls are explicit ATP/claim exceptions. They do not hard-block a picker from using physically present stock.
- A picker may use **Pick with discrepancy**. The system atomically records found-stock correction, claim/custody resolution, and the pick, then opens a cycle-count/reconciliation case.
- Claim cutover does not copy anonymous counters or historical signed ledger totals. It reconstructs claims from genuinely open, unfulfilled order demand; picked/packed lines become custody evidence; terminal lines receive no new claims; insufficient lines become explicit `claim_shortfall` cases.

### Channel inventory exposure

- Every external publication target has an explicit fulfillment-node/network scope. There is no silent fallback from no assignments to all active warehouses.
- Scope resolution supports channel defaults, product overrides, and SKU overrides:

```text
SKU scope -> product scope -> channel default
```

- Any eligible combination of internal warehouses, networks, or 3PL nodes may be assigned. No channel is hardcoded to LEON or any other warehouse.
- Channel policy quantities are sellable-SKU units. Shares are integer basis points.
- Per-SKU semantics can be `exposure` or `partitioned`.
- Agreed dial order:

```text
shared = floor(canonicalAtpUnits * shareBps / 10_000)
afterHoldback = max(0, shared - holdbackSellableUnits)
capped = min(afterHoldback, maxPublishSellableUnits ?? infinity)
published = capped < minPublishSellableUnits ? 0 : capped
```

- The minimum is a publish cutoff, not safety stock.

### Channel control and publication

- One global emergency stop remains.
- Each publication target state is `disabled`, `preview`, or `live`.
- Every scheduler, inventory event, activation, rule change, and manual command must resolve the same effective state before creating work and again before provider I/O.
- `disabled` creates no publication. `preview` records calculated desired state without provider work. `live` creates durable outbox deliveries.
- Manual publication is explicitly channel/target scoped. A Shopify action cannot publish eBay.
- Provider/listing routes cannot independently calculate or accept inventory quantities. Listing creation and listing resync request central planner/outbox work.
- Each outbox delivery is keyed by publication target, provider location, SKU, and monotonic desired revision. Zero is a valid absolute quantity and is never dropped.
- Delivery states distinguish `desired`, `queued`, `leased`, `acknowledged`, `verified`, `drifted`, `retryable`, `dead_letter`, `superseded`, and `cancelled` as appropriate.
- Provider acknowledgement and provider readback are separate evidence. Periodic reconciliation does not blindly raise a provider's lower quantity before marketplace-order ingestion has caught up and ATP has been recomputed.

### Shopify store identity and TikTok

- Each Shopify store has one exact provider-account connection containing normalized store identity, credentials reference, webhook secret, cursors, and revision.
- External location identity belongs to `(channelConnectionId, fulfillmentNodeId, externalLocationId)`, not globally to `warehouse.shopify_location_id`.
- Inventory feed identity is exact publication target plus SKU, not channel type plus SKU.
- Webhooks, polling, order recovery, fulfillment observation, writeback, readback, and reconciliation resolve the originating connection. Unresolved store identity is quarantined and never defaulted to channel 36.
- TikTok currently routes through Shopify. It remains a TikTok-attributed sales subchannel whose order transport, fulfillment network, and published inventory are inherited from the relevant Shopify target.
- A future direct TikTok connection uses a thin adapter for authentication, mapping, absolute writes, acknowledgements, readback, retries, and event normalization. It never implements another ATP formula.

## 3PL Architecture

Echelon remains the ownership, order, cost, claim, and audit ledger. A 3PL is an external custody and fulfillment node. A marketplace is a separate demand/order/publication connection.

Required lifecycle:

```text
local receipt
-> local physical on-hand
-> transfer dispatched
-> owned in transit (not ATP)
-> 3PL receipt acknowledgement
-> external-custody physical on-hand
-> marketplace order and node claim
-> 3PL fulfillment
-> exact claim consumption and custody decrement
```

Required additions:

- External custody/provider accounts and facilities.
- Channel/provider-specific external-location bindings.
- Inter-warehouse stock transfer headers, lines, lot allocations, events, dispatch, in-transit, partial receipt, damage/loss, discrepancy, and cancellation states.
- Immutable 3PL inventory snapshots with separate provider on-hand, available, committed, damaged, and inbound fields.
- Expected-versus-observed reconciliation cases; raw provider `available` never becomes physical `variant_qty` automatically.
- External fulfillment orders/events and a durable release/cancel outbox when Echelon is the submitter.
- Exactly one inventory publisher and exactly one fulfillment submitter for each target/order partition.
- One 3PL node may serve multiple marketplaces, and one marketplace may use multiple fulfillment nodes. All demand sources that consume a shared pool must be trustworthy before Echelon publishes that shared ATP.

For Shopify Canada, the agreed target is:

- Order and fulfillment visibility stays in Echelon.
- Inventory ownership stays in Echelon.
- Physical custody and fulfillment execution belong to the Canadian 3PL.
- Inventory publication remains externally managed by the 3PL/current external path unless deliberately changed later.
- Shopify's published `available` value is channel observation, not physical 3PL on-hand.

Current gaps are directly evidenced by:

- Cross-warehouse transfers are rejected: `server/modules/inventory/application/inventory.use-cases.ts:1242-1452`.
- The current external warehouse sync supports Shopify only and writes Shopify `available` through an ordinary inventory adjustment: `server/modules/inventory/application/inventory.use-cases.ts:1598-1739`.
- 3PL-routed orders become `awaiting_3pl` and skip reservation: `server/modules/oms/wms-sync.service.ts:665-689,1031-1043`.
- External fulfillment location resolution is global rather than constrained to the routed warehouse: `server/modules/oms/channel-fulfillment-ingress.repository.ts:479-530`; the selected location is passed to shipment posting at `server/modules/oms/channel-fulfillment-ingress.service.ts:157-182`.

## Confirmed Bypasses And Enforcement Defects

| Defect | Evidence | Agreed closure |
|---|---|---|
| Dropship eBay acceptance performs an exact-SKU stock gate before canonical ATP | `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:628-650,863-903,1243-1262`; `server/modules/dropship/application/dropship-order-acceptance-service.ts:255-267,571-594` | Delete the raw gates; call the common warehouse-aware whole-order planner and atomically create claims before order acceptance/wallet commit |
| Dropship accepted warehouse, WMS route, and reservation scope can diverge | `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:779`; `server/modules/oms/wms-sync.service.ts:665-680`; `server/modules/channels/reservation.service.ts:186-299` | Persist planner fulfillment groups and claims; WMS/3PL consumes them and cannot independently reroute |
| Direct eBay listing flows publish raw ATP without channel policy | `server/modules/channels/ebay-listings.routes.ts:585-704,1007-1067,1403-1498`; `server/modules/channels/ebay-sync-helpers.ts:459-525` | Listing routes request central publication; provider adapter receives only approved outbox deliveries |
| Dropship eBay listing applies a separate ATP/cap formula | `server/modules/dropship/application/dropship-selection-atp-service.ts:233-257`; `server/modules/dropship/infrastructure/dropship-ebay-listing-push.provider.ts:692-744` | Bind each external store to a canonical publication target; vendor cap becomes `maxPublishSellableUnits` |
| eBay test route hardcodes quantity one | `server/modules/channels/ebay-settings.routes.ts:458-461,589-599` | Remove production quantity writes from the test route or isolate it to a nonproduction target |
| Correct sync-state resolver exists but is bypassed | `server/modules/channels/sync-settings.service.ts:276-307`; scheduler `server/index.ts:313-360`; full sync `server/modules/channels/echelon-sync-orchestrator.service.ts:1310-1339`; allocator `server/modules/channels/allocation-engine.service.ts:215-224` | One effective-state resolver governs every trigger and is rechecked before provider I/O |
| Shopify-labelled manual sync can fan out to all active channels | `server/modules/channels/sync.service.ts:142-267`; UI `client/src/pages/Channels.tsx:331-350,701-710` and `client/src/pages/ShopifyChannelPage.tsx:278-298,853-867` | Explicit target-scoped publication command only |
| Saving one Shopify store's location mappings clears global mappings | `server/modules/channels/channels.routes.ts:862-899`; global field `shared/schema/warehouse.schema.ts:108` | Channel-connection-specific external-location bindings |
| Feed upsert can collide between Shopify stores | `server/modules/channels/inventory.repository.ts:600-624`; intended schema identity `shared/schema/channels.schema.ts:115-139` | Key feeds by exact publication target/channel ID and SKU |
| Fulfillment writeback can use the singleton primary Shopify client | `server/modules/oms/fulfillment-push.service.ts:919-993,1886-1931`; bootstrap `server/services/index.ts:355-365` | Resolve client and external identities from the originating connection; no default fallback |
| Shopify reconciliation is channel-36-only | `server/modules/orders/shopify-order-reconciliation.ts:114-157,281-316,381-435` | Provider-account-scoped reconciliation cursors and recovery |
| Product Detail and Channels Reserves edit non-authoritative legacy values | `client/src/pages/ProductDetail.tsx:1969-2096,3310-3415`; `client/src/pages/Reserves.tsx:83-170,235-354`; publisher `server/modules/channels/sync.service.ts:142-200` | Replace with server evidence and channel exposure workspaces; retire legacy writers after cutover |
| Inventory UI performs ATP-like recursive math | `client/src/lib/inventory-availability.ts:9-37`; `client/src/pages/Inventory.tsx:1422-1474,1562-1564` | Browser displays `AvailabilityEvidenceDto`; it performs no ATP arithmetic |

## Target UI

- **Inventory -> Availability:** physical on-hand, claims, picked/packed custody, eligible and excluded supply, promise safety stock, directed transformation contribution, canonical ATP, desired publication, provider acknowledgement, and provider readback.
- **Inventory -> Promise Policies:** location eligibility and promise safety stock. Existing procurement buffer is separately labelled.
- **Inventory -> Supply & Transformations:** source-column-oriented directed conversion/build paths, draft validation, full preview, version activation, and audit.
- **Inventory -> Transfer Orders:** local-to-warehouse/3PL dispatch, in-transit, partial receipt, discrepancies, and close.
- **Inventory -> Fulfillment Nodes:** internal and external custody, provider/facility connections, inventory observations, claims, and reconciliation.
- **Channels -> Inventory Exposure:** exact provider account, external location bindings, fulfillment-node scope, channel/product/SKU inheritance, exposure/partition semantics, and full calculation preview.
- **Operations -> Inventory Publication:** desired, queued, acknowledged, verified, drifted, retryable, and dead-letter deliveries.
- **Operations -> External Fulfillment:** route decision, claim, provider submission/observation, acknowledgement, execution events, shipment, tracking, and exceptions.
- Product Detail becomes a read-only summary with deep links. Channels -> Reserves and legacy allocation editors are retired only after new authority is active.

## Activation, Locking, And Delivery

Agreed production approach:

- Implementation may use multiple reviewable commits/slices in a fresh clean branch/worktree, but production receives one inactive deployment containing the complete new model.
- Validate conversions and full-catalog ATP/channel outputs before that deployment using tests and nonproduction data.
- In production, run full-catalog shadow preview and evidence comparison while legacy authority remains active.
- No canary cohorts.
- Activation is gated by an explicit role ability; no two-person approval.
- Conservative first cutover publishes and reads back `min(currentProviderObserved, newDesired)` where a valid readback exists, then atomically switches authority and queues the full new desired state.
- Never roll back the first cutover to legacy formulas. Later rollback may select only a previously verified version of the new model.

Global lock order:

1. Product/resource-graph advisory locks in ascending stable order.
2. Active transformation, safety-policy, channel-policy, and source-binding heads in deterministic order.
3. Order, item, fulfillment-group, and claim rows.
4. Inventory resources/levels and lot positions in deterministic warehouse/location/variant/lot order.
5. Build/claim allocations, transfer/custody positions, activation audit, and outbox rows.
6. Commit before any provider call.

## Implementation Slices

1. **Schema and contracts, inactive:** versioned transformation/safety/channel policy heads, claims, fulfillment nodes/connections, external location bindings, transfer/custody structures, snapshots, activation runs, audit, and publication/3PL outboxes.
2. **Canonical planner:** warehouse-aware physical aggregation, safety resolution, directed transformation graph, whole-order planning, claim/release/consume, deterministic locks, and evidence DTOs.
3. **Shadow readers and claims:** route every ATP reader, reservation caller, build-promise caller, registration path, dropship acceptance, and listing preview through the new contracts without changing live authority; reconstruct open-order shadow claims.
4. **Channel identity and policy:** exact Shopify/provider connection resolver, explicit fulfillment-node scopes, SKU dials, multi-store mapping/feed identity fixes, TikTok-through-Shopify attribution, and provider-neutral adapter contracts.
5. **Durable delivery:** publication outbox, acknowledgement/readback, reconciliation, retries/dead letters, absolute zero handling, and removal of direct provider quantity calls.
6. **3PL workflow:** inter-warehouse transfers, in-transit custody, external receipt/snapshots, node claims, external fulfillment lifecycle, exact shipment consumption, and reconciliation.
7. **Authoritative UI:** Availability, Promise Policies, Supply & Transformations, Inventory Exposure, Transfer Orders, Fulfillment Nodes, Publication, and External Fulfillment; legacy surfaces remain read-only until cutover.
8. **Full preview and controlled activation:** full-catalog evidence, configuration blockers, role-gated authority switch, conservative publication/readback, full publication, and post-activation verification.
9. **Retirement:** remove legacy formulas, writers, dead toggles, anonymous reservation authority, direct provider quantity paths, and obsolete UI only after verified activation.

## Confirmed Facts, Hypotheses, Unknowns, And Next Checks

### Confirmed facts

- Multiple active ATP formulas and channel quantity paths exist.
- Dropship order acceptance and direct eBay/dropship listing paths bypass the final canonical planner/channel-policy sequence.
- Current reservation attribution and anonymous counters disagree in live aggregate evidence.
- Location pickability does not consistently define ATP eligibility.
- Current recipe capacity automatically pools sibling finished variants and can lose source location identity.
- Current per-bin ATP clamping can overstate warehouse availability.
- Current channel sync controls are not uniformly enforced.
- Current sync success is provider acknowledgement/local desired state, not provider readback.
- Current Shopify store identity, external location identity, feed identity, and writeback client are not consistently connection-scoped.
- Current 3PL support lacks inter-warehouse transfer, in-transit custody, authoritative physical snapshot reconciliation, node claims, and exact shipment custody lineage.

### Hypotheses

- Some production provider quantities may differ from recorded `lastSyncedQty`. No provider readback was performed during Phase 0.
- Some direct listing bypass routes may have executed recently. Existing logs do not preserve a sufficiently precise originating caller to prove which route ran.
- Shopify Canada order/fulfillment visibility may be incomplete beyond the five historical records observed. Current provider/webhook health was not tested.

### Unknowns and required next checks

- Identify the Canadian 3PL and its supported receipt, inventory, order, fulfillment, cancellation, return, and reconciliation feeds: API, webhook, EDI, SFTP/CSV, or manual.
- Obtain provider read-only quantities and mapping evidence only as part of an explicitly approved integration/readback check.
- Confirm intended initial fulfillment-node assignments for every live publication target during the full preview; do not infer them from missing assignments.
- Validate every existing recipe/path in the new source-oriented transformation preview.
- Run the prepared aggregate dropship intake -> OMS -> fulfillment -> claim, accepted-warehouse alignment, and cross-route eBay identifier audits before activation.
- Verify current order-ingestion watermarks for every marketplace sharing a supply pool before Echelon is allowed to publish that pool.
- Re-fetch `origin/main`, verify the deployed release, and select fresh migration identifiers immediately before implementation begins.

## Phase 0 Gate

Phase 0 is complete. The current dirty checkout was not cleaned, reset, staged, committed, or used for implementation. All unrelated local changes remain untouched.

Future implementation must begin only after explicit user approval, from a newly created clean worktree based on the then-current `origin/main`, using a `codex/` branch. The parked and dirty worktrees discovered during Phase 0 must not be reused.
