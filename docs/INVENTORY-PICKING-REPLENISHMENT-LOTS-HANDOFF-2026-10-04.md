# Picking replenishment and inventory lot review handoff

Prepared October 4, 2026. Git baseline checked at approximately 08:31 Eastern.

This handoff resumes the **code architecture review of picking, replenishment, inventory movement, and lot costing**. It is not a new ATP implementation, another cutover checklist, a channel UI redesign, or an instruction to repeat completed order recoveries.

The October 1 review found an existing authoritative quantity-posting primitive but inconsistent operation owners around it. Preserve that foundation; investigate and consolidate the callers, policies, transactions, and follow-up work. This was the report's conclusion at its pinned baseline, not a fresh claim about every current code path. [Original conclusion][review-conclusion]

## Start here

1. Read the [original findings report][review] in full. It contains the detailed traces, exact functions, source links, counterexamples, limits, and recommendations.
2. Read this handoff in full, including the later changes and uncommitted recovery work below.
3. Read applicable `AGENTS.md` instructions wherever present and [BOUNDARIES.md][boundaries]. No `AGENTS.md` was found at the checked root/ancestor/docs paths during this handoff; the user supplied engineering instructions in the conversation. Their important requirements are preserved below. `BOUNDARIES.md` is dated May 30: retain its ownership principles, but verify its older runtime descriptions against current code.
4. Use the [new session prompt][prompt] to begin a focused chat in `C:\Users\owner\Echelon`.

**Publication scope:** this branch publishes the findings report, this handoff, and the new-session prompt together under `docs`. The original local report remains untouched (SHA256 at handoff: `7A32BB3ACB4510DC1D5D126BFFA2184140B4CC60D47DF25A3F1B5D73E63C6765`); the published copy changes only source-link presentation, the local-artifact notice, and trailing whitespace. Recovery code, recovery records, audit tests/results, and `.tmp` files are not included. Their absolute paths below remain local-only references, unavailable in a fresh clone. If those artifacts are unavailable, state that limitation rather than inventing their contents. Preserve the historical findings; record current verification in a separate addendum.

## What is verified and what is not

- **Verified for this handoff:** the report and audit artifacts exist; the worktree states below were inspected; `git fetch origin main` succeeded; the listed later commits are in the fetched main history; the two recovery records were read.
- **Historical findings:** F01-F15 and L01-L05 describe the October 1 source baseline. Their detailed evidence is in the report. None has been reclassified as fixed or still open by this handoff.
- **Historical operational evidence:** the recovery records contain successful production readbacks for orders 63721 and 63764. Those observations were not queried again for this documentation task.
- **Not proven here:** current deployed commit, current live inventory/order state, which review findings remain, whether the local recovery code should become a general feature, or whether any production repair is now needed.
- **Authorization:** preparing this handoff authorizes documentation only. It does not authorize implementation, production writes, merge/deploy, new cutover actions, or rerunning recovery scripts. First produce the current findings status and proposed implementation scope for review.

## Workspace baseline and work to preserve

| Location | Verified state | Treatment |
| --- | --- | --- |
| `C:\Users\owner\Echelon` | Branch `codex/catalog-piece-uom`; HEAD `45312a58f42362113e7e7647326aa4c94ee9aeb2`; unrelated tracked catalog/UI/schema/fixture edits and many untracked files | Do not implement, reset, clean, switch branches, or broadly stage here. The root checkout is not the runtime baseline. |
| Fetched `origin/main` | `b8df7a3fa2260d19e11b18fe6d41fa9436f38687`, commit time `2026-10-03T22:10:53-04:00` | Snapshot only. Fetch again when the new session starts. This is not deployment proof. |
| `C:\Users\owner\.codex\worktrees\canonical-pick-conversions\Echelon` | HEAD `f90970ec8150295da0ccdfaa919b0244675a3a69`, branch `codex/fix-canonical-pick-conversions`; no tracked modifications reported | Historical checkout used by the review's source citations. Do not use it as current main or repurpose it without checking ownership. |
| `C:\Users\owner\Echelon\.codex-worktrees\order-63721-investigation` | HEAD `5aee5b65830efda69a0499efede8bc4e0e15585d`, branch `codex/order-63721-untracked-recovery`; modified picker file plus untracked recovery files | Unfinished local work. Preserve it. Do not reset, merge wholesale, or assume it is deployed. |
| `C:\Users\owner\Echelon\.codex-audits\inventory-system-review-20261001` | Counterexample source, configuration, and saved test-result JSON files exist | Historical evidence. Inspect before reuse; the tests intentionally demonstrate bugs. |

The original review also compared its source checkout with main `c8c81f48ea3d4e755cf1084d198daedf9678459a`. Its 47 cited source files matched that main snapshot at the time. Source line numbers in that report are pinned to the historical checkout, not current main. [Original baseline][review-baseline]

For future implementation, inspect existing worktree attachments and use a suitable clean worktree based on refreshed main, with a dedicated `codex/` branch. Keep the recovery work separate unless a specific, reviewed change is intentionally incorporated. Never reuse an unrelated PR number or link; verify the branch, head, changed files, and actual returned PR URL.

## Engineering requirements and settled direction

These are requirements carried from the user's instructions and decisions, not new feature proposals.

- Prove behavior through code, configuration, schema, tests, receipts, or logs. Cite exact files, functions, and lines. Separate confirmed facts, hypotheses, unknowns, and next checks. Do not infer production success from passing tests or a commit title.
- One source of truth means **one owner for each decision and operation**, not two implementations plus a check that their answers match.
- Keep the existing ATP engine, quantity journal, transaction protections, and derived balances. Do not add another inventory authority, ATP formula, or reconciliation calculator.
- Prefer small, focused primitives composed by application services. Separate domain policy, orchestration, persistence, external adapters, and HTTP/UI. No business rules or direct database mutation in transport handlers. Internal domains expose published interfaces; do not build speculative interchangeable adapters for systems we own.
- Use explicit input/output schemas, narrow command DTOs, exact units and identities, integer/decimal money, stable retry identities, transactions, ordered locking, atomic state transitions, and actionable structured errors. No silent fallbacks or hidden side effects. Inject nondeterministic dependencies where relevant.
- Physical-only, package-hierarchy, and build-managed behavior must govern every execution entry point. Do not infer a package conversion solely from package size or bypass an approved recipe. Automatic materialization must use the authorized server-side path, not depend on the picker manually performing a software conversion.
- Replenishment is rules/resolver driven. Plan, create, and execute must share the same policy and quantity definitions; the picker UI does not decide transformation permission.
- Preserve the distinction between claim-owned and unclaimed stock. Shared lower-level primitives do not justify consuming another order's stock or merging authorization scopes into a generic move-anything operation.
- Keep exact physical identity, custody, and lot/cost lineage. The user's objection to accounting metadata blocking physically available stock is not permission to erase lots, fabricate receipts, assume unknown costs are zero, or disable ownership/negative-stock checks. The explicit F11 policy still needs approval.
- Warehouse identity matters. The user explicitly expects eligible stock in linked reserve warehouses to contribute through the connected fulfillment hub, not require every reserve building to be separately connected to Shopify. This is context to preserve, not a request for another channel audit in this session.
- Removing a hold and releasing a picking assignment are separate actions. A hold does not imply a particular business reason. Preserve recorded picks; a shipment/provider status is not proof of a missing physical pick.
- Untracked shippable merchandise is not necessarily digital. Do not conflate inventory tracking, catalog identity, requires-shipping, and pick confirmation. Preserve the current intended behavior while verifying each code path.
- Remove duplicate/dead paths only after checking runtime imports, routes, jobs, scripts, and external consumers. Do not delete historical records as code cleanup.
- Work in large coherent batches with unit, real disposable PostgreSQL, and relevant browser coverage. Prove replay, concurrency, rollback, and post-commit recovery. Skipped database tests are not passing transaction tests. Do not equate a large green suite with closure of the specific defects.
- Keep the two-person operation usable; do not introduce new stations, artificial handoffs, or repeated approval ceremonies unrelated to the actual change. Explain unresolved decisions with concrete SKU/order examples, one issue at a time.
- Any future production correction needs a scoped preview, exact records and inventory/cost impact, audit/replay behavior, and explicit approval. Previous one-order approval does not grant general repair authority.

## Original findings to revalidate

**Status for every row below: current-main revalidation pending.** The priority and defect description are the historical report's assessment. The original report distinguishes source traces, controlled counterexamples, real PostgreSQL probes, and missing production evidence.

| ID | Original priority | Reported issue and principal trace | Original batch |
| --- | --- | --- | --- |
| F01 | P1 | Displayed pick bin can differ from executed bin: `loadPickQueue` -> `handleStartPicking` -> `resolveCanonicalPickTarget`. [Evidence][f01] | A |
| F02 | P1 | A retried partial unpick constructs another operation: `completeCanonicalUnpick`. [Evidence][f02] | A |
| F03 | P1 | Inventory commits before required follow-up work, which replay can skip: `pickItem`. [Evidence][f03] | A |
| F04 | P1 | Competing order lifecycle writers can overwrite newer state: `releaseOrder`, `updateOrderProgress`, shipment projection. [Evidence][f04] | A |
| F05 | P1 | Maintenance replenishment defaults to test-style legacy authority: monitor composition -> replenishment factory. [Evidence][f05] | A |
| F06 | P1 | Manual transfer marks replenishment tasks complete without a quantity receipt: `completeMatchingTransferTask`. [Evidence][f06] | A |
| F07 | P2 | Exact-SKU package counts and base-unit counts are mixed: `evaluateReplenNeed`, `planReplenishmentExecution`. [Evidence][f07] | A |
| F08 | P2 | Source resolution can stop at an insufficient preferred bin: `findSourceLocation`. [Evidence][f08] | A |
| F09 | P2 | Unguarded task transitions and post-commit error handling can misstate executed work: task PATCH/delete, `executeTask`, `executeInlineTaskAutomatically`. [Evidence][f09] | A |
| F10 | P2 | Manual task creation calculates auto-execution using a different method from the stored task: POST task -> `resolveAutoExecute`. [Evidence][f10] | A |
| F11 | P1 | Historical cost denominators or later cost revisions block physical execution: `recordLotCostContribution`, claim cost validation, `applyCostRevision`. [Evidence][f11] | B |
| F12 | P1 | Return costing confuses OMS/WMS IDs and omits original allocation lineage: `applyReturnRestock` -> `resolveReturnCost`. [Evidence][f12] | B |
| F13 | P2 | Invalid authoritative mills can be hidden by a cents fallback: `preferredMills`, `normalizeBuildLotCosts`. [Evidence][f13] | B |
| F14 | P2 | Two valuation owners use different monetary arithmetic: lot-service versus COGS-service `getInventoryValuation`. [Evidence][f14] | B |
| F15 | P2 | Build/transform outputs discard provisional-cost classification: output-layer inserts. [Evidence][f15] | B |

Also revalidate the report's conditional items without promoting them to proven production incidents: L01 exact legacy unpick attribution; L02 legacy reservation attribution; L03 hierarchy preview/execution direction; L04 nested advisory-lock re-entry; L05 dependent-task wake-up using raw settings instead of the resolved mode. See [conditional findings][legacy].

The cleanup inventory includes hidden writes during queue reads, mismatched real query/test DTO shapes, duplicate readiness/source policies, broad storage bundles, and candidate dead methods/callbacks. Those candidates are not permission to delete them without checking callers. [Architecture assessment][assessment]

## Later changes that make blind reuse of the report unsafe

The following commits appear in `c8c81f48..origin/main` history. Descriptions summarize their commit subjects; **their complete diffs and current call chains were not re-audited for this handoff**. These are navigation leads, not declarations that a finding is closed or deployed.

| Commit or group | Change to inspect | Revalidation focus |
| --- | --- | --- |
| `eb5e438b6` | Re-reserve short claims instead of blocking picks | Pick/recovery admission and retry behavior |
| `73a21b89f` | Warehouse context and confirmed cross-warehouse transfers | F01, F06, warehouse-specific source identity |
| `4d5f3bdde`, `ba6629536`, `9dd25d800`, `f72c02333`, `6f76a3c96`, `0bea428a5` | Confirmed shipped-pick recovery, holds, idempotency keys, reservation reconciliation | Ordinary versus corrective picking; do not assume one flow fixes the other |
| `75ad5de71` | Linked reserves in canonical hub ATP | Preserve agreed warehouse-network behavior |
| `dba14c3f5`, `d3d4e32e0`, `c230f8437` | Product behavior authority, approved conversions during picking, legacy authority/UI gaps | F05, model enforcement across all entry points, build versus package semantics |
| `370edbf32`, `6a9f050c6` | Hold removal and secured picking-assignment release | F04, retained picks/holds, guarded transitions, UI command snapshot |
| `147722f87` | Unmapped-line handling across reservation, picking, and ShipStation | Catalog/tracking/readiness contracts and remaining historical-line recovery gaps |

Use `git show <commit>` and trace the current owner and callers. Do not infer a general fix from an order-specific workaround or a commit title.

## Recent recoveries are completed historical work

Read the detailed records if working near their code. Do not rerun the scripts or reopen the incidents merely because this handoff mentions them.

| Order | Recorded successful outcome | Important distinction |
| --- | --- | --- |
| 63721 | WMS `209135`, OMS `995563`; shipment `18590`, ShipStation reference `797292365`, recovery audit `2386`. The recovery record confirms preserved picks and successful handoff; the runner pins the order IDs. [Record][recovery-63721] [Runner][runner-63721] | Its five picks were already confirmed. Repairing catalog identity/readiness did not create new picks or ship it. |
| 63764 | WMS `209181`, OMS `1001137`; shipment `18597`, ShipStation reference `797308360`, recovery audit `2389`. The record confirms the ordinary worker created the reservation/shipment and the ShipStation UI showed one Awaiting Shipment order. [Record][recovery-63764] | All items remained pending with zero picked/fulfilled quantities. Only three tracked lines received claims; the untracked card did not. This is not the confirmed-pick recovery case. |

The second record's final read was `2026-10-04T00:42:28.430Z`. Neither recovery purchased a label or marked the order shipped. These are recorded results at those times, not current status assertions. [63721 outcome][recovery-63721] [63764 result][recovery-63764-result]

One separate issue remains explicitly documented: the Release picking assignment UI twice reported a changed assignment, while the permission-checked owner accepted a current Drizzle snapshot. The exact UI snapshot mismatch was **not root-caused or fixed**. Revalidate this beside F04 if relevant; do not assume its cause or bypass the guard. [Recorded observation][release-observation]

## Uncommitted recovery work

All files below are in `C:\Users\owner\Echelon\.codex-worktrees\order-63721-investigation`. They are preserved local work, not an automatically deployed or generally approved backfill feature.

- Modified [picking.use-cases.ts][local-picker] delegates readiness checks to the new [ready-to-ship-blockers.ts][local-readiness], with a [unit suite][local-readiness-tests]. The recovery record describes this as extracting the existing formula rather than adding a second one. Inspect the actual diff before reusing it.
- OMS orchestration: [confirmed recovery][local-oms-confirmed], [never-picked recovery][local-oms-unpicked], and [shared recovery context][local-context].
- WMS-owned operations: [confirmed recovery][local-wms-confirmed] and [never-picked identity recovery][local-wms-unpicked].
- Transaction tests: [confirmed-untracked-line-recovery.integration.test.ts][local-recovery-tests]. The suite covers both recovery modes despite its filename.
- Incident runners, **not to execute as part of this review**: [recover-order-63721.ts][runner-63721], [recover-order-63764.ts][runner-63764], and [release-order-63764-assignment.ts][runner-release].
- The two recovery documents and `.tmp` evidence/readers/screenshots remain in that worktree. Do not copy environment files, credentials, or broad production extracts into the new handoff or a PR.

The later recovery record reports 40 focused passing tests, including 25 real disposable PostgreSQL cases. The fixture was not the complete production migration/trigger set. Full typecheck was not green: missing local dependencies and associated unrelated errors remained. These tests were **not rerun for this handoff** and are not proof that general picking/replenishment findings are fixed. [Recovery validation][recovery-validation]

## Proposed work packages remain proposals

Preserve the original grouping, then adjust only where current evidence justifies it. These are not a mandate for dozens of deployments or permission to start coding before scope review. [Original batches][batches]

**Batch A — Picking and replenishment operations.** Resolve the remaining F01-F10 as a coherent change: exact source/quantity plans, stable user-command identity, required runtime authority, shared replenishment plan/create/execute, quantity-receipt task credit, guarded order/task transitions, and durable post-commit effects. Preserve ordinary, corrective, claim-owned, and free-stock authorization distinctions.

**Batch B — Physical eligibility and accounting evidence.** Resolve the remaining F11-F15: correct return identity and lineage, strict exact costs, provisional output classification, versioned cost evidence, and one valuation policy. Before changing F11 admission, agree exactly how verified physical stock can move with unresolved historical costing, how the obligation is recorded, and how later costing is reconciled. Do not invent a receipt denominator or merely remove a guard.

**Batch C — Retirement and enforceable ownership.** Remove verified obsolete paths, hidden read-time writes, unused plumbing, and unsupported abstractions. Add operation-level ownership/import tests. Necessary cleanup can accompany A/B where cohesive; avoid a cosmetic refactor that leaves duplicate owners alive.

Exit criteria: one supported owner per relevant command/policy; preserved exact identity, quantity, cost, and authority; retries and races cannot double-post or overwrite terminal state; post-commit failure does not repeat physical work; required effects survive restart; tests exercise real boundaries rather than only permissive mocks. Preserve historical evidence and make retained compatibility paths explicit.

## First deliverable in the new session

1. Refresh main and record the exact source commit. Inspect the dirty worktrees without altering them.
2. Revalidate F01-F15 and relevant conditional/cleanup findings against current code. Use an existing suitable clean checkout, or inspect Git objects without switching the dirty root. Do not rerun a broad production census or cutover checklist.
3. Produce a current addendum with one status per finding: `open`, `partially fixed`, `fixed with evidence`, `superseded`, or `not yet verified`. Include exact current files/functions/lines, the relevant change and test evidence, remaining uncertainty, and the required next check. Preserve the historical report unchanged.
4. Identify overlaps with the uncommitted recovery work and any separate active effort before proposing replacement code. Do not silently incorporate incident scripts into runtime.
5. Recommend the first coherent implementation batch and identify genuinely unresolved decisions, particularly F11. Explain the practical effect plainly. Do not ask the user to re-decide settled architecture or repeat the entire thread.
6. Stop for scope approval before application implementation or production changes. Once approved, use the clean-worktree workflow and validate the full coherent change, not just an isolated patch.

For every implemented batch later, report the summary, assumptions, risks, test coverage and limits, failure modes, and what remains. Verify migration prefixes against current main before submitting a PR. Verify actual PR identity and CI independently from deployment and runtime proof.

## Handoff validation and limits

Preparing the local handoff checked all 40 defined local references for file existence and valid line bounds and confirmed that the original findings file's SHA256 was unchanged. Publication uses a separate clean documentation worktree and includes only the three requested Markdown files, with repository-relative document links and commit-pinned source links. The original local files and unfinished application work remain untouched. No application tests, production queries, recovery commands, provider writes, merge, or deployment are part of this publication. This handoff does not claim to remediate or revalidate the findings.

[review]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md
[review-conclusion]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L6
[review-baseline]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L26
[boundaries]: ../BOUNDARIES.md
[prompt]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-NEW-SESSION-PROMPT.md
[f01]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L114
[f02]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L126
[f03]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L136
[f04]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L146
[f05]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L158
[f06]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L170
[f07]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L180
[f08]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L190
[f09]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L202
[f10]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L214
[f11]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L224
[f12]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L242
[f13]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L256
[f14]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L266
[f15]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L278
[legacy]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L288
[assessment]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L320
[batches]: ./INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md?plain=1#L381
[recovery-63721]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/docs/ORDER-63721-RECOVERY-2026-10-03.md
[recovery-63764]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/docs/ORDER-63764-INVESTIGATION-2026-10-03.md:39
[recovery-63764-result]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/docs/ORDER-63764-INVESTIGATION-2026-10-03.md:53
[release-observation]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/docs/ORDER-63764-INVESTIGATION-2026-10-03.md:47
[recovery-validation]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/docs/ORDER-63764-INVESTIGATION-2026-10-03.md:65
[local-picker]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/orders/picking.use-cases.ts
[local-readiness]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/orders/ready-to-ship-blockers.ts
[local-readiness-tests]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/orders/__tests__/unit/ready-to-ship-blockers.test.ts
[local-oms-confirmed]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/oms/application/confirmed-untracked-line-recovery.service.ts
[local-oms-unpicked]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/oms/application/unpicked-untracked-line-recovery.service.ts
[local-context]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/oms/application/untracked-line-recovery-context.ts
[local-wms-confirmed]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/wms/confirmed-untracked-line-recovery.ts
[local-wms-unpicked]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/wms/unpicked-untracked-line-recovery.ts
[local-recovery-tests]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/server/modules/oms/__tests__/integration/confirmed-untracked-line-recovery.integration.test.ts
[runner-63721]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/scripts/recover-order-63721.ts
[runner-63764]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/scripts/recover-order-63764.ts
[runner-release]: C:/Users/owner/Echelon/.codex-worktrees/order-63721-investigation/scripts/release-order-63764-assignment.ts
