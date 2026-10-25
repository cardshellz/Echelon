# Connected procurement verification, permissions and cost-read performance

## Scope and baseline

The review started at main `719b60983453a5723f27d224953a536f30502b57`, after the reported deployment of PR #1912. Main `0550f2856de213a65c4a91418d031aaf25bcbfd2` and then `1ddaf0470` were merged, producing validation base `7b4a6e941060c3afeeab6e04e0a951b06e43b9e3`. The shipment editor registration and `executeLineBatchInTransaction` service entry point are retained. This batch contains no SQL migration or historical repair.

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

`test/performance/procurement/run-health-cost.ts` executes the actual health, shipment work-list, purchasing-health and PO cost-summary owners. Baseline and corrected runs use identical helper files, fresh synthetic local databases, the same bounded tiers, and three serial samples per owner. The posted scenario creates and closes real receipts and applies actual cost revisions; every measured line must satisfy the current posting rule.

Each read phase is read-only and checks complete table digests before and after. `compare-health-cost.ts` compares complete public owner outputs across baseline/current and repeated samples, with no excluded timestamps, monetary values, statuses or identities. Query counts are actual driver calls, including module-global database users. Parameters and live data are not recorded.

Synthetic pending tiers contain 10, 100 and 500 shipments with five lines each. Posted tiers contain 10 and 100 shipments. The shared-PO fanout is bounded to 100 shipments. Sales/forecast tables are small, and transformed/sold lot histories are covered by separate financial regression tests rather than this volume experiment. Local timings are diagnostic, not production latency guarantees.

The [compact measured evidence](evidence/procurement-connected-performance-20261025.json) preserves the initial baseline/current heads, owner/helper hashes, all three sample timings for all 26 owner/tier comparisons, PostgreSQL configuration and original report hashes. It also retains a separate quiet posted-100 baseline/current rerun, including all five complete-output comparisons and its original report/wrapper hashes. All complete outputs matched exactly, repeated samples were stable, and measured owner/helper files and table fingerprints remained unchanged during reads. The four initial and two additional uniquely owned databases were disposed and dropped; the additional wrappers confirmed child exit and closed output streams before cleanup. Both versions installed the same 235 indexes and had matching row counts across all 114 fixture tables. The quiet window excluded other test/build/typecheck work; unrelated UI/fixture text edits were permitted and are outside the measured-source freeze. No live records were involved.

The following table preserves the largest completed tier of each initial profile. Times are median elapsed milliseconds across three serial samples; arrows are baseline to corrected. Shipment list requests return at most 50 rows; the PO cost row reads one PO with 100 linked shipments.

| Read owner | 500 unresolved: SQL calls | 500 unresolved: median ms | 100 posted: SQL calls | 100 posted: median ms |
| --- | ---: | ---: | ---: | ---: |
| Landed-cost health | 19,508 → 6,043 | 8,328 → 3,554 | 4,004 → 1,911 | 4,025 → 4,765 |
| Shipment list | 1,955 → 612 | 770 → 351 | 2,005 → 962 | 1,863 → 2,439 |
| Filtered shipment list | 19,509 → 6,044 | 7,899 → 3,243 | 4,005 → 1,912 | 3,947 → 4,919 |
| Purchasing health | 19,530 → 6,065 | 9,746 → 3,113 | 4,025 → 1,932 | 5,165 → 5,344 |
| PO shipment-cost summary | 619 → 19 | 426 → 28 | 620 → 620 | 672 → 835 |

Initial posted-100 latency increased despite fewer health/list SQL calls, and the valid posted PO summary retained all 620 calls. A separate quiet posted-100 baseline/current pair reproduced the same query counts and exact public outputs, with these three-sample medians:

| Read owner | Quiet posted-100 median ms, baseline → corrected |
| --- | ---: |
| Landed-cost health | 4,138 → 3,590 |
| Shipment list | 2,136 → 1,686 |
| Filtered shipment list | 4,038 → 3,321 |
| Purchasing health | 4,069 → 3,365 |
| PO shipment-cost summary | 457 → 490 |

The quiet rerun did not reproduce a higher median for the four health/list owners, but the corrected first health sample took 5,849 ms. PO summary still made 620 calls and had a slightly higher median. All runs used PostgreSQL 17.11 with `shared_buffers=400kB` and `work_mem=4MB`. Baseline ran before corrected in the quiet pair; execution order, caches and scheduling effects were not isolated. The evidence establishes fewer round trips and improved unresolved-profile timings, with variable posted timings; it does not establish a blanket latency improvement, its cause, or a production latency target.

The repeated supplier reads remain in `shipment-tracking.service.ts:readShipmentHealthPage` → `shipment-cost-review.repository.ts:readShipmentCostReviewInTransaction` → `purchase-cost-status.repository.ts:readPurchaseCostStatus`. Both the initial experiment and quiet rerun executed 100 product/packaging revision reads returning 1,000 rows, 100 descendant-lot reads returning 50,000 rows, and 100 application-lot reads returning 100,000 rows for posted-100 health. The real migration-222 supplier revision/application indexes were installed; their SQL fingerprints, call counts and row volumes were unchanged between versions. This fixture links all 100 shipments to the same five PO lines, so supplier evidence is repeatedly read within one snapshot. The bounded one-entry supplier reuse described above was added after these measurements; its final measured result is separate from the preserved initial and quiet-pair tables. Broader reuse/batching must preserve canonical validation, complete evidence, per-review limits, immutable caller results and transaction/page lifetime. The PO summary already reads supplier status once; its remaining per-shipment live-source fingerprint preparation is a distinct follow-up and is unchanged by this reuse.

## Validation and remaining boundaries

Final run results are recorded with commands and source fingerprints under the primary workspace's `outputs/procurement-connected-verification-2026-10-25`. Earlier quantity-ledger and receiving-close fixture regressions passed 47 and 42 PostgreSQL cases respectively; those runs predate the current-main merge and are distinct from final merged-source validation.

Historical PO 144, PO 149 and shipments 95/97 remain a separate evidence/repair queue. No live records were read or changed. Foreign-currency support and mixed/converted-source returns remain separately scoped capabilities with their existing guards.
