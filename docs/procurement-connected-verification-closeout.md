# Connected procurement verification, permissions and cost-read performance

> October 27 follow-up: the AP common-snapshot gap described below is now fixed and verified against current main. See [the new closeout](procurement-ap-summary-snapshot-closeout.md). The October 25 measurements and results retain their original source attribution.

## Scope and baseline

The review started at main `719b60983453a5723f27d224953a536f30502b57`, after the reported deployment of PR #1912. Main `0550f2856de213a65c4a91418d031aaf25bcbfd2` and then `1ddaf0470` were merged, producing validation base `7b4a6e941060c3afeeab6e04e0a951b06e43b9e3`. A final fetch found main `31043e158a696fb1506d211be074e8e9bd8cf25b` with the shared monetary-read correction; merge `e18b7fd321de5081544c8e63c2d02a95a4494eba` preserves both batched allocation evidence and its strict integer-cents reader. Earlier passing results remain evidence for their recorded sources; final combined-source results are identified separately below. The shipment editor registration and `executeLineBatchInTransaction` service entry point are retained. This batch contains no SQL migration or historical repair.

The remaining acceptance work in `procurement-numbering-clock-closeout.md` was connected browser/HTTP recovery with an active quantity ledger, non-admin authority/navigation, and synthetic-volume cost/health reads. This report distinguishes those tests from production acceptance and from the separate historical record queue.

## Reproduced permission defects and corrections

The initial PostgreSQL-backed sessions reproduced a picker with valid receiving/purchasing grants reading the APIs while seven corresponding browser routes redirected to picking. A view-only receiver saw enabled quantity, location and receipt-state controls while the APIs returned 403 without business writes. Receiving adjustment permission also exposed vendor/catalog creation controls, and shipment/invoice lists exposed creation without the API's separate creation grant.

The source trace then found the same legacy role gate on AP summary/payments, supplier-credit/return list/detail, and PO new/edit routes. Their owners are explicit: read routes use purchasing:view; PO creation requires purchasing:create; saved draft editing requires purchasing:edit. The dashboard combines inventory:view diagnostics with purchasing:view financial reads. Its auto-draft POST additionally requires the admin role and inventory:adjust. These are code-derived contracts, not assumptions about production role assignments.

The corrections use those existing owners:

- client/src/lib/procurement-access.ts declares shared read descriptors used by App.tsx:ProtectedRoute and AppShell.tsx. The sidebar retains the original named-child-grant and child-role fallback for unrelated modules. Unconfigured children still inherit their parent's role rule. The optional reorder-label settings query also requires its API's purchasing:view grant.
- Receiving.tsx gates receipt quantity/location/settings mutations with the existing receiving-entry adjustment capability. Vendor and catalog creation retain distinct purchasing:create and inventory:create grants. A catalog-only creator can create metadata without linking or changing a receipt. Quarantine and reversal approval owners remain separate.
- PO new/edit routes require purchasing:view plus their respective create/edit action. Catalog visibility remains optional for non-product purchases. PurchaseOrders.tsx:poHref, PurchaseOrderDetail.tsx's draft redirect and DailyBuyingReview.tsx retain read-only users on purchase detail. Draft line/header editing requires purchasing:edit. A create-only buyer returns to detail after saving instead of being sent into a denied editor.
- Shipment, invoice and PO-detail invoice creation controls and handlers require purchasing:create. The duplicated PO header invoice initializer now calls its existing shared dialog function; its amount/date initialization is preserved.
- PurchasingDashboard.tsx requires both read grants and exposes auto-draft only to the exact existing role-plus-adjustment capability. ExclusionRulesModal.tsx keeps review available and independently gates exclusion/automation changes with inventory:adjust. PurchasePlanningPolicyEditor.tsx gates stock/growth changes with purchasing:edit. Every changed mutation handler rechecks its grant; the server remains authoritative.

The connected suite asserts actual-session API access/denial, UI navigation and unchanged persisted business evidence. Its non-lead creator has purchasing:view/create without edit or inventory:view; the new case submits a fee PO through the actual UI/command and checks its durable result and read-only return. Separate cases cover a non-lead editor, draft reader and AP work-list reader. The mocked planning cases isolate read-only, adjustment-only and policy-edit permissions; sidebar rendering tests preserve pre-existing named grants and parent-role inheritance. Final results and their source boundaries are recorded below.

The connected dashboard check also reproduced a server-side authority difference: `/api/purchasing/auto-draft/run` rejected a non-admin, while `/api/purchasing/auto-draft-run` accepted the same session and persisted a run. `server/jobs/auto-draft.job.ts:runAutoDraftJob` delegates to `startAutoDraftJob`; these are two entry points to the same operation. Both repository UI callers use the former endpoint and its existing administrator requirement. A shared HTTP guard in `purchasing-recommendation.routes.ts` now applies that same requirement after `inventory:adjust` on both endpoints, using the authenticated session identity for the trigger actor. Administrator response contracts remain synchronous HTTP 200 and asynchronous HTTP 202 respectively. Legacy callers without the administrator role now receive HTTP 403 with `AUTO_DRAFT_ADMIN_REQUIRED`; external legacy callers were not inspected. Scheduler entry points are unchanged. Denial tests assert that neither job entry is called, and the connected case requires unchanged run/business evidence.

## AP summary availability

`client/src/pages/APDashboard.tsx:APDashboard` previously rendered default zero balances and empty activity when its summary query failed. The page now validates the complete response with `shared/procurement/ap-summary.ts:apSummarySchema`, including safe integer cents/counts, aging buckets and activity rows. A failed, missing or malformed response shows an unavailable state with an explicit retry; a failed background refresh also hides stale financial cards. Valid zero balances remain valid evidence. Existing integer-based payment formatting is reused, and vendor sorting copies the response array instead of mutating query data.

The schema unit cases cover missing/invalid money and counts, unsafe values, complete zero summaries and supported nullable legacy fields. The browser recovery case exercises HTTP failure, null/malformed success responses, verified balances, a failed cached-page refresh and a successful retry to a verified zero summary. It asserts that these reads and retries do not issue mutations. Final run results are recorded below.

The incoming shared monetary reader also exposed pre-submission exceptions in `APInvoices.tsx:handleCreate` and the discount, tax and shipping controls in `PurchaseOrderDetail.tsx`. Their amount conversion happened before the mutation error boundary. The existing `exact-money-input.ts` adapter now delegates to the canonical `dollarsToCents` converter and classifies its known range errors before either form submits. Invalid amounts retain the draft and show validation feedback without an HTTP mutation or uncaught page exception; a corrected amount uses the existing mutation. Signed values, blank-as-zero charge policy, separators and the converter's established sub-cent truncation remain unchanged. Unexpected exceptions are not disguised as invalid money. Unit and desktop/mobile form cases verify both rejection and correction.

## Missing shipment allocations remain unknown

After the monetary-read integration, the real connected navigation check reproduced HTTP 500 from the shipment detail endpoint with `allocatedCents: invalid cents amount`. `shipment-tracking.service.ts:getEnrichedLines` intentionally represents unrecorded allocation categories and totals as null, but `allocatedCentsPerUnitMills` sent those nulls to the strict present-money reader. That helper now returns null for null/undefined before reading an amount. An explicitly recorded zero still produces zero; malformed or unsafe present amounts still throw the canonical money error. The existing `formatMillsOrDash` and allocation cells therefore retain the dash for unknown values without inventing cost evidence or changing any financial record.

Nine public `getEnrichedLines` cases cover absent amounts, explicit zero and malformed/unsafe values, including assertions that no line/allocation writer is called. The final connected viewer/picker navigation cases pass against the actual endpoint in both browser projects. This corrects a display-read integration defect; it does not mark an allocation or posting complete.

## CI graph-registration work

The final guard rerun exposed repeated source parsing inside `dropship-browser-features.test.ts`'s injected-entrypoint registration case: each of twelve feature groups called the same dependency traversal without its existing optional edge cache. That case now shares a single parsed-edge map for its immutable source snapshot while retaining an independent visited set and every per-group assertion. The production API is unchanged; `browser-suite-impact.d.mts` now declares the existing optional fourth argument, matching the runtime implementation and the other declaration file.

A complete-set comparison proved identical closures and injected HTML roots for all twelve groups. Parsed files fell from 1,060 to 472 and read calls from 2,145 to 1,557. A focused diagnostic run passed all 36 cases; the final official guard lane passed all 420. No test assertion or timeout was relaxed. The local diagnostic timings do not establish hosted CI latency.


## Catalog variant validation and recovery

The PostgreSQL-backed `catalog-validation.spec.ts` baseline reproduced three failures through the authenticated receiving endpoint:

- `ZERO-C0` returned HTTP 200 and created a parent product and a variant with `unitsPerVariant: 0`.
- `TOO-LARGE-C2147483648` returned HTTP 500 when the variant insert failed, but retained the newly created parent product.
- A test-only PostgreSQL trigger rejecting a valid `ROLLBACK-C7` variant insert also left its parent product behind.

`server/modules/procurement/receiving.service.ts:ReceivingService.createVariantFromLine` now validates the parsed factor with `shared/procurement/unit-quantity.ts:toBasePieces(1, unitsPerVariant)` before any catalog read or write. The shared quantity owner rejects zero, non-integer and out-of-range factors; this command maps its error to HTTP 400. The same transaction retains `lockReceivingLineAndOrder` through parent lookup/creation and variant creation. `server/modules/catalog/catalog.storage.ts:getProductBySku` accepts the transaction executor; the existing `createProduct`, `createProductVariant` and `prepareVariantInventoryTracking` owners use that same executor, so a failed variant insert rolls back its newly created parent.

The response still returns the line, product, variant and `requiresUnitConfirmation: true`. Catalog creation does not link the receipt or change its counts. The focused three-case rerun proved that both invalid factors return 400 on repeated attempts with unchanged catalog/receipt/stock evidence; the injected variant failure leaves no parent; retry creates one parent and variant; and a duplicate retry returns 409 without further writes. The baseline is retained in `connected-1792961928153.log` and the passing focused rerun in `connected-1792962052060.log` under the primary output directory. These are focused local results, not the final combined-suite result.

The catalog admission trigger `inventory.pin_cutover_writer_admission` in migration `236_inventory_cutover_admission.sql` uses `FOR SHARE NOWAIT`. An admission refusal therefore aborts this transaction instead of waiting behind the cutover owner while retaining receipt/product locks. This source review does not claim a tested live cutover race or global product-family SKU uniqueness; the fixture's active-variant SKU uniqueness guard is a separate constraint.

## Connected workflow evidence

`test/connected/procurement/server.ts` starts real Express, login/session storage, HTTP routes, procurement owners, inventory services and the active quantity ledger against a unique disposable PostgreSQL database. The built application runs in desktop and mobile browser projects. No business response is substituted. External inventory-channel dispatch is explicitly inert; providers, schedulers and the complete production migration/bootstrap sequence are outside this harness.

`receiving-recovery.spec.ts` submits actual case quantities, lets Add Line or Finalize commit, then drops only the response delivery. It checks recovery/reload/replay, one entry audit, one receipt stock posting and the exact 25-piece stock increase from five five-piece cases. `authority.spec.ts` covers read-only controls, draft actions, a grant revoked and restored around pending recovery, session expiry and real login, copied request keys and a different actor, and separate vendor/catalog creation grants. Stored request body/key and resulting quantities remain part of the assertions.

`navigation.spec.ts` follows PO to shipment Costs to freight invoice and back, and a shared goods invoice to a second PO while preserving the original purchase anchor. It verifies reload/back/forward, list/detail API access, sidebar links, no unexpected HTTP 5xx/page exceptions, and unchanged PO/shipment/invoice/payment/credit/inventory evidence. Goods and freight use distinct valid document ownership fixtures.

The fixture installs actual schema columns and selected owner migrations/constraints. It is deliberately not a full release migration replay. No test is claimed as live deployment acceptance, external-provider delivery proof, or exhaustive financial approval coverage.

The catalog scenarios specifically exercise a reduced post-cutover fixture. `test/connected/procurement/server-fixture.ts:createConnectedReceivingDatabase` calls the real quantity-ledger `context.open()`, requires exactly one remaining preparation freeze, then acquires `acquireInventoryCutoverFenceInsideTransaction` for canonical authority before releasing that synthetic freeze using its persisted activation timestamp. The existing admission/freeze guards remain installed and are not disabled. `addOwnerReadColumns` adds the current owner columns, generated catalog identities and the active-variant SKU guard needed by actual catalog creation. This arrangement permits post-cutover catalog commands; it does not run or prove the full publication/completion and operational freeze-release lifecycle, which has separate integration owners.

Each child receives an allowlisted environment, refuses live application URLs/provider configuration, and reports its unique database allocation before importing database owners. Cleanup closes sessions and application pools. Parent fallback removal requires the actual child exit event and exact database-owner verification, and causes a test failure if needed. Output is drained before the log is closed. An unconfirmed child exit preserves the database and reports its identity and process for recovery.

The new `procurement-connected.yml` workflow registers this suite with the existing dependency selector. Four test-level shards each use a disposable PostgreSQL service, one serial worker, a twelve-minute Playwright limit and a twenty-minute job budget for setup/build/evidence headroom. `fullyParallel` permits case-level partitioning; it does not add concurrent workers against a database. Actual Playwright discovery guards prove that every project/case appears exactly once and that shard case counts differ by at most one as the suite grows. The matrix does not cancel sibling evidence after a failure, and each artifact has a distinct shard identity. The aggregate fails for missing selection, failed/cancelled coverage or failed migration guards. Existing mocked browser coverage remains separately registered. Adding the workflow does not claim that a GitHub ruleset already requires its new check.

## Cost-read correction

`shipment-tracking.service.ts:readShipmentHealthPage` reads each bounded shipment-header page in the existing repeatable-read, read-only transaction. `shipment-health-evidence.repository.ts:readShipmentHealthEvidence` fetches raw lines, charges, allocations, provisional lots, snapshots and PO sources in seven batches and groups them by identity. Existing allocation, product-cost and posting/reconciliation domain owners still determine amounts and status. No status or currency arithmetic moved into SQL and no cross-request cache was introduced.

All evidence rows are retained; there is no hidden row truncation or arbitrary snapshot selection. Duplicate/foreign identities fail closed. PostgreSQL array parameters avoid expanding large line-ID sets beyond the wire bind-count limit. The repository test retains all 70,003 line identities with one snapshot-query parameter.

`domain/current-shipment-cost-source.ts:shipmentCostSourceReadRequirement` owns whether a saved source contract can require a current fingerprint. `shipment-cost-posting-read.repository.ts` avoids preparing unused current sources for pending/invalid/issue-bearing contracts. Accepted/reconciled exceptions still call their existing current-source verification owner. Stale source errors are preserved, not converted into a healthy result.

`purchase-cost-status-snapshot.repository.ts:createPurchaseCostStatusSnapshotReader` now reuses one previous exact normalized PO-line ID set within one health page. `readShipmentHealthPage` creates a new instance for each bounded page inside its caller's read-only, repeatable-read transaction; the reader rejects a different executor. The direct owner and every reused lookup share `normalizePurchaseCostStatusLineIds`, including strict positive safe-number validation and the 500-unique-line bound. The reader retains only a successful schema-validated DTO with exactly the requested line identities and returns independent clones. Concurrent identical reads share one pending result; a different set or invalid boundary invalidates retention, and an older resolution/rejection cannot replace or clear a newer result. No module-global state or write-path reuse is introduced.

`readShipmentCostReviewInTransaction` still reads each shipment's landed revision, current-source fingerprints and exception/reconciliation evidence. Only its supplier-status read may use the page reader. Existing direct/command callers and the PO summary retain their direct canonical supplier read. The focused 115-case unit run includes exact-set hits, subset/superset misses, invalid/over-limit inputs, failed or invalid output, nested mutation isolation, executor isolation, asynchronous races and page/request lifetime; final PostgreSQL/performance verification of this added reuse is recorded separately below when completed.

The existing per-shipment supplier-cost review and its evidence bounds remain. Total health evaluation still performs work per shipment, and distinct or interleaved supplier ID sets may miss the one-entry reuse. It is not a constant-query health service for unlimited history.

## Repeatable performance verification

`test/performance/procurement/run-health-cost.ts` executes the actual health, shipment work-list, purchasing-health and PO cost-summary owners. The [final measured evidence](evidence/procurement-connected-performance-final-20261025.json) compares starting main `719b60983453a5723f27d224953a536f30502b57` with final code `5dc5f1b4bd25dac4c83aab51b888f7b64cb7d7ca`. Four fresh local databases were measured serially: baseline/current posted-100, then baseline/current unresolved-500. No other tests, builds or compilers ran in that measurement window. Both versions used identical helper bytes and PostgreSQL configuration. Every measured owner returned exactly the same complete public output across baseline/current and all three repeated samples, with no excluded timestamps, amounts, warnings, statuses or identities. The eleven owner/profile pairs, actual driver-call counts, all sample timings, source/helper hashes and report hashes are retained in the evidence.

The posted scenario creates/closes actual receipts and applies freight cost revisions; product and packaging estimates remain provisional. Unresolved fixtures retain estimated freight without allocation/application evidence. Each shipment has five lines, and shared-PO fanout is bounded to 100 shipments. Sales/forecast tables remain small; transformed/sold lot volume is covered by separate correctness regressions rather than this experiment.

Each measured read phase is read-only and preserves complete table fingerprints. All four child exits and output closes were confirmed before their exact owned databases were dropped. Baseline/current installations contain the same 114 fixture tables and 235 indexes, with matching profile row counts. Database version/configuration and all measured-source hashes are retained in the final evidence. These selected actual owner migrations are not a full production release migration replay.

The table shows baseline → final. Times are three-sample medians in milliseconds; list requests display at most 50 rows. The PO fanout row reads one PO with 100 linked shipments.

| Read owner | 500 unresolved: SQL calls | 500 unresolved: median ms | 100 posted freight: SQL calls | 100 posted freight: median ms |
| --- | ---: | ---: | ---: | ---: |
| Landed-cost health | 19,508 → 5,152 | 7,286 → 2,232 | 4,004 → 921 | 4,001 → 874 |
| Shipment list | 1,955 → 612 | 723 → 256 | 2,005 → 472 | 1,986 → 413 |
| Filtered shipment list | 19,509 → 5,153 | 7,036 → 2,171 | 4,005 → 922 | 3,835 → 764 |
| Purchasing health | 19,530 → 5,174 | 7,224 → 2,256 | 4,025 → 942 | 3,893 → 846 |
| PO cost summary (100 linked shipments) | 619 → 19 | 259 → 22 | 620 → 620 | 500 → 476 |
| PO cost summary (one linked shipment) | 25 → 19 | 11 → 7 | — | — |

These are local diagnostic measurements, not production latency guarantees. Baseline preceded current within each profile; sample order, PostgreSQL/OS caches and scheduling effects were not isolated. The bounded one-entry supplier reader benefits consecutive shipments with exactly the same normalized source set. Different/interleaved sets can miss. Per-shipment landed revisions, current-source fingerprints and exception/reconciliation checks remain. The posted PO summary's per-shipment freshness preparation is separate and remains visible in its measured query count.

The [historical measurement evidence](evidence/procurement-connected-performance-20261025.json) is retained unchanged: 26 initial comparisons and a later quiet posted-100 pair predate the final supplier reader and main-310 integration. Initial posted timings included regressions despite fewer round trips; the quiet pair did not reproduce the four health/list median regressions, while the posted PO summary retained 620 calls. Those results are not substituted for the final comparison above. Historical helper equivalence is not assumed: the fresh baseline/current pair uses identical final helpers, including the expanded source fingerprints. The final helper's fingerprint-only difference from the previously committed helper is separately recorded; the older historical working-copy helper hash is not claimed as reconstructed.

The long volume experiment is explicitly operator-invoked local verification. It is not registered as an ordinary CI test. The connected CI suite remains four guarded shards; local final test durations were approximately 3.5–3.7 minutes per shard, excluding hosted setup time.

## Validation and remaining boundaries

The [final validation manifest](evidence/procurement-connected-validation-20261025.json) binds the following local results to code commit `5dc5f1b4bd25dac4c83aab51b888f7b64cb7d7ca` and pinned main `31043e158a696fb1506d211be074e8e9bd8cf25b`:

| Verification | Passed | Scope |
| --- | ---: | --- |
| Connected desktop/mobile browser cases | 46 | Real built application, login/session store, HTTP owners and active quantity ledger; four shards, no skipped/flaky cases or reporter errors |
| Mocked desktop/mobile screen cases | 308 | Ten procurement groups, including AP availability and invalid-money recovery; UI/spec/build inputs stayed unchanged |
| PostgreSQL regression cases | 245 | Receiving/cost application 209, controlled full cost flow 4, reporting 25 and work lists 7 |
| Unit cases | 5,097 | Procurement/inventory/shared owners and the explicitly recorded additional unit files |
| Official CI guards | 420 | Eleven guard files, without relaxing assertions or timeouts |
| Typechecks | 5 | Application, server tests, client tests, connected tests and procurement browser specs |
| Production build | 1 | Final committed code; completed after browser children had closed |
| Migration policy | 557 identities | Validated against pinned main; no migration files changed in this batch |

The manifest preserves source boundaries rather than treating every earlier run as final. Runtime units and application/connected types ran against frozen H3; server types and guards ran against H4, which differs only by the optional dependency-cache type declaration. The later four-file commit exactly contains both tested patches, verified with full patch and per-file hashes. The 308 screen cases used unchanged UI/spec/build inputs while backend-only files changed. The final 46 connected cases and build ran at clean committed code. During the PostgreSQL suites, one unrelated, unexecuted guard test changed; every executed backend/schema/fixture input and all 20 recorded cost/money owners remained unchanged and match the committed code. Final documentation/evidence changes do not change those tested runtime inputs.

All 46 connected fixture databases and the four final regression databases were removed after confirmed child exits. The post-run audit found no owned database, client connection or scoped test-server process remaining. Earlier failed discovery runs remain diagnostic evidence: they are not counted as passing acceptance, and the cause of two earlier forced-shutdown failures was not established. The final isolated run required graceful teardown and passed without accepting fallback cleanup.

The final read-only coherence review of the changed runtime and CI owners found no additional actionable regression. This is a review result, not proof of absence of all possible defects. Earlier quantity-ledger and receiving-close fixture runs (47 and 42 PostgreSQL cases) predate the final current-main integration and remain separate evidence.

### System and performance boundaries at the October 25 closeout

1. **AP common-snapshot gap — resolved in the October 27 follow-up.** The prior owner made six independent reads without a common transaction. The [new closeout](procurement-ap-summary-snapshot-closeout.md) records the reproduced settlement/clock failures, read-only repeatable-read correction and complete current-main validation. This historical report retains its original measurement/test source boundaries.
2. **Posted PO costing still prepares current sources per linked shipment.** `po-shipment-cost-summary.repository.ts:readPoShipmentCosts` loads all non-cancelled linked shipments and passes them to `readShipmentCostPostingEvidence`; that owner calls `readCurrentShipmentSourceFingerprints` once for each shipment that requires freshness. Its supplier-status read already occurs once per PO. The final performance evidence records the remaining query count for the 100-shipment posted scenario. No production latency target or violation has been established. Further batching must preserve per-shipment identity, full evidence and current-source validation.
3. **Health header pagination does not bound every child collection.** `shipment-health-evidence.repository.ts:readShipmentHealthEvidence` validates at most 100 shipment headers, then retains all matching lines, charges, allocations, lots, snapshots and PO sources. PostgreSQL array parameters prevent bind-count overflow; they do not cap child-row memory or total read work. Supplier-review bounds apply later. `getLandedCostHealth` scans every eligible page; the requested display limit does not limit that scan. Extreme child-volume and large sales/forecast capacity remain unverified. A safe continuation must preserve complete evidence instead of silently truncating it.

### What remains unproven

Hosted CI, Linux/PostgreSQL-16 execution, deployment, actual production permission assignments and production latency are not established by these local Windows/PostgreSQL-17 results. The connected fixture does not execute a complete release migration/bootstrap sequence or external provider dispatch. AP connected work-list coverage uses empty payment/credit/return lists and real summary/navigation reads; it is not a connected posted-payment, supplier-credit or supplier-return detail journey. Separate financial integration and mocked-screen checks must not be described as that missing connected proof.

The manual legacy auto-draft alias intentionally now denies non-admin callers with HTTP 403. Both known repository UI callers already use the administrator-gated endpoint; external legacy callers were not inspected. Session-derived frontend grants can become stale; each API remains authoritative and the revocation recovery case verifies retained intent and safe replay.

### Historical cleanup remains separate

Historical PO 144, PO 149 and shipments 95/97 remain a separate supplier-evidence and repair queue. No live records were read or changed. Foreign-currency support and mixed/converted-source returns remain separately scoped capabilities with their existing guards.

## Verified source references

These references identify the reviewed owners at the validated code commit. The detailed manifest records file hashes and the acceptance boundaries above.

| Owner or boundary | Source |
| --- | --- |
| RECEIVING_READ_PERMISSIONS | [client/src/lib/procurement-access.ts:3](../client/src/lib/procurement-access.ts#L3) |
| ProtectedRoute | [client/src/App.tsx:147](../client/src/App.tsx#L147) |
| SidebarContent / visibleChildren | [client/src/components/layout/AppShell.tsx:449](../client/src/components/layout/AppShell.tsx#L449) |
| updateChargesMutation | [client/src/pages/PurchaseOrderDetail.tsx:2506](../client/src/pages/PurchaseOrderDetail.tsx#L2506) |
| PATCH incoterms-charges registration | [server/modules/procurement/purchase-order.routes.ts:482](../server/modules/procurement/purchase-order.routes.ts#L482) |
| createVariantMutation | [client/src/pages/Receiving.tsx:1095](../client/src/pages/Receiving.tsx#L1095) |
| POST create-variant registration | [server/modules/procurement/receiving.routes.ts:266](../server/modules/procurement/receiving.routes.ts#L266) |
| ReceivingService.createVariantFromLine | [server/modules/procurement/receiving.service.ts:1902](../server/modules/procurement/receiving.service.ts#L1902) |
| requireManualAutoDraftAdmin | [server/modules/procurement/purchasing-recommendation.routes.ts:67](../server/modules/procurement/purchasing-recommendation.routes.ts#L67) |
| canRunAutoDraft / runAutoDraftMutation | [client/src/pages/PurchasingDashboard.tsx:648](../client/src/pages/PurchasingDashboard.tsx#L648) |
| APDashboard | [client/src/pages/APDashboard.tsx:38](../client/src/pages/APDashboard.tsx#L38) |
| apSummarySchema | [shared/procurement/ap-summary.ts:11](../shared/procurement/ap-summary.ts#L11) |
| GET AP summary registration | [server/modules/procurement/ap-ledger.routes.ts:548](../server/modules/procurement/ap-ledger.routes.ts#L548) |
| formatPaymentAmount | [client/src/lib/ap-payment-command.ts:126](../client/src/lib/ap-payment-command.ts#L126) |
| evaluateDollarInput | [client/src/lib/exact-money-input.ts:35](../client/src/lib/exact-money-input.ts#L35) |
| dollarsToCents | [shared/utils/money.ts:30](../shared/utils/money.ts#L30) |
| handleCreate | [client/src/pages/APInvoices.tsx:132](../client/src/pages/APInvoices.tsx#L132) |
| readShipmentHealthEvidence | [server/modules/procurement/shipment-health-evidence.repository.ts:61](../server/modules/procurement/shipment-health-evidence.repository.ts#L61) |
| readShipmentHealthPage | [server/modules/procurement/shipment-tracking.service.ts:1410](../server/modules/procurement/shipment-tracking.service.ts#L1410) |
| createPurchaseCostStatusSnapshotReader | [server/modules/procurement/purchase-cost-status-snapshot.repository.ts:32](../server/modules/procurement/purchase-cost-status-snapshot.repository.ts#L32) |
| normalizePurchaseCostStatusLineIds | [server/modules/procurement/purchase-cost-status.repository.ts:36](../server/modules/procurement/purchase-cost-status.repository.ts#L36) |
| readShipmentCostReviewInTransaction | [server/modules/procurement/shipment-cost-review.repository.ts:19](../server/modules/procurement/shipment-cost-review.repository.ts#L19) |
| allocatedCentsPerUnitMills | [server/modules/procurement/shipment-tracking.service.ts:202](../server/modules/procurement/shipment-tracking.service.ts#L202) |
| formatMillsOrDash / AllocationAmountCell | [client/src/pages/InboundShipmentDetail.tsx:297](../client/src/pages/InboundShipmentDetail.tsx#L297) |
