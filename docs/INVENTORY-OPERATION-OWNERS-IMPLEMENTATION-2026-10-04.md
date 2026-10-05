# Picking and replenishment: root-cause implementation and remaining gaps

October 4, 2026. Approved Batch A addresses operation/source ownership, stable command identity, transactional receipts and required follow-up. It uses the existing ATP, canonical claim, quantity journal and cost owners. F11 physical admission remains unchanged; its unresolved-cost policy still needs explicit agreement.

## Review identity and preservation

- Branch: `codex/picking-replenishment-operation-owners`, checkout `C:\Users\owner\.codex\worktrees\picking-replenishment-operation-owners\Echelon`.
- Initial base: `0b8ecd337002d08480babbb35541033796756eab`. Fresh main before publication: `f1e5c382c7ce7bf84e333fc7865c3098c4f0bc5d`. Intervening main changes did not overlap this batch; migration prefix `0719` was free on that main.
- The dirty primary `codex/catalog-piece-uom` checkout and `C:\Users\owner\Echelon\.codex-worktrees\order-63721-investigation` were preserved. A before/after verifier compares HEAD, status and recorded file hashes. No completed order recovery was rerun or copied into this branch.
- The October 1 report is unchanged: SHA-256 `7A32BB3ACB4510DC1D5D126BFFA2184140B4CC60D47DF25A3F1B5D73E63C6765`. The separate pre-change addendum remains `C:\Users\owner\Echelon\docs\INVENTORY-PICKING-REPLENISHMENT-LOTS-CURRENT-STATUS-2026-10-04.md`.
- No production data/configuration/quantity changes, incident runners, merge, deployment or activation. Test initialization affects only uniquely named disposable localhost databases.

## What the code definitely does

The root cause addressed is split operation ownership: queue guidance, execution identity, mutable retry keys, task completion and post-commit effects described the same physical work independently. New user paths freeze one validated intent, carry its exact source/method/unit plan into the existing physical owner, save a receipt with physical/WMS mutations, and retry the required tail using that receipt. Wider cost and lifecycle consolidation remains incomplete.

### Pick and unpick trace

1. `selectPickingSource` validates warehouse/bin identity, active/pickable/frozen state, quantities and ambiguity. An assigned bin remains assigned even when empty. An unassigned tracked line needs one eligible bin capable of the entire remaining exact-SKU demand; diagnostic guidance cannot replace an executable source. `PickingUseCases.resolvePickTarget` and `planPickingItems` supply this same plan to execution, queue, claim and refresh. Explicit non-stock/unmapped lines retain confirmation-only behavior; missing tracked catalog identity fails. [Selector:54][source] [Execution:1456][resolver] [Queue planner:4065][queue]
2. `validatePickerOrder` checks the actual operational DTO. SQL maps recorded `claimed_at` to `startedAt`. The client consumes fresh claim items/source IDs; `sendPickingCommand` retains the original UUID/body across response loss, changed progress and page reload. It does not replace intent using a refreshed picked counter. [DTO:72][dto] [Mapping:537][mapping] [Client:11][client] [Actual-page tests:302/315][browser]
3. `preparePickingCommand` freezes actor/action/item/before snapshot and intent hash. `freezeCanonicalPickingRequest` validates the lower-owner DTO and retains it for retry. Existing authorized short-claim refresh may adopt a new claim only after a rolled-back strict attempt with unchanged physical intent and an old/new claim audit. A committed receipt is immutable. [Preparation:86][prepare] [Canonical freeze:137][freeze] [Refresh:1659][refresh] [Migration:23][migration]
4. Legacy order/item locks validate frozen SKU/warehouse/bin/progress before calling inventory core. Canonical movement, claim/cost/quantity journals and WMS receipt share the existing canonical transaction. Receipt failure rolls back physical movement. Legacy unpick resolves the recorded warehouse bin through the common selector in its transaction. `InventoryUseCases.unpickItem` rejects custody below the exact requested quantity instead of clamping it and reporting success. [Legacy path:3231][unpick] [Canonical receipt:289][receipt] [Exact rejection:786][exact] [Canonical PostgreSQL tests:125/142][canonical-tests] [Actual custody regression:82][transfer-tests]
5. `deliverPickingFollowup` executes idempotent effects without holding an extra database connection across lower owners; a short transaction saves the result and reconciles progress. Failures stay durable/logged and return “physical work recorded; follow-up pending.” Review exceptions, log phases and replenishment trigger associations use stable unique identities. `startPickingFollowupWorker` retries new command/task/transfer follow-up after restart, independently catches each port's failures, and does not run historical recovery scripts. [Delivery:334][delivery] [Worker:2][worker] [Concurrency/restart/partial-effect tests:486–1076][command-tests]
6. `pickingReadinessBlockers` and `deriveWmsPickingProgress` own ordinary picking counts/readiness. `reconcileWmsPickingProgress` locks order/items, reads exceptions/tasks/pending receipts, and writes header/non-shipping finalization/audit together. Manual ready, diagnostic repair and storage progress delegate to it. Existing secured assignment release is retained. Shipment projection remains a wider lifecycle writer, so F04 is partial. [Policy:37/73][policy] [Transaction:80][progress] [Storage:985][storage] [Remaining shipment owner:24][shipment]

### Replenishment and transfer trace

1. Replenishment and break/assembly factories require explicit transformation authority. Web composition and the write-capable monitor inject the real repository; isolated tests inject explicit fakes. Existing physical-only, package-hierarchy and build-managed authority remains authoritative. [Monitor:249][monitor] [Factory:3895][factory] [Break authority:753][break]
2. `planReplenishmentDemand` explicitly converts destination VARIANT demand into BASE quantities/source batches with safe-integer/BigInt checks. `findSourceLocation` checks required source capacity. Tasks freeze method, quantity, ratio and server execution mode; `executeTask` uses that plan with physical-owner capacity checks. [Demand:51][demand] [Source:3797][capacity] [Execution:1401][execute]
3. `insertTriggeredTask` acquires the per-bin lock in one short metadata transaction, checks immutable originating-operation associations, rejects stale observed bin quantities, and creates/reuses the plan. Cascade plans/association share that transaction; physical execution follows it. Each originating operation retains its own task/no-work receipt even after a shared task completes. This removes nested application-wide bin-lock wrappers. [Lock/create:341/373][create-task] [Associations:42][trigger] [PostgreSQL association/observation tests:957/1023][command-tests]
4. `createManualReplenishmentTask` validates submitted method/quantities/identities, pins authority before catalog locks, and reads warehouse settings/resolver through the same transaction connection. It freezes the server's inline/queue decision. Client `autoExecute` no longer owns policy; the UUID/hash retains the entire original manual plan. [Application:44; decision:249][manual] [Concurrent creation:649][command-tests]
5. `changeReplenishmentTask` and `reportReplenishmentException` use the existing financial-command framework, expected status/revision, row locks, constrained mutations and atomic audit/result. Migration `0719` increments revision on every update, including ABA. Physical execution saves completed quantity, moved BASE units and required follow-up with movement. Maintenance cancellation guards candidate status/revision and skips recorded physical progress/manual intent. [Transition:25][transition] [Exception:39][exception] [Revision:49][revision] [Execution:1401][execute] [Maintenance:2024][maintenance] [Waiting cancellation:733][command-tests]
6. `ManualInventoryTransferService.transfer` saves existing core movement, command result and durable tail together. Core records the source unit basis on the transfer receipt. `creditTransferToReplenishment` locks receipt/matching tasks and converts its VARIANT amount to BASE credit using that frozen basis. A shared receipt budget and unique receipt/task attribution prevent double/over-credit. Partial credit remains partial. Historical missing unit bases are rejected, not invented. [Application:35][transfer] [Core receipt:2160][unit-basis] [Credit:15][credit] [Real physical replay/rollback:121/161][transfer-tests] [Budget tests:923/1140][command-tests]
7. `unblockDependentTasks` uses persisted execution mode and guarded status/revision. Wake-up/audit commits before physical execution. Failure keeps parent follow-up pending, allowing retry without repeating parent movement. [Wake-up:1553][wake] [Recovery:2803][recovery] [Controlled physical-port fault/retry test:796][command-tests]

Replaced GET-time queue repairs and duplicate picker readiness/header helpers were removed. Unused break/assembly change callback, pick-queue reservation callback wiring and raw task cancellation method were removed after caller tracing. Cartonization shadow remains a best-effort consumer of the common transition. Wider storage, reservation, hierarchy, bin prediction, old cost-table compatibility and lifecycle cleanup remain Batch C work.

## Finding disposition

“Fixed” means the stated source path and selected local regression evidence, not merged/deployed/current-production proof. Conditional findings remain conditional.

| Finding | Status | Evidence and remaining proof |
|---|---|---|
| F01 source display/execution | Fixed in ordinary picker path | Shared source/claim plan and actual-page source-ID regression above. Live prevalence/deployed behavior unknown. |
| F02 partial-unpick retry | Fixed in user HTTP path | Original UUID/body, frozen before state, coupled receipt; PostgreSQL concurrency/restart and browser lost-response/reload. Command-less internal compatibility does not gain this guarantee. |
| F03 committed pick/missing tail | Partially fixed | New user commands persist/recover required work. Older command-less/internal operations and wider notification debouncer are not a general outbox; producer retirement remains. |
| F04 progress/readiness | Partially fixed | Picker/manual-ready/diagnostic/storage use common guarded policy. Queue DTO/timestamp and GET-time repair corrected. Shipment lifecycle writer and broader UI capability projection remain. [Shipment:24][shipment] |
| F05 omitted authority | Fixed | Mandatory dependency and actual monitor/server composition; authority tests pass. Maintenance scheduling/live authority unknown. |
| F06 unsupported credit | Fixed in manual-transfer path | Immutable movement/unit receipt, exact shared credit budget and atomic audit/outbox. Historical missing unit bases need separate disposition. |
| F07 unit disagreement | Fixed | Shared explicit VARIANT/BASE planner and package tests. No production rule configuration or unit migration was performed. |
| F08 insufficient source | Fixed in traced planning/execution | Required capacity, guarded stock observation, frozen execution and rollback tests. Every resolver/cascade combination is not HTTP/browser-to-DB tested. |
| F09 stale transition/tail | Partially fixed | New commands, execution, durable tail and maintenance revision/physical guards covered. Wider legacy SQL policy/retirement and unrelated maintenance writers remain Batch C; not all cross-workflow races exercised. |
| F10 method/mode drift | Fixed in manual creation | Submitted method participates in transactional resolver; client policy flag removed; concurrent replay preserves plan. Configuration unchanged. |
| F11 cost admission | Open; policy unapproved | Historical received bounds and claim cost-snapshot guards remain. Need explicit policy, atomic obligation/reconciliation design and real concurrent recost/movement proof. [Contribution:106][contribution] |
| F12 return identity/lineage | Open | `applyReturnRestock` still passes OMS identity to cost resolution. Need original shipped/picked allocation, subcent costs, partial/multi-lot replay and recost lineage. [Return:138][return] |
| F13 money validation | Open | `preferredMills` substitutes cents unless authoritative mills are positive, before normalization. Need strict authoritative money and distinct known-zero/unknown/invalid contracts. [Parser:137][money] |
| F14 valuation/rounding | Open | Lot and COGS valuation retain separate rounding owners. Need one exact read model and explicit rounding boundary. [Lot:1250][valuation] [COGS:757][cogs] |
| F15 output confidence | Open | Canonical output still writes `cost_provisional=0`. Need shared confidence/lineage rules and reconciliation through all outputs. [Output:2127][confidence] |
| L01 exact legacy unpick | Fixed in traced path | Same-warehouse recorded bin and frozen identity; shortfall rejects atomically. Actual PostgreSQL checks unchanged levels/lots/costs/journal. Bin-selection tests use a controlled physical port; full legacy multi-bin reversal through HTTP not proven. |
| L02 reservation attribution | Open, conditional | Existing reserve/release preserved. Runtime reach, exact partial-lot attribution and retirement need proof; no journal bypass inferred. |
| L03 hierarchy direction | Open, conditional | Omitted authority closed; preview/legacy direction and supported caller retirement incomplete. |
| L04 nested bin lock | Fixed in traced creation | Short owning transaction, association/observation guards; four-connection concurrency regression. Every full physical cascade interleaving untested. |
| L05 dependent mode | Fixed in traced wake-up | Persisted mode, guarded wake-up/audit, durable parent retry. PostgreSQL fault test uses controlled dependent physical execution, not full cascade movement. |

## Validation and limits

PostgreSQL 17.11 binds only to `127.0.0.1:55447`; disposable permission is explicit; databases are uniquely created and cleaned up. No production environment file/credentials loaded.

- Final rebased unit/PostgreSQL acceptance: 27 files, 294 tests passed, including the exact-unpick guard and existing short-claim/confirmed-work regressions. Detailed results are in `rebased-focused-acceptance.txt`.
- Independent cost-lineage, canonical picker-observation and build-order authority suites: three files, 15 tests passed in a separately named localhost database, then dropped.
- Additional fixture-contract/quantity-owner acceptance: three files, 67 tests passed (`fixture-contract-acceptance.txt`), including the 20 command-owner tests already counted above. The distinct local unit/PostgreSQL total is 356 tests in 32 files. Client sender typing was followed by its four retry tests passing again.
- Browser: 90 tests passed on desktop/mobile. Four new runs use the actual Picking page for fresh source identity and lost-response/reload intent. HTTP APIs are mocked; this is not live-HTTP/PostgreSQL end-to-end proof. Some existing inventory-policy browser cases use synthetic/source-extracted harnesses.
- Full `tsc --noEmit --incremental false` passed again after rebasing onto fresh main (`rebased-typecheck.txt`); `git diff --check` passed. Source checking is not deployment proof.
- Protected server test typechecking passed before the client step in `protected-test-typecheck-acceptance.txt`; the corrected client signature then passed `tsc -p tsconfig.tests.client.json` (`protected-client-test-typecheck.txt`). Initial test-typecheck failures were corrected, not excluded: explicit authority in the quantity fixture, receipt field in the transfer mock, SQL-derived backend PID, and sender mock typed from the actual public contract. No test exclusions were added.
- Physical-owner PostgreSQL tests use actual canonical claims, quantity admission/journal, FIFO/cost lineage, transfer owners and migration `0719`. Receipt/outbox/WMS fault injection proves rollback; replay/competing actions retain one physical posting. Actual transfer tests cover pending-publication recovery.
- Metadata-owner fixtures use a reduced ORM-derived schema plus the actual operation migration, not all application foreign keys/indexes. Some dependencies are controlled ports. Claim-refresh identity/audit, legacy bin identity and dependency wake-up tests prove their exercised boundaries, not full physical end-to-end flows. Four-connection tests prove the exercised owners avoid nested-pool starvation.
- Migration reapplication preserves historical task work and nullable receipt units. Three new database suites are registered in the PostgreSQL CI manifest and independently checked shard guard.
- October 1 counterexamples remain unchanged and are not fix regressions. The intentional pre-fix pool-starvation reproduction failed; the corrected regression passes.

Logs/previews remain under `C:\Users\owner\Echelon\.codex-audits\inventory-operation-owners-20261004`. `picker-followup-preview.png` and `picker-followup-mobile-preview.png` show “Pick recorded; follow-up pending.” Physical progress remains visible. The existing Complete Order control can remain visible while follow-up is pending; server readiness checks that pending work. A full UI capability redesign is not claimed.

## Assumptions, risks and failure modes

- Deployed commit/live authority, affected records, scheduler health and external legacy consumers are unknown. Main source, local tests, PR publication, deployment and production behavior are separate evidence.
- Nullable warehouse identity retains explicit legacy compatibility. Ambiguous/frozen/inactive sources reject. Missing historical transfer unit bases remain missing.
- UUID/revision contracts and migration `0719` need coordinated future deployment. External clients need the new command fields. No production rollout was executed.
- Receipt/outbox failure rolls physical work back. Failure after commit persists/returns required follow-up pending; replay/worker retries the tail. Publication/dependency failures can keep readiness blocked. Logs expose errors; production alerting was not tested.
- Delivery effects may be attempted concurrently outside the result lock. Stable exception/log/trigger/credit identities prevent duplicate business effects in exercised paths. Wider notification/outbox guarantees are not claimed.
- Client retains all HTTP 409 intents conservatively. A definitive conflict may require a later explicit cancel/change-intent interaction; automatically replacing it would break retry identity.
- F11 cost guards remain strict and can still block physical stock with unresolved historical evidence. No receipts, costs or physical events were fabricated.
- Existing picking authentication, inventory-adjustment permissions, diagnostic warehouse-management permission and secured assignment-release admission are retained; wider permission architecture was not redesigned.
- This connected batch requires review of source/intent/receipt/task traces and migration together. No build, deployed HTTP smoke test, provider integration or production census is claimed.

## Next checks

Review Batch A before considering merge/deployment. F11 requires explicit policy: for an exact lot with four verified physical units but `qty_received=0`, permit an authorized one-unit movement only with an atomic unresolved-cost obligation and exact later reconciliation, or retain the block until cost evidence is repaired? Either choice retains identity/ownership/quantity/warehouse/authority guards and distinguishes unknown from known zero.

F11–F15 form the cost/lineage batch after that decision. Wider lifecycle producers, conditional reservation/hierarchy reach and verified retirement form Batch C. Coordinate future overlap with preserved catalog UOM/recovery code. Historical operational remediation is not authorized by this code review.

[source]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/shared/picking-source-plan.ts#L54
[resolver]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/picking.use-cases.ts#L1456
[queue]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/picking.use-cases.ts#L4059
[dto]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/shared/types/picker-order.ts#L72
[mapping]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/orders.storage.ts#L537
[client]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/client/src/lib/picking-command.ts#L11
[browser]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/test/browser/picking-hold-controls.spec.ts#L307
[prepare]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/picking-command.repository.ts#L86
[freeze]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/picking-command.repository.ts#L137
[refresh]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/picking.use-cases.ts#L1659
[migration]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/migrations/0719_warehouse_operation_owners.sql#L23
[unpick]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/picking.use-cases.ts#L3225
[receipt]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/picking-command.repository.ts#L289
[exact]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/inventory.use-cases.ts#L786
[canonical-tests]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory-planning/__tests__/integration/canonical-pick-case-break.integration.test.ts#L125
[transfer-tests]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/__tests__/integration/manual-transfer-command.integration.test.ts#L82
[delivery]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/picking-command.repository.ts#L334
[worker]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/picking-followup.worker.ts#L2
[command-tests]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/__tests__/integration/warehouse-operation-commands.integration.test.ts#L486
[policy]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/shared/wms-picking-progress.ts#L37
[progress]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/picking-progress.repository.ts#L80
[storage]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/orders/orders.storage.ts#L985
[shipment]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/wms/channel-fulfillment-projection.repository.ts#L24
[monitor]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/scripts/monitor-pick-replen-health.ts#L249
[factory]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L3934
[break]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/break-assembly.use-cases.ts#L753
[demand]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/domain/replenishment-execution.domain.ts#L51
[capacity]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L3836
[execute]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L1425
[create-task]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L343
[trigger]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/infrastructure/replenishment-trigger.repository.ts#L42
[manual]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/create-manual-replenishment-task.ts#L44
[transition]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment-task-command.ts#L25
[exception]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/report-replenishment-exception.ts#L39
[revision]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/migrations/0719_warehouse_operation_owners.sql#L49
[maintenance]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L2065
[transfer]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/manual-inventory-transfer.service.ts#L35
[unit-basis]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/inventory.use-cases.ts#L2160
[credit]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/infrastructure/replenishment-transfer-credit.repository.ts#L15
[wake]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L1594
[recovery]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/replenishment.use-cases.ts#L2844
[contribution]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/infrastructure/cost-evidence.repository.ts#L106
[return]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/application/return-restock.use-case.ts#L138
[money]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/infrastructure/build.repository.ts#L137
[valuation]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/lots.service.ts#L1250
[cogs]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/cogs.service.ts#L757
[confidence]: https://github.com/cardshellz/Echelon/blob/codex/picking-replenishment-operation-owners/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L2127

The approved Inline replenishment continuation and its current evidence are recorded separately in [INLINE-REPLENISHMENT-FIXES-2026-10-04.md](./INLINE-REPLENISHMENT-FIXES-2026-10-04.md). The validation counts above describe the earlier operation-owner batch.
