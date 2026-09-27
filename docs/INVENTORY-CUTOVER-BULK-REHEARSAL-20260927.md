# Inventory cutover: one bulk history review and current-order rehearsal

## Bottom line

**Production has not been switched.** This batch completes the grouped historical-work review and a conditional rehearsal of every current stock order. It does not implement or execute the historical-work retirement command. It does not introduce another ATP engine, change the UI, or change production inventory/configuration.

The final capture is **September 27, 2026, 13:27:57 UTC (09:27:57 Eastern)**. Runtime authority was **legacy, revision 1**, with no saved opening or configuration freeze. The latest release independently checked was **v3033 / `12a11c4d`**, the returns-label release. This local branch is not that deployment.

Using the accepted recorded-bin baseline and the explicitly hypothetical retirement of the listed old work, the existing planner handles **98 current stock orders / 233 stock lines** together. **84 orders are fully covered; 14 have shortages across 15 lines.** No current customer obligation is dropped. These are simulation results, not active claims or proof that cutover is ready.

## What the code definitely does

| Work | Exact source and reasoning |
| --- | --- |
| Captures complete candidate membership in one enforced read-only snapshot. | `readCutoverHistoryFacts`, `server/modules/inventory-planning/infrastructure/inventory-cutover-history.reader.ts:8`. Requires repeatable-read/serializable, read-only mode and the same transaction timestamp as the opening census. Reads exact receipt IDs and complete shipment contents. Hashes full receipts, attempts, items, linked orders, lines, packages, package items/adjustments and labels. Missing members fail, rather than yielding a partial census. |
| Separates recorded terminal/digital history from current work and unknown identity. | `proposeHistoricalWork`, `server/modules/inventory-planning/domain/inventory-cutover-history-proposal.ts:82`. Validates contracts, fingerprints and duplicate identities; checks lease state, exact channel/order identity, remaining authorized shipping demand, current stock owners, correction work and package lifecycle. Unknown channel IDs are never matched across channels. Every result remains `executable:false` and `productionReady:false`. |
| Tests the exceptional correction against the actual original package identity. | `isDuplicateCorrectionIntention`, the same domain file at line 221. Requires the exact ShipStation physical-shipment ID, original source-item linkage, order item, variant, quantity, no quantity adjustment, and a recorded shipped original package. This identifies a duplicate intention; it does not attest to delivery of an additional box. |
| Keeps actual readiness separate from a hypothetical scenario. | `rehearseCutoverBatch`, `scripts/rehearse-inventory-cutover-batch.ts:26`. The actual blocked opening remains in the output. Only the explicitly labelled scenario removes the proposed old work from its active census; displaced source/review evidence is retained verbatim and hashed. Original captures, physical packages, costs and current demand are unchanged. |
| Reuses the existing whole-basket planner, including competition for stock. | `planFreshCutoverClaims`, `server/modules/inventory-planning/domain/inventory-cutover-reconstruction-planning.ts:46`. Each subsequent order sees stock already claimed by earlier orders. The rehearsal does not implement an alternative ATP formula. Shortfalls remain explicit at line 94 rather than being converted to inventory or erased. |

The saved-policy/non-stock identity correction from the preceding batch remains on this same branch. See `INVENTORY-CUTOVER-SAVED-POLICY-AND-BIN-OPENING-20260926.md`; its September 26 counts are historical, not this capture's counts.

## Historical work: one proposed batch

| Proposed treatment | Count | What is and is not established |
| --- | ---: | --- |
| Recorded-settled order notifications | 1,750 receipts | Exact channel/order match, locally shipped header, no remaining authorized shipping lines. Not independent delivery or original inventory-posting proof. |
| Fulfilled digital notifications | 11 receipts | Exact digital lines are already fulfilled. No warehouse demand or new stock postings should be created. |
| Unresolved-origin quarantine | 9 receipts | Original channel remains unknown. Neither direct inbox IDs nor a matching original webhook record was found. Preserve the uncertainty; do not assign channel 36 from an unscoped order-ID match. |
| Closed shipment intentions | 97 headers | Already cancelled/voided; owners terminal. Includes empty abandoned headers, a cancelled replacement, and five links to already-voided physical packages. Preserve all original records and labels; do not replay inventory. |
| Terminal-order posting debt | 19 headers | Still queued locally, but exact source-line owners record complete fulfillment. Propose stopping old processing, not changing the recorded shipment to “shipped” or claiming missing custody evidence. |
| Duplicate correction intention | 1 header | Header 15070 / source 17871 refers to ShipStation shipment 446993073, already represented by physical package 1680 / item 3710 / original source 14181. No separate correction package was found. |

There are **117 distinct source headers**, of which **116** occur as review flags. They contain **229 source rows**. The actual opening has **1,886 receipt/header findings plus 229 source findings**; these overlap and must not be added as distinct shipments. The final proposal classifies all captured candidates without classification blockers. That does **not** waive production lifecycle checks or authorize a write.

The nine unknown receipt IDs are 33, 34, 378, 7573, 24616, 26727, 33997, 60656 and 61100. They remain unknown, not repaired. The independent origin/package investigation is retained in the private lineage artifact listed below.

## Proposed opening quantities: unchanged decision, refreshed effects

- Preserve all **348 recorded bin on-hand positions**. Do not add historical picked counters back onto shelves.
- Preserve all **233 current stock lines**, then allocate them together through the existing canonical planner. The prior capture's 186 lines are not a reusable current-order list.
- Proposed differences: **139 bin-counter rows / 316 lot rows**. These are counter retirements plus the one existing bin/lot on-hand disagreement, not an applied adjustment.
- Sole on-hand correction remains **lot 3966, C-15, variant 265: 14 → 13**. Its original unit cost remains 28,000 mills. The proposed **on-hand-only** valuation difference is −28,000 mills ($28); this is not a statement that all legacy picked-custody retirement has only a $28 accounting effect.
- Original journals, costs, package contents, labels and customer fulfillment remain untouched. The actual opening assessment retains **38,708 historical findings** as unresolved evidence.

## Current-order shortages, not invented stock

All 15 short lines belong to LEON-scoped orders in this capture.

| SKU | Short lines | Uncovered SKU units |
| --- | ---: | ---: |
| ESS-TOP-STD-SLV-CLR-C1000 | 9 | 13 cases |
| ESS-TOP-STD-SLV-CLR-P100 | 1 | 1 pack |
| SHLZ-SEMI-OVR-B200 | 4 | 4 boxes |
| SHLZ-SEMI-OVR-C2000 | 1 | 1 case |

For the semi-rigid holders, the same snapshot contains **200 C2000 cases at RTE-19 / FLOOR-01**, not LEON. The product's proposed package paths are valid and allowed. `warehouseIds` in `inventory-availability-planner.ts:1031` confines a warehouse-scoped canonical plan to that warehouse; `planFreshCutoverClaims:69` requests the order's warehouse. The simulation does not silently transfer stock or treat the RTE-19 balance as already at LEON. The actual physical transfer/replenishment situation is unverified.

For the clear sleeves, the captured LEON positions contain two C1000 cases and zero P100 packs. The sequential planner consumes available supply for earlier orders and reports the remaining shortfall. Safety stock is fixed at zero in this captured draft, so it is not the reason for these shortfalls.

Shortage is represented by the existing `partial` plan and explicit `shortfallQty`; it is not permission to cancel a customer line or require perfect historical inventory. Physical discrepancies remain resolvable through the existing audited warehouse flows. No stock transfer, count, ATP or channel quantity was changed here.

## What is likely happening

**HYPOTHESIS:** the bulk of these held records is obsolete notification/posting work left behind by earlier shipment paths. Exact local identities, terminal states and the duplicate package trace support that operational grouping. They do not prove all historical physical/financial events were correct.

## What is not proven / next delivery boundary

1. **The durable retirement executor and replay protection are not implemented by this batch.** The rehearsal deliberately refuses to advertise a ready production result. Before applying the proposed treatment, an admitted owner operation must recheck the exact cohort, prevent further processing of retired work, persist immutable before/after evidence, and return an idempotent receipt. A blanket reader filter or merely clearing review flags is not sufficient.
2. The nine unknown-origin records need explicit acceptance as unresolved quarantined history, not an invented identity. The bin-on-hand decision is already settled and is not being reopened.
3. Final opening/counter retirement, full-catalog definition coverage, channel publication drain/readbacks, external/3PL boundaries, and the final admission-time recapture remain separate cutover requirements. The current-order rehearsal is not proof of full-catalog/channel readiness.
4. The entire branch remains local, unpushed and undeployed. No PR is claimed or linked. Current `origin/main` was merged into the isolated branch without modifying the original checkout.

**Next coherent implementation:** the single audited historical-work retirement/replay boundary, followed by one consolidated apply review containing this cohort, refreshed opening effects, current claims and publication proof. Do not resume one-order-at-a-time historical reconstruction or redesign ATP.

## Tests, assumptions, risks and failure modes

- **1,137 tests passed, zero failed or skipped**, across the final 37-file cutover-focused and CI-manifest run. This includes **172 tests in six real PostgreSQL suites**. The final output is fingerprinted below.
- Application TypeScript and server/client test TypeScript checks passed. The repository-wide/default suite and GitHub CI were not rerun in this turn; the preceding batch's full-suite result is documented separately.
- New coverage: 41 classification cases, seven whole-basket rehearsal cases, and eight PostgreSQL reader cases. Tests cover exact/null/conflicting identities, live/expired leases, duplicate/missing membership, current owners, corrections, voided versus open packages, unknown future columns, quantity adjustments, concurrent snapshot stability, no-write enforcement, stock competition and preserved real blockers.
- PostgreSQL tests use unique disposable databases on the owned loopback cluster. The new fixture is a SELECT-query contract test, not a claim of production lifecycle-migration proof. No migration is added. The suite is registered in the existing eight-shard CI manifest, preserving all prior suites.
- **Assumptions:** the conditional scenario assumes explicit approval and a future durable retirement operation. It assumes only the already-accepted recorded-bin baseline, not a fresh count or physical delivery.
- **Risks/failure modes:** current stock, orders or metadata can drift after capture; unknown origin remains unknown; a live lease/current customer or correction blocks grouping; invalid or unmatched evidence fails closed; the conditional result cannot authorize runtime activation; a future retirement operation must not create a second stock/COGS posting.
- No browser/UI behavior, carrier/provider execution, production mutation, channel publication or authority activation was performed.

## Private evidence and reproduction

Raw production captures remain outside the PR under:
`C:/Users/owner/Echelon/.codex-worktrees/inventory-cutover-final-20260924/artifacts/inventory-cutover-20260924/`.

| Artifact | SHA-256 |
| --- | --- |
| `batch-capture-2026-09-27T13-28-29-266Z.json` | `5879f1c6e805baf1cd4e5c7cc42a737dee3c4d3e7ea6b1f53863bfcb7bce2560` |
| `batch-rehearsal-20260927-final.json` | `6b07c9818f3f0fa93cc81c45e6de0982bcc2b7d046aed772906be70f414b1a7d` |
| `work-lineage-2026-09-27T13-03-25-277Z.json` | `a1d96dc91dfe2544bc2ac311ddf3e862e5895a89532e50b44b3cdaf3a0f54ca1` |
| `batch-final-tests-20260927.json` | `759698a6a712a593700f91566c42f62fd2ee0c620dc395b5e399f9647e69c8e4` |

Source evidence hash: `1a11240081411759657f6feabc957a8683c0d436d639b86991bfca5187829d08`.
History proposal hash: `12d740720e81a43fed1c1f1bb2b806107d9ef01f66caacd0621623fd84520a40`.
Conditional claim impact hash: `9f7794a7627f2429b6035ea2afb6fe590fa6f5227b6786b5f80fb4801aec3e56`.
Final focused test output: `batch-final-tests-20260927.json`. Repeating the rehearsal against the same capture produced the identical output SHA-256 shown above.

Offline reproduction uses `node --import tsx scripts/rehearse-inventory-cutover-batch.ts <capture-file> <sha256> <new-output-file>`. It verifies the immutable input hash, validates all contracts and writes exclusively to a new local file. It has no database/provider/apply option. The separate private capture harness enforces read-only PostgreSQL and prohibits ambient application-pool use.
