# Receiving quarantine validation

Reviewed base: `9c3ab37bb63fd437bad631426721b52ec453a441`, fetched on 2026-10-14. The feature remains a separate branch. Purchasing PR1771 and CI PR1784 deployment is operator-confirmed; this batch has no production deployment evidence.

Publication incorporates main `3aa15cd601e1e77a09f6c5e1487a967e8ba58340`; the only intervening changes are the Shopify line-item discount normalizer and its test. Draft PR1789 allocates `900000004000017890001_receiving_quarantine.sql` with generated ownership/dependency metadata. Its SHA256 remains `14e13ba62f62a52e54ab86c52bda668b960b7d7d2237dfbb30e7ceb9b11f7ea2`, identical to the fully tested candidate.

## Changes and assumptions

The new receiving panel records accepted/held counts, unidentified goods and immutable custody evidence. Normal receiving owns acceptance and cost posting. Physical returns do not create supplier credits. Inventory counts/manual additions cannot turn held physical goods into available stock. See `RECEIVING-QUARANTINE-WORKFLOW.md` for release sequencing and recovery.

No historical damaged-count interpretation is assumed. Operators must explicitly review current physical counts. Existing catalog, purchasing, receiving and financial-command owners supply identity, costs, transaction boundaries and retry authority. This batch covers pending recognition; it does not implement quarantine of already recognized lots.

## Executed local checks

| Check | Result |
| --- | --- |
| Entire procurement unit directory | 201 files; 2,659 passed, 14 existing skips |
| Inventory unit directory plus legacy/canonical count suites | 91 files; 947 passed |
| Early CI guards plus writer ownership guard | 6 files; 196 passed |
| Custody commands with real PostgreSQL and normal receiving/cost owners | 20 passed |
| Receiving integrity with activated quantity ledger | 12 passed |
| Frozen units, close, reversal and concurrency PostgreSQL regressions | 26 passed |
| Existing receipt/AP/freight cost PostgreSQL regressions | 45 passed |
| Existing complete RFQ/partial receipt/sale/late freight flow | 3 passed |
| Inventory quantity ledger PostgreSQL regressions | 46 passed |
| Canonical picker observation PostgreSQL regressions | 5 passed |
| Custody count/fence/catalog-identity PostgreSQL regressions | 10 passed |
| Desktop/mobile receiving, quarantine and navigation browser acceptance | 104 passed on refreshed base |
| Application, server-test and client-test TypeScript projects | Passed |
| Direct strict typing of new browser fixture/spec | Passed |
| Production client/server build | Passed; existing large-bundle warning remains |
| Migration catalog and whitespace checks | Allocated catalog passes: 514 migrations, base `origin/main`, owner PR1789 |

The PostgreSQL total is 167 tests across eight suites. Every database run used an explicitly disposable local database, with server identity checked and the owned database removed afterward. Local PostgreSQL is version17; hosted PostgreSQL CI is separate evidence. Browser tests mock API boundaries; real PostgreSQL tests exercise backend owners independently.

After PR1789 allocation and the current-main merge, all six suites that load the renamed SQL passed again: 116 PostgreSQL tests (20 custody, 12 receiving integrity, 26 frozen-unit/reversal, 45 cost, three complete-flow and ten count/fence cases). The six early/writer guard suites plus the incoming Shopify normalizer regression passed 213 tests, and the server-test TypeScript project passed again. Both the SQL SHA256 and Git blob identity match the approved candidate; Git records a 100% rename. No application behavior was changed by allocation.

The final procurement unit command was `npx vitest run server/modules/procurement/__tests__/unit --maxWorkers=2 --allowOnly=false --passWithNoTests=false`. TypeScript checks use sufficient heap for the repository's existing large graph; a default4GB attempt exhausted memory before completing. The subsequent8GB application and server-test checks passed. No typecheck failure was suppressed.

## Independent review corrections and failure coverage

- Canonical source resolution now precedes immutable intake. Legacy PO receipts missing an unambiguous line link can still close and later accept held goods, including all-held intake.
- Composite variant/product foreign keys prevent a catalog reparent from hiding held goods from counts or changing prepared ownership.
- Exact source selection includes counts, units and cost provenance. A cost edit with an unchanged timestamp invalidates the reviewed option.
- Unknown failures preserve the command key. A missing-fence503 remains retryable; repair followed by the same request succeeds and subsequently replays without another mutation.
- Normal receipt close and custody completion commit together. Failed close, invalid source mapping and invalid conversion leave custody held and roll back prepared effects.
- Original custody/history, protected source counts, catalogue ownership and acceptance source cannot be silently changed or deleted. Successful normal reversal remains additive and exact-once.
- Count tests cover unchanged and positive counts, sibling pack variants, unidentified goods, pending acceptance, absent fence, autocommit misuse and an obsolete serializable snapshot.
- Desktop/mobile tests caught and corrected obscured normal count controls and ambiguous selector labels. Related target receipts now display the origin and link to its resolution controls.

## Risks and remaining evidence

The persisted custody fence follows the existing global cost-graph lock; throughput was not benchmarked. The migration must precede new code, and old count/receiving writers must be drained before custody operations begin. Rollback after custody exists requires preserving its protections and history.

The migration has its actual PR1789 namespace; allocation changed identity/metadata and fixture references while preserving SQL bytes. Hosted CI, a deployment, controlled live workflow acceptance, historical data remediation, supplier financial resolution and recognized-lot quarantine are not established by these local checks. The overall procurement remediation remains broader than this batch.
