# Procurement cost-read performance and deployed-1925 verification

> October 28 follow-up: [supplier handoff, connected recovery and remaining supplier-read batching](procurement-supplier-handoff-connected-performance-closeout.md) closes the specifically identified follow-up gaps. The measurements and release attribution below retain their original scope.

## Scope and release verification

Code commit `c310d6d47660714f0c1c1e20f511f2d772dd73a9` starts from pinned main `198543a220a790ab115c995fef203816d6b6e44c`. The subsequent evidence/reproduction files do not change tested runtime inputs. No SQL migration, new accounting rule, production permission assignment or historical repair is included.

PR [#1925](https://github.com/cardshellz/Echelon/pull/1925) merged at `df740f856bd611dcd97ac03f211616e27a2d235c`; all seven hosted workflows completed successfully at its actual final head `9b4e6bf15578af30f0b9d84964228c29280adbdd`. That merge is an ancestor of the pinned main. Heroku metadata observed at 2026-10-28T00:13:42.8455219Z reports release v3394, status `succeeded`, description `Deploy 198543a2`; both web and inventory-capture processes are up on that release. The release description matches the main SHA prefix. The metadata returned a slug ID without a full slug commit: this is not independent full-slug or operator-journey acceptance.

## What the code definitely does

- [readCurrentShipmentSourceFingerprintBatch](../server/modules/procurement/shipment-cost-exception.repository.ts#L48) validates the complete identity set, prepares economic evidence in pages of 100 shipment headers, hashes each page and releases its complete proposal graphs. Posting evidence and accepted/reconciled exception reads use those same current fingerprints inside their existing transaction.
- [readShipmentCostRevisionEvidence](../server/modules/procurement/shipment-cost-revision-read.repository.ts#L47) batches complete lines, charges, documents, allocations, prior revisions and supplier credits. Shared invoices are fetched once and routed to every applicable shipment with their entire document and exact totals. Routing columns are removed before immutable economic evidence is built; native scalar types and row order remain unchanged.
- [readShipmentProvisionalLotCounts](../server/modules/procurement/shipment-health-evidence.repository.ts#L116) counts every flagged lot and every uncovered flagged lot in PostgreSQL, using each shipment's exact supplier-traced identities. It transfers complete counts rather than all wide lot rows. There is no lot-row LIMIT or omission of source freshness.
- [readShipmentCostReviewProjectionsInTransaction](../server/modules/procurement/shipment-cost-review.repository.ts#L66) validates the full canonical review, then immediately projects the health fields. [projectShipmentHealthCostReview](../server/modules/procurement/shipment-tracking.service.ts#L76) and [readShipmentHealthPage](../server/modules/procurement/shipment-tracking.service.ts#L1425) retain posting decisions, supplier review count/action and traced lot IDs, rather than every shipment's full supplier-lot DTO graph. Existing domain owners still decide completion, source review and next actions.

Parsed-source comparison proves the 12 original financial preparation statements are unchanged apart from the proposal type name. `recordShipmentCostRevisions` and `applyShipmentCostRevisions` are textually unchanged. Advisory-lock and transaction owners remain in place; there is no cross-request source cache. Supplier credit filters and the existing per-shipment 10,000-row boundary are retained independently for each shipment.

## Performance evidence

The [evidence manifest](evidence/procurement-cost-read-performance-20261027.json) binds exact code/helper hashes, complete response hashes, source identities, query/row counts, sample timings, schema metadata and cleanup. All 15 owner/profile pairs return identical complete DTOs across all six baseline/candidate samples. No response field is omitted or normalized. Before/after table fingerprints remain unchanged during every read phase, and PostgreSQL read-only defaults apply to every fixture pool connection.

Both revisions use the same Node runtime, dependency installation, owned PostgreSQL cluster/settings and participating table/index catalog. Each profile starts from a new disposable database. Measurements run serially after regression/browser processes finish. The posted profile has 100 shipments with real receipts, lineage, finalized estimated freight and actual cost applications. The unresolved profile has 500 shipments; PO fanout remains bounded to 100 linked shipments. The depth profile adds 100,000 depleted, untraced provisional lots to one shipment within a 10-shipment fixture. Three samples per owner are diagnostic, with warmed OS/database caches after the first sample.

| Profile / owner | Driver queries, before → after | Driver rows, before → after | Median local ms, before → after |
| --- | ---: | ---: | ---: |
| posted / landed-health | 921 → 30 | 6926 → 6526 | 1218 → 634 |
| posted / unfiltered-shipments | 472 → 31 | 4527 → 4327 | 597 → 381 |
| posted / filtered-shipments | 922 → 31 | 6976 → 6576 | 1124 → 688 |
| posted / purchasing-health | 942 → 51 | 6939 → 6539 | 1183 → 750 |
| posted / po-cost-fanout | 620 → 26 | 5721 → 5721 | 666 → 405 |
| unresolved / landed-health | 5152 → 3667 | 15416 → 15416 | 4356 → 3048 |
| unresolved / unfiltered-shipments | 612 → 465 | 1751 → 1751 | 488 → 358 |
| unresolved / filtered-shipments | 5153 → 3668 | 15466 → 15466 | 4005 → 3136 |
| unresolved / purchasing-health | 5174 → 3689 | 17835 → 17835 | 4659 → 2806 |
| unresolved / po-cost-fanout | 19 → 19 | 1611 → 1611 | 48 → 48 |
| unresolved / po-cost-single | 19 → 19 | 27 → 27 | 19 → 14 |
| depth / landed-health | 49 → 22 | 100196 → 197 | 1390 → 183 |
| depth / unfiltered-shipments | 51 → 24 | 100207 → 208 | 1525 → 169 |
| depth / filtered-shipments | 50 → 23 | 100206 → 207 | 1342 → 166 |
| depth / purchasing-health | 71 → 44 | 100215 → 216 | 1298 → 193 |

[run-health-cost.ts](../test/performance/procurement/run-health-cost.ts) reproduces the posted/unresolved workload. [run-lot-depth.mjs](../test/performance/procurement/run-lot-depth.mjs) reproduces the depth workload from the selected checkout; the exact same runner bytes were used for both revisions. Both require an explicit loopback disposable database and a sanitized test environment, with live database variables absent. The fixture enforces the disposable database naming boundary and the comparison wrapper verifies exact cluster, role and database ownership; callers must create a new empty database and remove it only after the child closes.

## Test coverage and failure modes

- 6086 unit cases, 356 PostgreSQL cases and 424 official CI guard cases passed, with zero skipped/todo cases in those runs.
- 46 real desktop/mobile cases cover login/session, permission denial/restoration, catalog rollback, PO/shipment/invoice navigation and committed receipt/finalization response-loss recovery. The complete discovered identity set is verified; no case identities are silently dropped.
- Application, server-test and connected-test typechecks and the production build passed at the frozen code commit. The same built frontend remained stable throughout connected acceptance.
- Added PostgreSQL tests compare single/batch complete proposals and reviews for a shared invoice, check cross-PO isolation, preserve credit filters, refresh after concurrent commits and retain one repeatable-read snapshot. A 201-shipment source read uses three six-query pages. More than 10,000 child lots are counted completely. An actual PostgreSQL read error propagates, a write is rejected in a read-only transaction, and a fresh read succeeds afterward.
- Input, malformed-routing, invalid-count, duplicate-scope, per-shipment credit overflow and foreign-evidence cases fail closed. A missing or stale fingerprint still reopens approved/reconciled exceptions; unavailable evidence cannot become healthy completion.

The first local four-shard connected attempt overlapped the financial regression suites: 35 cases passed and 11 failed only during teardown. Server logs reached database shutdown; PostgreSQL logged DROP DATABASE waiting on its checkpointer barrier, and the existing shutdown timer killed those children while deletion was still finishing. No product assertion failed in those reports. The complete suite was rerun serially after every earlier database/client closed. Source code, assertions and shutdown deadlines were unchanged; initial failures remain in the evidence rather than being counted as successful acceptance.

## Assumptions, risks and what is not proven

No live business behavior, supplier evidence, latency target or production capacity was inferred. Local timing and sampled process RSS are not production SLOs or allocation profiles. The fixture installs selected actual schemas/migrations/indexes, not a full release/bootstrap replay. Actual production role assignments, external dispatch and operator acceptance are outside these local tests. The connected navigation fixture starts its shipment in transit and has empty payment/credit/return work lists; it does not establish a connected draft-to-booked setup journey or posted payment/credit/return detail journeys. Unit/database command and authority tests remain separate layers of proof.

These measurements do not establish unbounded capacity for shipment lines, charge allocations, exception-heavy reconciliations, supplier-lineage graphs or large sales-history planning queries. Existing supplier review safety limits remain. Full health/filtered membership still scans all eligible headers; only displayed detail rows are limited. Complete economic evidence is still read within each bounded header page. Hosted Linux/Node/PostgreSQL CI has not run for this new payload.

## Next checks and historical cleanup

This closes the two previously identified, measured read-path issues: posted-PO freshness query fanout and wide provisional-lot transfer into health reads. The new payload still requires publication, hosted checks, review and deployment. Larger distributions or production latency targets require their own evidence before further changes.

Historical PO 144/149 and shipment 95/97 cleanup remains a separate evidence/repair queue. This package does not read or change live business records, apply repair previews, post journals or run production migrations. The exact owned local test cluster was stopped after zero remaining databases/connections were verified; unrelated local resources were preserved.

The managed comparison checkout remains attached because the app reports it is protected by a pinned task or workspace. No forced removal was attempted.
