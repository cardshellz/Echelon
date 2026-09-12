# Dropship allocation and packaging architecture assessment

Date: 2026-09-12

Audience: engineering, product, operations. Companion to
`docs/DROPSHIP-ENGINEERING-REVIEW-HANDOFF-2026-09-12.md` (the "handoff"). This
document answers the handoff's section 7 review questions from source, corrects
the handoff where the code disagrees with it, and gives an ordered plan to close
the architecture gaps and get Dropship to a live listing and order.

Baseline: `origin/main` merge commit `8909226` (PR #1451, the handoff itself).
Every file/line citation below was read at that commit.

## How this was produced

- Seven independent source readers, one per subsystem (allocation engine, sync
  orchestrator, runtime authority and Inventory Exposure, Dropship quantity path,
  packaging and box suites, product-cost authority, reservation and OMS/WMS
  handoff). Each returned findings with file/line evidence.
- Seven adversarial verifiers, one per area, each instructed to refute that area's
  most consequential claim. Every mechanism survived; the verifiers corrected line
  numbers and trimmed overstatements. The corrected wording is what appears here.
- One completeness critic mapped the results onto the handoff's thirteen
  questions and spot-checked contradictions in source.
- No application code, configuration, database row, or provider state was changed.
- **Limits of this pass:** no production database credential exists in this
  environment, so nothing below is a production readout. `node_modules` is not
  installed here, so no test suite was executed; test coverage statements come
  from reading the test files.

Evidence labels follow the handoff: **CODE-CONFIRMED**, **HYPOTHESIS**,
**UNKNOWN**, **DECISION REQUIRED**, **HARD STOP**.

---

## 1. Executive answer

**Does the Channel Allocation engine work for multiple sales channels?**
Yes, for Shopify and eBay main-store publication, and only while the inventory
runtime authority is `legacy`. CODE-CONFIRMED. It is a *publication view*, not
a partition of reservable stock: reservation draws from one network-wide pool
with no channel dimension, so any two channels can still oversell each other.
That was always the design (`allocation-engine.service.ts:14-17`, "no drawdown").

**Does it work for the Dropship program?** No, and it never has. CODE-CONFIRMED.
The Dropship listing quantity chain never calls the engine. The engine *does*
compute an allocation row for the internal `Dropship OMS` channel on every
sync, and the orchestrator throws it away because no adapter exists for
provider `manual`. So anything an operator configures for `Dropship OMS` on the
Channel Allocation page affects nothing today. Dropship quantity is network ATP
minus vendor include/exclude, capped by a per-vendor cap that has no writer.

**What was the rabbit hole?** There are two allocation policies in the codebase,
and the code has always meant for exactly one to be live:

| | Channel Allocation (legacy) | Inventory Exposure (canonical) |
| --- | --- | --- |
| Policy | warehouse assignments + rules (`mirror` / `share` / `fixed`, floor, ceiling, product lines) | per-target dials (`eligible`, `shareBps`, holdback, max, min) + source-node bindings |
| Who runs it | `AllocationEngine.allocateProduct` via the sync orchestrator | `calculateChannelExposure` via the canonical planner and publication outbox |
| Live when | `inventory.availability_runtime_authority = 'legacy'` | `= 'canonical'` |
| Relationship | Canonical **replaces** it. It does not feed it. | |
| Migration of rules into dials | none exists in code | |
| Rollback | the DB trigger forbids `canonical` → `legacy` | |

The last tracked read-only production capture (2026-09-09) recorded
`legacy`, revision 1, no activation run, "Not activated; not ready to activate"
(`docs/INVENTORY-CUTOVER-CLOSURE-BATCH-2026-09-09.md:13,29`). That is
documentary evidence about a past snapshot, not the current row; see section 5.

**Conclusion.** The allocation engine is not broken. The program went off track
because (a) Dropship was built beside the engine rather than on it, (b) a second
allocator with its own UI shipped in primary navigation before any cutover,
and (c) three hard-stop defects sit on the live-order path regardless of which
allocator is chosen: the days-of-cover floor fails open, order acceptance does
not charge the `.ops` cost shown in preview, and packaging silently resolves
through the legacy assignment table for any channel without a saved policy.

The path back is not a new allocator or another UI build. It is: pick the
Dropship quantity contract (recommendation: Option B), fix the three hard stops,
make the live authority visible in one place, and then run the handoff's
phased dogfood with evidence.

---

## 2. What the code definitely does

### 2.1 Channel Allocation engine (Shopify and eBay)

CODE-CONFIRMED unless stated.

- **Three layers as documented.** Channel → warehouse assignment, then rule
  resolution `variant override ?? product override ?? channel default ?? DEFAULT_RULE`
  (`mirror`, eligible, floor 0, no ceiling; `allocation-engine.service.ts:167-178`,
  `:561-587`), then per-channel independent computation with no drawdown
  (`:14-17`).
- **Per-warehouse arithmetic.** For each assigned warehouse: `share` uses
  `floor(whBaseAtp × pct / 100)`; `mirror` and `fixed` use `whBaseAtp`; then
  `floor(base / unitsPerVariant)`; `fixed`/`ceiling` are one base-unit budget
  drawn down warehouse by warehouse (`:651-697`). There is no safe-integer or
  `unitsPerVariant > 0` guard in the engine (grep negative); the only such guard
  lives in the preview repository and never runs on the publication path
  (`inventory-availability-channel-preview.repository.ts:102-121`).
- **Which channels get rows.** Every `channels.channels` row with
  `status = 'active'`, no provider or type filter (`:239-245`). The internal
  `Dropship OMS` row (`type='internal'`, `provider='manual'`, seeded by
  `migrations/0106_dropship_internal_channel_seed.sql:5-15`) therefore receives
  allocation rows and audit-log rows like any other channel.
- **Warehouse fallback.** A channel with no *enabled* assignment (assignments are
  filtered `enabled = true` before grouping, `:279-296`) receives every warehouse
  with `is_active = 1 AND warehouse_type IN ('operations','3pl')` (`:300-317`,
  selection at `:419`). `warehouses.feed_enabled` is ignored; the only reader,
  `getDisabledWarehouseIds`, has no caller. The provenance value
  `warehouseScopeSource: 'legacy_all_active_fallback'` is on the result row but is
  **not** written to `allocation_audit_log.details` (`logAllocation`, `:780-812`).
- **Who consumes it.** Under `legacy` authority every runtime Shopify/eBay
  quantity publication derives from `allocateProduct`: the 2-second
  per-product debounce on inventory mutations (`server/services/index.ts:405-437`),
  the scheduled sweep (`server/index.ts:312-445`, boot plus every
  `sync_settings.sweepIntervalMinutes`, default 15, gated on `global_enabled`),
  manual run, allocation-rule create/update (`channels.routes.ts:2492,2549`), and
  exact-scope catch-up (`echelon-sync-orchestrator.service.ts:330-357`). Shopify
  receives the per-warehouse breakdown (`:682-814`,
  `shopify.adapter.ts:170-177`); eBay receives `allocatedUnits`
  (`:477-556`, `ebay.adapter.ts:275-284`). A second eBay path, the DB-trigger-fed
  variant-availability worker, uses the engine only on reactivation and pushes
  a constant 0 on deactivation (`variant-availability-sync.service.ts:234-235,
  246-249, 271-278`).
- **Rows with no adapter are dropped.** Only `shopify` and `ebay` adapters are
  registered (`server/services/index.ts:347-352`). For any other provider the
  orchestrator logs a `console.warn`, sets `variantsErrored = allocations.length`,
  returns an empty `details` array, and writes nothing
  (`echelon-sync-orchestrator.service.ts:440-445`). The sweep summary then counts
  the `Dropship OMS` rows as errors every cycle (`server/index.ts:371-375`).
- **Publication view only.** The engine's only write is a best-effort insert into
  `allocation_audit_log` whose failure is swallowed (`:809`). Reservation never
  consults it: `reserveForOrder` has no channel parameter
  (`reservation.service.ts:278-286`) and gates on network-wide
  `getAtpPerVariant` (`:362-365`), which for fungible products sums every
  `inventory_levels` row for the product with no warehouse or channel filter
  (`atp.service.ts:229-259, 271-273, 507-518`). Under canonical authority the
  claim service also has no channel dimension.
- **`getAtpForChannel` is not what the handoff implies.** It has zero runtime
  callers. It returns network ATP filtered to variants with an active
  `channel_feeds` row; it never reads allocation rules or warehouse assignments
  (`atp.service.ts:550-597`). Under canonical authority it throws
  (`inventory-availability-runtime-atp.service.ts:178-192`). Pointing Dropship at
  it would not make quantity "explained by Channel Allocation".

### 2.2 Days-of-cover floor fails open, and the failure is cached

CODE-CONFIRMED. `queryAvgDailyUsage` wraps its SQL in a `try`; the `catch`
logs via `console.warn`, writes `velocityCache.set(productId, 0)`, and returns 0
(`allocation-engine.service.ts:82-86`). A rule with `floorType = 'days'` then
computes `effectiveFloor = ceil(days × 0) = 0` and the gate
`channelBaseAtp < effectiveFloor` can never trigger (`:625-648`). The result is
the no-floor allocation, not necessarily full ATP: share, fixed and ceiling still
apply (`:650-697`).

Aggravations the handoff did not record:

- The 0 lives in a module-level `Map` with no TTL (`:49`). `clearVelocityCache`
  (`:53-56`) has exactly two callers: the start of the full sweep
  (`echelon-sync-orchestrator.service.ts:374`) and the read-only preview
  repository (`:300`). Single-product syncs (event debounce, rule routes,
  catch-up, variant reactivation) never clear it, so a poisoned 0 survives until
  the next sweep or process restart.
- `velocityCacheGeneration` is incremented and never read.
- Nothing on the allocation row or the audit row records whether velocity was
  read successfully. A genuine zero-velocity product and a failed read are
  byte-identical downstream.
- The UI velocity endpoint returns HTTP 500 on the same SQL failure
  (`channels.routes.ts:2616-2646`), so the UI can distinguish the two cases and
  the engine cannot.
- **No test sets `floorType = 'days'`.** The unit mock DB has no `execute`
  method (`__tests__/unit/allocation-engine.test.ts:84-97`), so a days-rule
  fixture would silently take the catch branch and pass.

### 2.3 Dropship quantity path (current behavior is the handoff's Option A)

CODE-CONFIRMED.

1. All three composition roots build `InventoryServiceDropshipAtpProvider` over
   `createAuthorityAwareInventoryAtpService(pool)`
   (`dropship-listing-preview.factory.ts:32`,
   `dropship-vendor-catalog.routes.ts:79`,
   `dropship-marketplace-registration.factory.ts:86-88`). The provider's only
   call is network-level `getAtpPerVariant(productId)`
   (`dropship-atp.provider.ts:31-35`).
2. `evaluateDropshipVendorCatalogSelection` applies admin exposure, vendor
   include/exclude, and `marketplaceQuantityCap`; blocked decisions force 0; the
   cap is the only reducing operation
   (`domain/vendor-selection.ts:60-66, 132-142`). Exclusion does not partition
   supply among vendors: every selected vendor sees full network ATP.
3. `marketplace_quantity_cap` on `dropship_vendor_variant_overrides` has **no
   writer** anywhere in routes, services, client, or migrations (repo-wide grep;
   schema at `shared/schema/dropship.schema.ts:1155,1171`). Rows can only come
   from hand SQL. Separately, `dropship_vendor_listings.quantity_cap` stores the
   *computed marketplace quantity* at queue time, not an operator cap
   (`dropship-listing-preview.repository.ts:753-776`).
4. **The queued snapshot is not what gets published.** The push worker calls
   `refreshListingIntent`, which the only production factory wires to a fresh
   `generatePreview` (`dropship-listing-push-worker-service.ts:236-253`,
   `dropship-listing-push-worker.factory.ts:14-24`). The regenerated quantity is
   pushed and written to `pushed_quantity`
   (`dropship-listing-push-worker.repository.ts:211,221`). The stored intent is
   used only for readiness and preview-hash drift checks.
5. Every quantity-bearing eBay write passes the shared quantity admission gate.
   Under `legacy` the Dropship quantity reaches the wire unchanged; under
   `canonical` the request body's quantity is **rewritten** to the canonical plan
   while `pushed_quantity` still records the Dropship value
   (`dropship-ebay-listing-push.provider.ts:499-504`,
   `channels/quantity-publication-request.ts:128-140`,
   `quantity-publication-admission.repository.ts:293-310`).
6. No file under `server/modules/dropship` references the allocation engine,
   `channel_warehouse_assignments`, or `getAtpForChannel` (grep negative).
7. The `Dropship OMS` channel is a plain `channels.channels` row resolved by
   name/type/provider/status, optionally pinned by `DROPSHIP_OMS_CHANNEL_ID`
   (`dropship-order-intake.repository.ts:313-360`). The Channel Allocation page
   filters channels on status only (`ChannelAllocation.tsx:217,761`), so
   operators can configure assignments and rules for it that affect nothing.
8. One active-like store connection per vendor is enforced by the partial unique
   index on `(vendor_id)` where status is connected/needs_reauth/refresh_failed/
   grace_period/paused (`shared/schema/dropship.schema.ts:432-436`). Listings are
   unique per `(store_connection_id, product_variant_id)` (`:1306-1309`).
9. **Option B change point.** The `DropshipAtpProvider` port
   (`dropship-selection-atp-service.ts:122-126`) is a single method
   `getVariantAtp(targets) → Map<variantId, units>`. An allocation-backed
   implementation would resolve the `Dropship OMS` channel id, call
   `AllocationEngine.previewProduct(productId)` (no audit write; `allocateProduct`
   writes audit rows and must not be used from a read path), and return
   `allocatedUnits` for rows where `channelId` matches. Because the push worker
   regenerates the preview through the same provider, the push-time quantity
   follows automatically. Inherited risks: the product-line gate (`:252-280`),
   the days-of-cover fail-open, `DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED` failing
   closed, and one full engine run per product per preview.

### 2.4 Runtime authority and Inventory Exposure

CODE-CONFIRMED.

- `inventory.availability_runtime_authority` is a singleton seeded `legacy`,
  revision 1 (`migrations/0638_inventory_availability_cutover.sql:42-70`). A
  `BEFORE UPDATE` trigger forces `revision + 1`, forbids `canonical → legacy`, and
  permits `legacy → canonical` only when the activation run is `activating`
  (`:336-352`).
- The only production writer is `POST /api/inventory-planning/admin/cutover/commit`
  (`inventory_planning:activate`), guarded by `authority = 'legacy' AND revision = $4`
  after an admission fence and a ready review; in the same transaction it promotes
  every `preview` target with `publication_authority = 'echelon'` to `live`
  (`inventory-cutover-commit.repository.ts:33-41, 53-66, 67-80`;
  `inventory-cutover-commit.routes.ts:24-31`). Nothing schedules a cutover; it
  is an explicit operator POST. **"Include in readiness preview" on the Exposure
  page is therefore an activation-set decision, not a display filter.**
- Under `canonical`, `AuthorityAwareInventoryPublicationService.publishProduct`
  never invokes the legacy publisher callback that holds the `allocateProduct`
  call; it calls the canonical planner instead
  (`inventory-availability-runtime-publication.service.ts:145-164`, legacy branch
  `:154-156`, canonical `:215-218`; orchestrator `:265-277`). The canonical
  planner reads only sealed exposure heads and never
  `channel_allocation_rules` or `channel_warehouse_assignments` (grep negative
  outside the cutover fence table list; HYPOTHESIS for the runtime repository
  SQL, which was not read line by line).
- The canonical "channel dials" are a second allocation policy of the same kind:
  `{ allocationSemantics: exposure|partitioned, eligible, shareBps, holdbackSellableUnits,
  maxPublish, minPublishSellableUnits }`, resolved SKU → product → channel and
  applied as gate → share → holdback → cap → min-cutoff over canonical ATP summed
  across the target's bound source nodes
  (`shared/types/inventory-channel-exposure.ts:33-42`,
  `domain/inventory-channel-exposure.ts:140-173`). The store connection is not a
  policy (handoff 4.4 is right about that), but the target's channel dials are.
- The shadow preview runs the *legacy* engine twice, on legacy and proposed
  ATP, and diffs (`inventory-availability-channel-preview.repository.ts:301-304`).
  It proves ATP-input parity, not rules-versus-dials parity.
- Inventory Exposure routes: GET view/preview (`inventory_planning:view`); PUT
  drafts and POST target (`:edit`); PUT preview-state (`:activate`). Targets are
  created `disabled` and can only toggle `disabled ↔ preview`; `live` is rejected
  (`inventory-channel-exposure.routes.ts:44-145`,
  `shared/types/inventory-channel-exposure.ts:259-265`). No route touches the
  authority row. Draft saves change nothing the legacy publisher reads (the
  engine imports only `channels.*` and catalog tables).
- **The page's "Legacy runtime retained" badge and the view DTO's
  `runtimeAuthority` are hard-coded literals**
  (`InventoryExposure.tsx:367-368`, `shared/types/inventory-channel-exposure.ts:198`
  `z.literal("legacy_channel_allocation_rules")`,
  `inventory-channel-exposure-admin.repository.ts:281`). After a cutover the page
  would still say legacy. A live readout exists only on Supply & Transformations
  via `GET /api/inventory-planning/admin/cutover-preflight`
  (`inventory-cutover-preflight.repository.ts:29,45`,
  `inventory-cutover-preflight-panel.tsx:63`). `ChannelAllocation.tsx` contains
  no reference to authority.
- Gating: Inventory Exposure is a nav child of "Catalog & Channels" with
  `requiredPermission inventory_planning:view`, placed directly above Allocation
  (`AppShell.tsx:227-233`); route `ProtectedRoute` with the same permission
  (`App.tsx:411-416`). Migration 213 grants view/edit/activate to
  `Administrator` only (`:28-35`). There is no feature-flag framework; the three
  gate patterns in the codebase are env booleans, one settings-driven route
  switch (`App.tsx:101-127`), and permission gates.

### 2.5 Product cost: preview versus acceptance (HARD STOP HS-05)

CODE-CONFIRMED, and worse than the handoff states.

- **Preview** resolves cost from membership tables keyed on
  `dropship_vendors.current_plan_id` inside a `REPEATABLE READ READ ONLY`
  transaction, precedence exclusion → single exact-variant override (fixed price
  parsed as decimal cents; percent with BigInt half-up on basis points) → plan
  fallback; failures return `unavailable`, never a fabricated 0 or discount
  (`shellz-club-product-cost.adapter.ts:68-88, 123-167`;
  `domain/dropship-product-cost.ts:38-43, 94-97, 116-143`).
- **Acceptance** computes `retail − floor(retail × discountPercent / 100)`
  (`dropship-order-acceptance-service.ts:352-364`), where retail is
  `COALESCE(ROUND(public.shopify_variants.price × 100), pv.price_cents)` matched
  by `shopify_variant_id` or SKU (`dropship-order-acceptance.repository.ts:536,
  541-553`) and `discountPercent` is `channels.partner_profiles.discount_percent`
  for the intake's channel (`:418, 422`), which is always the single internal
  `Dropship OMS` channel. `partner_profiles.channel_id` is UNIQUE, so this is one
  platform-wide integer percent. `normalizeDiscountPercent` maps NULL → 0 with no
  log or error (`:1285-1295`). Different source, different precision (integer
  percent versus basis points), different rounding (floor versus half-up).
- **There is no in-app way to set that discount.** The only writer,
  `PUT /api/channels/:id/partner-profile`, returns 400 unless
  `channel.type === 'partner'` (`channels.routes.ts:914-925`), and `Dropship OMS`
  must be `type = 'internal'`. Unless a row was inserted out of band, acceptance
  charges **full Shopify retail** (0% discount) and records that 0 in the
  economics snapshot.
- That cost flows to OMS order/lines, the wallet debit
  (`totalDebit = wholesale + shipping + fees`, insurance pool excluded,
  `service:262-276`), the ledger row, the economics snapshot, and audit events
  (`repository:741-861, 907-988, 1000-1034`). The snapshot records the discount
  percent but no `.ops` provenance because none is loaded.
- No file on the acceptance, workflow, or processing path references the
  `.ops` cost reader (module-wide grep). The acceptance DTO carries no cost
  (`dropship-use-case-dtos.ts:70-77`), which is correct (browser cents must never
  authorize a debit) but means there is no preview-to-acceptance evidence link.
- Freezing mechanics already exist: `PgShellzClubProductCostAdapter.forTransaction(client)`
  uses a SAVEPOINT inside a caller-owned transaction (`adapter:40-43, 69`); the
  acceptance transaction is `READ COMMITTED` with `FOR UPDATE` on intake,
  vendor+store, inventory levels and wallet (`:154-166, 323-334, 424, 634-648,
  681-686`). The membership override tables have no revision column; the module's
  existing pattern is a content evidence hash (`dropship-rule-price.ts:13-23`).
  Replay idempotency compares a `requestHash` that excludes cost (`:344-393,
  366-373`), so cost evidence belongs in the pricing snapshot, not the hash.
- The economics snapshot is immutable only at application level: UNIQUE on
  `intake_id`, no append-only trigger (unlike migrations 0653/0657 tables).
- **Tests:** no test executes `acceptOrderWithClient`. The repository test asserts
  source text only; plan-builder tests receive `wholesaleUnitCostCents` from the
  fixture; the wallet-service tests exercise `debitOrder`, a second debit path
  with no production caller. NULL → 0, the partner-profile join, and the
  Shopify-cache COALESCE are untested.
- HYPOTHESIS: for `ARM-ENV-SGL-P50` the preview is 809 cents from a fixed-price
  override; the acceptance debit would be `R − floor(R × d / 100)` with R the
  Shopify cache price and d the platform discount. With the fixture retail of 899,
  no integer d yields 809. Actual R and d are UNKNOWN (database values).

### 2.6 Packaging and box suites

CODE-CONFIRMED.

**One runtime resolver, shared.** `SharedShippingConfigurationRepository.loadPackaging(channel, warehouseId, channelId?)`
is used by the Dropship cartonization provider (quote and listing estimate) and
by WMS `ensurePackPlan`
(`shared-configuration.repository.ts:260-314`;
`dropship-basic-cartonization.provider.ts:44-47`;
`wms-pack-plan.service.ts:238-245, 293-298`; `packing-input.repository.ts:114-117`).
When `channelId` is non-null it delegates to `ChannelPackagingRepository.resolve`
(`:273-278`).

**Canonical chain, hop by hop, inside one `REPEATABLE READ READ ONLY` transaction**
(`channel-packaging.repository.ts:275-323`):
policy row by `channel_id` with aggregated overrides → `resolveChannelSuite`
(warehouse override else default; >1 override throws;
`domain/channel-packaging.ts:15-37`) → `readSuite` loads members at the suite's
`current_revision`, rejects archived/missing (`:325-346`) → per-box warehouse
availability computed in SQL as all warehouses where
`shipping.box_available_at(box, warehouse, true)` (`:62-63`) → `assertSuiteBranding`
then `eligiblePackagingBoxes` (`shared/shipping/packaging-eligibility.ts:16-27`)
→ result with `suiteId, suiteRevision, assignmentRevision, requirement, source, boxes`,
snapshotted into `pack_plans.packaging_snapshot` (`wms-pack-plan.service.ts:351-353`).

**Empty intersection is fail-closed on every path.** `SHIPPING_SUITE_EMPTY_AT_WAREHOUSE`
(canonical `:301-305`, legacy `shared-configuration.repository.ts:304-308`),
`SHIPPING_PACKAGING_ASSIGNMENT_REQUIRED`/`_AMBIGUOUS` when no legacy row matches
(`domain/packaging-assignment.ts:19-33`). Save time also fails closed: an override
with no eligible boxes and any enabled warehouse left without eligible boxes are
rejected (`:214-252`). The runtime never widens to all boxes or another suite.

**Gaps the handoff's chain does not show:**

1. **The "enabled warehouses (Channel Allocation)" hop is not a runtime hop.**
   `resolve` never reads `channel_warehouse_assignments`. Enablement is checked
   only at policy save (`persistPolicy`, `:176-193, 235-252`) and in read models
   (`overview`, `:108-110`; `ChannelPackagingPanel.tsx:91-98`). At runtime the
   warehouse comes from `wms.orders.warehouse_id` (`wms-pack-plan.service.ts:420-434`)
   or the Dropship store connection's `defaultWarehouseId`
   (`dropship-order-processing-service.ts:594`,
   `dropship-listing-shipping-estimate-service.ts:78-89`). An override for a
   warehouse later disabled in Channel Allocation keeps being honored
   (HYPOTHESIS as to occurrence; CODE-CONFIRMED that nothing revalidates it).
2. **Legacy fallback with weaker semantics.** When `channelId` is null, or when
   no `shipping.channel_packaging_policies` row exists for the channel,
   `loadPackaging` runs the legacy `shipping.packaging_assignments` query with
   `box_available_at(..., false)` (an unreviewed box with no stock rows counts as
   available everywhere; `migrations/243:18-28`) and **no branding requirement**
   (`:281-295`). The returned shape lacks `channelId`/`requirement`, so the pack
   plan is non-canonical and `confirmParcel` skips the warehouse-availability and
   branding re-checks (`domain/packing-permission.ts:34-43`,
   `packing.service.ts:486-504, 522-530`); the Dropship provider and
   `ensurePackPlan` then treat the program as not white-label, so
   ships-in-own-container bypass is allowed
   (`dropship-basic-cartonization.provider.ts:52-53`). No log line or result
   marker distinguishes canonical from legacy resolution; only the admin panel
   shows "Legacy packaging is still in use" (`ChannelPackagingPanel.tsx:155-163`).
   Migration 241 deliberately creates no policies (`:9-10`), so **legacy is the
   designed default until an operator saves a policy per channel.** Null
   `channelId` reaches this path from WMS orders with `channel_id` NULL and from
   Dropship when `DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED`
   (`dropship-packaging-channel.ts:9-17`).
3. **`availabilityReviewed` is a server-side no-op.** `BOX_PROJECTION` hard-codes
   `true AS "availabilityReviewed"` (`channel-packaging.repository.ts:61`). The
   reviewed requirement is enforced only inside `box_available_at(..., true)`'s
   no-explicit-override branch; an explicit `warehouse_packaging_availability`
   row wins regardless.
4. **Legacy surfaces still mounted on the server:** `packaging_assignments` is
   read by `loadPackaging`, `listPackaging`, `saveSuite`, `saveAssignment`,
   `changeSuiteStatus`, `resetAssignment`
   (`shared-configuration.repository.ts:292, 374, 429-432, 492, 516-522, 559,
   621-628, 642`); legacy write routes remain
   (`PUT /api/shipping/admin/packaging/assignment`, `POST .../reset`,
   `PUT /api/dropship/admin/shipping/shared/packaging`, `POST .../reset`;
   `shared-configuration-admin.routes.ts:159-171, 200-221, 234-251`) with no client
   callers; `GET /api/shipping/admin/packaging/resolve` passes no `channelId` and
   therefore **always** resolves legacy; the admin shadow-replay tool uses the
   legacy path (`shadow-quote.service.ts:133-136`). `box_warehouse_stock` is read
   only via `box_available_at` and by `GET /api/shipping/admin/config`
   (`shipping-admin.routes.ts:47-88`); nothing writes it any more.
5. **Orphaned second write surface.** `PUT /api/shipping/admin/warehouse-packaging/suites`
   → `ChannelPackagingService.assignWarehouseSuites` →
   `ChannelPackagingRepository.assignWarehouseSuites` plans a per-warehouse
   override delta and re-enters `persistPolicy` (writes the canonical tables, not
   the legacy one) (`routes:110-114`, `service:77-85`, `repository:556-606`). No
   client caller. Retiring it removes a route, a service method, a store member,
   a Zod schema (`packaging-policy.ts:185-212`), the domain planner, and tests; no
   table.
6. **Two editable mounts of one panel.** Shipping Settings → Channel routing →
   Packaging (`ShippingSettings.tsx:1633` via `PackagingAssignmentsPanel.tsx:2`, a
   pure re-export) and Dropship → Shipping Config
   (`Dropship.tsx:6040` → `DropshipSharedShippingPanel.tsx:145`). The `dropship`
   prop only filters channels and re-targets the URL
   (`ChannelPackagingPanel.tsx:29-31, 41-47, 618-619`); it does not make the
   panel read-only.
7. **Stale guide, plus an error the handoff missed.** `docs/WAREHOUSE-PACKAGING-ADMIN.md`
   says Warehouses → Packaging assigns suites (`:7, 15, 17`) and its deployment
   note says "Apply migration 242" (`:38`); 242 is the inventory quantity ledger,
   the availability migration is 243.
8. **Migration 246** corrects only `kind='box'` rows whose name matches
   `^Box LxWxH$` and whose code equals `BOX-LxWxH`, only when every stored axis
   equals the rounded or exact legacy conversion; it is idempotent via a
   deterministic `command_id`, bumps the box revision and writes one
   `configuration_commands` row per corrected box; skipped rows are `RAISE NOTICE`
   only and are **not persisted** (`migrations/246:17-29, 37-46, 51-72`). Proof
   of application therefore needs `_migrations` plus `configuration_commands`
   plus a re-derivation for boxes lacking an audit row (section 8).
9. **Writes are serialized and audited.** Every catalog/suite/policy/availability
   mutation runs inside `configurationCommand`, which takes
   `pg_advisory_xact_lock(hashtext('shipping-shared-config'))`, replays by
   `command_id` with request-hash equality, and inserts an immutable
   `configuration_commands` row in the same transaction
   (`configuration-command.ts:20-52`); the migration 241 trigger takes the same
   lock (`:28-49`). `persistPolicy` uses `FOR UPDATE` + `expectedRevision` CAS.

### 2.7 Which warehouse fulfils a Dropship order

CODE-CONFIRMED. Three unreconciled authorities, none of them Channel Allocation:

| Step | Warehouse source | Evidence |
| --- | --- | --- |
| Quote, acceptance validation, `oms_orders.warehouse_id`, inventory-level lock | Store connection `orderProcessing.defaultWarehouseId`; fails closed if missing | `dropship-order-processing-service.ts:586-604`; acceptance repo `:634-651` |
| WMS order `warehouse_id` | `fulfillmentRouter.routeOrder(channelId, country, skus)`: `fulfillment_routing_rules` for the channel or global, else the default warehouse (`is_default=1 AND is_active=1 AND type IN (operations,3pl) ORDER BY id LIMIT 1`); `oms_orders.warehouse_id` is not read | `wms-sync.service.ts:695-746`; `fulfillment-router.service.ts:91, 126-137`; `warehouse.repository.ts:97-109` |
| Reservation bin | the variant's primary `product_locations` row in any unfrozen warehouse | `reservation.service.ts:397-456` |

Migration 0106 seeds `Dropship OMS` with no warehouse assignments and no routing
rules. Packaging's save-time enablement check uses raw enabled assignment rows
*without* the engine's all-warehouses fallback, so "enabled" already means
different things in the two systems.

### 2.8 Buyer-selected eBay shipping service is dropped at intake

CODE-CONFIRMED (critic spot-check; no reader owned this area). The eBay order
type carries `fulfillmentStartInstructions[].shippingStep.shippingServiceCode`
(`ebay-types.ts:241`), but the Dropship intake mapper reads only `shipTo` and
`pricingSummary`, keeping the whole order as `rawPayload`
(`dropship-ebay-order-intake.mapper.ts:27, 118-137, 139-150`). Acceptance writes
no shipping method, so `oms.oms_orders.shipping_service_level` takes its default
`standard` (`oms.schema.ts:67-69`); WMS sync copies it (`wms-sync.service.ts:762`)
and uses it for SLA cutoffs (`:2420`). The main-store eBay path has the same gap.
No test asserts service propagation.

---

## 3. What is likely happening (HYPOTHESIS)

- Production runs on `legacy` authority today, so Shopify and eBay quantities
  come from Channel Allocation and Dropship quantities come from network ATP.
  Basis: the 2026-09-09 tracked capture plus the absence of any code path that
  flips authority without an operator POST. Not a readout.
- The operator's confusion is structural, not a misconfiguration: two allocation
  UIs are one menu apart, neither shows which is live, and the one that is live
  lets you configure a channel (`Dropship OMS`) whose rows are discarded.
- The `$8.09` preview cost is not what a live order would debit. Unless a
  `partner_profiles` row exists for `Dropship OMS`, the debit would be full
  Shopify retail.
- Every active channel that has not had a packaging policy saved since PR #1432
  is resolving boxes through the legacy assignment table with no branding gate.
  Whether that includes `Dropship OMS` depends on production rows.

---

## 4. Handoff corrections

| Handoff statement | Correction |
| --- | --- |
| 4.5: "the existing channel-aware read is `getAtpForChannel`" | It is channel-feed-aware only; no allocation rules or assignments; zero runtime callers; throws under canonical. The only allocation-aware computation is `AllocationEngine.calculateProduct`. |
| 4.4: vendors share "the one internal Dropship OMS allocation dial" | The dial is computed and discarded (no `manual` adapter). Nothing consumes it. |
| 4.6 Option B "reuses the existing allocation engine" | Only while authority is `legacy`. Under canonical the engine is bypassed; the equivalent lever is the exposure policy. Record the decision against the authority state. |
| 4.7 step 3: preview quantity → queued snapshot → publication | The push worker regenerates the preview at push time; the published quantity is push-time ATP, not the queued value. |
| 4.1: fallback when "no explicit warehouse assignment" | Trigger is no *enabled* assignment; `feed_enabled` is ignored; provenance is not persisted to the audit log. |
| 4.1: velocity catch at `:82-85`; days rule at `:465-473` | Catch is `:82-86`; `needsVelocity` is `:468-472`. Missing: the 0 is cached process-wide and cleared only by the full sweep. |
| 4.2: authority-aware service "delegates to legacy or canonical" | Only `getAtpPerVariant`, `getAtpPerVariantByWarehouse`, `getDirectVariantAtpByWarehouse` and two summary overlays have a canonical branch; `getAtpForChannel`, `getAtpBase`, `getAtpBaseByWarehouse`, `getBulkAtp`, `getProductInventoryStrategy` throw under canonical. |
| 4.2: the page says "Legacy runtime retained" | That badge and the DTO field are literals; they cannot report canonical. |
| 4.4: "no third allocator should be added" | A second one already exists (Inventory Exposure dials). The question is migration and parity, not addition. |
| 3.4: acceptance reads `partner_profiles.discount_percent` | Also: one platform-wide value; NULL → 0 silently; no in-app writer for an internal channel; retail is the Shopify cache first, catalog price second; rounding differs from preview. Cited lines are `:536`, `:574`, `:1182-1185`. |
| 2.1 runtime chain includes "enabled warehouses (Channel Allocation)" | Not a runtime hop; save-time and display only. |
| 2.1 resolver "must not silently fall back to another suite" | It never picks another suite within a policy, but it does fall back to the legacy assignment authority with weaker filters, unlogged. |
| 2.2: `eligiblePackagingBoxes` requires availability-reviewed | Server projection hard-codes `true`; the reviewed predicate is a no-op there. |
| 2.4: `PgChannelPackagingRepository.assignWarehouseSuites` | Class is `ChannelPackagingRepository`. Also unlisted: dead `GET /packaging/resolve` (always legacy) and the shadow-replay tool. |
| 2.4: `WarehousePackagingPanel` no longer calls `/warehouse-packaging/suites` | No client code anywhere calls it. |
| 2.5: prove migration 246 by querying boxes and audit rows | Skipped rows are not persisted; add `_migrations` and re-derive skips from name-implied dimensions. Also fix the guide's "migration 242" (should be 243). |
| 4.4: store index at `dropship.schema.ts:428-436` | `:432-436`. |

---

## 5. What is not proven (UNKNOWN, needs production access)

- Current `inventory.availability_runtime_authority` row (authority, revision,
  activation run, changed by/at) at the deployed SHA. Also whether the 0638
  guard trigger is installed in production
  (`docs/INVENTORY-CUTOVER-AUTHORITY-AND-ENCUMBRANCE-AUDIT-20260907.md:14` says
  unverified) and whether any target sits in `preview`.
- Deployed release SHA and the migration ledger (`_migrations`).
- Whether `Dropship OMS` has `channel_warehouse_assignments`,
  `channel_allocation_rules`, or `channel_product_lines` rows; whether any rule
  anywhere has `floor_type='days' AND floor_atp > 0`; whether
  `[AllocationEngine] Failed to query velocity` has ever appeared in logs;
  `sync_settings.global_enabled` and sweep interval.
- Whether a `channels.partner_profiles` row exists for `Dropship OMS` and its
  `discount_percent`; `public.shopify_variants.price` for variant 66; whether
  `membership.plans.flat_discount_bp` / `flat_discount_percent` exist in the
  Shellz-Club-owned schema (read by the adapter, absent from Echelon's schema).
- Which active channels have no `shipping.channel_packaging_policies` row; which
  `packaging_assignments` rows are active; which box/warehouse availability facts
  still depend on `box_warehouse_stock`; how many packable WMS orders have
  `channel_id` NULL; whether `DROPSHIP_OMS_CHANNEL_ID` is set.
- Whether migration 246 applied and which boxes it skipped.
- Whether any `dropship_vendor_variant_overrides` rows exist (no writer exists).
- Whether any `inventory_publication_targets` row is owned by a
  `dropship_store_connection` and `live` (only then is the canonical outbox a
  second real writer for a Dropship store).
- Whether the test suites currently pass in CI (not executed here).

---

## 6. Answers and recommendations for the thirteen review questions

Recommendations are labelled as such; they are engineering judgment on top of
the verified findings, and the product owner decides.

1. **Allocation contract.** Today: Option A (network ATP, vendor cap). The
   engine already computes the Option B input. **Recommendation: adopt Option B**
   as the target contract, implemented as an allocation-backed
   `DropshipAtpProvider` over `previewProduct` filtered to the `Dropship OMS`
   channel, with an explicit requirement that `Dropship OMS` has at least one
   enabled warehouse assignment (reject `legacy_all_active_fallback` for that
   channel with a structured error). Reason: it makes one authority govern every
   channel's exposure, it matches what the Channel Allocation UI already tells
   operators, and packaging save-time checks already depend on those assignments.
   Note what B does *not* do: Channel Allocation is a publication view in every
   channel, so Dropship and Shopify can still oversell each other exactly as
   Shopify and eBay can today; a hard partition is only available as the
   canonical `partitioned` semantics. For the single-SKU dogfood listing, Option A
   is acceptable *only* with the trace recorded (network ATP → selection → cap →
   push-time quantity), because under A the quantity is fully explainable.
2. **Runtime authority.** Last tracked value `legacy` / rev 1 / no run
   (2026-09-09). No cutover is scheduled by code or docs. Read the row (section 8).
3. **UI disposition. Recommendation:** keep Channel Allocation as the live
   authority; freeze Inventory Exposure features; gate it behind a dedicated
   `inventory_planning:migration_lab` permission (pattern: migration 213) and
   move it under Inventory beside Supply & Transformations, which already hosts
   the cutover controls; replace the literal badge with the live authority; show
   the live authority on the Channel Allocation page via a small read-only
   endpoint. Do not plan a Channel Allocation retirement until a rules → dials
   migration and a parity review exist; none does.
4. **Warehouse fallback. Recommendation:** fail closed for `Dropship OMS`
   (explicit assignment required), and reconcile the three order-warehouse
   authorities: make the store connection's default warehouse the single Dropship
   warehouse authority, validate at save and at acceptance that it is enabled for
   `Dropship OMS` in Channel Allocation, and route the WMS order to the same
   warehouse (a `fulfillment_routing_rules` row for `Dropship OMS`, or honor
   `oms_orders.warehouse_id` for dropship-owned orders).
5. **Store cardinality.** One active-like store per vendor is the enforced
   contract. **Recommendation:** keep it for launch; a multi-store redesign must
   also retrace every "the store for this vendor" consumer, which no reader did.
6. **Quantity cap.** Read but unwritable; no per-store scope; no revision or
   audit columns. **Recommendation:** out of launch scope. Do not hand-insert
   rows. When needed, add an admin writer with immutable revisions and audit
   events (pattern: listing price revisions, migration 0657). Rename or document
   `dropship_vendor_listings.quantity_cap` now, since it stores a computed
   quantity.
7. **Velocity failure policy. Recommendation:** classify the failure as a
   `transient` structured error and **skip publication for that product** (the
   channel keeps its last published quantity) rather than publishing the
   no-floor allocation or a zero; scope the cache to one allocation run; put a
   `velocityStatus` on every allocation row and in `allocation_audit_log.details`;
   add `floorType='days'` tests including the failure. Product may prefer
   last-known-good with a timestamp; the code currently supports neither.
8. **Cost authority. Recommendation (HARD STOP):** acceptance must charge the
   `.ops` cost. Read it inside the acceptance transaction with
   `forTransaction(client)`, use it as `wholesaleUnitCostCents`, and on
   `unavailable` throw a structured permanent error so nothing is written
   (never 0, never the legacy discount). Freeze per line `unitCostCents, source,
   planId, overrideId, catalogRetailPriceCents` plus a content evidence hash in a
   `pricing_snapshot` v2 and in the ledger metadata; add a DB append-only trigger
   to the economics snapshot. Product must decide whether a `0.00` fixed price may
   be accepted, whether `retail` source is acceptable at acceptance, and the
   concurrency policy for plan changes between preview and acceptance.
9. **Packaging edit surface. Recommendation:** Shipping Settings → Channel
   routing → Packaging is the single editor; the Dropship page shows the resolved
   policy read-only with a link. Delete the orphaned
   `PUT /warehouse-packaging/suites` and the dead `GET /packaging/resolve`.
   Correct the admin guide.
10. **Legacy packaging exit.** Run the dependency report (section 8), save a
    policy for every active channel including `Dropship OMS`, log the fallback
    immediately, then switch `loadPackaging` to fail closed
    (`SHIPPING_PACKAGING_POLICY_REQUIRED`) when `channelId` is non-null and no
    policy exists. Product must decide whether null-channel WMS orders keep the
    legacy path or fail closed.
11. **Scale target.** No contractual maxima exist anywhere in code or docs. The
    bounds present are listing preview/push ≤ 500 variants, order items ≤ 200,
    pricing review ≤ 10,000, packaging overrides and bulk selections ≤ 1,000,
    source bindings ≤ 100. The packaging overview and `readSuite` evaluate
    `box_available_at` once per box × warehouse; the exposure admin view has no
    LIMIT. Not a launch blocker; measure before promising fleet scale.
12. **Shipping-service execution.** The buyer's service code is discarded at
    intake. **Recommendation:** at minimum persist it on intake and the OMS order
    now (no behavior change) so it is not lost; decide execution constraints
    later.
13. **Deferred pricing work.** Pricing rules write only local revisions and
    explicitly request no marketplace update
    (`dropship-pricing-rules-service.ts:81`). A changed price reaches eBay today
    only through a full listing re-push (HYPOTHESIS). Correctly deferred.

---

## 7. Plan to close the gaps and launch

Order matters. Items marked **decision** need the product owner's answer from
section 6 before code; the rest are correctness work under existing rules.

### Phase 0. Read-only production baseline (needs DB access; half a day)

Run the queries in section 8. Nothing else starts until the authority row, the
partner-profile row, the packaging policy coverage, and migration 246 are known.

### Phase 1. Hard stops on the live-order path (no new product decision beyond confirming the recommendations)

| # | Change | Size | Files |
| --- | --- | --- | --- |
| 1.1 | Acceptance reads and snapshots the `.ops` cost; unavailable cost fails the acceptance transaction; pricing snapshot v2; ledger metadata; append-only trigger; classify cost errors on worker and vendor paths | medium | `dropship-order-acceptance.repository.ts`, `dropship-order-acceptance-service.ts`, `dropship-order-processing-service.ts`, `dropship-order-acceptance-workflow-service.ts`, new migration |
| 1.2 | Interim guard until 1.1 ships: throw on NULL partner discount instead of charging full retail | small | `dropship-order-acceptance.repository.ts:1285-1295` |
| 1.3 | Days-of-cover: classified transient error, skip publication for the product, per-run velocity cache, `velocityStatus` on rows and audit details, structured logger instead of `console.warn`, tests for `floorType='days'` and its failure | medium | `allocation-engine.service.ts`, `echelon-sync-orchestrator.service.ts`, `variant-availability-sync.service.ts`, `inventory-availability-channel-preview.repository.ts`, tests |
| 1.4 | Engine guards: `unitsPerVariant >= 1`, safe-integer on inputs and outputs, permanent classified error rather than publishing NaN/Infinity | small | `allocation-engine.service.ts` |
| 1.5 | Log the packaging legacy fallback and the null-channel path with `{channelId, warehouseId, source}` | small | `shared-configuration.repository.ts:273-295` |
| 1.6 | Stop counting no-adapter channels as push errors; classify as not-publishable at DEBUG | small | `echelon-sync-orchestrator.service.ts:440-445`, `server/index.ts:371-375`, `manual-sync-runner.ts` |

### Phase 2. One visible authority

| # | Change | Size | Files |
| --- | --- | --- | --- |
| 2.1 | Read-only runtime-authority endpoint and a banner on Channel Allocation: "Runtime authority: legacy. This page governs live channel quantities." | small | new route under inventory-planning (pattern `inventory-cutover-preflight.repository.ts:29`), `ChannelAllocation.tsx` header |
| 2.2 | Replace the literal badge and DTO field on Inventory Exposure with the live value | small | `InventoryExposure.tsx:367-368`, `shared/types/inventory-channel-exposure.ts:198`, `inventory-channel-exposure-admin.repository.ts:281` |
| 2.3 | **decision** Gate Inventory Exposure behind `inventory_planning:migration_lab`; move it out of the Channels menu | small | `identity.domain.ts`, new migration (pattern 213), `AppShell.tsx:231`, `App.tsx:414`, routes |

### Phase 3. Dropship quantity and warehouse contract

| # | Change | Size | Files |
| --- | --- | --- | --- |
| 3.1 | **decision (Option B)** Allocation-backed `DropshipAtpProvider` over `previewProduct` filtered to `Dropship OMS`; swap into the three factories; reject `legacy_all_active_fallback` for that channel | medium | `dropship-atp.provider.ts`, three factories, `dropship-order-intake.repository.ts`, `allocation-engine.service.ts` |
| 3.2 | **decision** Single Dropship warehouse authority: validate the store default warehouse is enabled for `Dropship OMS`; route the WMS order to it | medium | store-connection admin writer, `dropship-order-acceptance.repository.ts`, `wms-sync.service.ts:695-746` or a routing rule |
| 3.3 | Persist the buyer's eBay `shippingServiceCode` on intake and the OMS order | small | `dropship-ebay-order-intake.mapper.ts`, acceptance repo, schema |
| 3.4 | Record the admitted wire quantity, not the intent quantity, in `pushed_quantity` when the gate rewrites it | medium | `dropship-listing-push-worker.repository.ts`, `dropship-ebay-listing-push.provider.ts`, `quantity-publication-request.ts` |
| 3.5 | Rename or document `dropship_vendor_listings.quantity_cap`; add persistence tests for queue-time and completion-time quantity writes | small | preview repository, worker repository, tests |

### Phase 4. Finish the packaging migration

| # | Change | Size | Files |
| --- | --- | --- | --- |
| 4.1 | Save a packaging policy for every active channel, `Dropship OMS` included, from the dependency report | ops | admin UI |
| 4.2 | **decision** Single editor: Dropship page becomes a resolved read-only summary with a link | small | `DropshipSharedShippingPanel.tsx:117-145` |
| 4.3 | Delete `PUT /warehouse-packaging/suites`, `GET /packaging/resolve`, and the shadow tool's legacy read; fix `docs/WAREHOUSE-PACKAGING-ADMIN.md` including the 242 → 243 error | small | routes, service, repository, domain planner, doc |
| 4.4 | **decision** Fail closed when `channelId` is non-null and no policy exists; decide null-channel orders | small | `shared-configuration.repository.ts:273-278`, integration test for the fallback branch |
| 4.5 | **decision** Enforce Channel Allocation enablement in the runtime resolver, or document that packaging runtime does not | medium | `channel-packaging.repository.ts:275-323`, `domain/channel-packaging.ts` |
| 4.6 | Tests: fallback branch with a policy-less channel; override for a warehouse disabled after save; runtime resolve for a non-enabled warehouse | small | `channel-packaging.integration.test.ts`, `dropship-basic-cartonization.provider.test.ts` |

### Phase 5. Dogfood

Run handoff phases 1 through 12 as written, with the section 4 corrections
applied to the traces (push-time quantity, not queued; `.ops` cost at
acceptance; packaging resolution source logged).

---

## 8. Next checks: read-only production queries for Phase 0

Run in one `REPEATABLE READ`, `transaction_read_only = on` session. Capture
results into the evidence package the handoff's section 11 asks for.

```sql
-- Runtime authority and activation lineage
SELECT authority, revision, activation_run_id, changed_by, change_reason, changed_at
FROM inventory.availability_runtime_authority WHERE singleton_key = true;
SELECT id, state, created_at FROM inventory.availability_activation_runs
ORDER BY id DESC LIMIT 5;
SELECT id, destination_kind, state, publication_authority
FROM inventory.inventory_publication_targets WHERE state <> 'disabled';

-- Migration ledger (handoff Phase 0 list plus 246)
SELECT filename, applied_at FROM _migrations
WHERE filename ~ '^(0657|0659|0660|238|239|241|243|244|246)_' ORDER BY filename;

-- Dropship OMS channel, its allocation configuration, and the partner profile
SELECT id, name, type, provider, status FROM channels.channels
WHERE LOWER(name) = 'dropship oms';
SELECT * FROM channels.channel_warehouse_assignments WHERE channel_id = :dropship_oms_id;
SELECT * FROM channels.channel_allocation_rules
WHERE channel_id = :dropship_oms_id OR channel_id IS NULL;
SELECT * FROM channels.channel_product_lines WHERE channel_id = :dropship_oms_id;
SELECT channel_id, discount_percent FROM channels.partner_profiles
WHERE channel_id = :dropship_oms_id;   -- absent => acceptance charges full retail

-- Days-of-cover exposure
SELECT id, channel_id, product_id, product_variant_id, floor_atp, floor_type
FROM channels.channel_allocation_rules WHERE floor_type = 'days' AND floor_atp > 0;
SELECT global_enabled, sweep_interval_minutes FROM channels.sync_settings;

-- Test SKU cost inputs
SELECT pv.id, pv.sku, pv.price_cents, sv.price AS shopify_price
FROM catalog.product_variants pv
LEFT JOIN public.shopify_variants sv ON sv.id::text = pv.shopify_variant_id::text
WHERE pv.sku = 'ARM-ENV-SGL-P50';

-- Packaging legacy dependency report
SELECT c.id, c.name, c.provider FROM channels.channels c
LEFT JOIN shipping.channel_packaging_policies p ON p.channel_id = c.id
WHERE c.status = 'active' AND p.channel_id IS NULL;
SELECT channel, warehouse_id, suite_id, revision FROM shipping.packaging_assignments
WHERE is_active;
SELECT b.id, w.id AS warehouse_id FROM shipping.box_catalog b
CROSS JOIN warehouse.warehouses w
WHERE shipping.box_available_at(b.id, w.id, true)
  AND NOT EXISTS (SELECT 1 FROM shipping.warehouse_packaging_availability a
                  WHERE a.box_id = b.id AND a.warehouse_id = w.id);
SELECT COUNT(*) FROM wms.orders
WHERE channel_id IS NULL AND warehouse_status NOT IN ('shipped','cancelled');

-- Migration 246 proof
SELECT resource_key, created_at, before_state->>'length_mm' AS before_l,
       after_state->'box'->>'length_mm' AS after_l
FROM shipping.configuration_commands
WHERE actor_id = 'migration:246_correct_legacy_box_dimensions' ORDER BY resource_key;
SELECT id, code, name, length_mm, width_mm, height_mm, outer_length_mm, configuration_revision
FROM shipping.box_catalog WHERE kind = 'box' AND name ~ '^Box [0-9]';

-- Hand-inserted caps (no application writer exists)
SELECT COUNT(*) FROM dropship.dropship_vendor_variant_overrides;
```

Also read `GET /api/inventory-planning/admin/cutover-preflight` in the deployed
app (permission `inventory_planning:view`); it returns `runtimeAuthority` and
`authorityRevision` without a database session.

---

## 9. Test coverage, failure modes, risks, assumptions

**Test coverage found (static read; suites not executed here):**

- Allocation engine: 30 unit cases on mirror/share/fixed/floor-in-units,
  scoping and fallback quantities; no `days` rule, no velocity failure, no
  `legacy_all_active_fallback` label assertion; integration suite is
  `describe.skip` without a disposable database and seeds no days rules.
- Orchestrator: catch-up exact scope, canonical bypass
  (`echelon-sync-orchestrator.test.ts:400-436`), quarantine; no test for
  `allocateProduct` rejecting or for the no-adapter branch.
- Dropship quantity: provider fan-out and validation; domain cap and exclusion;
  refreshed-intent-wins (14 versus persisted 99); eBay transport absolute publish;
  worker suite is constructed without `refreshListingIntent`; no persistence test
  for `quantity_cap` / `pushed_quantity`; preview fixture uses ATP = cap so the
  cap never reduces.
- Cost: preview domain and adapter well covered including disposable-PG 809-cent
  proof; acceptance path has no executing test.
- Packaging: pure eligibility and override precedence; canonical resolve with two
  channels at two warehouses; legacy empty-suite fail-closed; **no test of the
  canonical → legacy fallback branch**, of an override for a later-disabled
  warehouse, or of a non-enabled warehouse at runtime.
- Runtime authority: fail-closed on invalid row; canonical rejections for three of
  five throwing methods; DB guard against early flip (integration).

**Failure modes on the current live-order path:**

- Wallet debited at full retail while the vendor saw `$8.09` (HS-05).
- A velocity SQL error on one sweep exposes inventory a days-of-cover rule was
  meant to hold back, for every later single-product sync until the next full
  sweep (HS-12).
- A channel with no saved packaging policy packs from the legacy table without a
  branding gate, and `confirmParcel` does not re-check it (HS-06).
- Dropship order accepted against the store's default warehouse, WMS order
  routed to a different warehouse, reservation taken from a third.
- Buyer-selected eBay service silently replaced by `standard` (HS-10).
- Two channels each publish the same last unit; first WMS sync wins the
  reservation, the other becomes a pick short (inherent to publication-view
  allocation in every channel).

**Risks of the recommended plan:**

- Option B makes Dropship quantity depend on `Dropship OMS` configuration that
  operators have never had to maintain; a missing assignment must fail closed,
  which will block listings until configured. That is the intended safety.
- Failing packaging closed on a missing policy will break any channel not yet
  configured; sequence it after the dependency report and policy saves.
- Reading `.ops` cost inside acceptance adds a Shellz-Club-owned table read to a
  financial transaction; `forTransaction` is designed for this, but the
  `membership.plans` discount columns must be confirmed to exist in production.

**Assumptions (labelled):**

- The 2026-09-09 tracked capture still describes production authority.
- CI runs the unit suites; the integration suites require the disposable
  database flag and may be skipped in CI (UNKNOWN).
- No out-of-band SQL has inserted `partner_profiles` or
  `dropship_vendor_variant_overrides` rows.

## 10. What this pass changed

Documentation only. No application code, test, migration, configuration,
database row, provider account, listing, credential, wallet, order, or deployment
was changed. No test suite was run (dependencies not installed in this
environment).
