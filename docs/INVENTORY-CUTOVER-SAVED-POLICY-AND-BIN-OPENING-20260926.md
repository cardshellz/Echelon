# Inventory cutover: saved policy and recorded-bin opening — September 26, 2026

## Bottom line

The false cutover rejection of a correctly linked non-stock bag is fixed locally. The correction was tested against both the earlier immutable production capture and a fresh read-only capture. It does not change ATP formulas, shipping contents, inventory, reservations, order authorization, configuration, or publication.

The recorded-bin opening is now a **single explicit proposal**, not a request to reconstruct thousands of historical transactions. Production remains on legacy authority. No opening was saved, counters retired, receipt replayed, channel quantity published, or cutover activated.

Base and deployed release checked this turn: `bc40185f504608f77b82119aa5c4dce903503679`, Heroku v3032. This branch is not deployed. Fresh inventory evidence: **19:11 UTC**. Shipment-group follow-up: **19:19 and 19:22 UTC**. These are separate read-only snapshots, not an activation-time freeze.

## What the code definitely does

| Implementation | Exact source / reasoning |
| --- | --- |
| Carries saved catalog product and tracking policy into cutover evidence. | `readOmsCutoverReconstruction`, `server/modules/oms/inventory-cutover-reconstruction.reader.ts:44`; `readWmsCutoverDemand`, `server/modules/wms/inventory-cutover-demand-reader.ts:53`; `readWmsCutoverReconstruction`, `server/modules/wms/inventory-cutover-reconstruction.reader.ts:16`. These are SELECT-only reader changes. Optional DTO fields preserve old captures without adding defaults to their immutable hashes. |
| Accepts a blank provider SKU only with matching exact OMS/WMS/catalog variant identity. | `acceptedDemandIdentityMatches`, `server/modules/inventory-planning/domain/inventory-cutover-accepted-demand.ts:12`. Conflicting explicit product IDs, nonblank SKUs and tracking policies remain failures. Quantity/materialization and unfinished terminal-owner checks remain in `planCutoverReconstruction`, `server/modules/inventory-planning/domain/inventory-cutover-reconstruction.ts:132`. |
| Uses saved order policy rather than silently adopting today's catalog default. | `cutoverLineTracksInventory`, `shared/inventory/cutover-line-policy.ts:10`. Absent/null legacy policy retains the prior explicit catalog fallback; missing policy and catalog evidence are unknown, not false. `cutoverLineIdentityConflicts` at line 21 retains exact identity validation before physical non-stock exclusion. |
| Applies that decision consistently to all three cutover views. | Reconstruction at `inventory-cutover-reconstruction.ts:185`, `classifyDemandLines` at `inventory-cutover-preflight.ts:262`, and `requiredOpeningItems` at `shared/types/inventory-cutover-opening.ts:83`. `isExactNonInventoryFulfillmentEvidence` at `inventory-cutover-preflight.ts:158` also honors the saved policy for already-completed digital lines. A non-stock shipping line remains a fulfillment obligation, but receives no stock claim. Existing stock/canonical ownership evidence is not cleared by the policy. |
| Replays old evidence without editing it. | `includeCapturedOrderPolicies`, `scripts/replay-inventory-cutover-evidence.ts:24`. SHA-pinned inputs, exact identity/quantity comparisons, complete accepted-demand policy coverage, duplicate/foreign-owner rejection, source-hash verification and exclusive output creation. It imports no database or provider client. |
| Produces a non-executable recorded-bin opening proposal. | `proposeRecordedBinOpening`, `scripts/propose-inventory-cutover-bin-opening.ts:33`. It stops for current picked/fulfilled demand, builds, canonical ownership, packed custody, missing bins or ambiguous cost-layer choices. It preserves all current demand and explicitly lists counter retirements; it never adds historical picked counters to bin on-hand. |

The existing opening evaluator is unchanged. `evaluateCutoverOpening`, `server/modules/inventory-planning/domain/inventory-cutover-opening.ts:29`, retains displaced historical findings and continues blocking unfinished receipt/package work. `PostgresInventoryCutoverOpeningRepository.save`, `server/modules/inventory-planning/infrastructure/inventory-cutover-opening.repository.ts:49`, still requires the admission fence, matching evidence and a ready assessment. Neither save nor commit was called.

## Confirmed production evidence

- Earlier pinned replay: the sole removed blocker was `OMS_ACCEPTED_DEMAND_NOT_COVERED` for bag line 119866. **No added blockers; planned inventory orders unchanged; all 181 stock owners retained.** Supplemental policy fields came from the same captured database snapshot, not guessed values.
- Fresh patched-reader capture: **81 nonterminal warehouse orders, 190 lines: 186 unstarted stock lines, 4 non-stock lines, zero line-level reviews.** Five additional stock lines arrived between captures. All 9,487 WMS census items now carry the saved-policy fields. Accepted OMS coverage has **zero blockers**.
- Authority remains **legacy / revision 1**. No canonical claims, quantity entries/opening, saved cutover openings, cutover commits, or new publication outbox rows. No configuration freeze.
- The four new publication targets remain disabled with no active mappings/readbacks. This does **not** establish that legacy publishing is stopped, nor that publication readiness is complete.

Private artifacts below contain the exact evidence and hashes; these counts are observations, not inferred physical counts.

## Consolidated proposed opening effects — not applied

The proposal uses the owner's accepted **recorded bin on-hand** baseline. That decision is not reopened. The proposed retirement of legacy reserved/picked counters is a separate, explicit approval item.

| Proposed effect | Exact scope |
| --- | --- |
| Preserve shelf/bin quantities | All 348 recorded bin on-hand values remain unchanged. |
| Preserve customer obligations | All 186 current stock lines remain at their recorded quantities, then require collective canonical planning. Four non-stock lines remain non-stock. No customer line is cancelled or marked fulfilled. |
| Replace legacy counters with the new opening basis | 139 bin rows and 324 lot rows have proposed counter/quantity differences. These are listed before/after in the private proposal. Current customer owners are all recorded unstarted; old picked counters are **not** asserted to be physically at the warehouse or put back into on-hand. |
| Apply the accepted bin quantity to the only on-hand disagreement | Lot 3966 at C-15 / level 1949: on-hand 14 → 13 to match the bin's 13. It is the sole positive on-hand cost layer at that position, so no arbitrary FIFO assignment is needed. Original unit cost remains 28,000 mills; proposed on-hand value delta is −28,000 mills ($28). Other lot on-hand values/cost components remain unchanged. |
| Preserve history | Existing journals, original costs, receipt evidence and package contents are not edited. The candidate opening preserves **38,787 historical findings** as unresolved history, not manufactured repairs. |
| Do not bypass remaining gates | The existing evaluator still reports 1,882 receipt/header findings and 229 source-item findings. Candidate claim orders remain empty while blocked. `executable` is always false. |

The candidate's reference explicitly says **PROPOSAL ONLY / not a physical count / counter retirement requires approval**. It is not a saved attestation. A current count or fresh owner activity can change the eventual effect set.

## Remaining shipment work, grouped rather than reviewed one by one

The 1,882 receipt/header findings comprise **1,766 OMS notifications plus 116 outbound shipment headers**. They overlap the 229 source-item findings; these numbers must not be added as distinct shipments.

### OMS notification groups

- **1,746** notifications map by exact channel/order identity to orders marked shipped, with no unfulfilled authorized shipping lines in the local records. Of these, **30** have expired processing leases from July 23; the rest are held in review. This is not independent proof of delivery or historical inventory posting.
- **11** notifications refer to fulfilled, non-shipping `CLUB-ANNUAL-US` lines. Their order headers are still confirmed, but the exact lines are digital and fulfilled. They must not create warehouse demand or stock postings.
- **9** notifications lack a channel ID. Each has a single local external-order-ID candidate marked shipped in channel 36. **The unscoped match is not sufficient proof of channel identity.** Preserve them separately until original ingestion scope is verified or an explicitly approved quarantine retains the uncertainty.

### WMS source groups

- **165** source rows belong to cancelled/voided shipments. Five cancelled rows retain links to physical shipment items; those links must remain historical evidence, not be deleted.
- **63** queued ordinary source rows belong to terminal orders/items. Whether they are obsolete intentions must be established in the disposition, not by marking them shipped merely to clear a check.
- **1** queued omission-correction source (17871) points through corrected source 14181 to item 314376 on order 205784. The local order is shipped and the corrected item records quantity/picked/fulfilled = 1/1/1. **This does not prove the corrective box itself was sent.** Preserve this distinction in the disposition.

The currently held notifications are not all continuously replaying: `claimReceipt` in `server/modules/oms/channel-fulfillment-ingress.repository.ts:1268` treats review/processed/ignored as terminal replay states. Expired processing leases have separate retry behavior at line 1355. `completeReceipt` at line 1716 requires an active lease and changes retry/reconciliation state. A blanket direct status update or bulk retry would therefore bypass important lifecycle behavior and is not proposed.

## What is likely happening

**HYPOTHESIS:** most remaining shipment findings are historical ingestion debt, duplicate notifications and obsolete shipment intentions rather than current warehouse work. The exact local terminal/digital classifications support grouping them; they do not prove delivery, stock consumption, or permission to replay a posting.

## What is not proven

- No production activation or completed verified opening; the branch is local and unmerged.
- The proposed legacy-custody retirement is not yet approved/applied. Accepted bin quantities are not a fresh physical count.
- No receipt/source quarantine or closure was performed. The nine missing-channel notifications and one corrective source retain the uncertainties above.
- Collective canonical planning of the proposed opening, final definitions, external/3PL boundaries, publication drain/readback, and the final admission-time recapture have not been proven by this batch.
- Production can continue changing. Saved hashes are evidence of specific snapshots, not reusable activation authority.

## Next checks and delivery

1. Deliver this tested validator/readiness batch on one branch. No schema migration or UI deployment is required for this fix.
2. Prepare **one audited historical-work disposition** for the groups above, with exact membership, unchanged inventory/cost/package evidence, retry protection, original-channel evidence for the nine ambiguous receipts, and an explicit outcome for the corrective source. Do not blindly replay historical shipments or infer missing deliveries.
3. Present the complete before/after package together: historical-work disposition, explicit legacy-counter retirement, one bin-to-lot quantity correction, all current customer claims, and the final planner outcome. No further old bin-versus-lot quantity debate is required.
4. After that package is approved, execute through admitted owner services and perform a fresh cutover verification. Authority activation and channel publishing are not implied by this report.

## Tests, assumptions, risks and failure modes

- **17,880 tests passed, zero failed** in the full suite with four workers; 1,750 skipped (including environment-gated integrations). The final shipping-obligation guard was also verified in a **231-test focused run**. This is not a claim that all database/browser suites ran.
- **164 real PostgreSQL tests passed** across cutover reconstruction, preflight, opening, composition, and OMS receipt evidence. Tests used unique disposable databases on the owned loopback PostgreSQL cluster, not production.
- Application TypeScript and both server/client test TypeScript checks passed.
- New tests cover blank/mismatched identities, saved-policy disagreement, changed defaults, legacy captures, non-stock shipping, signed stock evidence, terminal demand, actual SQL projections, replay evidence corruption, bin proposal cost-layer ambiguity, exact large integer costs, current custody and blocked historical work.
- Final review reproduced two failures for fulfilled digital lines after the catalog default changed; the saved-policy correction passes both regressions. The 13-case PostgreSQL preflight suite was rerun successfully after that correction.
- Full-suite attempts exposed Windows CRLF-sensitive source-text tests and transient local HTTP failures outside this change. The final unconstrained run passed 17,879 tests with one `fetch failed` in an untouched picking-history HTTP test; that complete file passed on isolated rerun. The subsequent full four-worker run passed all 17,880 tests. Successful full runs used the exact committed LF bytes for the untouched source-text fixtures. No unrelated source/test behavior fix is included.
- **Assumptions:** no physical custody or delivery is assumed. The only quantity basis is the existing owner-approved bin-record decision. Legacy null snapshots intentionally retain catalog fallback; unknown identity remains reviewable.
- **Failure modes retained:** stale hashes, conflicting identities/policies, incomplete current ownership, actual picked/build/packed custody, ambiguous lot cost layers, incomplete receipt/source lifecycle, and missing publication proof prevent a ready cutover. No failure is converted into a production correction.

## Private evidence index

Artifacts remain local under `C:/Users/owner/Echelon/.codex-worktrees/inventory-cutover-final-20260924/artifacts/inventory-cutover-20260924/`; no raw production capture is included in this branch.

| File | SHA-256 |
| --- | --- |
| `cutover-policy-replay-20260926.json` | `f63fab6ae84e504ce18cae33ef220ef9653d7d153f2428650152f01c15ec4f3a` |
| `patched-readiness-opening-source-2026-09-26T19-11-57-311Z.json` | `dfe8d5c8f9ae2a42d4ba2d37f07311b8f24397e2be09a9f0a00ae217308ff0f7` |
| `patched-readiness-strict-history-plan-2026-09-26T19-11-57-523Z.json` | `4e6c34e50e396f8c3b0be5e4d8cb5fb1c703834186be750bac16bea6e9b9135e` |
| `patched-readiness-preflight-2026-09-26T19-11-57-889Z.json` | `aabc7ac21754cee361ac4f235262d526462fb1c544e30ac5f613c66100afb802` |
| `recorded-bin-opening-proposal-20260926.json` | `916973faa04c64b0be8ded9313a5b7cce3a53545d9a38ce80218c9d6d69e7019` |
| `cutover-pending-work-readonly-20260926.json` | `7412a6331081148041f688520ed4287c3465f89a2034e5621d2dc94a5c6a0031` |
| `cutover-pending-work-exceptions-20260926.json` | `7c0e2696358d97cbd0547979e1bacb20fbdad21e206c84a97597e9ed0042ddc7` |

Full-suite result: `cutover-policy-full-tests-bounded-20260926.json`. The final offline replay reproduced the identical `f63fab6...` result hash. The production diagnostics enforced `default_transaction_read_only=on` and repeatable-read/read-only transactions, prohibited ambient application-pool use in the runtime capture, and invoked no provider API. Scripts used for the production captures are retained beside those private artifacts.
