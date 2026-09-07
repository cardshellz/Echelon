# Inventory cutover completion batch — 2026-09-07

## Status in plain language

The next inventory batch is implemented in the isolated `codex/inventory-cutover-completion-20260907` branch, based on refreshed `origin/main` at `dc5a84ddb49b80ea08660b1b5a7e2b58a3bc725e`. This is **not a claim that the new ATP system is fully activated**. No production inventory, reservations, recipes, settings, provider quantities, or authority switches were performed. No deployment or PR is represented by this document.

This batch adds the open-order/stock-hold evidence screen, corrects externally managed publication prerequisites, and implements a transactional canonical picked-stock dispatch component. It does not edit order contents or package contents.

The original checkout's unrelated catalog/UOM changes and the separate package-close worktree remain untouched. Migration `0662` is additive. At publication, refreshed main uses `0659` for dropship pricing; the separate package branch must recheck its own migration prefix. `0660`/`0661` were reserved by the fulfillment workstream. `0662` was verified unused on refreshed main and in open PR migration files. Recheck again before merge.

### Publication split

The preserved source batch is commit `591731a7c`. Two clean publishing branches were based on main `bbb052ea3`: `codex/inventory-01-cutover-preflight` first, followed by the stacked `codex/inventory-02-claim-dispatch`. The second PR contains the dispatch/migration/demand changes only; the first supplies the evidence screen and shared disposable-test helper. Publication does not activate the new runtime. Validation below describes the original batch; each PR body records checks rerun on the refreshed split.

### Main-target release correction

PR #1402 merged into main at `d34825c99`. PR #1403 instead merged into `codex/inventory-01-cutover-preflight` at `17d338a45`; it did not deliver the dispatch changes to main. Refreshed main `a532aa90a` lacks migration `0662` and the dispatch repository. The corrective branch `codex/inventory-claim-dispatch-main-release` applies the existing #1403 commit `bccadd9ff` directly onto that main baseline, with no new runtime behavior. Its PR must target `main`, not another feature branch. Git merge evidence does not independently establish the production deployment SHA or applied migrations.

## What the code definitely does

| Result | Concrete implementation evidence |
| --- | --- |
| Manually capture one consistent, read-only snapshot of nonterminal WMS demand and inventory encumbrances. | `PostgresInventoryCutoverPreflightRepository.capture`, `server/modules/inventory-planning/infrastructure/inventory-cutover-preflight.repository.ts:20`; both owners share its repeatable-read READ ONLY client. |
| Keep physical on-hand, picked custody, canonical holds, independent build holds, and unexplained reserved balances separate. Picker progress is not silently subtracted from demand. | `buildInventoryCutoverPreflight`, `server/modules/inventory-planning/domain/inventory-cutover-preflight.ts:42`; raw owners `readWmsCutoverDemand` and `captureInventoryCutoverEncumbranceInsideTransaction`. |
| Expose findings without offering repair or activation actions. Responses are strict, permission-gated, no-store; browser cache is scoped to the signed-in actor. | `registerInventoryCutoverPreflightRoutes`, `server/modules/inventory-planning/interfaces/http/inventory-cutover-preflight.routes.ts:9`; `InventoryCutoverPreflightPanel`, `client/src/pages/inventory-cutover-preflight-panel.tsx:120`. |
| Keep externally managed targets observe-only without demanding Echelon-only acknowledgement/readback proof. Mapping, destination, revision, and authority checks still apply. | `legacyPublicationCoverageBlockers` and `targetPublicationBlockers`, `inventory-availability-activation-dry-run.service.ts`; detailed evidence in `INVENTORY-EXTERNAL-PUBLICATION-READINESS-CORRECTION-20260907.md`. |
| Consume exact already-picked claim/lot lineage when a complete, authorized shipment source dispatches. No on-hand fallback or second cost posting. | `planCanonicalClaimDispatch`, `domain/inventory-availability-dispatch.ts`; `PostgresCanonicalClaimDispatchRepository.dispatch`, `infrastructure/inventory-availability-dispatch.repository.ts`; `dispatchCanonicalPickedResources`, `inventory/infrastructure/canonical-claim-dispatch-inventory.ts`. |
| Record immutable source-to-pick dispatch lineage; exclude dispatched quantities from later unpick selection. | `0662_inventory_availability_claim_dispatch.sql`; `PostgresInventoryAvailabilityClaimRepository.unpickClaimLine`, specifically the dispatched-quantity aggregate and remaining-movement calculation. |

## Concrete shipment example

Test fixtures—not live inventory—model one claim owning three picked units. Picking has already removed those units from on-hand and posted their original COGS.

On a valid three-unit shipment source, the new component:

1. Checks committed command replay before re-reading mutable source state.
2. Requires canonical authority, then asks WMS to lock and authorize the exact order, item, shipped source, persisted source bin, and any existing physical-shipment link.
3. Locks the claim, target line, complete final resources, lot allocations and immutable original picks. Checks all ownership balances and original cost identities.
4. Decrements only the exact physical picked buckets by three. On-hand and reserved quantity do not change. The existing `ship` ledger row therefore has an on-hand delta of zero.
5. Moves three claim units from picked to consumed; appends the command, receipt, original-pick allocations and event. The journal enforces exact receipt totals and append-only evidence.
6. Awaits the supplied transactional owner callback before commit. A callback failure rolls back stock, claims and journals together.

The same request replays without another stock or cost effect. A different command cannot reuse the same shipment source. Partial **order/claim** fulfillment is supported through separate explicit shipment records; repeatedly consuming part of the same source would violate the existing shipment-ledger unique keys.

The WMS `order_items.product_id` field is a historical product-or-variant hint, not this component's variant authority. Exact source variant and locked canonical claim-line target variant establish that identity. Missing persisted source bins are rejected, not replaced with a guessed historical or primary bin.

## What is not proven or not yet connected

- This branch does not construct the dispatch component in existing ShipStation/channel runtime callers. Its required before-commit callback is an explicit integration boundary, not a claim that production publication/outbox wiring is finished.
- The preflight is an evidence capture, **not** a complete activation-readiness certificate. It does not reconstruct all legacy open demand, identify every historical picked/packed lot and cost, or import canonical claims. Unknown holds are never freed.
- The full atomic authority commit, shared writer/configuration exclusion, live destination coverage, and post-cutover publication/readback completion still require connected implementation and proof. The prior authority audit lists the exact remaining contracts.
- A null physical-shipment pair can be valid before the existing shipping flow materializes that record. Runtime replay must preserve the original request instead of rebuilding a different request from later physical IDs.
- Arbitrary physical-correction inserts under mixed transaction isolation are not proven excluded by the source locks alone. The real correction writers and final admission fence require a separate concurrency proof before enabling this path.
- Days-of-cover readers must use exact canonical dispatch quantities, not infer shipment quantity from a zero on-hand delta. The accompanying demand-reader correction must be included with this component. Unquantifiable or conflicting canonical evidence must fail refresh rather than create trusted zero demand.
- Two existing repair readers still interpret a shipment's on-hand delta as shipped quantity: `prepareLines` in `server/modules/oms/shipstation-unmapped-remediation.service.ts:1447` (guard at1529), and `PgHistoricalShipStationContentsCorrectionRepository.loadFacts` in `server/modules/shipping/historical-shipstation-contents-correction.repository.ts:317`. They would falsely reject canonical zero-delta shipments. Update their read-side quantity contracts before runtime activation; this batch does not execute or alter remediation actions. Activity/history also needs a separately labeled shipped quantity instead of displaying only `ship 0`.

## Next implementation work

Keep developing in the isolated branch; another production deployment is not required just to continue. The next connected work is the remaining shipment-quantity readers and source-bin persistence/runtime shipment composition with the real transactional publication owner, then legacy demand/custody reconstruction and final atomic activation/recovery. Activation remains a separately reviewed production action.

## Verification record

Focused tests cover the strict DTOs, deterministic planner, permission/cache boundaries, owner reads, transaction rollback/discard paths, exact shipment replay, source authorization, physical lot/cost ownership, dispatch-aware unpick, and actual migration constraints. PostgreSQL tests run on uniquely created disposable local databases and explicitly distinguish reduced fixtures from full production-migration replay.

- `npm run test:unit`: **901 files passed, 1 skipped; 9,249 tests passed, 37 skipped**. This includes the writer-ratchet and migration-prefix collision guard.
- The eight PostgreSQL suites listed in the CI inventory-foundation step, run sequentially with the explicit disposable database gate: **189 tests passed**. This includes the actual0662 migration, actual dispatch repository and both owners, concurrent dispatch, deferred-COMMIT rollback, and failed-demand-refresh snapshot preservation.
- The two preflight UI/cache suites: **18 tests passed**, including actor-switch cache isolation.
- `npm run check`: passed.
- `npm run build`: passed; existing large-client-chunk warning remains.
- `git diff --check`: passed. Parsed CI YAML contains one folded test command, no embedded newline, and all eight paths exist.

No remote GitHub CI run or production deployment was performed. Successful local tests do not certify live inventory data, complete historical migration replay, provider publication integration, or full claim-unpick PostgreSQL concurrency; these are explicitly separate from the proven component behavior.
