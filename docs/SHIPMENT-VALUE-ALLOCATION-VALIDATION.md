# Shipment value allocation validation

Base: `a18a6501dde0ba9457aaf08ca3c542285b2fc8c1`, fetched and rechecked on 2026-10-14. Scope is F18 exact PO-value shipment allocation and its source/snapshot/close compatibility. No production database was accessed or changed.

## Executed evidence

| Check | Result |
| --- | --- |
| Complete procurement unit directory after all corrections | 202 files; 2,733 passed, 14 existing skips |
| Focused allocation/close/domain/audit units | 129 passed; subsequent lock regressions included in the full suite |
| New real-PostgreSQL exact value suite | 15 passed |
| Existing receiving-cost application | 45 passed |
| Existing RFQ, partial receipts, sale and late freight flow | 3 passed |
| Shipment cost commands | 40 passed |
| Shipment line commands | 52 passed |
| Procurement cost evidence | 5 passed |
| Cost reporting | 9 passed |
| Purchase workspace | 12 passed |
| Receiving close integrity | 12 passed |
| Receiving frozen-unit/reversal integrity | 26 passed |
| CI manifest, migration, browser selection and writer guards | 253 passed |
| Desktop/mobile exact value and shipment cost summary | 18 passed; no skips or retries |
| Application, server-test, client-test TypeScript projects | Passed; application and server-test checks rerun after the final command-lock correction |
| Production client/server build | Passed; existing large client bundle warning remains |

The PostgreSQL total is 219 across ten suites. The final command-lock rerun passed all107 cases in the new15-case suite and existing40-case cost and52-case line suites. The new suite verifies the 490/500-cent duty split, partial quantity ratios, known-zero fallback, absent/invalid/foreign-currency sources, explicit legacy reallocation, stale PO evidence, transactional rollback, and replay. Its receipt/sale/late-duty case conserves 1,980 cents: 1,882 inventory plus 98 sold COGS. Repeated commands and concurrent financial application do not duplicate writes.

The two direct-command race cases use real durable cost/line owners. PostgreSQL blocking evidence proves that each waits on a held cost-graph lock before taking the shipment row. A source-update fixture follows the actual PO amendment lock protocol, commits a new product total and ordered quantity, and the command then captures consistent new allocation/snapshot evidence. This verifies the lock protocol, not the entire amendment HTTP workflow. The candidate migration is installed in the new suite; both evidence columns accept legacy SQL NULL and generated v2 objects, and reject malformed JSON/version values.

Every database run used an explicitly disposable local PostgreSQL17 database with verified server identity; test databases were removed after use. The new receipt/sale case exercises the existing pre-opening quantity authority; it does not independently certify the activated quantity-ledger workflow. Browser tests mock API boundaries and exercise the real page. They complement the backend database tests; they do not establish a deployed end-to-end result.

## Review corrections

- Readiness validates the product source even when freight uses dimensions, line count, zero charges or no charges: finalization still creates product snapshots. Invalid sources are visible before the command. Existing orphan handling remains.
- Frozen exact snapshots ignore later PO price changes and reject a forged product ratio. Source evidence and allocated cents are compared against current authority before financial application.
- Historical PO-less shipment tests retain their known freight charge but now expect an unknown combined total. No zero product value is invented; prior concurrency, rollback and review assertions remain.
- The decimal-to-integer ratio helper uses bounded BigInt multiplication compatible with the repository's existing TypeScript target. No compiler target was changed.
- Closed-shipment audit history distinguishes a legacy product projection recalculation from changes in allocated charges. The persisted legacy case records its490-cent product-only difference, preserves original source revisions and existing stock/COGS, and creates no additional adjustment on repeated finalization. Malformed frozen evidence blocks replacement even when the monetary totals are unchanged.
- Both direct HTTP command entrypoints take the graph lock before source reads and shipment locks. Owner-level deferred-lock tests complement the real database barriers. AP link/unlink/void and PO amendment lock order were traced to the same graph-first order.

## Commands and limits

Use `node node_modules/vitest/vitest.mjs run server/modules/procurement/__tests__/unit --maxWorkers=2` for procurement units. The new database suite is registered in `scripts/ci/postgres-test-manifest.ts` and protected by `postgres-ci-shards.test.ts`; use the configured disposable database runner. Procurement Playwright discovery and CI selection include `procurement-allocation-value.spec.ts` without another workflow.

TypeScript checks run the application and both test projects. The existing server graph exceeded the default4GB heap; the8GB rerun completed. No diagnostic or failing assertion was suppressed. The first new database run exposed an incomplete test financial-command descriptor, which was corrected to use its canonical scope. The first legacy command run exposed the intentionally changed unknown-total expectation described above; its40-case rerun passed.

PR1792 allocates `900000005000017920001_shipment_exact_value_basis.sql` after `900000004000017890001_receiving_quarantine.sql`. The candidate and allocated SQL have identical SHA256 `d6444a634c30946966dab58a5df9e0692f98d233e0e7d58378df37cce083e2a1`; the fixture uses the allocated path. Publication includes current main `760bb9dea1f974c72ef4c1050a3f35c73f31526d`, whose only intervening change is the separate Shopify coupon-boundary correction. Hosted CI, deployment, historical live repair and integrated production acceptance remain distinct outstanding proof states. F19 shared-invoice attribution, F21 void/replacement recovery and F23 durable close recovery are not resolved by this batch.

After allocation and the current-main merge, the affected15-case PostgreSQL suite,411 guard/incoming-main cases, all18 browser cases and all three TypeScript projects passed again. The515-migration catalog validates against `origin/main` with owner PR1792. SQL Git blob `bf5308fa18b0d7a476b335e1afa75e6e0f34a5b5` also matches the approved candidate. The disposable database was removed and its verified, otherwise-idle PostgreSQL cluster stopped cleanly. No production code from the approved F18 commit changed during allocation.
