# Connected procurement verification, permissions and cost-read performance

## Scope and baseline

The review started at main `719b60983453a5723f27d224953a536f30502b57`, after PR #1912. Current main `0550f2856de213a65c4a91418d031aaf25bcbfd2` was merged before final validation. Its shipment editor registration and `executeLineBatchInTransaction` service entry point are retained. This batch contains no SQL migration or historical repair.

The remaining acceptance work in `procurement-numbering-clock-closeout.md` was connected browser/HTTP recovery with an active quantity ledger, non-admin authority/navigation, and synthetic-volume cost/health reads. This report distinguishes those tests from production acceptance and from the separate historical record queue.

## Reproduced permission defects and corrections

Actual PostgreSQL-backed sessions reproduced these differences between the UI and the existing APIs:

- A picker holding current receiving/purchasing grants could read the relevant APIs, but the receiving page and six PO/shipment/invoice list/detail routes redirected to `/picking` because of legacy role-name checks.
- A view-only receiving user saw enabled quantity, location and receipt-state controls while mutation requests returned 403 without business writes.
- An inventory adjustment grant exposed vendor/catalog creation controls even though those actions require separate creation grants. Shipment and invoice list creation buttons had the same mismatch with `purchasing:create`. The PO list already checked its creation grant correctly.

`client/src/lib/procurement-access.ts` declares the read grants used by `App.tsx` and the four corresponding sidebar links. Other sidebar children retain their existing parent-role restrictions. `Receiving.tsx` uses the existing receiving-entry grant for adjustment controls and mutation handlers; vendor and catalog creation use their own grants. Quarantine/reversal approval authority remains with its existing owners. `InboundShipments.tsx` and `APInvoices.tsx` gate creation controls and handlers with the API's creation grant. No server permission is added or bypassed.

A focused sidebar rendering regression covers unrelated named grants so the procurement correction cannot expose other role-restricted modules. Connected tests prove API denial and unchanged stored business evidence; an explicitly granted synthetic creator retains the three procurement launch buttons. That custom fixture role is not a substitute for system Administrator or financial approval acceptance.

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

The new `procurement-connected.yml` workflow registers this suite with the existing dependency selector. It uses a disposable PostgreSQL service, installs the browser, builds the real frontend and typechecks the harness. The aggregate fails for missing selection, failed/cancelled coverage or failed migration guards. Existing mocked browser coverage remains separately registered. Adding the workflow does not claim that a GitHub ruleset already requires its new check.

## Cost-read correction

`shipment-tracking.service.ts:readShipmentHealthPage` reads each bounded shipment-header page in the existing repeatable-read, read-only transaction. `shipment-health-evidence.repository.ts:readShipmentHealthEvidence` fetches raw lines, charges, allocations, provisional lots, snapshots and PO sources in seven batches and groups them by identity. Existing allocation, product-cost and posting/reconciliation domain owners still determine amounts and status. No status or currency arithmetic moved into SQL and no cross-request cache was introduced.

All evidence rows are retained; there is no hidden row truncation or arbitrary snapshot selection. Duplicate/foreign identities fail closed. PostgreSQL array parameters avoid expanding large line-ID sets beyond the wire bind-count limit. The repository test retains all 70,003 line identities with one snapshot-query parameter.

`domain/current-shipment-cost-source.ts:shipmentCostSourceReadRequirement` owns whether a saved source contract can require a current fingerprint. `shipment-cost-posting-read.repository.ts` avoids preparing unused current sources for pending/invalid/issue-bearing contracts. Accepted/reconciled exceptions still call their existing current-source verification owner. Stale source errors are preserved, not converted into a healthy result.

The existing per-shipment supplier-cost review and its evidence bounds remain. The correction removes per-line round trips, but total health evaluation still performs work per shipment. It is not a constant-query health service for unlimited history.

## Repeatable performance verification

`test/performance/procurement/run-health-cost.ts` executes the actual health, shipment work-list, purchasing-health and PO cost-summary owners. Baseline and corrected runs use identical helper files, fresh synthetic local databases, the same bounded tiers, and three serial samples per owner. The posted scenario creates and closes real receipts and applies actual cost revisions; every measured line must satisfy the current posting rule.

Each read phase is read-only and checks complete table digests before and after. `compare-health-cost.ts` compares complete public owner outputs across baseline/current and repeated samples, with no excluded timestamps, monetary values, statuses or identities. Query counts are actual driver calls, including module-global database users. Parameters and live data are not recorded.

Synthetic pending tiers contain 10, 100 and 500 shipments with five lines each. Posted tiers contain 10 and 100 shipments. The shared-PO fanout is bounded to 100 shipments. Sales/forecast tables are small, and transformed/sold lot histories are covered by separate financial regression tests rather than this volume experiment. Local timings are diagnostic, not production latency guarantees.

The [compact measured evidence](evidence/procurement-connected-performance-20261025.json) preserves the measured baseline/current heads, owner/helper hashes, all three sample timings for all 26 owner/tier pairs, PostgreSQL configuration and original report hashes. All complete outputs matched exactly, repeated samples were stable, and source/table fingerprints remained unchanged during reads. The four uniquely owned databases were disposed and dropped. Both versions installed the same 235 indexes and had matching row counts across all 114 fixture tables. No live records were involved.

The following table uses the largest completed tier of each profile. Times are median elapsed milliseconds across three serial samples; arrows are baseline to corrected. Shipment list requests return at most 50 rows; the PO cost row reads one PO with 100 linked shipments.

| Read owner | 500 unresolved: SQL calls | 500 unresolved: median ms | 100 posted: SQL calls | 100 posted: median ms |
| --- | ---: | ---: | ---: | ---: |
| Landed-cost health | 19,508 → 6,043 | 8,328 → 3,554 | 4,004 → 1,911 | 4,025 → 4,765 |
| Shipment list | 1,955 → 612 | 770 → 351 | 2,005 → 962 | 1,863 → 2,439 |
| Filtered shipment list | 19,509 → 6,044 | 7,899 → 3,243 | 4,005 → 1,912 | 3,947 → 4,919 |
| Purchasing health | 19,530 → 6,065 | 9,746 → 3,113 | 4,025 → 1,932 | 5,165 → 5,344 |
| PO shipment-cost summary | 619 → 19 | 426 → 28 | 620 → 620 | 672 → 835 |

Posted-100 latency increased despite fewer health/list SQL calls, and the valid posted PO summary retained all 620 calls. This experiment proves fewer round trips and improved unresolved-profile timings; it does not prove that every posted workload is faster. Both runs used PostgreSQL 17.11 with `shared_buffers=400kB` and `work_mem=4MB`. Three serial samples on this local configuration are not a production latency target or an explanation of the posted timing difference.

The expensive supplier reads remain in `shipment-cost-review.repository.ts:readShipmentCostReviewInTransaction` → `purchase-cost-status.repository.ts:readPurchaseCostStatus`. For posted-100 health, each version still executed 100 product/packaging revision reads returning 1,000 rows, 100 descendant-lot reads returning 50,000 rows, and 100 application-lot reads returning 100,000 rows. Their SQL and row counts were unchanged, while recorded query durations were higher in the corrected run. The cause of that timing difference is not established. Further batching of supplier evidence and valid-source freshness would need to preserve the current per-shipment evidence limits; this correction does not complete that work.

## Validation and remaining boundaries

Final run results are recorded with commands and source fingerprints under the primary workspace's `outputs/procurement-connected-verification-2026-10-25`. Earlier quantity-ledger and receiving-close fixture regressions passed 47 and 42 PostgreSQL cases respectively; those runs predate the current-main merge and are distinct from final merged-source validation.

Historical PO 144, PO 149 and shipments 95/97 remain a separate evidence/repair queue. No live records were read or changed. Foreign-currency support and mixed/converted-source returns remain separately scoped capabilities with their existing guards.
