# Inventory cutover completion batch — September 7, 2026

## September 8 approved completion batch

The user approved the remaining **local implementation and validation**. The changes described as rejected in the historical snapshot below have now been applied and validated: **11,047 unit tests and 382 PostgreSQL integration tests passed; typecheck, build, writer-ratchet and migration-prefix checks passed.** This batch is based on `099c6402c3f5f7bd0b13b56c215d631478546b1f` and uses migrations 233–237; the original checkout's unrelated catalog/UOM changes remain untouched.

Current implementation and final test evidence are recorded in [the September 8 test handoff](INVENTORY-CUTOVER-TEST-HANDOFF-2026-09-08.md). No production activation, provider mutation, deployment, commit, push, or PR is implied by this local work.

## Earlier September 8 snapshot — superseded, retained for audit

**Still local WIP, not test-ready or deployable.** Current isolated base is `2b549baab408fa38c013c6ec8e16288e5a18dad6`; upstream now owns migration232. This batch uses233–237. No new commit, PR, push, production activation or provider request was performed. The original ten catalog/UOM edits remain outside this worktree.

The previously requested local approval covered the77-table fence and six owner registrations. Both are now implemented: `migrations/236_inventory_cutover_admission.sql`, `infrastructure/inventory-cutover-admission-fence.repository.ts:23` (`acquireInventoryCutoverFenceInsideTransaction`), and the18-line addition in `scripts/writer-ratchet/baseline.json`. Fresh actual236 PostgreSQL validation: **22 passed**.

### Additional completed local work and evidence

- Preparation retains publication drain evidence in an append-only event, not by changing immutable captured run evidence: `server/modules/inventory-planning/infrastructure/inventory-availability-activation.repository.ts:178`, `PostgresInventoryAvailabilityActivationRepository.prepare`.
- Optional absent external source/mapping references are compared as absent; a newly selected head remains drift. `assertRefs` in the same repository, line634. The complete manifest still includes external targets, but commit activates only Echelon-controlled target IDs: `infrastructure/inventory-cutover-commit.repository.ts:53`, `PostgresInventoryCutoverCommitRepository.commit`.
- Final completion repository/service/HTTP contracts and strict proof validation exist. `infrastructure/inventory-cutover-completion.repository.ts:22`, `PostgresInventoryCutoverCompletionRepository`; exact latest full-outbox/readback proof remains mandatory. Completion and recovery agent reports **273 unit/route tests passed across7 files**.
- Main cutover controls are connected to Supply Transformations. Role checks, explicit review/confirmation, exact uncertain retry requests, and paginated full-catalog evidence are covered. `client/src/pages/inventory-cutover-controls.tsx:21`, `InventoryCutoverControls`.
- Advanced recovery panel exists but is not yet mounted; its route also awaits registration. It labels manual recovery as operator attestation, not provider verification. `client/src/pages/inventory-publication-recovery-panel.tsx:14`, `InventoryPublicationRecoveryPanel`; `interfaces/http/quantity-publication-recovery.routes.ts:13`, `registerQuantityPublicationRecoveryRoutes`. Both UI suites pass: **22 tests**.
- A bounded, nonoverlapping catch-up worker exists with shutdown tests, but startup wiring did not land. `application/quantity-publication-catchup.worker.ts:11`, `startQuantityPublicationCatchupWorker`. Parent focused worker/commit/projection/route run: **72 passed**.
- Actual composition run using233–237: **13 passed,2 failed**. Positive commit/finish paths stop at the unchanged blanket engineering blocker, not a fabricated ready response. External provider transport is mocked; capture, snapshots, admission, reconstruction, publication owner, and database constraints are real. Source agent added one final external-target positive-path assertion after that run; it remains unrerun.
- Publication agent reports **5 actual237 PostgreSQL cases passed**; a separate concurrency test still needs independent asynchronous contexts. Dropship current-preview callback tests: **14 passed**. Its retry branch depends on the unlanded current-intent worker refresh and must not be wired as safe before that dependency passes.

### Rejected local changes — not applied or bypassed

The approval checker rejected two combined local patches despite the request to finish the batch. No alternate tool or split patch was used to apply their rejected contents. One consolidated explicit local-only approval request is pending for:

1. Replacing the temporary unconditional `CUTOVER_LEGACY_PUBLICATION_DRAIN_UNPROVEN` blocker with actual admission/provider-evidence checks and wiring shared publisher admission plus the recurring catch-up worker into startup.
2. Refreshing queued Dropship intents from current rules, recording group-member scope/plan lineage in237, requiring exact successful admission/current canonical outbox evidence before catch-up completion, and the bundled compiler corrections.
3. Registering the four new237 table owners in the writer baseline: `inventory.quantity_publication_attempt_resolutions`, `inventory.quantity_publication_attempts`, `inventory.quantity_publication_catchup`, `inventory.quantity_publication_gate` — all solely `modules/inventory-planning`.

These are **local implementation/test approvals only**. After deployment, incorrect wiring could allow stale/duplicate provider quantities or an unsafe cutover. No deployment, production activation, live inventory/configuration change, or provider mutation is authorized by this development approval.

### Remaining checks and explicit unknowns

- Current typecheck is not green: wrong relative runtime import in `ebay-api.client.ts` and possibly undefined `resolveCurrentPlan` in publication admission. Those fixes were part of the rejected peer patch and were not split out to bypass it.
- Migration-prefix guard passes. Writer-ratchet fails only for the four new237 table registrations above; the original six remain registered.
- Current eBay route lifecycle/group and Dropship admission seams remain incomplete. A quantity-free publish payload is not proof of a quantity-free effect: activation of a stored offer must refresh/validate current canonical member quantities first. Durable group-member lineage and exact lease-expiry/latest-revision validation are still required.
- Positive full lifecycle, stock-drift rejection, rollback after receipt insertion, same-key concurrent finish, current-quantity catch-up, and final UI registration remain to be completed/verified after local approval. **HYPOTHESIS from code review:** finish checks replay before waiting on the exclusive fence, so a concurrent same-key call may fail after the first releases the freeze; the real regression is prepared but cannot yet pass the blanket blocker.
- No fresh full unit/build/remote CI success is claimed. September7 full-suite/build results below are historical, not validation of these later edits. `git diff --check` passed this continuation.
- All agents ended their local test processes. Before stopping the owned55487 PostgreSQL cluster, its exact data path/port were verified and `pg_stat_activity` showed zero other client backends. The cluster was stopped; its data directory is retained for the next approved test run.

## Historical September 7 record

## Status and authority boundary

**Development batch in progress; not deployable or activation-ready.** This is one coordinated batch, not a request for another intermediate deployment. Three agents worked on reconstruction, shipment compatibility/publication, and cutover evidence while the parent integrated preparation/projection/commit contracts.

Worktree: `C:/Users/owner/Echelon/worktrees/inventory-cutover-final-batch`.
Branch: `codex/inventory-cutover-final-batch`.
Base commit: `213a50cce0b4e6322df7166db24ab75c902db9d5`.

During this investigation PR #1409 changed from open to merged. GitHub reports its merge commit as `0a81cdc38a63d7ee6bc81af9b5767fe1ed904ffa`; the base tree above matches that merged `origin/main` tree (`git diff --quiet HEAD origin/main`). **The uncommitted work described here is not in PR #1409.** No new PR, commit, push, deployment or production activation was performed.

The original checkout remains on `codex/catalog-piece-uom` with its ten unrelated tracked catalog/UOM changes. Those files were not edited by this batch. The clean-worktree procedure kept this work isolated; dependencies were installed separately.

No production inventory, recipes, configuration, ATP, reservations, channel quantities, credentials or orders were queried or changed. PostgreSQL verification used an owned disposable local cluster on port 55487, which was stopped after testing; its data directory is retained. The compatibility agent removed only its named disposable database `echelon_final_operational_pub_test`. Results below are code/test evidence, not a live-data readiness assessment.

## What the code definitely does

Paths below are relative to the worktree above. Lines identify the relevant function/entry point in this batch.

| Area | Implemented behavior | Evidence |
| --- | --- | --- |
| Legacy demand/custody reconstruction | Captures accepted demand, reservations, picked custody, lots, source/physical shipments, build holds and original costs; rejects ambiguous ownership instead of inventing it. | `server/modules/inventory-planning/domain/inventory-cutover-reconstruction.ts:34`, `planCutoverReconstruction`; `infrastructure/inventory-cutover-reconstruction.repository.ts:26`, `capture`, and `:51`, `persistReviewed` under the same module. |
| Shared fresh-demand planning | Preview and commit call the same pure planner. Each order sees reservations added for earlier orders, avoiding repeated promises against the same free stock. | `server/modules/inventory-planning/domain/inventory-cutover-reconstruction-planning.ts:14`, `planFreshCutoverClaims`. |
| Preserve original picked stock | Imports existing claim ownership without decrementing already-picked stock or rewriting historical customer cost. Only uncovered demand adds new reservations. | `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:3993`, `persistReconstructedCutoverClaim`; `migrations/233_inventory_cutover_reconstruction.sql`. |
| Complete a partial pick correctly | Completing a six-unit line with two already picked moves only four additional units. Locked claim custody and WMS progress must agree; replay does not debit again. | `server/modules/orders/picking.use-cases.ts:1294`, `completeCanonicalPick`; `server/modules/wms/order-item-commands.ts:359`, `persistCanonicalWmsPickProgress`; real import-to-picker test in `server/modules/inventory-planning/__tests__/integration/inventory-cutover-reconstruction.integration.test.ts`. |
| Replacement/concession shipment | Uses a separate inventory owner to consume available unreserved stock and exact lot cost, without consuming another order's picked/reserved stock or reusing the original customer COGS. Stock, immutable dispatch evidence and desired channel publication share one transaction. | `server/modules/inventory/infrastructure/operational-shipment-dispatch.repository.ts:33`, `dispatch`, including callback at `:127`; `server/modules/inventory-planning/infrastructure/inventory-availability-dispatch-publication.ts:12`, `publishOperationalShipmentInsideTransaction`; composition in `server/services/index.ts:184`. |
| Historical shipment compatibility | Canonical zero-on-hand-delta shipment receipts remain readable and materializable; negative legacy shipment evidence remains a separate supported path. Full unpick clears stale source-bin planning hints. | `migrations/234_inventory_canonical_shipment_compatibility.sql`; `server/modules/inventory/infrastructure/shipment-quantity-evidence.sql.ts`; `server/modules/wms/order-item-commands.ts`, `persistCanonicalWmsPickProgress`; PostgreSQL suites listed below. |
| Proposed final quantities | Preparation and review project ATP after adopting existing ownership and allocating fresh accepted demand. Demand-only graph definitions must also belong to the reviewed manifest. Planner/census blockers are reported without silently truncating demand. | `server/modules/inventory-planning/infrastructure/inventory-cutover-projection.repository.ts:16`, `projectInventoryCutoverStateInsideTransaction`; `inventory-availability-activation.repository.ts:82`, `prepare`. |
| Exact review evidence | Validates immutable snapshot fingerprints and selected model/policy/mapping identities. Publication proof requires complete target/SKU coverage, exact destination identities, bounded integer quantities and fresh readback after acknowledgement. | `server/modules/inventory-planning/domain/inventory-cutover-manifest.ts`, `buildInventoryCutoverManifest`; `domain/inventory-cutover-publication-proof.ts`, `validateInventoryCutoverPublicationProof`. |
| Cutover command skeleton | Defines authenticated, permission-gated review/commit commands, stale-evidence rejection, selected-definition promotion, reconstruction, authority CAS, transactional full publication and immutable receipts. It is deliberately blocked before activation. | `server/modules/inventory-planning/infrastructure/inventory-cutover-commit.repository.ts:23`, `commit`; `interfaces/http/inventory-cutover-commit.routes.ts`, `registerInventoryCutoverCommitRoutes`; `migrations/235_inventory_cutover_commit_evidence.sql`. |

### Concrete PostgreSQL examples

1. **Adopt two picked units, then finish a six-unit line:** the importer preserves the original two-unit pick/cost evidence. Actual canonical picking moves only the remaining four: on-hand 20 → 16, reserved 4 → 0, picked custody 2 → 6. Retry creates no extra movement. This is tested with real inventory/WMS owners, not just mocked arithmetic.
2. **Replacement shipment updates ATP atomically:** the actual operational dispatcher calls the production publication callback and canonical planner. Inside the transaction the desired channel quantity changes from 7 to 4; another connection still sees 7 until commit. A forced later failure rolls back stock, dispatch receipt and outbox together. Successful commit exposes 4; replay adds neither another debit nor another publication.

Evidence: `server/modules/inventory-planning/__tests__/integration/inventory-cutover-reconstruction.integration.test.ts`, test "commits imported partial custody then picks only the four remaining units with real owners"; `server/modules/inventory-planning/__tests__/integration/inventory-availability-foundation.integration.test.ts`, test "plans and revises canonical runtime publication atomically against PostgreSQL".

## What is likely happening

**HYPOTHESIS — not a production finding:** direct listing maintenance or asynchronous listing work could overwrite a conservative quantity after its readback. The executable code paths exist, but this turn did not inspect production enablement, pending jobs or provider state. No actual oversell incident is attributed to them here.

The code-level gap itself is confirmed: the configuration freeze does not suppress later legacy callbacks, and some quantity-capable eBay/dropship listing calls bypass the authority-pinned publisher. Final review therefore always reports `CUTOVER_LEGACY_PUBLICATION_DRAIN_UNPROVEN`; the commit owner refuses a blocked review. See `server/modules/inventory-planning/infrastructure/inventory-cutover-review.repository.ts:38` and `inventory-cutover-commit.repository.ts:40`.

Detailed trace: [Publication drain evidence](./INVENTORY-CUTOVER-PUBLICATION-DRAIN-EVIDENCE-2026-09-07.md).

## What is not proven / remaining engineering

1. **Global write exclusion is not implemented.** The TypeScript fence contract exists, but migration `232_inventory_cutover_admission.sql` was rejected by the approval check and does not exist. Preparation now calls its planned database function. Deploying this WIP would therefore break preparation. No fallback or substitute production function was installed.
2. **Provider publication cannot yet be considered drained.** All quantity-capable listing/update paths must join the same publication admission lifecycle. Suppressed work must be durable, and both successful cutover and abort need explicit catch-up. A fresh readback alone is insufficient; a database lock cannot recall an HTTP request already sent.
3. **Final operator workflow remains incomplete.** Final review/commit routes exist; the end-to-end UI, post-full-publication verification/recovery and release of the configuration freeze still need implementation and proof. The current commit receipt explicitly records publication verification as `pending`; it must not be treated as completion.
4. **Full cutover composition/concurrency is unproven.** Reconstruction PostgreSQL fixtures stub admission-assertion plumbing and snapshot capture. They prove adoption and real owner behavior, not the missing cross-module fence or complete activation transaction. Migration 235 and the full prepare → review → commit → verify/release lifecycle still need real PostgreSQL integration tests.
5. **Live-data compatibility is unknown.** Ambiguous per-order lot ownership, packed/partially shipped custody, residual terminal custody, unresolved/ignored shipment review receipts, unsupported legacy build handoffs, existing canonical claims, and accepted OMS demand not represented in WMS block adoption. The current shared claim snapshot capture bounds unique target variants at 500; exceeding it must be resolved in engineering, never worked around by selecting a partial catalog.
6. **Not all integration tests were run.** Narrow PostgreSQL suites and one existing real-planner foundation case were exercised. The complete database/CI matrix remains required before any PR is declared ready.

## Approval check blockers — local development only

Two operations were explicitly rejected; neither was retried through another tool or workaround:

- Creating the proposed admission/configuration fence migration across **77 tables** (34 configuration, 43 operational). Intended behavior is to coordinate writes during the final switch and protect relevant configuration during preparation. Risk: incorrect trigger coverage, conditions or lock ordering could block legitimate warehouse/order/configuration writes after deployment. Exact table manifest: `server/modules/inventory-planning/domain/inventory-cutover-admission-fence.ts`, `INVENTORY_CUTOVER_CONFIGURATION_TABLES` and `INVENTORY_CUTOVER_OPERATIONAL_TABLES`.
- Regenerating the writer-ratchet baseline for the six intended new owner registrations below. Risk: a broad regeneration could silently approve unintended database writers. The baseline was left unchanged; the guard remains red.

| Table | Intended sole module registration |
| --- | --- |
| `inventory.availability_cutover_commits` | `modules/inventory-planning` |
| `inventory.availability_cutover_pick_sources` | `modules/inventory-planning` |
| `inventory.availability_cutover_reconstruction_receipts` | `modules/inventory-planning` |
| `inventory.availability_runtime_authority` | `modules/inventory-planning` |
| `inventory.operational_shipment_dispatch_lots` | `modules/inventory` |
| `inventory.operational_shipment_dispatch_receipts` | `modules/inventory` |

Approval sought is to develop/review/test the migration and these exact registrations locally. It is **not** permission to deploy, activate production, mutate live inventory or publish channel quantities. Approval also does not replace the unfinished engineering checks above.

## Verification record

- `npm run check`: passed after the main integration changes.
- `npm run build`: passed; emitted the existing large-bundle warning (client bundle exceeds 500 kB).
- Full `npm run test:unit`: **10,411 passed, 37 skipped, 1 failed** across 957 files. Sole failure: `server/__tests__/unit/writer-ratchet.test.ts`, the six unapproved registrations above. No other unit failure remains in that run.
- Focused projection/publication transaction regression suites: 30 passed, including conservative-versus-full outbox evidence and rejection of unfenced read-committed callers.
- Agent reconstruction validation: 134 passed across six suites, including ten PostgreSQL tests with the fixture limits described above.
- Agent manifest/fence-contract/publication-proof/route validation: 206 passed across six suites. These do not prove the missing migration-backed fence.
- Latest compatibility validation: 56 PostgreSQL tests passed (operational dispatch 21, omission materialization 14, unpick 15, historical quantity reader 6), plus 48 focused unit tests. The production operational-dispatch → canonical-planner → outbox composition case passed separately (one foundation case selected; 41 others excluded by the name filter).
- `git diff --check`: passed; line-ending warnings are Git working-copy normalization notices, not test failures.
- Migration-prefix collision guard passed in the full unit run. New accepted local migrations are 233, 234 and 235; 232 remains absent. Existing migrations were not renamed.
- CI entries added for the reconstruction and three new compatibility PostgreSQL suites; **remote CI has not run for this uncommitted batch**.

## Next checks and failure modes

Keep this as one completion batch. Once local-development approval is available: complete the actual fence, close every quantity publisher/catch-up path, implement final operator verification/recovery, and prove the combined lifecycle before preparing a reviewable PR. Do not create a series of tiny deployment requests merely to finish those connected pieces.

Required failure tests include concurrent inventory/order/configuration writers, stale snapshots, changed graph/demand, malformed or incomplete custody, partial picks, duplicate commands, provider success followed by persistence failure, stale/mismatched readbacks, aborted preparation, outbox retries/supersession, and rollback after any owner write. A canonical switch must not regain a legacy mutation fallback after commit. Any future production activation remains a separate, explicit decision supported by a fresh read-only census and provider evidence.
