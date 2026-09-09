# Inventory cutover closure batch — September 9, 2026

## PR publication update

The user subsequently requested a PR. `origin/main` was refreshed to `535a21329` (merged PR1425, census/journal hardening) and merged into this isolated branch. Both upstream hardening and this batch's terminal-demand correction are retained. The NULL-journal regression now distinguishes upstream's proven, in-memory FK completion from a stored journal mutation; conflicting stored IDs remain unchanged and blocked.

The investigation snapshots, counts, hashes and code references below describe the **pre-publication candidate against baseline `c59cedf67`**, not a new production capture after PR1425. They must not be reused as current activation evidence. Publication does not perform production queries, change authority/configuration or resolve the remaining blockers.

Fresh post-integration validation: **11,653 unit tests passed, 37 skipped; 995 files passed, 1 skipped.** The five PostgreSQL preflight/reconstruction/composition/capture-stage/OMS receipt suites passed **112 tests**, with no skips. Typecheck, production build and the four explicit writer-ratchet/migration-prefix assertions passed. The task-owned PostgreSQL cluster was verified and stopped. Results are retained locally in `.codex-artifacts/closure-pr-{unit-tests,postgres-tests,typecheck,build,architecture-guards}.log`; remote CI status is separate.

## Outcome

One local correctness batch plus a read-only review of the remaining cutover gates. **Not activated; not ready to activate.** No production inventory, orders, recipes, configuration, reservations, ATP authority or channel quantities were changed by this investigation.

The deployed reconstruction incorrectly included `completed` WMS orders as new demand. The candidate corrects that classification across the demand reader, reconstruction reader, preflight and planner, while retaining stock/cost/shipment exceptions. Comparing deployed and candidate code on **the same production snapshot**:

| Measure | Deployed baseline | Candidate |
| --- | ---: | ---: |
| Orders proposed for canonical claims | 199 | 131 |
| Order lines proposed for canonical claims | 455 | 311 |
| Demand-identity errors | 974 | 0 |
| Terminal-order custody-review flags | 4,175 | 5,144 |
| Unknown journal-owner groups | 18,862 | 18,862 |
| Eligible empty-bin promise-release positions | 0 | 0 |
| Reconstruction ready | No | No |

All **68 removed proposed orders are `completed`**. This does not erase their inventory obligations: custody flags increase because completed orders' unresolved ownership is now classified correctly. Counts are findings, not quantities or independent incidents.

Snapshot: `2026-09-09T14:08:36.801Z`, repeatable-read, `transaction_read_only=on`. Authority was `legacy`, revision `1`, no activation run. Baseline commit: `c59cedf67df47c974236de51e0f2e2051952210a`. Candidate evidence hash: `9c94274a743d7c73936767052b2ba0af47af5a451bc9bb1526a0a3f65a96f401`. Baseline evidence hash: `c98325daccc0f187b6276c6dae25ab12cc30f5fd988cdb14eedc7065345df242`.

## Workspace and deployed baseline

- Clean worktree: `C:/Users/owner/Echelon/worktrees/inventory-cutover-closure-batch`.
- Branch: `codex/inventory-cutover-closure-batch`, based on refreshed `origin/main` at the baseline commit above.
- The original checkout's ten unrelated catalog/UOM modifications remain untouched.
- No new commit, push, PR or deployment was performed in this batch. Do not reuse another workstream's PR number.
- PR **1424**, `fix(inventory): persist eBay quantity rejection evidence and cooldowns`, is merged at that commit. Heroku `cardshellz-echelon` release **v2894** succeeded at `2026-09-09T13:00:59Z`; `web.1` was up on that release. Migration `0663` and its immutable evidence protections were verified installed.
- The architecture/migration plan and the September 8 integrated handoff remain the design baseline. This is a closure update, not a new migration plan or a restart of the implementation phases.

## What the code definitely does

Code references below are repository-relative paths in this worktree, with function names and relevant lines. Baseline differences refer to the exact commit above, not an assumed production version.

| Fact / change | Exact evidence and reasoning | What this does not establish |
| --- | --- | --- |
| `completed` is closed to new WMS demand. | `server/modules/orders/cancel-wms-order.ts:69–99`, `completeWmsOrderAndRelease`, invokes `completeOrder` and releases leftover reservations after transition. `server/modules/orders/order-status-core.ts:258–276`, `completeOrder`, transitions to `completed`. `server/modules/orders/orders.storage.ts:765–789`, the pick-queue self-heal branch, explicitly treats completion as terminal demand. | Successful historical reservation release, physical dispatch or original cost correctness. The completion path can retain a release failure. |
| Completion is not proof of shipment. | `shared/enums/order-status.ts:141–161`, `deriveOmsFromWms`, returns no OMS transition for `completed`; only the shipped case derives shipped status. The new `TERMINAL_WMS_DEMAND_STATUSES` / `isTerminalWmsDemandStatus` at `:49–62` intentionally describe demand only. | Carrier possession, external fulfillment or permission to debit inventory. |
| The deployed readers omitted `completed` from their terminal exclusions. | Baseline `server/modules/wms/inventory-cutover-demand-reader.ts:60,72`, `readWmsCutoverDemand`; baseline `server/modules/wms/inventory-cutover-reconstruction.reader.ts:25`, `readWmsCutoverReconstruction`; baseline `server/modules/inventory-planning/domain/inventory-cutover-reconstruction.ts:132`, `planCutoverReconstruction`. Each used only shipped/cancelled. | That all findings involving completed orders are harmless. |
| Both candidate readers use the shared terminal-demand contract. | `server/modules/wms/inventory-cutover-demand-reader.ts:53–76`, `readWmsCutoverDemand`, binds the shared status array for both count and selection. `server/modules/wms/inventory-cutover-reconstruction.reader.ts:16–38`, `readWmsCutoverReconstruction`, excludes closed demand but includes residual order IDs and actual parents of residual item IDs. | A repair to incorrect historical journal headers. Both identities remain available for review. |
| The planner never adopts completed-order custody as fresh customer demand. | `server/modules/inventory-planning/domain/inventory-cutover-reconstruction.ts:125–141`, `planCutoverReconstruction`, handles terminal residuals before variant/warehouse demand validation and blocks unknown/null lifecycle states. `server/modules/inventory-planning/domain/inventory-cutover-preflight.ts:170–173`, the demand-classification branch, uses the same terminal helper. | Automatic release, new inventory, or suppression of unresolved custody. |
| Inventory evidence is collected independently of fresh-demand selection. | `server/modules/inventory-planning/infrastructure/inventory-cutover-reconstruction.repository.ts:28–49`, `capture`, reads the global inventory census first, retains signed residual owner/item IDs, then reads WMS and original costs. `server/modules/inventory/infrastructure/inventory-cutover-reconstruction.reader.ts:6–49`, `readInventoryCutoverReconstruction`, retains journal uncertainty, including reserve moves at both locations. | A zero signed residual does not prove complete historical movement or cost evidence. |
| Shipment-review evidence stays independent of terminal demand. | `server/modules/wms/inventory-cutover-reconstruction.reader.ts:8–12`, `readWmsCutoverShipmentReviews`, globally reads flagged outbound shipments. `readWmsCutoverReconstruction` retains orphan/review source and physical rows. `planCutoverReconstruction` at `:114–120` and `:329–347` keeps acknowledgment, source and physical exceptions blocked. | Grouping an acknowledgment is not inventory posting or COGS proof. |
| New request journaling has now executed in production. | Read-only inventory publication journal query at approximately `13:38Z`: 26 request-start records and 26 result records; all associated owners succeeded; 21 HTTP 200 and 5 HTTP 204 results, first `13:06:56Z`, last `13:31:22Z`. `server/modules/channels/quantity-publication-request.ts:55–64`, `executeAdmittedEbayQuantityRequest`, wraps actual transport with request observation. | No rejection/cooldown result was observed in that live sample. No provider request ID was populated. This cannot prove pre-deployment requests. |

### Completed-order cohort

The 974 baseline demand-identity flags were matched to their actual item/order IDs in a read-only SQL query. All were missing warehouse identity; none was a product-hint or non-sellable mismatch. They belong to **394 completed historical orders**, not 974 new customer orders:

| Source | Orders | Created between (UTC) | With OMS fulfillment-order identity |
| --- | ---: | --- | ---: |
| `oms` | 325 | March 27 – May 22, 2026 | 325 |
| `shopify` | 69 | March 31 – April 2, 2026 | 69 |

No warehouse was assigned to those orders. Closed demand was reclassified in memory; retained custody still blocks cutover.

## Remaining closure group 1: inventory ownership and shipment evidence

The candidate snapshot contains 341 inventory levels, 2,360 lots, 27,292 grouped journal positions, 4,225 cost records, 399 accepted OMS demand rows and 5,918 shipment-review entries. No canonical resources or independent build reservations were captured. This is not a claim that all those rows are defective.

The candidate emits 39,134 overlapping flags. The largest categories are 18,862 unknown journal groups, 5,281 unresolved encumbrance-owner flags, 5,144 terminal-order residual flags, 3,331 shipment-source flags, 3,167 receipt/review flags and 2,751 grouped acknowledgments. Smaller categories include 305 picked-lot ownership flags, 157 level encumbrance flags, 69 accepted OMS-demand coverage flags, 40 physical-shipment flags and 17 invalid level balances. Full counts and subjects are retained in the local evidence artifact.

**Do not turn this into 39,134 manual fixes or suppress the categories to pass activation.** The next reconciliation batch should group evidence by exact warehouse/variant/location and owner/package lineage, with one shared disposition for all linked findings.

Confirmed boundaries:

- Of the 18,862 unknown journal groups, 15,085 have zero signed reserved/picked residual and 3,777 have a nonzero residual. The unknown test also includes incomplete state/quantity and reserve-move history. Zero residual alone is insufficient proof for dismissal (`readInventoryCutoverReconstruction:31–48`; `planCutoverReconstruction:243–251`).
- Nine positions have zero recorded on-hand with positive reserved counters. None satisfies the existing whole-position empty-bin promise handoff. Their histories contain unknown groups and mixed ownership. The PR1423 safeguard remains unchanged (`planCutoverReconstruction:179–218`; `docs/INVENTORY-CUTOVER-RECONCILIATION-HANDOFF.md`, Whole-position eligibility).
- Removing completed orders from fresh-demand planning exposes accepted OMS lines that are not covered by current WMS demand. Do not recreate, cancel or alter an order just to make coverage agree. Resolve the accepted-demand owner and current state first.

Required next checks, as one evidence batch:

1. Link current level/lot counters to exact reservation and picked owners, preserving negative and orphan groups. Compare journals to original order/lot costs, not today's FIFO or catalog cost.
2. Separate fully evidenced closed history from actual outstanding custody and from unknown history. A proposed automated exclusion must prove its full chain and must not change stock or costs; add real-database regressions before adopting it.
3. For genuinely inconsistent current balances, produce a preview of exact proposed inventory-owner actions, before/after counters and immutable evidence hashes. Obtain approval before any production reconciliation. Never replay a historic shipment to manufacture evidence: it can debit current stock.
4. Keep provider acknowledgments distinct from physical stock posting. Any absent original cost or ambiguous package/owner chain remains an explicit exception, not a guessed repair.

**HYPOTHESIS:** A substantial subset of the zero-residual historical groups may be resolvable as closed history after complete linkage. The current census does not prove which subset. No such exemption is implemented in this batch.

## Remaining closure group 2: nine old eBay publication attempts

All nine predate PR1424's request-result journal. They belong to channel connection `34`, channel `67`, eBay account scope `uvchzdfrtkc`. Their saved scope has null product and variant IDs, so an ID-only lookup is insufficient. Exact external SKU matching against current channel listings/feeds yields one current variant for each below.

| Attempt | Exact external SKU | Current variant | Retained attempt state | Correlated retained sync-log evidence |
| --- | --- | ---: | --- | --- |
| 2729 | SHLZ-MAG-35PT-SLV-C250 | 144 | uncertain | No terminal provider result in the examined three-minute window. |
| 3237 | ARM-ENV-SGL-NM-P50 | 68 | uncertain | No terminal provider result in that window. |
| 4416 | SHLZ-MAG-35PT-SLV-P1 | 142 | uncertain | Log 419319: HTTP 400 / eBay 25001, daily revision limit, offer 136411970011. |
| 4417 | SHLZ-MAG-35PT-SLV-B25 | 143 | uncertain | Log 419320: HTTP 400 / eBay 25001, daily revision limit, offer 136411975011. |
| 6523 | SHLZ-MAG-130PT-C150 | 135 | running | No terminal provider result in that window. |
| 7495 | ESS-TOP-STD-SLV-CLR-C1000 | 12 | running | Log 423379 is admission/capacity rejection, not a terminal provider response for the original request. |
| 7531 | SHLZ-TOP-8X10-C250 | 56 | uncertain | No terminal provider result in that window. |
| 7600 | QUAD-BOX-TOP-P5 | 162 | uncertain | Logs 428153/428162 are admission/capacity rejection, not original-request termination. |
| 7603 | QUAD-BOX-TOP-C25 | 163 | uncertain | Log 428163: HTTP 400 / eBay 25020, invalid/missing package weight, offer 136411530011. |

These are **three correlated rejection logs and six without terminal proof**, not nine proven recoveries. Correlation uses exact SKU/current mapping and timestamps, not a persisted request ID. A final rejection does not prove an earlier transport attempt had no side effect. The old adapter can fall back from bulk quantity update to an individual offer update (`server/modules/channels/adapters/ebay.adapter.ts:234–335`, `pushInventory`). All nine remain unresolved; no attestation was submitted.

Bounded log check: the current Heroku log window returned September 9 messages only, with no matching September 8 request records; configured log drains were empty. This establishes the limits of that check, not that historical evidence exists nowhere.

### Package-weight finding

The catalog currently has `3175.00g` for variant 162 and `13154.00g` for variant 163, with null channel overrides. Therefore **missing catalog weight is not established**. `server/modules/channels/adapters/ebay/ebay-listing-builder.ts:251,313–327`, `buildSingleInventoryItem`, includes weight when building the full listing payload. The failing quantity path does not itself repair the stored inventory-item package weight. The actual eBay inventory-item record and original rejected body were not retrieved.

Required next checks:

1. Obtain exact retained provider request termination or owner-process/request-termination evidence for the nine attempts. Current quantity readback alone cannot establish the old request's outcome.
2. Read the actual eBay inventory item/offer for C25 and compare its package weight to the catalog. Any listing repair is a separately approved provider mutation; do not invent a weight or change package contents.
3. Once evidence supports it, submit one reviewed recovery batch through the existing permission-gated service, using individual immutable attempt IDs, evidence references/hashes and idempotency keys. Then re-read pending work and current quantities.

Recovery contract: `shared/types/inventory-publication-recovery.ts:9–17`, `quantityPublicationRecoverySchema`; `server/modules/inventory-planning/application/quantity-publication-recovery.service.ts:28–35`, `attest`; `server/modules/inventory-planning/interfaces/http/quantity-publication-recovery.routes.ts:24`, route requires `inventory_planning.activate`. Operator attestation is explicitly not provider acknowledgment (`server/modules/inventory-planning/infrastructure/quantity-publication-recovery.repository.ts:14–16,42–48`). Clearing a blocking owner may allow background catch-up, so it is not a harmless read-only metadata change.

## Remaining closure group 3: canonical channel/source setup

Read-only configuration census at approximately `13:51Z`:

| Configuration | Recorded state |
| --- | --- |
| Catalog migration/review queue | 431 active products: 331 approved, 100 excluded, zero blocked/unreviewed/conflicting. |
| Canonical publication targets | 0 |
| Publication source binding heads | 0 |
| Publication variant mapping heads | 0 |
| Channel exposure policy heads | 0 |
| LEON / 20 LEONBERG fulfillment node | Draft; warehouse 1; Echelon inventory and fulfillment authority. |
| SM-CA / ShipMonk Ontario fulfillment node | Draft; warehouse 35; external-provider inventory and fulfillment authority. |

The catalog queue is the result of `InventoryAvailabilityBackfillService.getMigrationQueue` (`server/modules/inventory-planning/application/inventory-availability-backfill.service.ts:120`) using `captureBackfillCatalog` (`server/modules/inventory-planning/infrastructure/inventory-availability-backfill.repository.ts:310–312`). **Approved catalog models do not prove channel setup or runtime activation.**

Legacy routing observations:

| Channel | Connection / provider scope | Recorded warehouse assignment |
| --- | --- | --- |
| 36 Shopify | Connection 4; `card-shellz.myshopify.com`; location 67892347039 | Warehouse 1 enabled; warehouse 34 disabled. |
| 37 Shopify-Canada | Connection 5; `cardshellz-ca.myshopify.com`; location 94220746788 | Warehouse 35 enabled. |
| 67 eBay | Connection 34; account scope above | No channel warehouse assignment. |

All three channels were active with legacy sync enabled. With no warehouse assignment, the legacy allocation engine can fall back to all fulfillment warehouses (`server/modules/channels/allocation-engine.service.ts:296–316,379–382,418–420`, allocation snapshot construction). **Do not silently choose warehouse 1 for eBay or copy that fallback into canonical setup.** Canada/ShipMonk is recorded as external authority, not locally controlled inventory to publish from LEON.

Required next batch: prepare one complete reviewable configuration manifest covering exact provider connection/account/location, fulfillment-node ownership, warehouse sources, per-SKU mapping, safety selection and exposure dials. Validate all managed physical SKUs together; keep externally controlled targets observation-only unless explicitly authorized otherwise. Do not copy the old allocation formulas simply to preserve old numbers. No configuration was saved here.

The last persisted activation dry run was a blocked September 6 run. Its detailed blocker list is stale relative to the now-approved catalog; do not treat it as current readiness. No open preparation/configuration freeze exists. `captureInventoryCutoverReviewInsideTransaction` (`server/modules/inventory-planning/infrastructure/inventory-cutover-review.repository.ts:16–29`) requires an open preparation. `InventoryAvailabilityActivationDryRunService` persists its result (`server/modules/inventory-planning/application/inventory-availability-activation-dry-run.service.ts:452`), so invoking that command in production would be a write. Neither command was executed.

## Test coverage and failure modes

| Verification | Result |
| --- | --- |
| Final full `npm run test:unit -- --maxWorkers=4` | **11,538 passed, 37 skipped; 991 files passed, 1 skipped.** |
| Shared lifecycle + cutover focused unit suites | **175 passed**; included in the unit coverage above, not added again. |
| Actual PostgreSQL preflight, reconstruction and complete cutover-composition suites | **60 passed**, no skips. |
| Explicit writer-ratchet and migration-prefix guards | **4 passed**. No migration or writer-ratchet baseline change. |
| `npm run check` | Passed, including a rerun after the residual-parent query change. |
| `npm run build` | Passed. Existing large client bundle warning remains. |
| `git diff --check` | Passed. |
| Production diagnostic | Enforced read-only, same-snapshot baseline/candidate comparison; no provider calls. |

PostgreSQL tests use a new task-owned local cluster at `127.0.0.1:55439`, explicit disposable configuration, unique per-suite databases and mocked external transport. Tests cover completed historical demand with no warehouse, all three terminal states with residual custody, review-only source/physical records outside active demand, unknown/null states, retained original cost rows, missing/conflicting journal order IDs, and the existing transaction/rollback/idempotency cutover composition. The reader does not update historical orders or stock. The exact local cluster was verified, had zero other client backends, and was stopped after tests; its diagnostic data and logs remain local.

Relevant regression locations:

- `server/modules/inventory-planning/__tests__/integration/inventory-cutover-preflight.integration.test.ts:146`: completed historical demand excluded without changing fixture rows or current holds.
- `server/modules/inventory-planning/__tests__/integration/inventory-cutover-reconstruction.integration.test.ts:159,260,267,288`: review retention, terminal custody, historical/unknown demand and actual residual parents.
- `server/modules/inventory-planning/__tests__/unit/inventory-cutover-reconstruction.test.ts:56,76,80,89,100`: physical review, positive/negative terminal custody, no false historical demand and fail-closed unknown lifecycle.
- `shared/__tests__/enums-status.test.ts:27`: complete known-status classification and distinction from shipment derivation.

Assumptions: no missing warehouse, journal owner, provider result, inventory count, cost or channel assignment was inferred. `completed` is classified from the existing WMS completion/release contract. Residual custody remains separate from demand lifecycle.

Risks / failure modes: deploying this code changes cutover previews, not runtime authority. Previously reviewed evidence must be recaptured; stale review/impact hashes cannot authorize a commit. Unknown custody still blocks. More terminal-custody or OMS-coverage flags may become visible because completed orders are no longer adopted as new demand. Deleting historical flags or substituting current FIFO costs would defeat the safety boundary and is not part of this change.

Remote CI has not run for this uncommitted batch. This is local verification, not a deployed fix or a claim that every production workflow was exercised. The final full unit run and production build both passed after the residual-parent refinement; the PostgreSQL, typecheck and architectural checks also cover that final code.

One later full-suite run encountered two `fetch failed / bad port` failures in the unchanged `server/modules/warehouse/__tests__/unit/sla-cutoff.routes.test.ts`; an isolated rerun failed on a different test with the same transport error. `startServer` at `:40–45` uses OS-assigned port 0; `req` at `:49` uses fetch. A bounded standalone HTTP diagnostic reproduced successful loopback responses on ports 3649–3657 and the same `bad port` failure on port 3659. `netsh int ipv4 show dynamicport tcp` reports this machine's dynamic range starts at 1024. No networking settings or unrelated SLA tests were changed. Failed-run evidence is retained separately; the final bounded-concurrency full-suite result is recorded in `closure-unit-tests-final.log`.

## Evidence artifacts and next handoff

Local evidence, intentionally not added to the PR:

- `C:/Users/owner/Echelon/.codex-artifacts/inventory-cutover-closure-comparison-20260909.json`: same-snapshot baseline/candidate results and all remaining blocker subjects.
- `C:/Users/owner/Echelon/.codex-artifacts/inventory-cutover-closure-triage-20260909.json`: earlier deployed-baseline census and empty-bin cohort.
- `C:/Users/owner/Echelon/.codex-artifacts/inventory-publication-1424-deployment-verification-2026-09-09.md`: deployment verification record.
- This worktree's `.codex-artifacts/closure-readonly.ts` plus exact baseline reader/planner copies: local diagnostic, no application boot, read-only PostgreSQL pool, certificate validation preserved, writer access disabled.
- This worktree's `.codex-artifacts/closure-unit-tests-final.log`, `closure-postgres-tests.log`, `closure-typecheck.log`, `closure-build.log`, `closure-architecture-guards.log`: local validation output. `closure-unit-tests-port-failure.log` and `closure-sla-test-rerun.log` preserve the local port failures.

Next implementation/review handoff is this **single code batch**, followed by one consolidated reconciliation/configuration proposal covering the three closure groups above. Production changes require the corresponding evidence and approval. A new deployment alone cannot supply missing historical custody proof or choose warehouse/channel authority. No legacy values or UI are retired before a successfully verified canonical cutover.
