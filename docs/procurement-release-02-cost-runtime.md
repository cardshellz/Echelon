# Release 2: component costs, lineage, review and controls

PR target: `main`. Release branch: `codex/procurement-02-cost-runtime`. Foundation PR #1398 and prerequisite PR #1391 are already merged to main. This release must merge into main to enter the deployment path.

PR #1399 was merged into the foundation feature branch rather than main. Its completed runtime changes are preserved here for the replacement PR against main. Merge and verify this runtime deployment before the planning/lifecycle release in PR #1400; that PR also targets main and remains draft until this prerequisite is deployed.

## Resulting behavior

Actual receiving, transfers, builds, break/assembly transformations and picker relocation preserve the exact sources used by later cost corrections. Product, packaging and allocated freight have separate immutable source revisions and component application history. Applications update affected inventory layers and sold-order COGS through the inventory owner in the same financial transaction as audit and reporting evidence.

Purchase detail exposes source revisions, application outcomes, lot contributions, component before/after values, COGS effects, invoice evidence and durable receipt-cost recovery. Ambiguous invoice component classification can be reviewed without rewriting invoice amounts. Current supplier allocation inputs are checked before saved landed-cost allocations are reused.

Configured approval roles are checked against current active Identity records and unrestricted approval grants. The approved decision captures its role, permission, threshold and economics; changed policy or economics requires review again before send. Solo operation without required approvals keeps its existing send flow. Migration227 prevents purchase-event modification and history loss through purchase deletion; cancellation remains the history-preserving operation.

## Deployment dependencies

- Migration `222_procurement_cost_evidence.sql` is byte-for-byte unchanged from release1 and must already exist. Migration `227_purchase_order_history_retention.sql` is new in this release.
- This release intentionally contains the full physical writer, graph-lock and cost application set. Releasing only part would create missing lineage or incompatible lock ordering.
- The cost workspace and approval paths have no dependency on the later planning/RFQ/supplier-report tables in migrations223–226. RFQ origins are not exposed by this release's workspace contract or UI.
- `migrations/run-migrations.ts:runMigrations` tracks individual filenames, not a numeric high-water mark. After227 is applied, later pending223–226 files still run. Existing history is retained; no production backfill is part of deployment.

## Local verification

These are the original prepared-candidate checks. The release was refreshed onto the updated prerequisite before bulk publication, then incorporated deployed main for the replacement PR. The cost/runtime patch is unchanged; the latest upstream changes and all procurement CI entries were retained. GitHub CI must pass on the published head.

- Full release-prefix unit suite: **8,947 passed**, 37 intentionally skipped, across892 passing files and one skipped file.
- TypeScript: passed. Client and server production build: passed; existing bundle-size warnings remain.
- Eleven actual PostgreSQL owner suites: **209 tests passed**, counting the final34-test approval/retention run in place of its earlier21-test checkpoint. These include immutable foundation, receiving/cost event permutations, actual lineage owners, picker observation, invoice review, approval, workspace, shipment cost/line commands, receiving units and invoice metadata.
- Desktop/mobile cost-workspace and invoice-review browser suite: **26 passed**. Browser requests use fictional intercepted API fixtures; database tests execute the real owners on explicitly disposable local PostgreSQL.
- Writer ratchet is part of the full unit suite. No unreviewed writer ownership was added.

## Assumptions, risks and failure modes

Missing historical origins, unknown component classifications, unsupported FX/credits and nonrepresentable uniform-lot remainders stay visible for review. Manual component protections are preserved. New history does not certify or reconstruct the past. No inventory-claim authority, external Archon delivery, live setting or historical financial correction is activated by this release.

Physical receiving and its post-close cost phase have distinct commit boundaries. A cost failure preserves the recorded physical receipt and leaves a durable recovery attempt. The retry command is permission-gated and idempotent; no new unattended retry daemon is introduced. Financial writes, COGS effects, immutable applications and their audit/report event either commit together or roll back together.

**After new physical operations start, release2 is the minimum compatible inventory-writer version.** Keep these writers during recovery or pause affected physical operations while correcting forward. Keeping additive tables while reverting to older writers is insufficient because those writers do not create the contribution edges consumed by later corrections. Application rollback cannot undo already posted quantities, values or COGS. Retain migration227's history guards on rollback.

Production contention under the graph lock and history-index build duration have not been measured. Production validation must use the release manifest's representative purchase/receipt/cost checks; local synthetic test success is not a production data reconciliation.
