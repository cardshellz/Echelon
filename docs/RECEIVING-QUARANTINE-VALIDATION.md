# Receiving quarantine validation

Reviewed base: `9c3ab37bb63fd437bad631426721b52ec453a441`, fetched on 2026-10-14. The feature remains a separate branch. Purchasing PR1771 and CI PR1784 deployment is operator-confirmed; this batch has no production deployment evidence.

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
| Migration catalog and whitespace checks | Passed before final PR namespace allocation |

The PostgreSQL total is 167 tests across eight suites. Every database run used an explicitly disposable local database, with server identity checked and the owned database removed afterward. Local PostgreSQL is version17; hosted PostgreSQL CI is separate evidence. Browser tests mock API boundaries; real PostgreSQL tests exercise backend owners independently.

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

The candidate migration must receive its actual draft PR namespace before merge/deployment; this allocation changes identity/metadata, not tested SQL semantics. Hosted CI, a deployment, controlled live workflow acceptance, historical data remediation, supplier financial resolution and recognized-lot quarantine are not established by these local checks. The overall procurement remediation remains broader than this batch.
