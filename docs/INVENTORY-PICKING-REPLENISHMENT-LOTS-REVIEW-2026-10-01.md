# Picking, replenishment, and inventory-lot architecture review

Date: 2026-10-01
Status: **Investigation and recommendations only — no application fixes or production changes**

## 1. Executive finding

**There is an authoritative quantity-posting primitive. There is not yet one consistent owner for every business operation that uses it.**

The existing quantity journal, its transaction protections, and its lot/bin projections are substantive implementation, not a proposed replacement. Keep them. The defects identified here are primarily in source selection, command identity, workflow transitions, replenishment planning, and the way cost evidence is coupled to physical operations. Evidence for the foundation is in section 3; individual defects and their limits are in section 4.

The practical consequences include:

- The picker can be shown one bin while the server uses a different stored bin.
- Repeating an unpick request can undo an additional quantity.
- Inventory can commit successfully while subsequent order/replenishment work fails and is skipped on retry.
- A production maintenance command constructs replenishment with a test-style legacy authority default.
- A small manual transfer can mark larger replenishment tasks fully complete.
- A return can inherit another order's cost because OMS and WMS identities are mixed.
- Historical cost metadata or a legitimate recost can block physically available inventory.

**Recommendation:** consolidate the existing operation owners in three coherent implementation batches, with regression tests for these exact failures. Do not build another ATP engine, another quantity ledger, a parallel reconciliation calculator, or additional warehouse stations as part of this work.

## 2. Scope, evidence, and boundaries

### Source baseline

- Repository: `cardshellz/Echelon`.
- Reviewed clean checkout: `C:/Users/owner/.codex/worktrees/canonical-pick-conversions/Echelon`.
- Reviewed commit: `f90970ec8150295da0ccdfaa919b0244675a3a69`, branch `codex/fix-canonical-pick-conversions`.
- Refreshed `origin/main`: `c8c81f48ea3d4e755cf1084d198daedf9678459a` — merge of PR #1625, timestamp `2026-10-01 09:04:09 -04:00`.
- The complete name-only diff between those commits was inspected. The reviewed picking, inventory, replenishment, lot/cost, WMS, schema, and corresponding test files are unchanged between them. The intervening differences concern other listing/catalog work and associated tests/CI selection.
- A final comparison of all 47 distinct source files cited in this report found no differences between the reviewed commit and that refreshed `origin/main`. All 134 referenced file targets/line positions were checked for existence and valid bounds.
- The primary checkout `C:/Users/owner/Echelon` has unrelated local catalog changes. Those files were not used as the reviewed runtime baseline and were not modified.

Line citations below refer to the pinned clean checkout, not an assumption about what production currently runs. The architecture document [INVENTORY-SINGLE-QUANTITY-AUTHORITY.md][quantity-doc] was read as historical context and checked against source. The user's supplied engineering instructions define the review criteria.

### Review method

Three parallel Astra reviewers covered picking, replenishment/transformation, and lots/costs. The coordinating reviewer checked cross-module ownership, independently inspected the principal failure paths, and ran existing tests plus isolated counterexamples against unchanged source.

In scope:

- Pick queue → assignment/claim → pick/unpick → inventory and WMS progress → shipment/correction boundaries.
- Replenishment rule resolution → plan → task creation → execution → completion/dependent tasks.
- Direct movement, case conversion, build execution, lot custody, cost attribution, return restocking, valuation, and cost revisions.
- Idempotency, transaction ownership, concurrency, input contracts, duplicated rules, hidden side effects, and retirement candidates.

Not a completed audit of every marketplace adapter, all ATP calculations, every catalog screen, production configuration, or current inventory records. Shipment and return modules were traced where they cross these operation boundaries.

### Evidence vocabulary

- **Confirmed/source:** the identified function and callers implement the stated behavior. A conditional failure scenario follows from that code; it is not a claim that a live incident occurred.
- **Reproduced:** a local audit test invoked the actual reviewed implementation with controlled inputs. Its mocked boundaries are identified below.
- **HYPOTHESIS:** possible production occurrence or a broader cause that has not been verified.
- **Unknown:** missing production, end-to-end, or external-consumer evidence.
- **Recommendation:** a proposed change, not existing functionality or approval to implement it.

Priorities: P1 = significant correctness/operational or financial risk worth fixing promptly; P2 = material correctness/maintainability issue. No production emergency or P0 incident is asserted by this read-only review.

## 3. What already has a sound foundation

### One final quantity posting owner exists

`normalizeQuantityCommand` validates movement identity and operation semantics; `applyQuantityDelta` validates integer bounds and custody invariants. Pick/unpick have opposite bucket effects, and a transfer must conserve custody per exact SKU. Transform/adjust business authorization belongs to the calling operation, not the journal. See [quantity-ledger.ts:50–128][quantity-domain].

`PostgresInventoryQuantityLedger.post` requires an existing transaction, establishes an admission fence and command-key lock, checks replay identity, locks exact inventory identities, derives balances from the journal, validates deltas, appends entries, and projects lots/bins. Failure rolls back its savepoint. See [quantity-ledger.repository.ts:41–128][quantity-post] and [`project`:183–194][quantity-project]. Database enforcement includes immutable entries and projection protections in [242_inventory_quantity_ledger.sql:71–231][quantity-migration].

This means **lot quantity and bin quantity are intended to be projections of the same authority after opening**, not two independently maintained stock authorities. It does not mean every application workflow around that authority is consistent.

### Existing atomic operations worth retaining

- Canonical picking owns claim inventory and WMS line progress together: [`pickClaimLine`:5039 onward][claim-pick], with inventory mutation delegated to [`pickResources`:1388][claim-inventory-pick].
- Canonical inline package materialization rechecks the permitted operation before picking: [`materializeClaimCaseBreakForPick`:5997 onward][claim-inline]. Do not replace this with client-authorized stock conversion.
- Replenishment execution pins authority/model state and locks the task, then posts inventory and task completion in its transaction: [`executeTask`:1329–1466][replen-execute].
- Generic build execution has command replay and a transaction around the run: [build-execution.repository.ts:789–1186][build-run]. It rejects operations that belong to claim-owned handoff rather than independently consuming the same claimed stock.
- Corrective picking has an explicit durable workflow and calls the normal picking owner: [pick-correction.service.ts:40–151][correction-service]. Tests distinguish recording an answer from completing the inventory correction.

These are foundations to reuse. Finding a surrounding defect does not invalidate all of their transaction or concurrency protections.

### End-to-end ownership map

| Operation | Current source path | Review conclusion |
|---|---|---|
| Ordinary pick | HTTP pick route → `PickingUseCases.pickItem` → authority routing → canonical claim owner or legacy inventory owner → quantity posting | One final posting primitive; duplicated source/workflow decisions before and after it. [Route][pick-route], [orchestrator][pick-entry] |
| Canonical pick/conversion | `completeCanonicalPick` → `pickClaimLine` → optional authorized package materialization → `pickResources` → posting + WMS line progress | Preserve claim ownership and atomic conversion/pick. [Canonical adapter][canonical-adapter], [claim owner][claim-pick] |
| Unpick | HTTP `{qty, reason}` → `unpickItem` → canonical target construction or legacy subtraction | Request identity is not stable across a retry; F02. [Route][unpick-route], [canonical unpick][canonical-unpick] |
| Replenishment | Rules/context → `evaluateReplenNeed` → task → `executeTask` → `executeReplenishmentMove` | Preserve system-owned policy, consolidate quantities, lifecycle, and all composition roots. [Evaluator][replen-evaluate], [execution][replen-execute], [movement][replen-move] |
| Manual transfer | Inventory transfer route → inventory movement → `completeMatchingTransferTask` | Inventory movement and task credit are not the same proof; F06. [Transfer route][transfer-route], [task credit][replen-match] |
| Case conversion / build | Break/assembly, free-stock replenishment/build, or claim-owned transformation → source lots/output lots → journal | Different authorization scopes are valid; duplicated quantity/cost production policies are not. [Break/assembly][break-entry], [build][build-run], [claim transform][claim-transform] |
| Return restock | Return case operation supplies OMS/WMS identities → `applyReturnRestock` → cost lookup + new lot + posting | Wrong identity and incomplete original allocation lineage; F12. [Caller][return-caller], [restock][return-restock] |
| Shipment/correction | Shipment owner consumes picked custody; provider declaration can create missing-pick review; correction calls pick owner | Do not equate provider-declared contents with fabricated physical pick records. [Dispatch owner][dispatch], [correction service][correction-service] |

## 4. Prioritized findings

| ID | Priority | Finding | Reach / proof |
|---|---|---|---|
| F01 | P1 | Displayed pick bin and executed bin can differ | Current queue/client/server trace; conditional scenario |
| F02 | P1 | Unpick retries construct a new operation | Canonical adapter reproduced; legacy also subtracts from fresh state |
| F03 | P1 | Post-commit pick work is not durably retried | Current ordinary-pick trace; fault injection still required |
| F04 | P1 | Competing order-state writers can overwrite terminal state | Reachable release/progress writes; concurrency scenario |
| F05 | P1 | Maintenance replenishment defaults to legacy authority | Production command wiring; default behavior reproduced; invocation unknown |
| F06 | P1 | Transfer completion credits tasks without quantity evidence | Reachable transfer path; actual task method reproduced |
| F07 | P2 | Replenishment mixes package counts with base-unit counts | Evaluator and domain execution reproduced |
| F08 | P2 | Source selection can choose insufficient stock and stop | Current resolver trace; capacity scenario |
| F09 | P2 | Task lifecycle has unguarded competing writes | HTTP, repository, and post-commit error trace |
| F10 | P2 | Manual task auto-execution resolves the wrong method | Route/default/domain trace |
| F11 | P1 | Cost completeness/revision gates physical execution | Metadata guard reproduced; recost rejection traced |
| F12 | P1 | Return costing confuses OMS/WMS identity and loses lineage | Actual restock orchestration reproduced with fake SQL boundary |
| F13 | P2 | Cost normalizer hides invalid authoritative mills | Actual pure function reproduced |
| F14 | P2 | Inventory valuation has two different calculations | Two routed implementations; arithmetic counterexample |
| F15 | P2 | Transform/build outputs discard provisional classification | Output SQL and contrasting transfer/replenishment trace |

### F01 — Pick guidance can name a different bin from the inventory command

**Confirmed.** `loadPickQueue` obtains a fresh bin by SKU and replaces the pending row's displayed location. `getBinLocationFromInventoryBySku` is not scoped to the frozen order warehouse/variant assignment. Existing real order-item locations are deliberately preserved by backfill. The client awaits claim but continues with its existing queue copy; its normal pick request sends status/quantity/method, not that displayed location. The server reloads the order item and resolves its stored location.

Evidence: [`loadPickQueue`:3913–3955][pick-queue]; [`getBinLocationFromInventoryBySku`:254][bin-lookup]; [backfill preservation:11–15][bin-backfill]; [`handleStartPicking`:1898–1918][client-start]; [client request:270–275][client-pick-request]; [server reload:1749][pick-reload]; [canonical target:1438–1445][canonical-target].

**Reasoning/example.** An order item already assigned A remains A in storage. Primary stock guidance changes to B. The queue can show B, while a subsequent ordinary confirmation still targets A. Canonical claim checks may reject an incompatible source; where A remains valid, those checks do not prove the human picked from A rather than the displayed B.

**Recommendation.** One warehouse/variant-scoped pick-source plan, returned by claim/start and consumed by the active picking UI. Carry exact source identity and plan revision in commands; validate or explicitly reconcile it at execution. A location label must not independently redefine the operation.

**Unknown / next proof.** No affected live order was inspected. Add queue → claim → scan integration/browser coverage where an assignment changes after queue load, including two warehouses with matching location codes.

### F02 — Repeating a partial unpick can undo additional stock

**Confirmed and reproduced.** The client/route supplies a quantity, not a stable command ID or fixed target revision. `completeCanonicalUnpick` recalculates target quantity and idempotency key using newly read picked progress and movement cursor. The lower owner can correctly deduplicate a key while the adapter generates a different key for the same retried user intent.

Evidence: [unpick route:375–384][unpick-route]; [`completeCanonicalUnpick`:2969–3033][canonical-unpick]; legacy subtraction [3229–3230][legacy-unpick]. Audit [counterexample:22][audit-unpick] invokes the actual canonical adapter twice with one requested unit: picked quantity goes **4 → 3 → 2**, with different command keys. Its claim owner is a controlled fake; this is not a full HTTP/database reproduction.

**Recommendation.** Generate command identity once per user action, retain it across retries, include the original expected revision/target, and replay the receipt before rebuilding a plan. “Unpick one” retried is not a new instruction to unpick another one.

**Unknown / next proof.** Automatic client retry frequency is not established. Add response-lost/retry and concurrent duplicate HTTP/PostgreSQL tests for both partial and full unpick.

### F03 — A successful pick can lose its required follow-up work

**Confirmed.** In ordinary `pickItem`, inventory/WMS line progress commits before user lookup, the awaited picking-log write, replenishment follow-up, and order-header progress. The comment calls logging fire-and-forget, but it is awaited. Replay branches return before these effects. A failed tail can therefore leave a committed pick without completing all follow-up work.

Evidence: [atomic result:2011–2049][pick-commit]; [awaited logging:2061–2095][pick-tail]; [replenishment:2205–2282][pick-replen-tail]; [header:2369–2374][pick-progress-tail]; replay assertions in [picking-canonical-authority-routing.test.ts:217][pick-replay-test]. `getPickQueueOrders` contains a separate self-heal, but its initial queue selection excludes ordinary fully picked rows, so it is not a general durable repair for a failed final-pick tail: [queue selection:485–510][queue-selection], [self-heal:718–747][queue-self-heal].

**Recommendation.** Persist required audit/projection work within the owning transaction, or persist an effect/outbox record in that transaction. Deliver replenishment/notifications through idempotent consumers. Return separate movement-committed/effects-pending status where appropriate; replay must not quietly abandon outstanding effects.

**Unknown / next proof.** No production tail failure was inspected. Inject failures after inventory commit, during logging, and before header update; prove replay/restart finishes each effect once. This finding concerns the ordinary picker tail, not a claim that the separately tested corrective workflow has no recovery.

### F04 — Order lifecycle is not protected by one transition owner

**Confirmed.** `releaseOrder` ultimately sets the header to ready and clears assignment using only the order ID as its update predicate. `updateOrderProgress` reads lines, derives a header state, and updates by ID without a terminal-state/version condition. By contrast, the shipment projection locks its order and applies its own lifecycle logic. Readiness is also calculated in more than one place, with different treatment of held lines.

Evidence: [release route:318–343][release-route]; [`releaseOrder`:924–946][release-storage]; [`updateOrderProgress`:1134–1173][progress-storage]; [shipment projection:58–73,123–140][shipment-projection]; [`getReadyToShipBlockers`:3651][ready-blockers].

**Reasoning/example.** A delayed release or progress write can run after shipment/cancellation and replace the newer header state. That is a code-level concurrency hazard, not proof of a duplicate physical shipment.

**Recommendation.** One guarded order transition/projection owner under an order lock or expected revision. Releasing a user's assignment must not itself mean reopening a shipped order. Consolidate held/non-stock/short readiness policy and pass the actual warehouse settings; the post-pick call currently requests settings without a warehouse [at 2370][pick-progress-tail].

**Unknown / next proof.** Run release-versus-ship, last-pick-versus-cancel, held-line, and multi-warehouse policy tests. Current affected orders and live race frequency are unknown.

### F05 — A maintenance entry point silently bypasses runtime transformation authority

**Confirmed and reproduced.** `monitor:pick-replen-health` is configured with recovery/queue-write flags. Its script creates replenishment without the transformation-authority dependency. The factory/constructor default is `legacyTransformationExecutionAuthority`, documented for isolated pre-cutover tests: it always reports legacy and does not pin/check the sealed model. The web composition correctly injects real authority.

Evidence: [package script:13][monitor-package]; [monitor composition/actions:235–270][monitor-script]; [factory:3923–3929][replen-factory]; [test-style authority:51–84][legacy-authority]; [correct web injection:273–278][service-composition]. Audit [counterexample:91][audit-authority] verifies the default reports legacy without reading the database.

**Reasoning.** Quantity-ledger enforcement does not validate a transformation path's authorization. A maintenance caller can use the final journal and still select the wrong pre-journal policy. `executeTask` branches on the supplied authority [at 1350–1369][replen-execute].

**Recommendation.** Make authority a required dependency. Use a common production composition root for HTTP, scripts, and jobs. Require tests to explicitly supply a fake; never silently default an omitted production dependency to legacy.

**Unknown / next proof.** This command is runnable and write-capable; its actual production scheduling/invocation was not verified. Add a composition test and a sealed-model-disallowed-path integration test for the script owner. No unsupported live conversion is asserted.

### F06 — Manual transfers can falsely complete replenishment tasks

**Confirmed and reproduced.** After transferring stock, the inventory route calls `completeMatchingTransferTask` without the moved quantity or an inventory receipt. That method selects matching pending destination/variant tasks and marks each completed for its full `qtyTargetUnits`, then unblocks dependents.

Evidence: [transfer route:174–198][transfer-route]; [`completeMatchingTransferTask`:2736–2776][replen-match]. Audit [counterexample:76][audit-task-credit] invokes the actual method with two selected tasks of 100 and 200 units; both are marked fully complete despite the method having no movement quantity to justify either. Database and dependent-task boundaries are mocked.

**Recommendation.** Credit tasks from a specific committed movement receipt. Allocate only the actual applicable quantity, once, under task locks. Support explicit partial fulfillment or explicit replacement of a plan; do not infer completion merely from a transfer to the same bin.

**Unknown / next proof.** No live falsely completed task was counted. Add a real transaction test for one-unit transfer against a twenty-unit task, several matching tasks, duplicate transfer receipt, and concurrent execution/manual transfer.

### F07 — Replenishment quantity planning mixes exact-SKU units and base units

**Confirmed and reproduced.** Context reads `inventoryLevels.variantQty`. `calculateQtyNeeded` subtracts that exact-SKU count from the configured target. `evaluateReplenNeed` then divides the shortfall by source `unitsPerVariant` without first converting the destination count into base units. The execution domain treats `qtySourceUnits` as exact source packages.

Evidence: [context/shortfall:752–769][replen-quantity-context]; [calculation:999–1051][replen-evaluate]; [`planReplenishmentExecution`:82–97][replen-plan]. Audit [counterexample:48][audit-units] exercises the actual evaluator and execution planner: destination P10 stock 0, target 20, source P10 → **2 packs**, not 20.

**Recommendation.** Explicit quantity contracts: `sourceSkuQty`, `destinationSkuQty`, `baseUnitQty`, and authorized conversion ratio. Convert a destination shortfall to base units exactly once, then derive whole source batches. For same-SKU movement the source and destination package count must agree. Make rule/UI unit labels match this contract.

**Unknown / next proof.** The number of current rules affected is unknown. Test non-EA destinations, same-SKU movement, P5/C25 multi-level conversions, nondivisible batches, overfill limits, and integer overflow. Do not silently reinterpret existing configuration during implementation.

### F08 — Source resolution can stop at an insufficient bin

**Confirmed.** `findSourceLocation` has no required-quantity argument. It accepts a candidate with available quantity greater than zero and picks according to priority. Required source quantity is calculated later. Re-resolution can select the same insufficient candidate and block even if another eligible source has enough.

Evidence: [`findSourceLocation`:3830–3899][replen-source]; [blocked-task re-resolution:526–575][replen-reresolve]; [later quantity calculation][replen-evaluate].

**Reasoning/example.** A task needs five cases; the preferred candidate has one and a later eligible bin has ten. Positive availability alone does not prove capacity for the plan.

**Recommendation.** Have the shared planner evaluate candidates against required free capacity. Either select a sufficient source or produce an explicit multi-source plan supported by execution. Do not conceal an implicit split in a function returning one location.

**Unknown / next proof.** No live bin distribution was inspected. Add preferred-insufficient/later-sufficient, claimed-stock, and capacity-changing-under-lock tests.

### F09 — Replenishment task lifecycle can diverge from committed inventory

**Confirmed.** The PATCH route reads state and validates transitions before calling an update-by-ID method, without an atomic expected-state predicate. It forwards the request body rather than a narrow command DTO. The DELETE path has no completed-task restriction in its repository predicate. Meanwhile `executeTask` correctly commits movement and completion together, but subsequent callback/dependent-work failure can escape; `executeInlineTaskAutomatically` catches it and calls an unconditional update to `blocked`.

Evidence: [PATCH:758–786][replen-patch]; [repository update/delete:329–339][replen-task-repo]; [DELETE route:848][replen-delete]; [execution commit/tail:1455–1470][replen-execute-tail]; [catch:606–619][replen-inline-catch]; [`blockTaskExecutionFailure`:484–490][replen-block]. Exception reporting is another multi-write workflow [at 3182–3239][replen-exception].

**Reasoning.** A terminal task can be overwritten by a stale lifecycle command, or physically completed work can be relabeled as execution failure because later delivery failed. The route's explicit ban on setting `completed` does not fix either race.

**Recommendation.** One typed task-transition owner with expected version/state and immutable execution receipt. Separate execution failure from follow-up delivery failure. Archive/cancel through an audited command instead of deleting execution history. Include exception/count side effects in one transaction or a durable follow-up contract.

**Unknown / next proof.** Race and callback-failure cases were traced but not reproduced against PostgreSQL in this review. Add execute-versus-cancel/delete, stale PATCH, and post-commit callback failure tests.

### F10 — Manual task creation can resolve auto-execution using the wrong method

**Confirmed.** POST `/api/replen/tasks` calls `resolveAutoExecute` without `replenMethod`; the wrapper defaults to `case_break`. The same route persists a supplied method or defaults the task to `full_case`. The domain auto-execution policy deliberately queues methods other than case-break. A task can therefore get a case-break inline decision while representing a physical transfer.

Evidence: [route:698–743][replen-create]; [default:3809–3818][replen-auto-wrapper]; [domain method policy:20–21][replen-auto-domain].

**Recommendation.** Require the actual method in the planner/policy contract; freeze method and mode together. A transport route must not invent a policy default separate from the stored plan. Keep replenishment rules/resolver authoritative; picker UI is not the source of execution permission.

**Unknown / next proof.** Actual usage of this manual route with inherited inline settings is unknown. Add HTTP composition tests for omitted/explicit `autoExecute`, every method, and warehouse/SKU overrides.

### F11 — Accounting evidence currently gates physical eligibility

This has two different mechanisms; do not conflate them with lack of physical stock.

**A. Historical received quantity.** `recordLotCostContribution` requires a positive source denominator and `source.qty_received >= sourceQty`. `executeReplenishmentMove` first checks available stock, consumes source lots, creates outputs, and calls this cost function before commit. Thus `qty_on_hand=4`, `qty_received=0`, consumption 1 can pass the physical check but fail the cost-lineage check, rolling back the movement.

Evidence: [`recordLotCostContribution`:106–125][cost-contribution]; [`executeReplenishmentMove`:1795–1865][replen-move]. The same dependency is present in [`transferLots`:1173–1199][lot-transfer], [claim transformations:2157–2169][claim-output], and [build output:1121–1130][build-output]. Audit [counterexample:145][audit-received] reproduces the cost guard with a fake SQL result; it is not a full transfer reproduction.

**B. Mutable cost snapshot.** Claim allocations snapshot cost components. `validatePickInventory` and transformation execution reject differences from the lot's live costs. Applying an invoice/source cost revision updates lot/COGS values without updating these allocation snapshots. The picker rethrows a cost-change error; its automatic reconciliation is specifically for location/quantity errors.

Evidence: [allocation snapshot:618–635][claim-cost-snapshot]; [pick rejection:2605–2623][claim-cost-pick]; [transformation rejection:1921–1939][claim-cost-transform]; [`applyCostRevision`:172][cost-revision]; [`revalueComponent`/lot update:289–306][cost-revalue]; [picker catch policy:1597–1615][canonical-reconcile].

**Recommendation.** Separate physical identity/custody eligibility from historical cost completeness and accounting revision identity. Keep lot attribution and claim safety. For verified physical stock with incomplete historical cost evidence, design an explicit unresolved-cost obligation and reconciliation status; do not fabricate receipts, silently assume zero cost, or merely delete the validator. Legitimate recosting should update versioned valuation evidence without requiring physically reallocating unchanged owned stock.

This policy change needs explicit design/approval because it changes which accounting incompleteness may coexist with a physical movement. It is not permission to bypass ownership, negative-stock, warehouse, or exact-SKU checks.

**Unknown / next proof.** Current affected lots/claims were not queried. The previously repaired lot-56 incident is not asserted to remain broken. Add real movement tests for verified stock with missing historical denominator and claim → legitimate recost → pick/transform, including exact cost catch-up and auditability.

### F12 — Return restocking uses the wrong identity and incomplete original cost evidence

**Confirmed and reproduced.** The return case owner supplies separate OMS order ID, WMS order ID, and WMS line ID. `applyReturnRestock` passes **OMS** order ID to `resolveReturnCost`, which filters `oms.order_item_costs.order_id`. Despite that schema name, the foreign key references the **WMS** orders table.

Evidence: [return caller:756–765][return-caller]; [restock cost lookup:138][return-restock]; [resolver:99–119][return-cost]; [COGS foreign key:385–398][cogs-schema] and [its WMS import:16][cogs-schema-import]; [WMS orders declaration:88][wms-orders-schema].

Audit [counterexample:100][audit-return] calls the actual restock use case with OMS ID 51 / WMS ID 61 and a controlled SQL boundary. WMS 61 has cost 275 cents; an unrelated WMS 51 has 999. The implementation queries 51 and inserts 999. A missing coincident record instead sends the resolver to current fallback cost.

**Additional confirmed gap.** The resolver chooses the latest same-SKU cost row, not the original WMS line's exact lot allocations, and uses rounded cents rather than authoritative mills. The return creates a new lot without a cost origin/contribution edge. Later graph-driven recost follows those edges, so the return lacks that linkage. See [restock:138–203][return-restock] and [revision traversal:35–67][cost-revision-graph].

**Recommendation.** Branded OMS/WMS/line identities; resolve returned quantities against original shipped/picked allocation evidence; preserve exact cost layers and return lineage. Correcting only the parameter does not fix multi-lot returns or recost propagation.

**Unknown / next proof.** No live return valuation was inspected. Add distinct/colliding IDs, multiple same-SKU lines, partial multi-lot returns, sub-cent costs, retry, and subsequent recost tests. The existing mock returns a cost without checking query identity [at test lines 26–28,69–70][return-test].

### F13 — Invalid authoritative costs are silently replaced by compatibility mirrors

**Confirmed and reproduced.** `toBigInt` treats missing values as zero; `preferredMills` accepts authoritative mills only when greater than zero and otherwise uses cents. Negative authoritative mills are replaced before `normalizeBuildLotCosts` checks for negative values.

Evidence: [parsers:123–144][cost-parsers]; [normalizer:244–297][cost-normalizer]. Audit [counterexample:137][audit-cost] supplies authoritative `-50` mills and a positive 5-cent mirror; the function accepts **500 mills**. Separate reviewer probes also confirmed missing/blank values collapse to zero/fallback. Existing negative tests cover cents, not this authoritative-field case.

**Recommendation.** One strict domain cost contract that distinguishes known zero, unknown, invalid, and explicitly admitted historical cent-only evidence. Validate authoritative input before choosing a compatibility source. A genuine zero cost is valid when supported; it must not automatically mean missing.

**Unknown / next proof.** Production prevalence of invalid or blank values is unknown. Add negative/missing/blank authoritative values, component-sum mismatch, zero-cost evidence, and integer bound tests. Move this pure function out of an infrastructure module whose imports pull in the global database.

### F14 — Two inventory valuation endpoints compute different values

**Confirmed.** `InventoryLotService.getInventoryValuation` multiplies quantity by rounded unit-cost **cents**. Both inventory valuation and procurement valuation routes use it. `COGSService.getInventoryValuation` aggregates **mills** before converting to cents. `updateVariantCosts` also derives a weighted average from cent mirrors.

Evidence: [lot valuation:1250–1304][lot-valuation]; [inventory route:1317][inventory-valuation-route]; [procurement route:30][procurement-valuation-route]; [COGS valuation:757–815][cogs-valuation]; [COGS route:2648][cogs-valuation-route]; [weighted mirror:1212–1238][lot-average].

**Arithmetic counterexample.** This repository defines mills as 1/100 cent ([schema:394–398][cogs-schema]). Three units at 149 mills each have a rounded unit mirror of one cent: the first API returns three cents, while aggregating 447 mills and then rounding gives four cents. This is a source-derived example, not a production valuation comparison. The COGS report also rounds per product; the desired aggregate rounding boundary should be explicit.

**Recommendation.** One exact valuation read model and rounding policy. Endpoint groupings may differ; authoritative monetary arithmetic must not. Display mirrors must not become a separate valuation authority.

**Unknown / next proof.** Current financial difference is unknown. Add cross-endpoint exact-value fixtures, multiple products, zero/provisional cost, and rounding remainder conservation.

### F15 — Output cost confidence depends on the transformation path

**Confirmed.** Canonical transformation/build output SQL sets `cost_provisional=0`; its source query does not load that flag. Manual build execution also inserts zero. By contrast, replenishment conversion and ordinary transfers propagate provisional classification from source lots.

Evidence: [canonical input:1871–1876][claim-transform-input]; [canonical output:2138,2149][claim-output]; [manual build output:1091–1099][build-output]; [replenishment propagation:1857][replen-move]; [ordinary transfer:1187][lot-transfer].

**Recommendation.** One cost-layer production policy preserving exact component values, lineage, and evidence classification across claim/free-stock owners. Do not certify an output's cost merely because a physical build completed.

**Unknown / next proof.** Contribution edges remain present in these transform/build paths, so this is not proof all later recost is impossible. Add provisional-source → every output-path tests and confirm downstream reporting/correction selection sees the same confidence state.

## 5. Conditional and legacy findings — not all current canonical failures

These should not be presented as additional proven production incidents.

| ID | Confirmed behavior and evidence | Reach / recommendation / unknown |
|---|---|---|
| L01 | Legacy picks can accumulate from different source bins, but legacy unpick resolves one stored location. `InventoryUseCases.unpick` clamps its movement to that location's picked balance, returns success, and the caller can reduce the whole WMS line. [Legacy pick:2700,2850–2859][legacy-pick]; [clamping:783][core-unpick]; [line update:3309–3315][legacy-unpick-progress]. | Legacy-only counterexample: pick 3 from B and 2 from A, then unpick 5 from stored A; only 2 are reversed physically while WMS can become 0. Canonical pick rejects a source switch after picking [at 5118–5146][claim-source-fence]. Require exact attributed reversal or reject atomically; never a success boolean for partial work. Live legacy authority was not established. |
| L02 | Legacy `reserveForOrder` writes the complete level reservation and ignores whether `reserveFromLots` attributed that full amount; the lot helper can return a partial result. Release likewise does not reject all remaining unattributed quantity. [Reservation owner:1487–1511][legacy-reserve]; [lot helpers:290–382][lot-reserve]. | Callers exist; this is not simply dead code. Post-opening quantity guards should reject independent projection writes, so this is not a proven ledger bypass. Retire the path with its authority; until then require exact attribution. |
| L03 | Legacy break preview and execute interpret `parentVariantId` in opposite directions. Compare `previewBreak` [at 472][break-preview] with execution [at 170][break-execute]. | Canonical sealed-path authorization is separate. Remove legacy hierarchy execution after verifying no supported caller requires it; until then one conversion resolver must define direction. No current canonical failure inferred from this legacy discrepancy. |
| L04 | `createAndExecuteReplen` can hold a pick-bin advisory lock and call a public operation that acquires the same lock through another transaction. [Outer lock:2528–2563][replen-nested]; [inner entry:2182][replen-trigger]; [lock wrapper:328–345][replen-lock]. | A real isolated PostgreSQL counterexample produced lock timeout `55P03` for the stockout/`blocksShipment:true` branch [audit:160][audit-lock]. Searched production callers currently supply false; treat as dormant. Internal composition must reuse the transaction/lock, not re-enter a public locking command. |
| L05 | Cascade creation persists resolved `executionMode`, but dependent wake-up checks the raw rule's `autoReplen === 1` instead of the frozen resolved mode. [Creation:3462–3487][cascade-create]; [wake-up:1500–1506][cascade-wakeup]. | Inherited inline mode can remain pending at that wake-up. The web inventory-change callback may later re-evaluate it [at 511–517][inventory-callback], so permanent stalling is not proven there. All compositions should resume the frozen plan via the same owner, not reimplement policy from raw settings. |

## 6. Lots: what they represent, and what should be separated

**Confirmed:** lots currently contain both physical attribution and accounting evidence. Removing all lot use would remove claim ownership and movement lineage, not merely accounting. The right separation is between those responsibilities, while retaining one quantity authority.

| Data | Current use | Recommended boundary |
|---|---|---|
| Lot ID, exact variant, warehouse/location identity | Claim allocation, FIFO selection, movement, relocation, shipment attribution | Preserve exact physical identity; no independent bin-versus-lot truth |
| `qty_on_hand`, `qty_reserved`, `qty_picked`, `qty_packed` | Journal-projected custody and availability | Read-only projections after opening; reserved overlaps on-hand, not extra physical stock |
| Status and `received_at` | Eligibility and FIFO ordering | Explicit physical eligibility/FIFO policy shared by operation owners |
| `qty_received` | Historical lot denominator for cost contribution; untouched-build-output reversal checks | Not current availability; unknown historical provenance must be explicit |
| `qty_consumed` | Build/legacy consumption and reversal checks | Do not treat it as a complete shipment/physical ledger |
| Cost component mills and `cost_provisional` | Valuation, output-layer production, and presently claim/pick admission | Separate versioned accounting evidence from physical ownership; preserve exact cost and confidence |
| Receipt/build/PO links and contribution edges | Origin attribution and subsequent cost revisions | Keep auditable lineage or an explicit unresolved obligation, never invented history |

Evidence: [lot schema:946 onward][lot-schema]; [quantity bucket rules:73–104][quantity-domain]; [claim validation][claim-cost-pick]; [cost contributions][cost-contribution]; [build reversal policy:327][build-reversal].

For example, the quantity domain models a pick as movement from on-hand custody into picked custody, not shipment from the building. Reserved stock is an encumbrance on on-hand, not an additional physical bucket. A cost denominator cannot be substituted for either of these quantity states. This is why “there is stock in the bin” and “the historical cost contribution is valid” currently produce different answers in F11.

**Unknown:** live completeness of cost lineage and current bucket balances. This report does not authorize another stock/metadata repair.

## 7. Coding/architecture assessment against the requested standards

### 7.1 One source of truth must include decisions, not only writes

The final journal owner is shared. Source selection (F01/F08), readiness (F04), execution mode (F10/L05), cost parsing (F13), and valuation (F14) still have competing interpretations. Adding another cross-check between those interpretations would preserve the problem. Move each rule to one typed domain policy and make every entry point call it.

The writer ratchet is useful but cannot prove one operation primitive: it groups all files under `server/modules/<module>` into a single bucket, and explicitly does not gate unresolved dynamic-table writes. See [`writerBucket`:59–62 and scanner limits:23–27][writer-ratchet]. Keep the ratchet and database protections; add narrower import/owner tests for protected operations. This is not evidence that a scanned independent quantity write succeeds after opening.

### 7.2 A primitive is not another giant service

The reviewed orchestrators are large: `PickingUseCases` is approximately 4,070 lines, `ReplenishmentUseCases` 3,930, `InventoryUseCases` 2,554, and the canonical inventory repository 2,836. Size alone is not a defect. The cited examples show the actual issue: these files mix policy, source resolution, database mutation, logging, workflow state, and recovery decisions.

Recommended conceptual boundaries below are **proposals**, not claims these exact APIs already exist:

| Responsibility | One authoritative operation | What it must not also do |
|---|---|---|
| Pure custody arithmetic | Existing quantity-domain rules | Resolve orders, choose bins, price lots, or call providers |
| Quantity persistence | Existing journal posting owner | Decide conversion authority or infer a human action |
| Source/quantity planning | Shared pick/replenishment planners with typed exact-SKU units | Mutate inventory while merely previewing a plan |
| Pick/unpick application command | Admit stable intent, validate locked plan, post exact custody/line progress and receipt | Independently choose another bin, retry unrelated effects inline, or reopen terminal orders |
| Replenishment command | Create/reuse a frozen plan; execute against its authority; credit from a receipt | Treat destination matching as proof of fulfillment |
| Cost-layer production | Preserve exact components, origin edges, and confidence | Fabricate receiving history or decide physical claim ownership |
| Workflow transitions | One order owner and one replenishment-task owner | Raw arbitrary status patches from routes/helpers |
| Follow-up delivery | Durable, idempotent effect handling | Repeat a physical movement because notification/projection failed |

Claim-owned inventory and unclaimed/free stock are distinct authorization scopes. Share the lower planning/posting/cost primitives without merging those scopes into an unsafe “move anything” function.

### 7.3 Explicit contracts would prevent observed bugs

Examples grounded in this review:

- Branded `OmsOrderId`, `WmsOrderId`, and `WmsOrderItemId` prevent F12's numeric-identity mix-up.
- Exact-SKU quantity and base-unit quantity types prevent F07's implicit conversion.
- Required authority ports prevent F05's silent legacy default.
- A movement receipt containing command ID, exact source/destination, quantities, and allocation identity prevents F06's unsupported task credit.
- Narrow command DTOs and expected revisions prevent F09's arbitrary-body/stale-status writes.

The web composition currently combines multiple storage modules into an `as any` dependency [at services/index.ts:282–289][picker-composition]. Replace that with focused ports as each owner is consolidated, rather than introducing interfaces that runtime callers do not use.

### 7.4 Reads should not secretly repair state

`getPickQueueOrders` mutates order and item progress during a queue read [at 718–747][queue-self-heal]. Move repair into an explicit, auditable command or durable projection owner. A read model should tell the truth about committed state, including an actionable inconsistency, without hiding lifecycle changes in GET behavior.

There is also a concrete contract mismatch: its SQL/mapping omits catalog/tracking/warehouse fields later consulted by `loadPickQueue`. The test fixture supplies richer fields than the real query. See [orders.storage.ts:577–637][queue-dto], [`loadPickQueue`:3904–3942][pick-queue-policy], and [pick-queue-read-load.test.ts:18–25][queue-dto-test]. The current unfiltered route does not establish a production warehouse-filter failure; test actual query-shaped rows before tightening filtering or non-stock decisions.

### 7.5 Dead-code and obsolete-abstraction candidates

“No caller found” below means the reviewed non-test repository search; it does not prove that an external consumer cannot exist. Verify imports, HTTP contracts, scripts, and operational dependencies before deleting. Do not drop historical records as code cleanup.

| Candidate | Evidence | Recommended disposition |
|---|---|---|
| `ordersStorage.updateOrderItemStatus` | Declaration at [1092–1115][unused-item-update]; no non-test invocation found in searched server/client/scripts | Remove after contract check; keep the actual guarded WMS command owner |
| `ReplenishmentUseCases.cancelTask` / `getActiveTasks` | Declarations at [1564][unused-cancel] / [1523][unused-active]; routes instead use repository/raw update paths | Route through a real transition/query owner or delete unused facade methods; do not retain two APIs |
| `BreakAssemblyService.notifyChange` | Declaration at [114][unused-break-notify], callback registered by composition [at 547–550][break-callback], no invocation found | Remove misleading unused callback plumbing or connect the single intended effect owner; inventory-core callback already exists |
| Picker bin-count modal path | State initializes closed/null and found setters only close/clear; server guidance never sets `binCountNeeded` true. [Picking.tsx:1167][bin-modal]; [guidance:2249][pick-replen-tail] | Treat as a UI retirement candidate, not proof its HTTP endpoint is unreachable. Consolidate counts into the actual count workflow |
| `InventoryQuantityPostingPort` | Defined in [quantity-ledger.port.ts][quantity-port]; concrete implementation is instantiated directly by runtime owners | Either inject the useful seam or remove unused abstraction, not the implementation |
| `replayQuantityMovements` | [Domain function:130][quantity-replay], test callers found, no operational runtime consumer found | Keep as reference/test fold if useful; do not advertise an unimplemented production rebuild command |
| `inventory.order_line_costs` compatibility table/export | Retired table still created by [startup DDL:976][old-cost-startup] and exported [in inventory schema:1083][old-cost-schema]; no active runtime reader/writer found | Remove obsolete startup creation/export only after historical migration/external-dependency verification; not a data-drop recommendation |

Legacy lot creation, reserve/release, and direct-counter branches have callers. They cannot be declared dead simply because a canonical implementation also exists.

## 8. Recommended implementation — three coherent batches

These are recommended work packages, **not implementation approval and not a requirement for dozens of deployments**. Build/review each coherent batch in a clean worktree. Related changes may be developed in parallel once ownership contracts are fixed. No production migration or data correction is implied here.

### Batch A — Make picking and replenishment trustworthy end to end

Address F01–F10, including stable unpick identity and the monitor composition, as one coordinated operational correction:

1. Define exact pick/replenishment plans, quantity units, command identity, and execution receipts.
2. Make UI guidance and server execution consume the same source plan.
3. Require runtime authority at every composition root; remove production defaults to test authority.
4. Route all replenishment triggers through shared plan/create/execute logic, with capacity-aware source resolution and the actual method.
5. Credit tasks only from committed movement receipts, with partial quantities and replay protection.
6. Consolidate guarded order/task transitions; separate assignment release from order reopening.
7. Make required follow-up work durable; distinguish committed inventory from outstanding delivery.
8. Fix dormant nested locking while consolidating transaction ownership; no independent re-entrant connection for the same command lock.

Exit proof: the precise regressions in F01–F10 pass through HTTP/application owners and real PostgreSQL where state/concurrency matters. Response loss, duplicate requests, mid-operation rollback, and process restart cannot double-post or lose required work. Existing corrective-picking protections still pass.

### Batch B — Separate physical eligibility from accounting evidence correctly

Address F11–F15 together:

1. Agree the explicit policy for physical stock with incomplete historical cost evidence. Distinguish known zero, unknown, and invalid evidence.
2. Correct return order identity and preserve original line/lot allocation, exact mills, and recost lineage.
3. Extract strict cost parsing/normalization and shared output-layer production; preserve provisional classification.
4. Version/reconcile cost evidence independently of unchanged physical claim ownership.
5. Consolidate valuation arithmetic and the rounding boundary; stop using display mirrors as an independent calculator.

Exit proof: a legitimate recost does not strand unchanged owned stock; incomplete history is visible and auditable rather than fabricated; returns/conversions/builds preserve amounts and provenance; every valuation endpoint derives the same exact totals under its declared grouping/rounding contract.

This is a policy/engineering change, not a bulk rewrite of `qty_received` or authorization to alter existing accounting evidence.

### Batch C — Retire duplicate paths and enforce the final ownership boundaries

1. Verify actual supported runtime authorities, scheduled commands, recovery scripts, and external callers.
2. Retire legacy branches proven unnecessary; preserve required historical evidence and an explicitly supported compatibility path only where justified.
3. Remove verified dead methods/callbacks/UI paths and obsolete startup/schema exports.
4. Replace broad `any` storage bundles with focused ports; put pure policies in domain modules and orchestration in application owners.
5. Add owner/import tests supplementing the module-level writer ratchet. Keep database protections as the final backstop.
6. Update operational documentation to describe the real primitive, its callers, transaction boundary, replay receipt, and failure recovery.

Exit proof: one supported owner per command/policy, no hidden mutation in read endpoints, explicit unknown-cost behavior, and an inventory of retained compatibility paths with real callers. This batch must delete obsolete behavior, not merely add wrappers around it.

## 9. Validation performed

No production connections were used for this review. PostgreSQL tests ran on a task-owned local PostgreSQL 17 cluster bound to `127.0.0.1:55481`, with disposable test databases. The cluster was stopped after testing; audit artifacts were retained. Application source in the reviewed checkout was unchanged, and the primary checkout's ten unrelated tracked modifications were left untouched.

| Run | Result | Scope / limitation |
|---|---|---|
| Focused inventory unit suites, picking guards/routing, writer-ratchet checks | **850 passed / 87 files** | Pure/mock/source tests; not production or end-to-end proof |
| Quantity ledger, ledger hardening, replenishment claim safety, cost-lineage owner PostgreSQL suites | **59 passed / 4 files** | Actual isolated PostgreSQL transaction/constraint tests |
| Confirmed-pick inventory and pick-correction PostgreSQL suites | **27 passed / 2 files** | Actual owners/workflows with documented peripheral stubs and reduced test schemas |
| Replenishment source-empty suite | **30 passed / 1 file** | Mock-based workflow coverage |
| Audit-only counterexamples | **8 passed / 1 file** | Seven controlled unit/application probes; one actual PostgreSQL advisory-lock counterexample |

**Total existing tests: 966 passed across 94 files.** The eight audit tests are additional and intentionally assert the undesired current behavior. Their passing result means the counterexample was reproduced, **not** that the implementation is correct or fixes have been tested. Overlapping tests run by individual reviewers are not added again.

Audit counterexample index:

| Test | Finding | Boundary |
|---|---|---|
| [Repeated unpick][audit-unpick] | F02 | Actual picker adapter; fake claim owner/storage |
| [P10 shortfall][audit-units] | F07 | Actual evaluator + execution domain; controlled context/resolver |
| [Unsupported full task credit][audit-task-credit] | F06 | Actual task method; fake database/dependent work |
| [Default legacy authority][audit-authority] | F05 | Actual factory; database access explicitly forbidden |
| [Wrong return order cost][audit-return] | F12 | Actual restock command; SQL-parameter-aware fake boundary |
| [Negative authoritative mills][audit-cost] | F13 | Actual normalizer |
| [Zero received metadata][audit-received] | F11A | Actual contribution validator; controlled database rows |
| [Nested advisory lock][audit-lock] | L04 | Actual lock-owning methods and PostgreSQL; controlled evaluation results |

Artifacts retained locally (not included in this documentation publication; the audit-artifact paths below refer to the original Windows workspace):

- [Audit-only test source][audit-source] and [isolated test configuration][audit-config].
- [Initial unit results][unit-results], [ledger/replenishment PostgreSQL results][postgres-results], [additional picking/replenishment results][additional-results], [audit counterexample results][audit-results].

Not run: full repository CI, full application/test TypeScript checks, browser/device end-to-end suites, every canonical-claim integration suite, load tests, or a production census. Passing the selected tests does not establish those results. The newly reproduced gaps demonstrate why a large passing suite is not sufficient evidence of coherent ownership.

## 10. What is likely happening, what is not proven, and next checks

### What the code definitely does

It centralizes final quantity posting while retaining several independent decisions and lifecycle writers around that posting. F01–F15 identify exactly where those decisions diverge. Some protections correctly fail closed; other paths can report misleading progress or use the wrong cost identity.

### What is likely happening

**HYPOTHESIS:** repeated operational repairs are partly symptoms of this incomplete consolidation: the stock primitive can be correct while a caller uses a different source, unit, authority, workflow state, or cost contract. This interpretation is supported by the source defects, but attribution of any particular historical incident requires its command receipts/logs and exact deployed version.

### What is not proven

- Which current production orders, bins, lots, returns, or tasks are affected.
- Which maintenance scripts/schedulers run today and with what composition/version.
- Whether every historical error discussed in this conversation came from these defects.
- Whether all legacy authorities and external consumers can now be retired.
- Whether a production data repair is needed after code changes; no such repair is approved by this report.

### Required next checks

1. Review the report and approve an implementation batch; keep the existing ledger and ATP foundation.
2. Resolve the F11 accounting-incompleteness policy before changing physical eligibility. This is the main product/accounting decision, not another request to redesign picking stations or channels.
3. Turn the audit counterexamples into permanent tests that assert the **corrected** behavior; extend source-only concurrency scenarios into database/browser tests.
4. Verify runtime callers/composition before deleting compatibility code, including the maintenance monitor.
5. After an approved fix is deployed, perform a scoped, read-only census keyed to these findings. Propose any data correction separately with exact records, quantities/cost impact, and replay/audit behavior.

### Change summary, assumptions, risks, and failure modes

- **Changes made for this review:** this Markdown report, audit-only counterexample tests/configuration, local test results, and a disposable local test database. No application code, production data/configuration, channel quantities, or PR was changed.
- **Assumptions:** none about current production authority, affected record counts, or deployed code. Proposed interfaces and batches are recommendations, not existing features.
- **Primary risks:** wrong-bin attribution; repeated reversal; stranded post-commit workflow; unsupported transformation policy; false task completion; incorrect return valuation; cost evidence blocking warehouse work.
- **Important safe failures:** several cost/claim/ledger checks reject rather than silently corrupt quantity. Fix the contract mismatch without removing physical ownership, concurrency, or audit safeguards.
- **Completion of this request:** read-only review and report delivered. Implementation and operational remediation remain separate, unperformed work.

## Source references

All source links below are pinned by the baseline described in section 2. Line spans in the text identify the relevant code; links open at the span's starting line.

[quantity-doc]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/docs/INVENTORY-SINGLE-QUANTITY-AUTHORITY.md
[quantity-domain]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/domain/quantity-ledger.ts#L50
[quantity-post]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/quantity-ledger.repository.ts#L41
[quantity-project]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/quantity-ledger.repository.ts#L183
[quantity-migration]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/migrations/242_inventory_quantity_ledger.sql#L71
[quantity-port]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/quantity-ledger.port.ts#L1
[quantity-replay]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/domain/quantity-ledger.ts#L130
[claim-pick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts#L5039
[claim-source-fence]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts#L5118
[claim-inventory-pick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L1388
[claim-inline]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts#L5997
[claim-transform]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L1656
[claim-transform-input]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L1871
[claim-output]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L2127
[claim-cost-snapshot]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L618
[claim-cost-pick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L2605
[claim-cost-transform]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts#L1921
[build-run]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/build-execution.repository.ts#L789
[build-output]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/build-execution.repository.ts#L1084
[build-reversal]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/domain/build.domain.ts#L327
[break-entry]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/break-assembly.use-cases.ts#L170
[break-preview]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/break-assembly.use-cases.ts#L472
[break-execute]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/break-assembly.use-cases.ts#L170
[correction-service]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/pick-correction.service.ts#L40
[dispatch]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/operational-shipment-dispatch.repository.ts#L95
[pick-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.routes.ts#L347
[unpick-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.routes.ts#L375
[release-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.routes.ts#L318
[pick-entry]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L1708
[canonical-adapter]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L1485
[canonical-target]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L1438
[canonical-unpick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L2969
[canonical-reconcile]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L1597
[pick-reload]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L1749
[pick-queue]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L3913
[pick-queue-policy]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L3904
[pick-commit]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L2011
[pick-tail]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L2061
[pick-replen-tail]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L2205
[pick-progress-tail]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L2369
[ready-blockers]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L3651
[legacy-pick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L2700
[legacy-unpick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L3229
[legacy-unpick-progress]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/picking.use-cases.ts#L3309
[core-unpick]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/inventory.use-cases.ts#L783
[legacy-reserve]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/inventory.use-cases.ts#L1487
[lot-reserve]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/lots.service.ts#L290
[bin-lookup]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/warehouse/infrastructure/warehouse.repository.ts#L254
[bin-backfill]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/bin-location-backfill.ts#L11
[client-start]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/client/src/pages/Picking.tsx#L1898
[client-pick-request]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/client/src/pages/Picking.tsx#L270
[release-storage]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/orders.storage.ts#L924
[progress-storage]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/orders.storage.ts#L1134
[queue-selection]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/orders.storage.ts#L485
[queue-self-heal]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/orders.storage.ts#L718
[queue-dto]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/orders.storage.ts#L577
[queue-dto-test]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/__tests__/unit/pick-queue-read-load.test.ts#L18
[pick-replay-test]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/__tests__/unit/picking-canonical-authority-routing.test.ts#L217
[shipment-projection]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/wms/channel-fulfillment-projection.repository.ts#L58
[transfer-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/inventory.routes.ts#L174
[replen-evaluate]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L999
[replen-quantity-context]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L752
[replen-plan]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/domain/replenishment-execution.domain.ts#L82
[replen-execute]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L1329
[replen-execute-tail]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L1455
[replen-move]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/inventory.use-cases.ts#L1795
[replen-match]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L2736
[replen-factory]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L3923
[replen-source]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L3830
[replen-reresolve]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L526
[replen-block]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L484
[replen-inline-catch]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L606
[replen-exception]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L3182
[replen-auto-wrapper]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L3809
[replen-auto-domain]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/domain/replenishment-auto-execution.ts#L20
[replen-create]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/replenishment.routes.ts#L698
[replen-patch]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/replenishment.routes.ts#L758
[replen-delete]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/replenishment.routes.ts#L848
[replen-task-repo]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/replenishment.repository.ts#L329
[replen-nested]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L2528
[replen-trigger]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L2182
[replen-lock]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L328
[cascade-create]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L3462
[cascade-wakeup]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L1500
[legacy-authority]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/transformation-execution-authority.port.ts#L51
[monitor-package]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/package.json#L13
[monitor-script]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/scripts/monitor-pick-replen-health.ts#L235
[service-composition]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/services/index.ts#L273
[picker-composition]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/services/index.ts#L282
[inventory-callback]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/services/index.ts#L511
[return-caller]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/returns/infrastructure/return-case-operation.repository.ts#L756
[return-restock]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/return-restock.use-case.ts#L138
[return-cost]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/cost-resolver.ts#L99
[return-test]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/__tests__/unit/return-restock.use-case.test.ts#L18
[cogs-schema]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/shared/schema/oms.schema.ts#L385
[cogs-schema-import]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/shared/schema/oms.schema.ts#L16
[wms-orders-schema]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/shared/schema/orders.schema.ts#L88
[cost-contribution]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/cost-evidence.repository.ts#L106
[cost-revision]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/apply-cost-revision.ts#L172
[cost-revision-graph]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/apply-cost-revision.ts#L35
[cost-revalue]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/cogs.service.ts#L289
[cost-parsers]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/build.repository.ts#L123
[cost-normalizer]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/infrastructure/build.repository.ts#L244
[lot-schema]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/shared/schema/inventory.schema.ts#L946
[lot-transfer]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/lots.service.ts#L1173
[lot-average]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/lots.service.ts#L1212
[lot-valuation]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/lots.service.ts#L1250
[cogs-valuation]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/cogs.service.ts#L757
[inventory-valuation-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/inventory.routes.ts#L1317
[procurement-valuation-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/procurement/procurement-report.routes.ts#L30
[cogs-valuation-route]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/inventory.routes.ts#L2648
[writer-ratchet]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/scripts/writer-ratchet/scan.ts#L23
[unused-item-update]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/orders/orders.storage.ts#L1092
[unused-cancel]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L1564
[unused-active]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/replenishment.use-cases.ts#L1523
[unused-break-notify]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/modules/inventory/application/break-assembly.use-cases.ts#L114
[break-callback]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/services/index.ts#L547
[bin-modal]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/client/src/pages/Picking.tsx#L1167
[old-cost-startup]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/server/db.ts#L976
[old-cost-schema]: https://github.com/cardshellz/Echelon/blob/f90970ec8150295da0ccdfaa919b0244675a3a69/shared/schema/inventory.schema.ts#L1083
[audit-source]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts
[audit-config]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/vitest.audit.config.ts
[audit-unpick]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:22
[audit-units]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:48
[audit-task-credit]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:76
[audit-authority]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:91
[audit-return]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:100
[audit-cost]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:137
[audit-received]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:145
[audit-lock]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/review-repros.test.ts:160
[unit-results]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/unit-tests.json
[postgres-results]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/postgres-tests.json
[additional-results]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/picking-additional-tests.json
[audit-results]: C:/Users/owner/Echelon/.codex-audits/inventory-system-review-20261001/audit-repros.json
