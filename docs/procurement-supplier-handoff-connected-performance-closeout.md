# Supplier handoff, connected recovery and supplier-cost read performance

## Scope and source identity

Implementation commit `fb6c97565` is verified at merged runtime commit `dbbce1f13969c20d04192cedef554eb11728f3a7`, including pinned main `f133fb9d4f2725190162323fc53651b65340ac19`. Main still pointed to that commit at the final remote check. All 17 implementation/test/helper files have identical Git blobs before and after that main merge. The later report, evidence and comparison-tool commit changes no application runtime code.

This batch contains no SQL migration, live permission change, historical repair or live database access. The primary checkout's unrelated work and older local resources were preserved. The [evidence manifest](evidence/procurement-supplier-connected-performance-20261028.json) records source hashes, individual successful checks, complete-output comparisons and disposable-cluster cleanup.

## What the code definitely does

### Missing-supplier handoff

[`ReorderEngine.openSupplierSetup` and `restoreSupplierOrder`](../client/src/pages/ReorderEngine.tsx) replace the generic supplier-directory link with the existing exact product/variant setup workflow. [`captureOrderSupplierHandoff`](../client/src/lib/order-supplier-handoff.ts) retains every selected recommendation, its pieces, explicit supplier choice, reason, PO/RFQ group mode and decision note before navigating. The strict, operator-scoped browser-session record contains no prices, approvals or submitted-command results.

[`orderSupplierSetupHref`](../client/src/lib/order-supplier-handoff.ts) uses the existing [`parseSupplierSetupDeepLink`](../client/src/features/supplier-catalog/supplierSetupDeepLink.ts) contract and its allowlisted return route. Supplier setup therefore uses the existing mapping editor and write owner. Returning to the builder requires an explicit review: current analysis is fetched, every saved identity and supplier choice is checked, and old approval acknowledgements are cleared. Storage failure prevents departure. Unavailable analysis, changed receive units or ineligible supplier choices retain the saved record and block an unsafe restoration. Selected positive-quantity items still lacking a supplier cannot silently disappear from a submitted order.

The [22 unit cases](../client/src/lib/__tests__/unit/order-supplier-handoff.test.ts) cover complete draft retention, zero quantities, eligible alternatives, stale identities, operator isolation, corrupt/unavailable storage and the 500-line boundary. The [12 desktop/mobile browser cases](../test/browser/procurement-order-supplier-handoff.spec.ts) exercise the real builder and supplier editor with mocked APIs, including return, cancellation, failed storage, unavailable analysis, changed units and read-only access. They do not establish a new live supplier mapping or create a PO/RFQ.

### Connected financial and physical workflows

The [connected server](../test/connected/procurement/server.ts) now wires the real post-receipt AP reconciler, matching [`createServices`](../server/services/index.ts), instead of omitting that owner. [`installConnectedWorkflowFixture`](../test/connected/procurement/workflow-fixture.ts) installs the actual payment, credit, return and exact-cost constraints in a newly owned database. Proven-empty placeholders are replaced without CASCADE; unexpected existing data/dependencies fail setup. Synthetic roles receive explicit grants. Production roles are untouched.

[Financial workflow cases](../test/connected/procurement/financial-workflow.spec.ts) prove that a non-admin records one $50 supplier payment, loses its committed response, encounters revoked approval authority, signs in again and recovers the same command. Applying $10 creates one retained allocation and leaves $65 outstanding on the original $75 invoice. Separate credit cases create and approve a $5 credit, recover one committed application after reload, then reverse it while retaining its original application and restoring invoice credit totals. Neither journey changes stock or executes a bank transfer.

The [shipment/return case](../test/connected/procurement/shipment-return-workflow.spec.ts) creates a draft from its PO, preserves 20 five-piece cases through booking, departure, delivery and receiving, and verifies the real cost request is applied. Returning one collected case removes five pieces. Reload/recovery reuses the original return request; persisted movements, quantity commands and return-cost entries remain unchanged on replay. The lot retains 19 cases, while original receipt and PO acceptance history remain intact. Every journey runs on desktop and mobile through actual login, HTTP handlers and PostgreSQL.

### Remaining measured read fanout

[`visitPurchaseCostStatusScopes`](../server/modules/procurement/purchase-cost-status-batch.repository.ts) combines supplier-line sets within one caller-owned snapshot and delegates to the unchanged [`readPurchaseCostStatus`](../server/modules/procurement/purchase-cost-status.repository.ts). It validates every original scope before SQL, verifies complete canonical output and immediately projects each shipment's own isolated subset.

A combined scope can exceed an existing boundary even when its individual shipments are valid. Only `COST_REVIEW_LIMIT` and `CREDIT_SOURCE_LIMIT` cause subdivision. An individual over-limit scope still fails; missing/malformed evidence, other errors and projection failures are not retried or suppressed. No row limit is raised, no source/approval freshness check is skipped, and no cross-request cache is introduced. [`readShipmentCostReviewProjectionsInTransaction`](../server/modules/procurement/shipment-cost-review.repository.ts) uses this read while retaining the existing posting evidence and domain projection.

[PostgreSQL cases](../server/modules/procurement/__tests__/integration/purchase-cost-status-batch.cases.ts) compare complete individual and batch reviews for two independently valid 5,001-lot shipments, retain the genuine 10,000-lot individual boundary, and verify a repeatable-read view across a concurrently committed supplier approval. [Unit cases](../server/modules/procurement/__tests__/unit/purchase-cost-status-batch.repository.test.ts) cover input/output scope, overlapping/empty sets, mutation isolation, snapshot ownership, both aggregate fallbacks and failure propagation.

## Performance evidence

All 30 owner/tier/profile comparisons preserve complete public DTOs across all six baseline/candidate samples. No response fields are removed or normalized. Participating table/index metadata matches, driver failures are zero, and every read phase retains its complete before/after table fingerprints under PostgreSQL read-only defaults. Profiles cover 500 unresolved shipments, 100 actually posted shipments and 100,000 depleted untraced lots. Benchmark source/helper identities and owned-database removal are recorded in the manifest.

| 500-shipment unresolved profile | Driver queries before → after | Median local ms before → after |
| --- | ---: | ---: |
| Landed-cost health | 3,667 → 103 | 1,565 → 471 |
| Unfiltered shipment page | 465 → 24 | 177 → 52 |
| Filtered shipment page | 3,668 → 104 | 1,415 → 491 |
| Purchasing health | 3,689 → 125 | 1,535 → 449 |

The experiment is reproduced by [`run-health-cost.ts`](../test/performance/procurement/run-health-cost.ts) and [`run-lot-depth.mjs`](../test/performance/procurement/run-lot-depth.mjs), using explicit disposable loopback databases and cleared live/provider variables. [`compare-health-cost.mjs`](../test/performance/procurement/compare-health-cost.mjs) accepts the absolute directory containing the six raw reports and successful wrapper records; it rejects changed/incomplete outputs, helpers, schema, failed driver calls or missing cleanup evidence.

Timings and sampled RSS are diagnostic, not production SLOs or allocation profiles. Improvements are not uniform: the 500-tier PO fanout owner retains 19 queries and its sampled median was 19 → 28 ms. Sampled RSS also varies; purchasing health observed 543 → 687 MiB in these long-lived experiment processes. This batch does not claim a memory reduction. Complete eligible-header scans and existing per-review safety boundaries remain. Exception-heavy reconciliations, large transformed supplier graphs and large sales histories require separate measurements before further changes.

## Test coverage and failure modes

- 4,973 unit cases and 228 real PostgreSQL cases passed, with no skipped cases in those counted runs. They ran before the unrelated main merge; the manifest verifies identical Git blobs for all 17 implementation files afterward.
- On the merged runtime commit, all 430 official CI guards, 52 connected desktop/mobile cases and 12 supplier-handoff browser cases passed. Application, server-test, client-test and connected-test typechecks passed, as did the actual client/server/inventory-worker production build.
- Lost responses are tested after the real commit, using the same body and idempotency key for recovery. Session expiry, permission revocation/restoration, original-operator ownership, catalog rollback, stock conservation, financial history and genuine evidence limits remain explicit assertions.
- Diagnostic failures remain in local output history. The local runner was corrected to serialize schema-owning integration files and to restrict Playwright JSON-report redirection to browser runs. Assertions, deadlines and production code were not weakened to resolve those runner failures. Final committed-source guards passed in full.

The owned local cluster was stopped only after verifying its exact role/directory/port, zero remaining test databases and zero other clients. Its data files and diagnostic artifacts were retained; unrelated clusters were preserved.

## What is likely happening

The measured large-profile delay is supported by the baseline query groups: nine supplier-evidence reads repeat for 401 distinct purchase-line sets. The batching change removes that repetition. No additional supplier policy, production latency cause or operator behavior is inferred from the synthetic results.

## What is not proven

Browser-session draft recovery does not provide cross-device storage. Stale source/unit/supplier choices require fresh review; this batch does not invent replacements. The test fixture uses selected real schemas/migrations/indexes, not a complete release/bootstrap replay. External channel dispatch is an inert boundary, and recorded payments do not execute bank transfers. Hosted Linux/Node 20/PostgreSQL 16 CI, production role assignments and live operator acceptance have not been verified for this new payload.

The production build still emits the existing shared-client bundle warning (about 15.15 MB JavaScript, 2.47 MB gzip). App-wide code splitting/startup performance was neither changed nor benchmarked here. No claim of unbounded procurement capacity or absence of all possible defects follows from these tests.

## Next checks and historical cleanup

The missing-supplier handoff, the identified connected-flow coverage gaps and the measured distinct-supplier read fanout are implemented and locally verified. The next release steps are publication, hosted checks, review/deployment and read-only acceptance against the deployed commit. This report identifies no additional product defect within the workflows and distributions actually tested.

Historical PO 144/149 and shipment 95/97 cleanup remains a separate evidence/repair queue. No historical preview was applied, no live record was changed and no production migration was run.
