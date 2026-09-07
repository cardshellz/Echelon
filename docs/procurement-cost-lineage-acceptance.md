# Procurement cost contribution capture acceptance

This workstream records new physical lot transformations for the integrated procurement build. It depends on the undeployed migration `222_procurement_cost_evidence.sql` and the inventory cost evidence owner. It does not reconstruct historical edges, apply source revisions, activate inventory claims, or post external accounting data.

## What the code definitely does

| Physical owner | Evidence recorded in the existing transaction |
| --- | --- |
| `InventoryLotService.transferLots` in `server/modules/inventory/lots.service.ts` | Each actual FIFO source layer has one destination lot and one immutable contribution. Source and output quantities equal the transferred layer quantity; the output interval starts at zero. The destination retains existing component costs, receipt metadata and provisional state. It is not recorded as another purchased quantity or origin. |
| `BuildExecutionRepository.executeInTransaction` in `server/modules/inventory/infrastructure/build-execution.repository.ts` | Actual consumed quantities are accumulated by source lot. Every produced cost layer records every contributing input, the total run output quantity, and the layer's starting output position. Edges use the persisted build run ID, posted actor (or explicit system actor), and durable run creation time. Existing successful command replay returns before adding new edges. |
| `PostgresCanonicalClaimInventoryRepository.executeTransformationOperation` in `server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts` | Break, assembly and build output segments record all exact consumed claim lots. Committed and surplus segments use the same total operation denominator and consecutive output offsets. Claim and operation IDs form the operation key; the owning command supplies actor and time. Existing duplicate source validation, quantity guards and cost snapshot reconciliation remain enforced. |
| `costEvidenceTransactionFromPg` in `server/modules/inventory/infrastructure/cost-evidence-pg.ts` | The shared parameterized SQL cost evidence helper executes through the already-owned `pg` client. No new connection or independently committed evidence write is introduced. Non-SQL queries are rejected. |

`recordLotCostContribution` owns validation, cycle prevention, immutable insertion and its database constraints. The new call sites supply source quantities for the whole operation, not quantities apportioned separately to each destination. `outputQty` is the full operation output; `outputStartQty` identifies the destination's interval within that output. This retains the information needed to allocate integer remainders across output layers during later corrections.

## Lock ordering

The shared transaction advisory cost graph lock is taken before cost reads and physical locks. It is acquired at the beginning of standard build execution, canonical build ownership, and canonical physical transformation. In `PostgresInventoryAvailabilityClaimRepository.executeBuildOperation` and `executePackageOperation`, it is also acquired immediately after `BEGIN`, before catalog, order, claim or inventory locks. These earlier owner calls prevent a later inventory helper from introducing an inverse lock order.

The root inventory transfer use case must acquire the same lock before location locks and supply `actorId` and `occurredAt` to `transferLots`. That caller change is owned by the integrated workstream; the contribution-capture commit must not be released alone against the older caller. The service repeats the lock before its source read for direct transactional callers. The method retains its existing requirement to execute inside its physical owner's transaction.

## What is likely happening

No production frequency, financial impact or historical completeness is inferred. The tests establish behavior for synthetic inputs through the actual transfer, standard build and canonical transformation repositories. They do not establish that production inventory already has complete purchase origins or transformation edges.

## Validation

- `npm run check` passed.
- Five focused unit suites passed 99 tests: transfer layers and input/audit failures, canonical physical transformation, canonical build ownership, claim execution repository, and build repository contracts. Assertions cover graph-before-read/lock ordering and remainder segment offsets.
- Seven real disposable PostgreSQL cases passed in `server/modules/inventory/__tests__/integration/cost-lineage-owners.integration.test.ts`. The fixture applies actual migration 222 and derives physical table columns from the Drizzle schema. Cases prove exact transfer edges, immutable edge rejection, full transfer rollback on an injected edge insertion failure, waiting on a concurrent graph owner before reading changed costs, standard build input/output edges and replay, and canonical break/assembly/build output segments.
- The standard build fixture consumes two lots containing five units worth 625 integer mills and produces four units in layers of one and three. It verifies all source/output edges, offsets zero and one, preserved total value, and no duplicate edges on replay. Canonical committed/surplus output uses offsets zero, one and three and also preserves 625 mills.
- The standard build integration test injects catalog variant facts only. It executes real inventory, build, reservation, ledger and contribution database queries. Canonical integration cases exercise the physical writer directly with exact claim inputs; upstream claim authority and recipe validation are covered by focused unit tests, not claimed as full PostgreSQL command integration here.
- Writer ratchet passed two checks and failed the new-writer baseline check for the foundation's three new tables (`lot_cost_contributions`, `lot_cost_origins`, `cost_source_revisions`). All three are attributed to `modules/inventory`. The integrated root workstream owns the reviewed baseline update; this workstream does not regenerate it.
- The PostgreSQL suite used the explicitly disposable local database with a coordinated lease. Its owned schemas were removed after the successful run. No production database was used.

## Assumptions, risks and failure modes

- Deployment includes migration 222, its output interval column, the root transfer caller changes, and the integrated writer baseline. Missing tables or missing transfer audit data fail the command; they do not silently omit evidence.
- A contribution write failure propagates through the physical transaction and rolls back the movement. Existing source quantity and reservation guards remain intact. New transfer boundary validation rejects non-integer, nonpositive or out-of-range identifiers/quantity, missing audit data, equal locations and blank optional operation keys before database work.
- The common graph lock serializes graph mutation with cost application. Full integrated owner lock ordering and opposing AP/physical operation tests remain the root workstream's responsibility.
- Existing canonical cost snapshots remain immutable: `executeTransformationOperation` throws `CLAIM_LOT_COST_CHANGED` when the current lot differs from the reserved claim cost snapshot. An AP correction may therefore require claim replanning. This workstream does not silently rewrite those snapshots.
- Historical transformations, reversal interpretation and revaluation of sold quantities remain separate work. New edges do not prove a legacy lot's purchase origin. Unrepresentable cost remainders require the cost application's explicit review outcome.

## What is not proven and next checks

- Receipt origin capture, source application, sold-order COGS, reporting events, replenishment and legacy break/assembly capture are implemented and validated by other integrated workstreams.
- Observed picker relocations are now included: `pickClaimLine` takes the graph lock immediately after `BEGIN` for observation commands, and `reconcileObservedPickResource` takes it before physical reads and records a one-to-one transfer edge for each actually relocated source layer. Existing target inventory that only changes reservation owner does not receive a fabricated transfer edge. The contribution key contains the claim ID and validated observation request hash. All 73 focused canonical physical/planning tests and all five real PostgreSQL picker-observation tests passed; the latter loads the contribution DDL from migration 222 and verifies the exact source/output edge. Its earlier fractional-cent fixture was corrected to the production integer-cent column types and mirrors. The earlier inventory observation method can still create adjustment lots without proven purchase origin; origin evidence must not be invented.
- No inventory claim activation, carrier tracking, availability policy or production financial correction is included in this workstream.
