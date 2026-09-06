# Assembly execution: single-order gun to bench

## Status and scope

Local implementation on `codex/wms-assembly-execution-ui`; no PR or deployment created by this continuation. No production data, inventory, recipes, roles, station configuration, ATP authority, channel settings, or replenishment rules were changed.

PR #1382 is the preceding assembly-backend PR: https://github.com/cardshellz/Echelon/pull/1382. Its merge is `f2cfb4b235e08451406bad727309954e28dcc788`; deployment was reported by the user, not independently verified here. This worktree was created from that merge and subsequently fast-forwarded to `5e689cfda193061ef25eb73651aee2dbfcb8a154` after verifying incoming files did not overlap. PR #1384 belongs to the separate warehouse-source-setup workstream, not this implementation.

**This is not full outbound completion or ATP activation.** It connects supported whole-line root component builds to the single-order gun, assembly queue, and explicit finished-output pick. Packing close, label binding, mixed/partial quantity custody, recovery/reassignment, nested dependency handoffs, and batch-gun handoffs remain separate work.

## What the code definitely does

| Conclusion | Exact evidence and reasoning | Still unknown / limitation |
| --- | --- | --- |
| Shows committed build instructions, not a new ATP formula | `server/modules/warehouse/work/application/assembly-execution.service.ts:50`, `AssemblyExecutionService.order`, reads the canonical reservation projection and catalog component identities, then checks exact station material/output bindings. | Actual production plans, station bindings, and role grants were not queried. |
| Adds a work-only handoff to the single-order gun | `client/src/pages/Picking.tsx:4221`, `Picking`, renders `AssemblyHandoffPanel`; `client/src/pages/warehouse-work/AssemblyHandoffPanel.tsx:12`, `AssemblyHandoffCard`, submits the existing canonical handoff command. Successful queue removal never invokes release or ready-to-ship. | Batch mode is not connected. Printing remains the existing ShipStation process. |
| Separates picker workload from physical pick completion | `server/modules/orders/picking.use-cases.ts:3344`, `getPickQueue`, uses `AssemblyExecutionService.handedOffOrderIds` (`assembly-execution.service.ts:175`) and pure `isFullyHandedToAssembly` (`work/domain/assembly-picker-coverage.ts:12`). Only wholly covered, active canonical full-line builds qualify; other physical lines must already be fully picked. | This is a read projection, not a new order status or quantity-level custody ledger. Original picker assignment remains attribution; direct claim APIs were not redesigned. |
| Keeps exact worker responsibility | `client/src/pages/warehouse-work/AssemblyWorkPage.tsx:17`, `AssemblyJob`, separates receive/start, complete assembly, and finished-goods pick. Existing `AssemblyWorkService.command` and `complete` remain the work/build writers. | Acknowledgment is not a barcode scan or provider-label verification. No packing completion action is added. |
| Posts output picking through canonical ownership | `AssemblyExecutionService.pickOutput` (`assembly-execution.service.ts:151`) constructs strict-location canonical pick input from immutable job identity and original request fields. `inventory-availability-claim.repository.ts:5055`, `pickClaimLine`, verifies producer-operation lineage and calls `AssemblyWorkOwner.authorizeOutputPick` (`assembly-work-owner.ts:32`) before committing WMS progress and the canonical receipt. | Actual database contention/rollback proof for the new fence remains CI work. Existing full-line WMS picking restrictions remain in force. |
| Adds no competing inventory writer | `server/modules/wms/assembly-output-pick-command.ts:10`, `recordAssemblyOutputPickLocation`, records only location/zone on the completed matching WMS line, using the canonical caller's transaction. Canonical stock/lot/COGS writes remain with their existing inventory owner. Writer-ratchet passed without adding a writer baseline entry for this work. | Failure after the WMS update must roll back the enclosing transaction; isolated PostgreSQL coverage is prepared but not locally executed. |
| Corrects the deployed item-hold type mismatch | `shared/schema/orders.schema.ts:132` defines order hold as integer; `:243` defines item hold as boolean. `requireAssemblyOrderAuthority` (`server/modules/orders/assembly-handoff-authority.ts:22`) now requires item hold `false`; `lockAssemblyOrderForWork` (`assembly-work-order-lock.ts:19`) does the same. Fixtures now use the real boolean column type. | Production occurrence/frequency is not established. The prior integer fixture could not detect this mismatch. |
| Does not imply shipment readiness | `AssemblyJob` explicitly distinguishes assembled, picked, packing, and dispatch. Existing `PickingUseCases.markReadyToShip` / `getReadyToShipBlockers` and `shipping-engine/application/packing.service.ts`, `getPackingQueue`, are unchanged. | After bench pickup, the order header may still need its existing ready-to-ship transition. There is no new assembly-to-packing close path in this slice. |

## Supported example

An order needs two P5 units. Its active canonical plan commits one root component-build operation producing two P5 from ten EA. Materials already sit in the configured assembly material location and the plan names the configured finished-output location.

1. The assigned picker sees **2 P5 / 10 EA** and a permitted matching assembly destination on the single-order gun. No guessed conversion, substitute recipe, material transfer, or build-time calculation is introduced.
2. The picker prints the label in ShipStation as before and sends the assembly job. The system records queued work, not physical receipt or a pick. The picker physically passes the label/instructions to the area.
3. If this accounts for all remaining physical work, the order leaves the gun's queue projection. It remains assembly work; stock and WMS picked quantities are unchanged by handoff.
4. A permitted assembler opens the job, acknowledges receiving the matching order's label/instructions, and starts it. Preview alone does not assign work.
5. The assembler enters the complete actual output quantity and confirms the finished units exist. The existing canonical build command consumes/produces stock and completes the assembly task atomically. Incomplete output requires blocking the job, not falsely completing it.
6. The assigned assembler, with picking capability as well as assembly capability, separately confirms physically picking the two finished P5. The canonical pick validates job/version/order/location/producer identity and WMS compare-and-set progress in one transaction.
7. The screen shows the line picked, **not packed or dispatched**. Existing label handling continues; connecting audited packing completion is the next outbound slice.

This example assumes a satisfied full-line root build, an active canonical claim, correctly configured real locations, and current role/scope permissions. It is not evidence that these conditions are enabled in production.

## Contracts, locking, and failures

- Published Zod DTOs live in `shared/warehouse-assembly-execution.ts`. HTTP endpoints use session identity, strict input validation and validated responses in `server/modules/warehouse/work/interfaces/assembly-work.routes.ts`, `registerAssemblyWorkRoutes`.
- The new screen is `/assembly`, gated by `warehouse_work:assembly`. Role permissions and warehouse/station scope remain independently enforced. Output picking requires current picking scope even on receipt replay. No grants are automatically added.
- Preauthorization read transactions finish before entering canonical writes. The canonical writer retains authority/graph/order/item/claim/resource/inventory locking before the work-owner callback acquires warehouse/identity/location/task locks. The callback does not start a second stock transaction. Failed lineage, scope, version, hold, WMS progress, or receipt persistence must reject/roll back; existing receipts remain idempotent.
- `assembly-api.ts`, `prepareAssemblyAttempt` and `use-assembly-command.ts`, `useAssemblyCommand`, retain the original command ID/body for an uncertain retry while the component remains mounted. No automatic physical retry is scheduled. A browser reload loses this in-memory request handle; refresh and inspect persisted job/pick evidence before another action. Server version/progress and canonical command fences still apply.
- Paused stations remain visible for reviewing/finishing already-started responsibility. New starts still obey the existing station-acceptance guard. Released/replaced claims stop qualifying for picker-queue coverage; mixed stock/build, partial picks, nested builds and shortages are not hidden by the new projection.
- Assembly history includes completed jobs because completed assembly can still need its finished-goods pick. This is not yet a dedicated pending-packing queue.

## Verification

- Refreshed-main full unit run: **862 files passed; 8,097 tests passed, 14 skipped**. The earlier four Windows source-extraction failures were fixed by the incoming separate #1384 workstream, not by hidden changes here.
- Additional final WMS evidence suite: **5 passed**. It validates matching completed-line writes, changed-line failure, and invalid input rejection.
- Focused coverage includes queue coverage/release boundaries, scope and wrong-worker denial, stale versions, actual boolean holds, producer lineage, canonical rollback, strict HTTP/session identity, retry stability, and server-rendered UI confirmation/blocker states.
- PostgreSQL assembly suite: **11 skipped**, explicitly requiring `ECHELON_TEST_DATABASE_URL` and `ECHELON_TEST_DATABASE_DISPOSABLE=true`. No local Docker/psql runtime or disposable database was available. The test uses isolated schemas; its posting marker is not an inventory-math simulation.
- Final `tsc --incremental false`, production build, and `git diff --check`: **passed**. Build retains the existing large-chunk warning. Browser clicks against a running backend and physical gun/bench acceptance were not executed.

## Next checks / remaining work

1. Obtain CI PostgreSQL proof for this branch, including the corrected boolean hold fixture and output-evidence rollback test, before deployment approval.
2. Exercise the connected gun and bench UI with a real disposable canonical plan, permissions, and correctly bound material/output locations. Verify denied scopes, stale tabs, uncertain responses, holds, and mixed-source blockers.
3. Connect assembly-completed output to audited packing readiness/close without treating label creation as carrier possession. Preserve the existing early-label practice; do not let the header get stranded silently.
4. Add supported mixed/partial line custody and picking, partial build accounting, nested dependency routing, recovery/reassignment, and batch-gun integration in explicitly bounded follow-on work. Do not claim this slice completes them.
5. Any production capability enablement, station configuration, canonical activation, inventory corrections, or channel changes requires its own authorized action. Nothing in this implementation performs those changes.
