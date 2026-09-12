# Dropship engineering review handoff

Date: 2026-09-12

Audience: engineering, product, QA, and the operator completing Card Shellz `.ops` dogfood

Purpose: establish the current, evidence-backed state of Dropship testing, shared box-suite/warehouse packaging, and inventory allocation before more implementation or live marketplace testing.

## Executive assessment

**Dropship is not yet proven ready for a live marketplace order.** The current dogfood run has reached a much richer eBay listing preview and configuration workflow, but it has not produced recorded evidence for a live listing push, marketplace order intake, wallet debit, OMS/WMS handoff, shipment, tracking push, or return.

Three issues require engineering review before the live-order phase:

1. **Inventory authority is unclear to the operator and incomplete in the Dropship listing path.** The application exposes the existing **Channel Allocation** screen and a second **Inventory Exposure** screen. The second screen explicitly labels itself `Draft / preview only` and `Legacy runtime retained`, but it is still visible in primary navigation and can create draft/disabled canonical publication records. Separately, Dropship listing selection reads network ATP with `getAtpPerVariant`, then applies a vendor cap; it does not consume the existing channel result from `getAtpForChannel`. The current allocation engine also converts a sales-velocity query failure to zero, causing a configured days-of-cover floor to become zero and fail open.
2. **Packaging ownership is mostly represented correctly in current code, but the migration is not cleanly finished.** The current UI separates box definitions, suites, warehouse availability, and program defaults/warehouse exceptions. However, legacy assignment and warehouse-stock compatibility remain in the schema/runtime, multiple editable entry points expose the same program packaging policy, and the tracked admin guide still describes an older workflow that the current warehouse component no longer implements.
3. **Preview product cost and order-acceptance cost still have different authorities.** Preview reads the Shellz Club `.ops` cost contract. Order acceptance still calculates wholesale cost from catalog retail and `channels.partner_profiles.discount_percent`; that value drives wallet debit and immutable economics. A live order must not be accepted until these authorities are reconciled and tested atomically.

The right immediate action is an engineering review and a controlled read-only production trace. It is **not** another broad UI build, another allocator, or a live order retry.

## Evidence rules used in this handoff

| Label | Meaning |
| --- | --- |
| **CODE-CONFIRMED** | Directly supported by current `origin/main` source, schema, migration, or a tracked implementation note. |
| **AUTOMATED-ONLY** | Covered by local/unit/integration/browser tests, but not proven in the deployed production workflow. |
| **OPERATOR-OBSERVED** | Reported or shown in screenshots during the current dogfood session. It is useful acceptance evidence but is not a database or provider trace. |
| **UNKNOWN** | Not established from current source, retained logs, production database, or the operator's recorded evidence. |
| **DECISION REQUIRED** | More than one behavior is technically possible; product/engineering must select the intended contract before implementation. |
| **HARD STOP** | Do not advance to a live listing/order until resolved. |

### Source baseline

- The code baseline inspected for this document is `origin/main` commit `fc1416cbc5f7069b0bbaaea395db100bb4202f62`, dated 2026-09-12, merge commit for PR #1448.
- The local checkout was **627 commits behind `origin/main` and already contained extensive unrelated modified/untracked work**. This handoff was therefore derived with read-only `git show origin/main:<path>` / `git grep origin/main` inspection and added as a new standalone file. Existing local changes were not modified or staged.
- The operator reported deploying the recent Dropship and packaging pull requests. The exact production release SHA and migration ledger were not queried during this documentation pass; deployment parity remains **UNKNOWN** until Phase 0 below is completed.
- The older tracked dogfood documents remain useful history, but they are stale. `docs/DROPSHIP-DOGFOOD-HANDOFF.md:3-17` is dated 2026-07-05 and says testing paused before the first live listing/order. `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md` currently contains 180 checklist rows, of which 28 are checked and 152 are open; its current-working-status section is also dated 2026-07-05.

## 1. Current dogfood state

### 1.1 Known dogfood identity from tracked evidence

The following values come from `docs/DROPSHIP-DOGFOOD-HANDOFF.md:19-33` and must be reconfirmed before a live write:

| Item | Recorded value | Current confidence |
| --- | --- | --- |
| Customer portal | `https://www.cardshellz.io/dropship-portal` | Historical CODE/OPERATOR evidence; re-open in deployed build. |
| Admin surface | `/dropship` | CODE-CONFIRMED. |
| Test customer | `bseager6@gmail.com` | Historical OPERATOR evidence. |
| Member ID | `42226465-6f54-4723-9204-057a5d38657e` | Historical database/UI evidence in prior handoff; not queried again here. |
| `.ops` plan ID | `14d8698f-09d8-4dea-8089-fa9a1ec0fb28` | Historical evidence; not queried again here. |
| Subscription ID | `b92ddb72-422c-4c20-b02d-f9861b1c369f` | Historical evidence; not queried again here. |
| Marketplace | eBay | OPERATOR-OBSERVED. |
| Store display name | `marzcards` | OPERATOR-OBSERVED. |
| Store connection UUID | `9f2a4919-ed4a-4130-b2fc-62ce0f91f51b` | Historical OPERATOR evidence; numeric store ID still needs capture. |
| Initial warehouse | Warehouse ID 1, `20 Leonberg` | Historical OPERATOR evidence; current program enablement/packaging must be verified separately. |
| Primary listing test SKU | `ARM-ENV-SGL-P50`, Armalope Envelope Single Pocket, Pack of 50 | OPERATOR-OBSERVED in current listing workflow. |

Do not put OAuth tokens, vault references, provider payloads, or customer secrets in this document or future evidence attachments.

### 1.2 What the current testing run actually reached

| Area | Current status | Evidence and limits |
| --- | --- | --- |
| `.ops` entitlement and portal login | **PARTIAL / previously passed** | The historical handoff records an active `.ops` entitlement and working login. Customer-facing purchase/upgrade was not proven. Reconfirm the entitlement projection after the latest deploy. |
| eBay connection identity | **PARTIAL** | `marzcards` was connected and the setup UI reached `Ready`. Repeated listing-setup authorization warnings were also observed. A stable renewal cycle without reauthorization has not been demonstrated. |
| Catalog selection | **PARTIAL** | One Armalope variant was selected in the portal. The end-to-end quantity authority for that row is unresolved; see section 4. |
| eBay business policies | **PARTIAL** | Store defaults, return/payment policies, listing overrides, refresh, pagination, and bulk assignment were exercised in the UI. No live listing using those policies has been published. |
| USPS Ground Advantage compatibility | **IMPLEMENTED; production publication unproven** | `docs/DROPSHIP-EBAY-LISTING-POLICY-ASSIGNMENTS.md:13-24` records eBay's sellable code `USPSParcel` and the explicit mapping from configured `usps_ground_advantage`. The operator saw the policy become compatible after the change. |
| Saved-policy outage recovery | **AUTOMATED-ONLY / deployment reported** | `docs/dropship-ebay-policy-read-recovery.md:11-22` says saved defaults/overrides remain visible when live verification fails and mutations remain disabled until verification succeeds. Post-deploy failure/recovery evidence has not been captured. |
| Product cost | **PARTIAL** | The UI initially displayed `Unavailable`, then displayed `$8.09`. `docs/DROPSHIP-OPS-PRODUCT-COST.md:34-40` records a read-only source check returning `809` cents from `variant_fixed_price` for `ARM-ENV-SGL-P50`. Order-acceptance parity is not implemented. |
| Listing price | **PARTIAL** | Inline/modal editing and rule-based pricing were exercised; the operator reported the rule workflow worked. Suggested price and price-only live marketplace update jobs remain deferred. No live marketplace price was written. |
| Listing preview | **PARTIAL** | Images, product cost, catalog retail, saved listing price, policies, status, and description were displayed. A reviewed preview has not been frozen into a successfully published eBay listing. |
| Description | **PARTIAL** | Vendor prose is editable, Reset exists, and product facts were separated after a regression. No live eBay listing has verified the final rendered description. |
| Shipping estimate | **CODE/READ-ONLY PROOF; deployed UI acceptance open** | The legacy path produced `$8.24` for one pack and failed for two packs. The shared-engine fix has current-data proof for 1, 2, and 5 packs, but the operator has not recorded a post-deploy UI pass. |
| Private shipping-cost logic | **CODE-CONFIRMED removed from DTO/UI; deployed UI acceptance open** | Current customer DTO and component expose only the final total, scenario, and allowlisted warning. No base rate, markup, insurance, dunnage, rate-table ID, or breakdown is rendered. |
| Box catalog and suites | **IMPLEMENTED; final deployed acceptance open** | Multiple iterations were merged. The final ownership model is inspectable in current code, but no complete post-PR #1447 operator acceptance run is recorded. |
| Box dimensions | **MIGRATION PRESENT; production result unknown** | Migration `246_correct_legacy_box_dimensions.sql` safely corrects matching `BOX-LxWxH` legacy rows. The operator reported deployment; the production rows and audit commands were not queried again afterward. |
| Allocation | **UNRESOLVED / HARD STOP for quantity publication** | Existing Channel Allocation and draft Inventory Exposure coexist. Dropship listing selection does not currently consume channel allocation output. Production runtime authority is unknown. A failed velocity query also disables a days-of-cover floor by converting its effective floor to zero. |
| Live listing push | **NOT PROVEN** | No successful job ID, external eBay listing/offer ID, exact payload, or post-push readback was captured in this run. |
| Order through return | **NOT STARTED** | No marketplace order, intake ID, wallet ledger entry, OMS/WMS order, package confirmation, label, tracking push, or return evidence exists for this run. |

### 1.3 Existing implemented listing capabilities

These capabilities are in current mainline; each still needs the deployment acceptance described later:

- **Policy ownership and scale:** `docs/DROPSHIP-EBAY-LISTING-POLICY-ASSIGNMENTS.md:26-37` describes explicit store defaults and listing overrides, an atomic 1-500 row bulk command, revision checks, idempotency, and audit. Lines 58-82 explicitly state that the current UI rendering improvement does not make the read path fully server-scalable; selected catalog rows and store assignments are still broadly loaded.
- **Ground Advantage:** `server/modules/dropship/application/dropship-ebay-fulfillment-capability-service.ts:80-90` maps the verified sellable Ground Advantage service to `USPSParcel`. It does not treat unrelated USPS services as aliases.
- **Product cost:** `PgShellzClubProductCostAdapter.loadProductCosts` and `resolveDropshipProductCost`, summarized in `docs/DROPSHIP-OPS-PRODUCT-COST.md:3-11`, resolve the exact entitled `.ops` plan/variant source using integer cents and surface unavailable data instead of zero.
- **Pricing rules:** `docs/DROPSHIP-PRICING-RULES.md:6-23` defines immutable store profile revisions, one winning recipe, percent and/or flat markup, explicit `.ops` cost or catalog-retail basis, exact-money rounding, review, and atomic adoption. Lines 45-49 bound review to 10,000 selected listings with 50 impact rows per browser page; that is not live repricing.
- **Description content:** `resolveListingContent` keeps vendor prose and catalog facts separate. `docs/dropship-vendor-listing-content.md:14-40` defines the Edit/Save/Cancel/Reset behavior, text limits, template precedence, stale-conflict handling, and frozen queued payload boundary.
- **Shipping estimate:** `DropshipListingShippingEstimate` at `client/src/pages/dropship/DropshipListingShippingEstimate.tsx:12-89` requires quantity, country, two-letter region, and postal code; editing clears stale output; the rendered result contains only the total and scenario. `listingShippingEstimateResultSchema` at `shared/dropship/listing-shipping-estimate.ts:3-45` rejects additional private fields.

### 1.4 eBay authorization state

#### What the code definitely does

`docs/DROPSHIP-EBAY-TOKEN-LIFECYCLE.md:3-14` documents the confirmed original defect: different consumers independently refreshed the same store grant with different scope subsets, narrowing a shared access token and causing a later Inventory/Account/Store read to fail. The UI then presented that failure as a need to authorize again.

The repaired design is:

- `DropshipEbayTokenOwner.loadFreshForStoreConnection` is the single refresh owner (`docs/DROPSHIP-EBAY-TOKEN-LIFECYCLE.md:16-39`).
- Refresh omits `scope`, fresh tokens are reused, and a rejected safe read may request one repair.
- PostgreSQL advisory locking and compare-and-swap protect concurrent refresh/consent/disconnect races.
- `withEbaySafeReadRecovery` retries a rejected safe read once; it does not replay listing publication or other writes (`docs/DROPSHIP-EBAY-TOKEN-LIFECYCLE.md:41-57`).
- Current listing-setup messaging says a persistent 401/403 is an access/support issue, not proof that the store disconnected (`client/src/pages/dropship/EbayListingSetupPanel.tsx:314-326`).

#### What is likely happening

No current incident log was captured during the repeated warnings, so attributing every warning to token narrowing, an invalid refresh grant, eBay seller eligibility, or a transient resource failure would be speculation. The historical narrowing bug is proven; the cause of each later deployed warning is not.

#### What is not proven

- The deployed store's refresh grant remains valid and contains all originally consented scopes.
- The deployed application release includes the entire token-owner/recovery change.
- Background order/return/tracking consumers have completed at least one normal access-token renewal without breaking listing setup.
- The most recent warning's HTTP status, eBay error ID, internal support reference, and consuming job.

#### Required acceptance

Complete Phase 1 below before another live listing push. Do not repeatedly send the vendor through consent unless the token owner classifies the current refresh grant as genuinely missing, expired, or rejected with `invalid_grant`.

## 2. Shared box catalog, suites, warehouses, and programs

### 2.1 Intended ownership model

The clean architecture is a sequence of independent authorities:

| Concern | Authority | What it owns | What it must not own |
| --- | --- | --- | --- |
| Packaging definition | `shipping.box_catalog` | Code/name, kind, usable inner dimensions, optional outer dimensions, tare, max weight, cost, fill factor, active state, branding | Suite membership, warehouse availability, program enablement, pricing |
| Reusable collection | `shipping.box_suites` + current immutable revision members | Which catalog boxes belong to a named suite | Box metadata, physical warehouse availability, channel pricing |
| Physical usability at a location | `shipping.warehouse_packaging_availability` with compatibility read through `shipping.box_available_at` | Whether a box can be used at a warehouse | Whether that warehouse may fulfill a program, suite membership, pricing |
| Fulfillment eligibility | Existing Channel Allocation warehouse assignment | Which warehouses can fulfill a channel/program and their inventory rule | Packaging definition or availability |
| Program packaging policy | `shipping.channel_packaging_policies` | One default suite and branding requirement per actual channel/program | Warehouse enablement or pricing |
| Warehouse-specific program exception | `shipping.channel_packaging_overrides` | A replacement suite for one enabled warehouse/program pair | Physical box availability or program enablement |
| Price charged for fulfillment | Shared pricing program/rate book and charge revision | Rate coverage, markup, insurance, customer/vendor charge | Box catalog/suite membership or warehouse enablement |
| Runtime eligible boxes | Shared eligibility resolver | Intersection of active + reviewed + suite member + warehouse available + branding allowed | It must not invent availability or silently fall back to another suite |

The runtime relationship is:

```text
program/channel
  -> enabled warehouses (Channel Allocation)
  -> program default suite or explicit warehouse suite exception
  -> current suite revision members
  -> boxes physically available at that warehouse
  -> active/reviewed boxes satisfying the program branding requirement
  -> cartonization / packing selection
```

This is **not** a one-warehouse Dropship design. Multiple warehouses may be enabled for the Dropship OMS program. Each uses the program default suite unless it has an explicit suite exception, and each independently intersects that suite with its own physical availability.

### 2.2 What current code definitely implements

- **Catalog:** `shippingBoxCatalog` in `shared/schema/shipping.schema.ts:89-126` stores canonical millimeter dimensions, cost cents, fill factor, active state, and branding. Comments at lines 100-109 specify that cartonization uses inner dimensions and fill factor is applied to inner volume.
- **Suites:** `shippingBoxSuites`, `shippingBoxSuiteRevisions`, and `shippingBoxSuiteMembers` in `shared/schema/shipping-configuration.schema.ts:144-196` provide named, versioned collections with immutable revision membership.
- **Warehouse availability:** `warehousePackagingAvailability` in `shared/schema/shipping-configuration.schema.ts:46-61` has a `(warehouse_id, box_id)` primary key. `WarehousePackagingPanel` at `client/src/components/shipping/WarehousePackagingPanel.tsx:25-93` explicitly says it changes physical availability only; it does not enable programs, assign suites, change pricing, or track stock.
- **Program policy:** `shippingChannelPackagingPolicies` and `shippingChannelPackagingOverrides` at `shared/schema/shipping-configuration.schema.ts:63-98` store one default per channel and at most one suite exception per channel/warehouse pair.
- **Existing program enablement is reused:** `ChannelPackagingPanel` derives enabled warehouses from `data.warehouseAssignments` at `client/src/components/shipping/ChannelPackagingPanel.tsx:91-107`. Its UI says to enable warehouses in Channel Allocation first and that packaging never enables/disables/prioritizes them (`:145-152`, `:210-215`).
- **One default plus exceptions:** the same panel edits a `Program packaging default` or `Warehouse suite exception` (`client/src/components/shipping/ChannelPackagingPanel.tsx:501-560`) and saves one complete revision-aware policy (`:596-639`).
- **Eligibility intersection:** `eligiblePackagingBoxes` at `shared/shipping/packaging-eligibility.ts:16-27` requires active, availability-reviewed, warehouse-available, branding-compatible boxes. The caller supplies only current members of the effective suite (`client/src/components/shipping/ChannelPackagingPanel.tsx:265-278`).
- **Audit/idempotency:** `shipping.configuration_commands` at `shared/schema/shipping-configuration.schema.ts:121-141` records command ID, hash, actor, resource, before/after state, and timestamp. The UI schemas bound overrides and bulk operations (`shared/shipping/packaging-policy.ts:14-32`, `:163-209`).
- **UI scale bounds:** `WarehousePackagingPanel` displays 25 warehouses per page and permits selection of up to 1,000; `ChannelPackagingPanel` displays 50 enabled warehouses per page. The tracked guide records operation limits of 1,000 warehouses, 1,000 boxes, and 100,000 pairs (`docs/WAREHOUSE-PACKAGING-ADMIN.md:32-34`). Its 100-warehouse regression is not proof for larger fleets.

### 2.3 Current UI locations

Current mainline has more than one entry point:

1. **Shipping Settings → Box catalog**: box definition and bulk branding (`client/src/pages/ShippingSettings.tsx:420-769`, mounted at `:1603-1616`).
2. **Shipping Settings → Box suites**: collection lifecycle and membership (`client/src/components/shipping/BoxSuitesPanel.tsx:28-240`).
3. **Warehouse → Packaging** and **Warehouse Settings → Packaging**: physical availability only (`client/src/pages/WarehousePage.tsx:24-53`; `client/src/pages/WarehouseSettingsPage.tsx:258-272`).
4. **Shipping Settings → Channel routing → Packaging assignments**: program default and warehouse exceptions. `PackagingAssignmentsPanel.tsx` is only a stable re-export of `ChannelPackagingPanel`.
5. **Dropship → Shipping Config**: `DropshipSharedShippingPanel` mounts the same `ChannelPackagingPanel` filtered to the Dropship legacy profile and also renders pricing per warehouse (`client/src/components/shipping/DropshipSharedShippingPanel.tsx:117-145`).

Items 4 and 5 use the same underlying model, so this is not two database authorities. It is still two editable presentations of the same authority, which increases operator confusion. **Recommendation:** retain one authoritative editing location and make every other location a compact resolved readout with a direct, contextual transition into the editor.

### 2.4 Confirmed unfinished migration/compatibility state

The packaging redesign is not a clean replacement yet:

- `shipping.packaging_assignments` remains in `shared/schema/shipping-configuration.schema.ts:198-220` as a legacy channel-text assignment model.
- `BoxSuitesPanel` explicitly displays both `configurationAssignments` and legacy `assignments`, labeling legacy usages at `client/src/components/shipping/BoxSuitesPanel.tsx:81-87` and `:144-214`.
- Migration `238_shared_packaging_and_program_charges.sql:66-91` seeds imported `Existing shared packaging` and `Dropship packaging` suites plus legacy assignments.
- Migration `243_warehouse_packaging_availability.sql:16-28` makes explicit warehouse overrides authoritative first, but falls back to `shipping.box_warehouse_stock` under defined compatibility rules. This fallback is read-only compatibility, but it means effective availability is not yet represented only by the new table.
- `ChannelPackagingPanel` displays `Legacy packaging is still in use` when a new channel policy has not been saved (`client/src/components/shipping/ChannelPackagingPanel.tsx:155-163`).
- The generic server still exposes `PUT /api/shipping/admin/warehouse-packaging/suites` (`server/modules/shipping-engine/interfaces/http/shared-configuration-admin.routes.ts:110-118`). `ChannelPackagingService.assignWarehouseSuites` parses the legacy-named warehouse assignment command (`server/modules/shipping-engine/application/channel-packaging.service.ts:77-84`), and `PgChannelPackagingRepository.assignWarehouseSuites` writes the same channel policy/override authority (`server/modules/shipping-engine/infrastructure/channel-packaging.repository.ts:556-617`). The current `WarehousePackagingPanel` no longer calls this endpoint, but the alternate write path and misleading ownership name remain.
- The tracked `docs/WAREHOUSE-PACKAGING-ADMIN.md:7-20` still says Warehouses → Packaging assigns suites and describes a bulk **Assign program suites** workflow. Current `WarehousePackagingPanel` does not do that; it owns availability only. The guide matches the leftover API more than the current UI and must be corrected or retired.

This dual-read compatibility may be a reasonable migration strategy, but it needs an explicit exit plan and a production report showing which channels/warehouses still depend on legacy rows.

### 2.5 Dimensions and fill factor

Current intended contract:

- Inner dimensions are required usable dimensions and drive fit/cartonization.
- Outer dimensions are optional shipment/carrier dimensions and, when supplied, must be at least as large as inner dimensions (`shared/schema/shipping.schema.ts:100-125`; `shared/shipping/packaging-policy.ts:125-139`).
- Fill factor is a utilization constraint on inner volume, not a substitute for inner dimensions.
- Millimeters are canonical storage; inches are an admin presentation/input unit. `formatDimensionInches` and `dimensionInputToMm` use `decimal.js`, exact `25.4` conversion, four stored millimeter decimal places, and three input/display inch decimal places (`shared/shipping/dimensions.ts:1-69`).

Migration `246_correct_legacy_box_dimensions.sql:1-75` corrects only legacy boxes whose `Box LxWxH` name, `BOX-LxWxH` code, and prior rounded/exact millimeter values agree. It acquires the shared configuration lock, preserves outer-dimension constraints, increments the box revision, and writes before/after audit evidence. It does not infer outer dimensions or rewrite historical parcel plans.

**UNKNOWN:** whether production applied migration 246 to every expected box and how many rows it skipped. Required proof is a read-only query of named boxes plus matching `shipping.configuration_commands` audit rows.

### 2.6 Packaging decisions engineering must confirm

1. Confirm that program identity is the existing actual `channels.channels` row, not a new packaging-specific “fulfillment program” table.
2. Confirm that program warehouse enablement remains Channel Allocation authority.
3. Confirm that one program default suite plus sparse warehouse exceptions is the intended rule; do not create a full warehouse × program assignment matrix when inheritance is sufficient.
4. Select the one authoritative edit surface for program packaging. The other surface should be read-only summary/navigation.
5. Define and execute a legacy retirement report for `shipping.packaging_assignments` and implicit `box_warehouse_stock` availability.
6. Decide whether the current client-loaded overview and 1,000-warehouse command bound meet the actual maximum deployment. If 100+ warehouses is realistic, measure payload/render/write latency and design server-side pagination/search before claiming scale.

## 3. Shared shipping and pricing state

### 3.1 What current code definitely does

`docs/DROPSHIP-SHIPPING-ESTIMATE-ENGINE.md:5-23` traces the original multi-quantity failure end to end:

- `readDropshipShippingCutoverConfig` defaulted to `legacy` when `DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE` was unset.
- The two-pack shipment weighed 1,225 g and had no legacy cached rate; the exact error came from `assertEveryPackageHasRate`.
- The shared engine could rate the same package.
- The corrected default is `live`; the shared provider resolves the Dropship channel policy, uses purpose `vendor_fulfillment_charge`, and lets the configured pricing program/rate table determine the charge.
- No runtime rate amount or rate-book ID is hardcoded.

The same tracked note records a read-only current-data trace for warehouse 1, variant 66 (`ARM-ENV-SGL-P50`), US/PA/16046 at `docs/DROPSHIP-SHIPPING-ESTIMATE-ENGINE.md:25-39`:

| Packs | Cartons | Old explicit legacy result | Shared/default result |
| ---: | --- | ---: | ---: |
| 1 | 635 g | 824 cents | 719 cents |
| 2 | 1,225 g | no matching legacy rate | 719 cents |
| 5 | 1,225 g; 1,225 g; 635 g | no matching legacy rate | 925 cents |

This proves those exact reads/calculations at the recorded time. It does not prove every destination, item, pricing revision, or the current deployed UI.

### 3.2 Privacy boundary

The current customer response contract includes only final total/currency, requested scenario, timestamp, and allowlisted warning (`shared/dropship/listing-shipping-estimate.ts:3-45`). The current result component renders only `Estimated shipping total`, destination/quantity, total, and warnings (`client/src/pages/dropship/DropshipListingShippingEstimate.tsx:78-93`).

Any appearance of rate-table charge, markup, insurance pool, dunnage, internal rate source, or rate table/book ID in the customer portal is a regression and a **HARD STOP**.

### 3.3 Pricing boundaries still open

- Suggested selling price remains deferred (`docs/DROPSHIP-OPS-PRODUCT-COST.md:23`; `docs/DROPSHIP-PRICING-RULES.md:33`).
- Saving pricing rules only changes local desired listing prices. It does not update active marketplace listings (`docs/DROPSHIP-PRICING-RULES.md:25-31`, `:45-49`, `:77-79`).
- Buyer-facing eBay shipping charges remain the vendor's business-policy responsibility. Card Shellz's vendor fulfillment charge is separate.
- `docs/DROPSHIP-EBAY-LISTING-POLICY-ASSIGNMENTS.md:84-92` identifies a downstream execution gap: buyer-selected shipping service is retained only in raw eBay order data and is not normalized through OMS/WMS or constrained at execution. This must be reviewed before promising exact buyer service behavior.

### 3.4 HARD STOP: preview cost is not acceptance cost

`docs/DROPSHIP-OPS-PRODUCT-COST.md:17-23` explicitly warns that `loadVendorContextForUpdate` and `mapListingCandidateRow` still use the old partner-profile discount for live-order acceptance.

Current source confirms it:

- `loadVendorContextForUpdate` selects `channels.partner_profiles.discount_percent` at `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:395-448`.
- `resolveAcceptanceLinesWithClient` loads catalog retail and passes that discount into `mapListingCandidateRow` at `:494-574`.
- `mapListingCandidateRow` calculates `wholesaleUnitCostCents` from catalog retail and discount at `:1147-1185`.
- That acceptance plan feeds `debitWalletWithClient` and immutable economics/audit records elsewhere in the same repository.

Until order acceptance reads and snapshots the same authoritative `.ops` cost contract—or product explicitly chooses a different acceptance contract—the `$8.09` preview cost must not be treated as the amount a vendor will be charged.

## 4. Inventory allocation and the Inventory Exposure screen

### 4.1 The existing Channel Allocation system

The existing engine is not absent. `server/modules/channels/allocation-engine.service.ts:1-20` describes and implements three layers:

1. channel → warehouse assignment;
2. channel/product/variant allocation rule (`mirror`, percentage `share`, or `fixed`, plus floor/ceiling/eligibility);
3. independent parallel channel views with no cross-channel drawdown.

Important current behavior:

- If a channel has no explicit warehouse assignment, it receives all active `operations` and `3pl` fulfillment warehouses (`allocation-engine.service.ts:301-317`, `:418-445`).
- If there is no rule, the default is eligible `mirror` at 100% with no floor/ceiling (`:168-178`).
- The result reports whether warehouse scope was explicit or `legacy_all_active_fallback` (`:124-145`, `:378-382`).
- `ChannelAllocation.tsx:1207-1246` exposes two primary tabs: Warehouse Assignments and Allocation Rules. Its copy tells operators this screen controls which warehouses feed inventory to each channel.
- Current packaging code depends on these assignments to decide which warehouses are enabled for a program.

That is a real, current system. No evidence in this review shows that operators should configure a second live allocation system in addition to it.

#### Confirmed days-of-cover fail-open behavior

The existing engine has a separate correctness defect that matters even if engineering chooses to keep it as the authority:

1. `queryAvgDailyUsage` queries 90 days of WMS outbound activity in base units (`server/modules/channels/allocation-engine.service.ts:58-81`).
2. If that query throws for any reason, the catch block logs a warning, caches `0`, and returns `0` instead of propagating a classified error (`:82-85`).
3. A rule using `floorType === "days"` requests that value (`:465-473`).
4. The effective floor is `ceil(configured days × avgDailyUsage)` (`:625-638`). A query failure therefore makes the effective floor `0`, so positive ATP is published even though the safety floor could not be evaluated.
5. The UI also tells the operator that “No recent sales data” produces a zero-unit floor (`client/src/pages/ChannelAllocation.tsx:664-697`), so a legitimate zero-velocity product and a failed velocity read are not distinguishable in the resulting behavior.

This is **CODE-CONFIRMED** fail-open behavior, not a hypothesis. Until it is changed to a classified unavailable/error state with explicit policy, a days-of-cover rule cannot be treated as an enforced inventory guardrail.

### 4.2 What Inventory Exposure actually is in current mainline

The second screen is a canonical inventory-planning **draft/preview and migration surface**, not a proven replacement operating console:

- It is exposed in primary navigation immediately above Allocation (`client/src/components/layout/AppShell.tsx:220-235`).
- The page itself says `Draft / preview only` and `Legacy runtime retained` (`client/src/pages/InventoryExposure.tsx:356-369`).
- `WarehouseInventorySourceSetup` says it prepares an existing warehouse as a draft and does not move stock, enable publishing, or change live authority (`client/src/components/inventory/WarehouseInventorySourceSetup.tsx:43-100`).
- New publication targets start disabled and can be owned by a normal channel connection or exact Dropship store connection (`client/src/pages/InventoryExposure.tsx:374-430`).
- Source bindings and channel dials are saved as drafts; an empty/missing source scope publishes zero in the proposed model (`InventoryExposure.tsx:534-575`).
- The HTTP surface contains GET view/preview plus draft saves, disabled target creation, and preview-state changes; it contains no route that directly flips global runtime authority (`server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts:36-158`).

The canonical inventory work has a real runtime switch, but it is separate from this page:

- Migration `0638_inventory_availability_cutover.sql:42-70` creates singleton `inventory.availability_runtime_authority` and initializes it to `legacy`.
- `loadAndLockRuntimeAuthority` reads and validates that exact database row for each authority-aware ATP operation (`server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts:87-128`).
- `AuthorityAwareInventoryAtpService` delegates to legacy or canonical logic according to the row (`server/modules/inventory-planning/application/inventory-availability-runtime-atp.service.ts:53-61`, `:159-190`).

**UNKNOWN:** the current production singleton value, revision, and activation run. Source defaults are not proof of current production state.

### 4.3 Why the second screen exists, based on code

It exists to prepare a more explicit future model:

- exact provider destinations, including a specific vendor's Dropship store connection;
- explicit source-node bindings;
- channel/product/SKU policy inheritance;
- exact target/SKU mappings;
- preview/readiness evidence before a canonical authority cutover.

That can be a valid migration architecture. The current product problem is that it is exposed beside the existing operational Allocation page without an operator-facing migration status, authority readout, or instruction that clearly says **do not configure both**. Its current label is technically accurate but insufficient to prevent confusion.

### 4.4 Dropship store connections are not channels

Current code distinguishes these concepts:

- `resolveDropshipOmsChannelIdWithClient` requires exactly one active internal/manual channel named `Dropship OMS` for order intake (`server/modules/dropship/infrastructure/dropship-order-intake.repository.ts:313-392`).
- Each vendor marketplace account is a `dropship.dropship_store_connections` row (`shared/schema/dropship.schema.ts:386-445`).
- A store-specific listing is unique by `(store_connection_id, product_variant_id)` (`shared/schema/dropship.schema.ts:1265-1330`).
- The canonical eBay inventory transport is keyed to an exact `dropshipStoreConnectionId`, validates its vendor/provider/account identity, and accepts an already-planned absolute quantity; it never calculates ATP, allocation, or warehouse scope (`server/modules/dropship/infrastructure/dropship-ebay-inventory-publication.adapter.ts:35-215`).

Therefore, multiple vendors can have their own store connections and listings while sharing the one internal Dropship OMS allocation dial/channel. The store connection is the exact provider destination; it is not another channel allocation policy.

**Confirmed schema limitation:** `dropship_store_conn_active_vendor_idx` at `shared/schema/dropship.schema.ts:428-436` allows only one active-like store connection per vendor across connected/reauth/refresh-failed/grace/paused states. If the product requirement is one vendor operating multiple active stores or platforms, the current schema does not support it and needs a deliberate redesign. If the requirement is merely many vendors connected under the same Dropship OMS channel, current schema supports that.

### 4.5 Confirmed Dropship quantity inconsistency

Current listing selection does not call the existing channel allocation result:

1. `InventoryServiceDropshipAtpProvider.getVariantAtp` calls `inventoryAtpService.getAtpPerVariant(productId)` at `server/modules/dropship/infrastructure/dropship-atp.provider.ts:10-52`.
2. Under legacy runtime authority, `AuthorityAwareInventoryAtpService.getAtpPerVariant` delegates to network-level legacy ATP; under canonical authority it projects network ATP (`inventory-availability-runtime-atp.service.ts:171-175`).
3. `evaluateDropshipVendorCatalogSelection` calculates marketplace quantity from that raw/network ATP and optional `marketplaceQuantityCap` (`server/modules/dropship/domain/vendor-selection.ts:52-66`, `:119-141`).
4. The repository reads `marketplace_quantity_cap`, but a repository-wide `origin/main` search found no customer/admin route or form that writes this field. The schema and evaluation support a cap; the current exposed management path is unproven/incomplete.
5. The existing channel-aware read is a different method: `getAtpForChannel(productId, channelId)` at `inventory-availability-runtime-atp.service.ts:178-190`. Dropship selection does not use it.
6. The eBay publication adapter cannot correct this because it receives an absolute desired quantity and intentionally does not read allocation data.

This does **not** prove the currently displayed quantity is numerically wrong for the test SKU. It proves that the displayed/listing quantity is not explained by the existing Channel Allocation result.

### 4.6 Decision required: intended Dropship quantity contract

Engineering/product must select one contract and encode it in one resolver:

**Option A — network ATP per vendor, capped per vendor**

```text
network ATP -> vendor selection/exclusion -> vendor/store cap -> listing quantity
```

This matches the current Dropship selection code. It means Channel Allocation does not constrain Dropship listing quantity, even though packaging and the admin UI treat Dropship OMS as a normal fulfillment program.

**Option B — Dropship program allocation first, vendor/store refinement second**

```text
warehouse ATP -> Dropship OMS warehouse/rule allocation
              -> vendor selection/exclusion
              -> vendor/store cap
              -> listing quantity
```

This reuses the existing allocation engine as the program-level authority and treats vendor/store records as exact destinations/refinements. It is the more consistent model if Channel Allocation is supposed to govern Dropship exposure.

**No third allocator should be added.** If Option B is selected, the work is an adapter/orchestration correction plus tests and migration/readiness UX—not a new allocation engine.

### 4.7 Recommended disposition before further build-out

1. Freeze new Inventory Exposure UI features.
2. Read the production `inventory.availability_runtime_authority` singleton, activation lineage, and current publication gates in a read-only transaction.
3. Trace one test SKU end to end: per-warehouse ATP → Channel Allocation result → Dropship selection/cap → listing preview quantity → queued snapshot → exact store publication request.
4. Decide Option A or B above and record the product rule.
5. While runtime remains legacy, remove Inventory Exposure from normal navigation or gate it behind an explicit migration-lab permission/feature flag. Keep its data and code until dependency/cutover review is complete.
6. If canonical authority is already live, stop and produce a formal migration/retirement plan for Channel Allocation and every consumer—including packaging—before changing either UI.
7. Show the current runtime authority and migration state on the authoritative allocation admin surface. Operators must not infer it from two menus.
8. Do not delete legacy or canonical tables until a dependency trace proves they are unused and rollback/audit requirements are satisfied.

## 5. Updated end-to-end testing plan

Every step below requires an evidence value. A screenshot alone is insufficient for financial/inventory/provider writes; capture the relevant database ID, provider ID, job ID, audit ID, or sanitized log reference.

### Phase 0 — establish the deployed baseline

**Gate:** no functional test begins until the exact code/config/schema baseline is known.

- [ ] Record production release ID, full Git SHA, deploy timestamp, and process restart timestamp.
- [ ] Confirm migrations `0657`, `0659`, `0660`, `238`, `239`, `241`, `243`, `244`, and `246` are applied exactly once.
- [ ] Read `inventory.availability_runtime_authority`: authority, revision, activation run, changed by/reason/time.
- [ ] Read Dropship shipping runtime mode and confirm no intentional `legacy` override remains.
- [ ] Capture the Dropship OMS channel ID and verify name/type/provider/status match `Dropship OMS` / `internal` / `manual` / `active`.
- [ ] Capture the test vendor numeric ID, store numeric ID/UUID, verified eBay account ID/display name, status, setup status, and configured warehouse(s). Do not capture tokens.
- [ ] Export a sanitized read-only snapshot of Channel Allocation warehouse assignments/rules for Dropship OMS.
- [ ] Export a sanitized read-only snapshot of current program packaging policy, suite revisions, warehouse availability, and pricing-program assignments for the test warehouses.
- [ ] Record any legacy packaging assignment or implicit warehouse-stock fallback still affecting those warehouses.

**Stop if:** deployed SHA/schema cannot be reconciled, runtime authority is missing/invalid, or the test account/store identity is ambiguous.

### Phase 1 — prove eBay authorization stability

**Gate:** listing setup remains usable through a normal token renewal without repeated consent.

- [ ] Open Catalog → eBay listing setup for `marzcards` without authorizing again.
- [ ] Use **Refresh options** and record success/failure, support reference, HTTP classification, resource, and timestamp from sanitized logs.
- [ ] Verify Inventory locations, Account policies, and Store categories can all be read.
- [ ] Verify saved defaults/overrides remain visible during one simulated or naturally occurring transient provider read failure.
- [ ] Exercise a controlled safe-read repair of a rejected access token in non-production or with an expired test token; verify only one refresh generation is created under concurrency.
- [ ] Allow/trigger one normal background consumer renewal, then reopen listing setup and refresh again.
- [ ] Verify the connection is not moved to `needs_reauth` for timeout, 429, 5xx, or persistent resource permission errors.
- [ ] If consent is genuinely required, authorize once, capture why the token owner classified it that way, and repeat the full stability check.

**Pass evidence:** before/after credential metadata (references redacted), one refresh audit/log sequence, and successful post-renewal listing setup.

**Stop if:** another consumer narrows/replaces the token incorrectly or the vendor must repeatedly consent.

### Phase 2 — identity, entitlement, catalog selection, and cost

- [ ] Reconfirm the `.ops` entitlement resolves to the expected member/subscription/plan and includes Dropship.
- [ ] Reconfirm `ARM-ENV-SGL-P50` is active, sellable, Dropship-eligible, and narrowly exposed by admin policy.
- [ ] Confirm the vendor selection rule that includes it and excludes unrelated rows.
- [ ] Capture product ID, variant ID, units per sellable pack, selection-rule revision, and listing/store IDs.
- [ ] Verify the product cost returns 809 cents with exact plan/override provenance in a read-only trace.
- [ ] Verify unavailable/ambiguous cost blocks cost-based pricing; it must never become zero.
- [ ] Determine whether a quantity cap is required. If yes, first implement/prove an audited, revision-safe management path; do not edit the database ad hoc.
- [ ] Trace the preview quantity against the selected allocation contract from section 4.6.

**Stop if:** the preview quantity cannot be explained from recorded ATP/allocation/cap evidence or cost authority is ambiguous.

### Phase 3 — eBay business policies

- [ ] Save store default fulfillment, return, and payment policies; verify both setup and listing tables refresh without a hard browser reload.
- [ ] Confirm Ground Advantage policy using eBay code `USPSParcel` is compatible.
- [ ] Save one listing-specific override, cancel one unsaved edit, and restore the listing to inheritance.
- [ ] Bulk-assign policies to multiple test rows and verify unselected rows remain unchanged.
- [ ] Verify saved state remains visible through a transient eBay read failure and cannot be edited/published until live verification recovers.
- [ ] Generate a new preview after every policy revision.
- [ ] Capture policy IDs, local revisions, audit IDs, and the effective policy IDs in the frozen listing intent.

**Scale follow-up:** test UI rendering with 1,000+ selected listings, but separately profile the current broad server/read path. Do not interpret 50 mounted rows as server-side scalability.

### Phase 4 — price, content, and preview fidelity

- [ ] Configure one store pricing rule with known exact expected cents and apply it through review/adoption.
- [ ] Verify percent-only, flat-only, combined, optional `.99` rounding, a group override, priority conflict, and missing-basis blocker.
- [ ] Verify one inline fixed exception, modal/table agreement, Reset/default/rule restoration, reload, and stale-tab conflict.
- [ ] Verify images, title, category, item specifics, condition, SKU/pack size, product cost, catalog reference retail, listing price, effective policies, and quantity are present in the preview.
- [ ] Edit description prose, Save, Cancel, and Reset. Verify product facts remain a separate read-only section and are not appended to the authored description.
- [ ] Test store introduction/footer and one group template without generating per-listing writes.
- [ ] Confirm every price/content/policy change invalidates the prior publication preview and requires a new review.
- [ ] Record the exact preview/content/pricing hashes and local revisions that will be carried into queueing.

**Deferred, not a blocker for one dogfood listing:** suggested price and automated/live price-only repricing.

### Phase 5 — box catalog and suite ownership

- [ ] Read all `Box LxWxH` rows after migration 246. Verify inner inches display exactly as names intend (for example 10 × 8 × 4) and capture any skipped row/reason.
- [ ] Verify inner/outer validation, tare, maximum weight, cost cents, fill factor, active state, and branding on representative box/mailer/envelope types.
- [ ] Bulk-change branding and confirm suite membership and warehouse availability do not change.
- [ ] Create/duplicate/edit/archive/restore a suite. Confirm revisions are immutable and usage prevents unsafe archival.
- [ ] Change suite membership and verify warehouse availability does not change automatically.
- [ ] Verify imported/legacy suites are clearly labeled and produce a retirement list.
- [ ] Correct `docs/WAREHOUSE-PACKAGING-ADMIN.md` to match current ownership before asking another operator to use it.

### Phase 6 — two-warehouse program packaging

Use at least two warehouses to prove the design the UI is supposed to support.

- [ ] In Channel Allocation, explicitly enable Warehouse A and Warehouse B for Dropship OMS. Do not rely on the all-fulfillment-warehouses fallback.
- [ ] In each warehouse's Packaging tab, make a controlled set of catalog boxes physically available. Give the warehouses different availability.
- [ ] Create a white-label Dropship suite and a graphic main-store suite from catalog items.
- [ ] Set the Dropship OMS program default to the white-label suite with `unbranded` requirement.
- [ ] Add one warehouse suite exception only if Warehouse B genuinely needs a different suite.
- [ ] Verify the effective boxes at each warehouse equal: active/reviewed ∩ suite members ∩ warehouse availability ∩ branding requirement.
- [ ] Verify an enabled warehouse with no usable box blocks configuration/quote/packing; it must not silently choose another suite.
- [ ] Verify disabling a warehouse in Channel Allocation removes it from the program packaging editor without changing its physical packaging availability.
- [ ] Verify Dropship and Shopify/main-store policies can use different suite/branding rules at the same warehouse.
- [ ] Verify program packaging and pricing are independent: changing one does not mutate the other.
- [ ] Verify stale revisions and concurrent saves fail atomically and preserve retry identity/audit.

**Scale test:** measure initial payload, search latency, render time, and save time at the expected maximum warehouse/box counts. Current code has client-side overview paging, not proven server-side fleet scale.

### Phase 7 — shared shipping estimate

- [ ] In the deployed portal, estimate 1, 2, and 5 packs of `ARM-ENV-SGL-P50` to US/PA/16046.
- [ ] Compare results to the currently active pricing-program/rate revision; do not hardcode the historical 719/719/925 expectations if configuration has changed.
- [ ] Confirm quantity changes clear the stale total before the next response.
- [ ] Confirm missing state, missing weight, missing origin, missing rate coverage, and unavailable packaging fail with customer-safe messages.
- [ ] Confirm the response and UI contain no base charge, markup, insurance, dunnage, warehouse, box, rate-table, rate-book, or internal warning fields.
- [ ] Confirm estimate is read-only: no snapshot, wallet, reservation, order, listing, or carrier write.
- [ ] Confirm the actual order quote uses the same provider/configuration decision as preview, while persisting private calculation evidence server-side.

### Phase 8 — allocation and quantity truth test

This phase must pass before queueing the listing.

- [ ] Record runtime authority and selected contract (Option A or B).
- [ ] For the test SKU, capture base/variant ATP per Warehouse A and B.
- [ ] Capture the Dropship OMS allocation result, warehouse scope source, rule scope/mode, floor/ceiling, and warehouse breakdown.
- [ ] Capture admin exposure decision, vendor rule decision, optional cap, and final portal quantity.
- [ ] Verify the final quantity equals the documented resolver formula exactly.
- [ ] Verify no visible Inventory Exposure draft changes the live result while runtime is legacy.
- [ ] If canonical authority is under evaluation, compare its preview to an immutable legacy input; do not change authority as part of dogfood.
- [ ] Verify the queued listing snapshot freezes the reviewed absolute quantity and exact store destination.

**Stop if:** any step uses an unexplained fallback, raw quantity is copied past the selected authority, or the same physical supply is presented contrary to the selected product contract.

### Phase 9 — one live eBay listing

Only one SKU/variant is in scope for the first live write.

- [ ] Generate a fresh preview after all prior revisions.
- [ ] Verify title, images, description, item specifics, category, price, quantity, location, and all business policies against the reviewed intent.
- [ ] Complete required MFA and queue exactly one listing with a new idempotency key.
- [ ] Capture listing push job ID, request hash, queue audit ID, worker attempts, final status, and sanitized provider responses.
- [ ] Capture the persisted local listing ID, eBay inventory item key/SKU, offer ID, and external listing ID.
- [ ] Read the live eBay listing and compare all fields to the frozen intent.
- [ ] Retry only if the job state and idempotency evidence prove it is safe. Do not blindly create a second offer/listing.

**Stop if:** provider success is not mapped to a durable local external identity, quantity differs, or auth becomes unstable.

### Phase 10 — marketplace order, acceptance, wallet, OMS, and WMS

**Prerequisite:** reconcile preview `.ops` cost with acceptance/wallet cost first.

- [ ] Place one controlled marketplace order for the published listing.
- [ ] Capture external order/line IDs and buyer-selected shipping service from the provider payload.
- [ ] Verify order intake creates exactly one row under the correct vendor, store connection, Dropship OMS channel, listing, and variant.
- [ ] Replay the intake and prove idempotency/no duplicate OMS order.
- [ ] Produce/persist the shipping quote snapshot for the actual destination/items.
- [ ] Verify acceptance snapshots the exact `.ops` product cost source/revision/evidence chosen by the approved contract.
- [ ] Verify wallet hold/debit total in integer cents: product cost + authoritative fulfillment shipping charge + any other explicitly approved charge. No UI preview value may authorize the debit.
- [ ] Capture wallet account/ledger IDs, before/after balances, economics snapshot, request hash, actor, and audit IDs.
- [ ] Verify insufficient funding enters the intended hold/failure state without partial inventory/order/ledger writes.
- [ ] Verify one OMS order and WMS order are created with exact line identity, quantities, warehouse, cost, and destination.
- [ ] Verify reservation/claim behavior uses the active inventory authority and is concurrency-safe.

**Stop if:** product cost authorities differ, buyer shipping choice is lost contrary to product requirements, balance/inventory is ambiguous, or any retry is not idempotent.

### Phase 11 — packing, label, tracking, notifications, and return

- [ ] Resolve the actual warehouse and effective packaging suite for the accepted order.
- [ ] Confirm the chosen box was active, reviewed, in the effective suite revision, physically available at that warehouse, and branding-compatible at confirmation time.
- [ ] Capture pack plan/parcel IDs, box ID/revision, package dimensions/weight, and packaging confirmation audit.
- [ ] Create/purchase the label through the intended shipping provider and capture shipment/label identity without exposing credentials or private rate logic.
- [ ] Verify WMS/OMS shipment state and physical inventory transitions once—no double decrement.
- [ ] Push tracking to the exact eBay store/order and verify customer-visible carrier/tracking.
- [ ] Verify retries do not duplicate shipments or tracking events.
- [ ] Verify required vendor/internal notifications and their retry state.
- [ ] Execute the agreed return path: request, policy/fault classification, receipt/inspection, disposition, inventory treatment, vendor credit/debit, and audit.

### Phase 12 — exit and scale validation

- [ ] Review all support references, warnings, skipped migrations, legacy fallbacks, and manual interventions from the run.
- [ ] Reconcile eBay listing/order, Dropship intake, wallet/economics, OMS, WMS, shipment, tracking, and return identities into one evidence chain.
- [ ] Run catalog/policy/pricing/packaging read paths at realistic 1,000-listing and warehouse-fleet sizes and record latency/payload/memory.
- [ ] Verify there is one operator-visible authority for allocation, one for program packaging, and no contradictory help text.
- [ ] Update the old dogfood checklist with evidence or archive it in favor of a maintained runbook.
- [ ] Obtain engineering, QA, product, operations, and finance sign-off for the behaviors in their authority.

## 6. Hard stops before live listing/order

| ID | Condition | Why it stops the run |
| --- | --- | --- |
| HS-01 | Reauthorization recurs without an `invalid_grant`/missing/expired grant classification. | Store operation is not durable and repeated consent hides the actual failure. |
| HS-02 | Production runtime authority is unknown or invalid. | ATP/reservation/publication cannot be explained. |
| HS-03 | Dropship listing quantity cannot be traced to the selected allocation contract. | Oversell/undersell risk. |
| HS-04 | No explicit Dropship warehouse assignment and the engine uses `legacy_all_active_fallback`. | Warehouses may contribute inventory unintentionally. |
| HS-05 | Preview `.ops` cost and acceptance/wallet cost use different authorities. | Direct financial-loss and audit risk. |
| HS-06 | Effective package is not provably in the suite, available at the warehouse, active/reviewed, and branding-compatible. | Fulfillment may be impossible or violate white-label requirements. |
| HS-07 | Customer API/UI exposes internal rate/fee construction. | Commercially sensitive pricing logic is leaked. |
| HS-08 | Shared shipping cannot rate the actual item/destination or silently falls back to legacy. | Vendor charge is missing or comes from the wrong authority. |
| HS-09 | Live provider success has no durable local listing/offer identity. | Retry can duplicate or orphan marketplace state. |
| HS-10 | Buyer-selected service is required by product behavior but is lost before execution. | Fulfillment can violate the buyer promise. |
| HS-11 | Any wallet, inventory, order, shipment, or tracking retry lacks idempotent evidence. | Duplicate financial or physical side effects. |
| HS-12 | A days-of-cover allocation rule is active while velocity lookup failures resolve to zero. | The configured safety floor can silently fail open and expose inventory. |

## 7. Engineering review questions requiring explicit answers

1. **Allocation contract:** Is Dropship marketplace quantity network ATP per vendor, or Dropship OMS channel allocation followed by vendor/store refinements?
2. **Runtime authority:** What is the current production `inventory.availability_runtime_authority` row, and is a canonical cutover actually scheduled?
3. **UI disposition:** Should Inventory Exposure be hidden/gated as a migration tool until canonical activation, or is Channel Allocation scheduled for replacement? What is the migration and rollback plan?
4. **Warehouse fallback:** Is “all fulfillment warehouses when none assigned” acceptable for Dropship, or must Dropship fail closed until at least one warehouse is explicit?
5. **Store cardinality:** Is one active store per vendor intentional? If vendors need multiple simultaneous marketplace stores, change the schema/ownership contract deliberately.
6. **Quantity-cap ownership:** Who can set per-vendor/per-store quantity caps, at what scope, with what audit/revision semantics? Current code reads a cap but no exposed writer was found.
7. **Velocity failure policy:** Must a days-of-cover rule fail closed, retain the last independently timestamped valid velocity, or block publication when velocity is unavailable? Returning zero for both “no sales” and “query failed” is not an auditable contract.
8. **Cost authority:** Must order acceptance charge the exact Shellz Club `.ops` price shown in preview? If yes, what evidence is frozen and how are concurrent plan/override changes handled?
9. **Packaging edit surface:** Which one location owns program default/warehouse suite exceptions? Other pages should display the resolved policy rather than duplicate the editor.
10. **Legacy packaging exit:** Which live rows still rely on `shipping.packaging_assignments` or implicit `box_warehouse_stock` fallback, and when can each be retired?
11. **Scale target:** What are the contractual maximum listings, warehouses, boxes, suites, program exceptions, and vendor stores? Current client-loaded overview patterns and 1,000-item command bounds must be tested against that number.
12. **Shipping-service execution:** Must the buyer-selected eBay service constrain OMS/WMS/label execution? Current normalized path does not prove that behavior.
13. **Deferred pricing work:** When do suggested prices and price-only marketplace update/reconciliation become required? They are not part of the current first-live-listing path.

## 8. Recommended engineering review order

1. **Read-only production baseline:** deployed SHA, migrations, runtime authority, Dropship OMS channel, store identity, allocation, packaging, pricing.
2. **Inventory quantity trace:** one SKU through warehouse ATP, channel allocation, vendor selection, preview, queue, and provider destination.
3. **Financial trace:** `.ops` product cost through pricing preview and live-order acceptance/wallet plan.
4. **Packaging trace:** one program across two warehouses, different physical availability, default suite plus one exception, then cartonization/quote.
5. **eBay credential trace:** one normal renewal across all consumers and listing setup.
6. **UI consolidation:** remove/gate misleading Inventory Exposure navigation; select a single program-packaging editor; update stale documentation.
7. **Controlled live listing:** one SKU only after the above traces pass.
8. **Controlled order lifecycle:** one order with full immutable evidence.

## 9. Recent mainline change map

These commits are merged into the inspected `origin/main`; merge presence is not proof of production deployment or acceptance.

| PR | Merge commit | Implementation area |
| ---: | --- | --- |
| #1374 | `8785bc758` | eBay Ground Advantage mapping and store/listing policy assignments |
| #1375 | `552fe1dde` | policy save/cache synchronization without browser hard refresh |
| #1381 | `deaec38fe` | rich listing preview and shipping estimates |
| #1386 | `4f282048e` | persisted listing-price editor |
| #1390 | `66e64a929` | shared eBay token lifecycle and safe read recovery |
| #1394 | `445efdc70` | Shellz Club `.ops` product cost and inline price editing |
| #1401 | `bbb052ea3` | versioned rule-based listing pricing and bulk adoption |
| #1407 | `3a1505911` | vendor description drafts and templates |
| #1410 | `a2c1f886e` | simplified description Edit/Reset actions |
| #1415 | `447447ed2` | catalog facts separated from vendor description |
| #1419 | `bb6dc64ea` | saved eBay policy display decoupled from live discovery |
| #1422 | `5f4543431` | shared shipping engine as estimate authority; private breakdown removed |
| #1427 | `75c6159db` | shared pricing-program charges and reusable box suites |
| #1432 | `a36020e9b` | channel/warehouse packaging policies |
| #1435 | `ffd665523` | warehouse-owned packaging availability and bulk workflow |
| #1440 | `b6aaa8cbc` | exact dimension precision across catalog/packing |
| #1442 | `1b61a9191` | owner-confirmed legacy named-box correction; final migration prefix fixed by `4e262de2d` |
| #1447 | `2a528c32a` | current packaging authority separation and UI untangling |

## 10. Risks and explicitly unproven claims

- The exact production release SHA is **UNKNOWN**.
- The production migration ledger and number of dimension rows corrected/skipped are **UNKNOWN**.
- Production inventory runtime authority is **UNKNOWN**.
- No sustained post-deploy eBay token-renewal acceptance has been recorded.
- No post-deploy shipping-estimate UI evidence has been recorded after the shared-engine/privacy fix.
- No complete post-deploy packaging acceptance has been recorded after PR #1447.
- No live eBay listing/offer ID has been recorded from this dogfood run.
- No live marketplace order lifecycle has been tested.
- The `$8.09` preview cost is not yet the proven wallet-debit cost.
- The intended Dropship allocation contract has not been selected.
- Days-of-cover allocation currently fails open when its velocity query throws; no separate stale/unavailable/error state exists in that path.
- A customer/admin writer for `marketplace_quantity_cap` was not found in current `origin/main`.
- One vendor cannot currently have multiple active-like store connections because of the partial unique index.
- Legacy packaging assignment and warehouse-stock compatibility still affect the read model until proven otherwise.
- Program packaging has two editable UI entry points using one underlying authority.
- The tracked warehouse-packaging guide conflicts with current UI ownership.
- Packaging UI behavior beyond the tested 100-warehouse fixture has not been proven at production scale.
- Suggested price and live price-only repricing/reconciliation are not implemented in the current release boundary.
- Buyer-selected eBay shipping service is not proven to survive normalized intake through execution.

## 11. Evidence to return to this handoff

The reviewing team should append or link a dated evidence package containing:

- production SHA/release and migration ledger;
- sanitized runtime-authority row and activation lineage;
- Dropship OMS channel, warehouse assignments, allocation rules, and one-SKU allocation output;
- test vendor/store/listing identifiers;
- eBay token-renewal/support-reference trace without credentials;
- product-cost provenance and reconciled acceptance-cost snapshot;
- pricing profile/revision and expected/actual listing cents;
- policy IDs/revisions and frozen listing intent;
- box/suite/warehouse/program policy revisions and effective eligibility output;
- shipping estimate and private server-side quote evidence;
- listing job/audit/provider/local mapping IDs;
- order intake, wallet, economics, OMS, WMS, reservation/claim, shipment, tracking, notification, and return IDs;
- measured scale results and any accepted limits;
- signed answers to the thirteen review questions in section 7.

## 12. Documentation and validation performed for this handoff

This was a documentation-only pass. No application code, database row, provider account, marketplace listing, credential, pricing configuration, packaging configuration, inventory state, wallet, order, or deployment was changed. No automated application test suite was rerun because no runtime code was modified. Source conclusions were checked against the current remote-tracking mainline and the specific files/functions cited above.
