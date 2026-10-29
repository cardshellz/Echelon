# Procurement exception-read performance

## Summary and source

This batch removes per-line reconciliation query fanout from shipment exceptions, costing/health projections and purchase cost history. It starts from main `7b28119a3ec9bb0c96723ff3084b9eead6a5f319`. The [evidence manifest](evidence/procurement-exception-read-performance-20261029.json) binds the six implementation/test/experiment files to their exact hashes, frozen validation patch and raw report hashes. Final prose/evidence files were added after execution; the code patch fingerprint is checked separately.

There is no SQL migration, permission change, historical data repair or live database access. Synthetic writes happen only in uniquely owned disposable loopback databases. External dispatch remains inert in the existing test harness.

## What the code definitely does

`shipment-cost-exception.repository.ts:readShipmentCostExceptions` previously called the inventory owner's historical-record reader once and its two-query ledger reader once for each valid exception. A real 500-line workload therefore used 1,503 driver queries, including transaction and initial fact reads.

[`visitShipmentReconciliationEvidence`](../server/modules/inventory/infrastructure/cost-reconciliation.repository.ts) now reads pages of at most 100 exception lines. Each page selects the latest approval per line, latest posting per line/destination, and complete historical lot evidence in three queries. Correlated LATERAL reads retain the existing 1,001-row overflow sentinel **for each original line**. Two independent 1,000-record lines remain valid together; a single 1,001-record line still fails with `COST_RECONCILIATION_LIMIT`.

Both direct command reads and this projection use the same `reconciliationRecordsQuery`, `projectReconciliationRecords` and `projectReconciliationLedger` functions. They retain receipt-line uniqueness, missing-origin selection, explicit unresolved lot identities, COGS/contribution/physical-commitment flags, exact mills, original issue quantities and explanations. Page evidence is projected and released; no graph or approval cache survives a request. Duplicate scopes, escaped identities, malformed evidence and query/projection failures fail the read.

[`readShipmentCostExceptions`](../server/modules/procurement/shipment-cost-exception.repository.ts) still delegates completion to `reconciliationEligibility` and `reconciliationState`, and retains the existing current-source fingerprint checks. Accepted or posted evidence reopens when its economic source changes. `readShipmentCostReviewProjectionsInTransaction` and `readPoShipmentCosts` reach that same owner through `readShipmentCostPostingEvidence`; `readPurchaseCostApplications` calls it directly. These consumers receive the same complete DTOs.

Approval/posting commands retain their scalar reads, graph lock and transaction. Source comparison verifies unchanged `hasReconciliationRoots`, `postCostReconciliation`, `recordReconciliationApproval`, `readReconciliationHistory` and `persistShipmentExceptionDecision` bodies. No business decision, balance write or audit mutation is added.

## Measured results

[`run-exception-cost.mjs`](../test/performance/procurement/run-exception-cost.mjs) creates 10/100 closed shipments with 50/500 actual cost applications requiring missing-receipt-history review. The application owner generates these exceptions; the experiment does not fabricate posting or application status. Each baseline/candidate phase uses its own empty database, the same selected actual schemas/indexes and deterministic inputs, read-only measured transactions, unchanged business-table fingerprints and three serial samples per owner.

[`compare-exception-cost.mjs`](../test/performance/procurement/compare-exception-cost.mjs) verifies all **six** owner/tier pairs across all six samples per pair. Entire DTOs match, including exception fingerprints, amounts, warnings, destinations, identities and ordering. No response field is removed or normalized. Every driver call succeeds and both children close before their owned databases are removed.

| 100 shipments / 500 exception lines | Driver queries before → after | Median local ms before → after |
| --- | ---: | ---: |
| Exception evidence | 1,503 → 18 | 570 → 90 |
| Landed-cost health | 1,529 → 44 | 1,148 → 692 |
| Filtered shipment list | 1,531 → 46 | 1,176 → 709 |

The first comparison correctly rejected different exception fingerprints. The fixture's allocation `created_at` default used wall time, and complete allocation rows are source fingerprint inputs. The final experiment fixes that synthetic default before inserts, retains every timestamp/fingerprint in the output comparison, and reruns both phases. Earlier diagnostic reports are retained separately and are not counted as successful comparisons.

Reproduce from the selected checkout with a uniquely owned empty loopback database, `NODE_ENV=test`, `VITEST=true`, `DISABLE_SCHEDULERS=true`, `ECHELON_TEST_DATABASE_DISPOSABLE=true`, `ECHELON_TEST_DATABASE_URL` set only to that database, and live/provider variables cleared. Run `node --import tsx test/performance/procurement/run-exception-cost.mjs <absolute-report.json> 10,100`. Its caller owns allocation and verified cleanup. Keep the two final raw reports and successful wrapper records together, then run `node test/performance/procurement/compare-exception-cost.mjs <absolute-evidence-directory>`.

## Test coverage and failure modes

- **6,107 unit cases** passed across 391 files. The 25 new inventory-reader cases cover input/output scope, both record boundaries, retained issue identity, 201-line pagination, invalid IDs, malformed money/approvals/records, query failures, projection failure and mutation isolation.
- **231 PostgreSQL cases** passed across the full receiving/AP/freight suite and controlled full-flow suite, without counted skips. New cases compare entire scalar/batch evidence through actual approval and destination replacement, preserve two complete 1,000-record scopes, reject one 1,001-record scope, retain a snapshot across a concurrently committed approval and refresh afterward. Existing cases verify stale approval reopening, exact cost conservation, concurrency, immutable history, receiving retry, payments, supplier credits and returns.
- **430 official CI guards** passed with writer ownership, migration checks and baselines unchanged. Application and server-test typechecks passed. The actual frontend/server/inventory-worker production build passed.
- **52 connected desktop/mobile cases** passed without skipped, flaky or failed cases, through real login, HTTP owners and PostgreSQL. They cover permission denial/restoration, session expiry, original-operator recovery, PO/shipment/invoice navigation, payment and credit recovery, receiving, and accepted-stock return.

All full checks use the same frozen code patch. The build intentionally changes the generated frontend hash; its source code fingerprint stays unchanged, and the connected suite uses the resulting stable build. The dedicated cluster was stopped only after exact role/directory/port verification, zero remaining test databases and zero other clients. Data files, failed diagnostic artifacts and unrelated local resources were retained.

## What is likely happening

The baseline query groups demonstrate repeated reconciliation reads for each exception line. The new page reads account for the reduced driver-call counts. Timings also depend on database/OS caches, sample order and scheduling; this experiment does not isolate those effects or identify a production latency cause.

## Assumptions, risks and what is not proven

The workload is synthetic and explicitly bounded. Supplier policy, production record quality, role assignments and production latency targets are not inferred. Local Windows/Node/PostgreSQL 17 timings and sampled RSS are diagnostic, and no memory reduction or production SLO is claimed. The fixture installs selected actual owner schemas/constraints, rather than the complete release migration/bootstrap sequence.

One page can transfer at most 100 × 1,001 historical rows before its independent line limits are enforced. Full health still scans all eligible shipment headers, and supplier graph/reconciliation safety limits remain. Extreme transformed supplier graphs, very large charge/line collections and large sales-history planning capacity need separate measurements. The build retains the existing shared-client chunk warning: 15,189.43 kB JavaScript / 2,480.46 kB gzip. App-wide startup/code splitting is outside this patch.

Hosted CI, deployment and live operator acceptance have not been performed for this new patch. Connected test payments record evidence; they do not execute bank transfers.

## Next checks and historical cleanup

This closes the measured per-exception reconciliation read fanout. The new payload requires publication, hosted checks and review/deployment. Wider capacity studies remain separate from confirmed defects; no further product correction is inferred from an unmeasured distribution.

Historical cleanup remains a separate evidence/repair queue. No preview was applied and no live record was changed.
