# Inventory cutover: audited retirement of obsolete processing

## Delivery and production boundary

This completes the **code** for one bulk historical-work retirement, alongside the saved demand-policy correction and current-order rehearsal on `codex/cutover-demand-policy`. It does not create another ATP engine, redesign the UI, or switch production inventory authority.

The retirement command writes only two new audit tables. It does **not** edit historical order, receipt, shipment, package, label, bin, lot, cost or reservation records. It performs no provider call. Applying the migration creates empty storage; it retires nothing automatically.

No production connection, retirement, quantity opening, channel update or activation was performed during this implementation. The production numbers in the [earlier rehearsal report](INVENTORY-CUTOVER-BULK-REHEARSAL-20260927.md) remain a dated snapshot, not today's apply authority.

## Why this small boundary exists

The missing operation was not another inventory safety formula. The existing cutover census still treats old receipt-review flags and unposted shipment intentions as outstanding processing. The owner wants that obsolete work reviewed together, preserved as history, and excluded from opening work without losing current customer demand.

The new operation records **"stop processing these exact old IDs"**, not **"these goods were physically delivered"** or **"post their inventory again."** Existing workers then recognize those retired IDs. This is narrower than putting permanent replay-blocking triggers on all order/shipment/inventory tables; those broad triggers were not implemented.

Existing protection remains unchanged:

- `requireLegacyShipmentAuthority`, `server/modules/inventory/application/inventory.use-cases.ts:231`, rejects legacy shipment writes under canonical authority.
- `PostgresCanonicalClaimDispatchSourceCommandResolver.resolve`, `server/modules/inventory-planning/infrastructure/inventory-availability-dispatch-source-command.repository.ts:46`, resolves the exact canonical source and picked owner.
- `selectCanonicalClaimDispatchPickedOwner`, `server/modules/inventory-planning/domain/inventory-availability-dispatch-source-command.ts:68`, reconciles remaining pick movements to claim, resource and lot custody. Lines 129-135 reject missing, ambiguous or insufficient picked ownership. A historical `shipped` status alone is not dispatch authority.

## End-to-end contract

| Stage | Behavior and evidence |
| --- | --- |
| Review | `PostgresInventoryCutoverHistoryRepository.review` (`server/modules/inventory-planning/infrastructure/inventory-cutover-history.repository.ts:22`) reads the full current census and owner facts in the existing read-only repeatable-read transaction. No partial ID filters are accepted. |
| Classify | `reviewHistoricalWork` (`domain/inventory-cutover-history-retirement.ts:16`, under the same module) reuses `proposeHistoricalWork`. Current demand, live leases, active corrections and ambiguous evidence remain blockers. Unknown origins remain explicitly unknown. A saved opening must not already exist. |
| Approve | `assertHistoryRetirementApproved` (same file, line 32) requires the exact review hash, authority revision and configuration run. Unknown-origin quarantine requires an explicit boolean acceptance. The caller cannot waive other blockers. |
| Execute | `PostgresInventoryCutoverHistoryRepository.retire` (repository above, line 29) locks the command key, acquires the existing admission fence, locks owner evidence, recaptures and revalidates the full review, then inserts the entire audit batch in one transaction. |
| Replay | The same method returns the original validated result for the same key, actor and semantic request. Changed intent conflicts. Replaying an already committed result cannot retire more work. |
| Audit | `validateHistoryAudit` (`infrastructure/inventory-cutover-history-audit.reader.ts:35`) rebuilds the original decision and validates request/result hashes, actor, time, counts and complete membership. Incomplete or changed audit evidence fails closed. |
| Opening | `activeCutoverHistory` (`domain/inventory-cutover-history-retirement.ts:45`) removes only retired processing from the active opening projection. The original complete census, historical findings, current orders, stock, costs and physical packages remain. The existing opening and claim planners are reused. |

The relative module paths in this table are within `server/modules/inventory-planning/`.

### Operator API

`registerInventoryCutoverHistoryRoutes`, `server/modules/inventory-planning/interfaces/http/inventory-cutover-history.routes.ts:12`:

- `GET /api/inventory-planning/admin/cutover-history/review` — complete read-only review.
- `POST /api/inventory-planning/admin/cutover-history/retire` — exact reviewed command. Required fields: `expectedReviewHash`, `expectedAuthorityRevision`, nullable `expectedConfigurationRunId`, `acceptUnresolvedOrigin`, `reason`, `idempotencyKey`.
- Both use the existing `inventory_planning.activate` permission and authenticated session actor. Actor overrides and unknown body fields are rejected. Responses are validated and `Cache-Control: no-store` applies, including denied requests.
- New retirement returns 201; exact replay returns 200 with `alreadyApplied: true`. Both report `inventoryChanged: false` and `authorityChanged: false`.
- This is an audited **apply** operation, not a draft editor. It has no new operator UI or routine draft-reason requirement.

### Audit storage and locking

`migrations/253_inventory_cutover_history_retirement.sql` creates `inventory.cutover_history_batches` and `inventory.cutover_history_retirements`. Unique receipt/header IDs prevent duplicate retirement. A GIN index supports lookup of immutable source-item membership even if someone later changes its header link.

Only these **new audit tables** receive immutable/update/delete/truncate protection. Their insert checks require the existing admission owner, same-transaction membership and a complete nonempty batch at commit. Original business tables receive no new triggers.

Install the migration before starting the new processing workers: normal receipt/shipment paths query this registry even while it is empty. A missing table is a database failure, not permission to bypass the lookup.

Lock order in `retire` and `lockHistoryFacts` (`infrastructure/inventory-cutover-history-locks.ts:11`):

1. Existing command-key advisory lock; validated replay may return here.
2. Existing global cutover admission fence and runtime/configuration checks.
3. Exact receipt parents and items; exact shipment headers; owning order items and corrections; requests; label links and labels, each ordered by ID.
4. Fresh owner facts, exact approval check, audit insertion/completeness/readback, commit.

Parent locks also protect child insertion through the existing foreign keys. Existing admission controls continue to cover stock/order/source writers; this change does not install another global fence. The existing transaction wrapper (`infrastructure/inventory-cutover-commit.repository.ts:167`) bounds lock waits and statements. Timeout, deadlock, changed evidence or any partial failure rolls back the command; the operator must review the failure instead of accepting partial success.

## Existing processing owners

| Owner | New behavior for retired IDs |
| --- | --- |
| OMS inbound receipt claim | `claimReceipt`, `server/modules/oms/channel-fulfillment-ingress.repository.ts:1228`: after locking the receipt, returns a terminal replay with reason `cutover_history_retired`; does not reclaim a lease or falsify its original status. |
| Explicit receipt retry | `preview` and `requeue`, `server/modules/oms/channel-fulfillment-receipt-retry.repository.ts:213`: preview rejects retired work; the write transaction independently rechecks before auditing/requeueing. Existing completed retry replay remains a no-op. |
| Receipt sweeper | `recoverStaleChannelFulfillmentReceipts`, `server/modules/oms/fulfillment-sweeper.scheduler.ts:129`: excludes exact retired receipt IDs from pending/expired recovery candidates. |
| Legacy stock posting | `recordShipmentInsideTransaction` and `recordReplacementShipmentFromAvailableInventory`, `server/modules/inventory/application/inventory.use-cases.ts:870` and `:1008`: reject retired header/source identities before new stock posting. Already-recorded shipment replay remains idempotent. |
| Canonical ordinary dispatch | `WmsCanonicalClaimDispatchSourceOwner.lockSourceForPreparation`, `server/modules/wms/canonical-claim-dispatch-source.ts:67`: exact retirement lookup after source locking; existing picked-custody validation remains. |
| Operational dispatch | `WmsOperationalShipmentSourceOwner.lockSource`, `server/modules/wms/operational-shipment-source.ts:17`: exact retirement lookup before returning an executable source. |

The common lookup is `infrastructure/inventory-cutover-retired-work.ts`. It fails on malformed database responses rather than treating them as “not retired.” This is scoped application-owner enforcement, not a claim to prevent arbitrary privileged SQL or to cancel remote provider work.

## Deployment and remaining cutover work

1. Review, merge and deploy this one combined PR, including its empty audit migration. Confirm the deployed commit and migration before using the command.
2. Obtain a fresh bulk review. Present the exact counts/IDs and unchanged-record boundary, including explicit unresolved-origin quarantine. The earlier snapshot is not reusable approval for changed membership.
3. After explicit production approval, retire that exact cohort once and independently read back the audit and unchanged protected records.
4. Rebuild the complete opening/current-order proposal from fresh evidence using the accepted bin baseline. Do not restart one-order-at-a-time historical reconciliation or invent inventory to hide shortages.
5. Complete the existing definition/publication/provider/3PL checks and separately approve the existing atomic quantity/claim/ATP authority cutover. Retirement alone does not save an opening, enable publishing or activate authority.

**Rollback:** before any retirement, the additive empty migration has no retired IDs to enforce. After retirement, keep marker-aware processing owners deployed, or pause affected processing before rolling back to an older binary. Older code does not know these records were retired. Do not delete audit history to make a rollback appear safe.

**Changed historical records:** original records remain writable by their existing owners. If retired review evidence or source membership changes before opening, opening fails closed. This implementation does not provide automatic unretirement or audit supersession; investigate the correction rather than deleting the marker or pretending an ordinary refresh renews the original approval. Truly new work requires a new source identity.

## Validation, assumptions and unknowns

Final validation uses the committed lockfile and the merged `origin/main` base `172e68dc8`:

- Full default suite: **18,635 passed, zero failed, 1,857 skipped**. Opt-in database suites are not silently counted as executed; their separate local coverage is below.
- Connected run: **525 passed, zero failed or skipped, 28 files**, including **406 real PostgreSQL tests in 21 suites**. This covers the new command and audit migration, read-only reader, opening/reconstruction, legacy and canonical posting, publication, HTTP permissions, migration numbering, writer ownership and CI-suite preservation.
- Application TypeScript and server/client test TypeScript checks passed. Client, server and opening-capture production bundles built successfully; the client build retains its large-bundle warning.
- The new HTTP harness closes its test-owned connections instead of retaining sockets across ephemeral servers. All 11 route cases also passed in five consecutive fresh runs; no assertion or authorization check was relaxed.
- Audit/transaction cases include exact simultaneous replay, changed actor/intent, five stale-evidence cases, live lease/current-correction rejection, explicit unknown-origin acceptance, injected partial failure, incomplete membership, tampered audit validation, real ingress replay, unchanged original records and retained current-order planning.
- Fixtures distinguish actual audit/admission migrations from reduced foreign-owner schemas; the reduced empty lookup table used by other owner tests is not migration proof. Disposable local PostgreSQL tests are not production proof. All 104 PostgreSQL CI files remain registered; only the 21 listed database suites were run locally in this final connected command.

The private connected report is `artifacts/history-pinned-connected-20260927.json` under the local final-cutover evidence directory. SHA-256: `d671599407a79c0d0c89343463472e1fb304119cc62406fec7c3ea5d4321df09`. Raw production captures and local test artifacts are not included in this PR.

The full default report is `artifacts/history-pinned-full-final-20260927.json`, SHA-256 `4aeb04a80b0024bec2b39dc8a5b9da419ce7f41bd0a7e250dddf770eb8ec53dd`. These results supersede intermediate failures while updating test doubles, fixture columns, Windows line endings and the local dependency installation. The owned disposable PostgreSQL cluster was stopped after validation.

Assumptions: the previously agreed bin-on-hand baseline remains the opening policy, not a new physical count. The operator reviews a fresh exact cohort before any production apply. No assumption is made that unknown channels can be inferred or that terminal statuses prove historical delivery/accounting correctness.

Not proven here: current production readiness, carrier delivery, a fresh warehouse count, provider readbacks, or a completed authority cutover. Those are operational checks, not additional ATP implementation or a UI redesign.

### September 27 CI fixture correction and complete PostgreSQL validation

PR #1569's first CI run exposed two failures in `oms-disposition-cutover-replay.integration.test.ts`. They were reproduced locally before editing: its reduced `fixtureSql` omitted `catalog_product_id` and `inventory_tracking`, which `readOmsCutoverReconstruction` selects at `server/modules/oms/inventory-cutover-reconstruction.reader.ts:48`. Both nullable columns already belong to the application schema and migration `migrations/0694_product_inventory_tracking_policy.sql:25`; the correction does not change the production reader or add a migration.

The fixture now includes both columns, and `withOrders` names its insert columns explicitly. Three additional database cases prove that tracked, non-stock physical and unresolved legacy policy values survive the real reader without dropping accepted demand or modifying either synthetic order line. The original refund/replay assertions remain intact.

After this correction, all eight existing `scripts/ci/postgres-tests.ts` shards ran locally, using their separate disposable databases and the committed lockfile. **All 104 registered suites passed: 1,748 tests, zero failures, errors or skips.** Report names were checked against the complete CI manifest; each shard contains 13 suites. Reports are in the isolated worktree's ignored `test-results/postgres-hardening-{1..8}` directories, timestamped `2026-09-27T19:45:18.533Z` through `2026-09-27T19:52:39.859Z`. This supersedes the earlier 21-suite local PostgreSQL coverage limitation, not the production-proof boundary.

The five repaired/regression database cases and five reader unit cases also passed in a focused run, and the server test TypeScript check passed. The earlier full default suite/build results above were not rerun for this test-only correction. The disposable PostgreSQL cluster was stopped after validation. Production was not connected to or changed; GitHub CI for the follow-up commit remains a separate verification.

### September 27 browser CI locator correction

The PR's newer main merge (`751eeea74`) was preserved before this test-only follow-up. `WalmartChannelWorkspace` always renders a Channel Inventory link in Store Setup (`client/src/pages/WalmartChannelPage.tsx:65`), while `ListingActivity` also renders that link when an item is verified (`client/src/features/channel-listing-publication/ListingActivity.tsx:152`). The publication-retry browser test searched the entire page: it could pass early on Store Setup, or fail with two matches after the reconcile/refetch finished. Waiting explicitly for the verified item while retaining the old locator reproduced CI's exact two-element error locally.

The test now asserts the Activity link is absent before checking status, waits for `Item verified`, and verifies the Activity-scoped link and its `/channels/inventory` destination. Existing retry-identity and submitted-price checks are unchanged; no UI, API, inventory, migration or provider behavior changed.

Validation on that base: the repaired journey passed **20 consecutive runs (10 desktop, 10 mobile)**, then the complete `playwright.inventory.config.ts` suite passed **158 tests**. Both commands disabled retries and used the local frontend-only harness with mocked APIs. GitHub CI for the new commit remains separate from these local results; production was not changed.

### September 27 follow-up: share the opening's historical-work scope

The deployed review and opening did not select the same outstanding work. `PostgresInventoryCutoverHistoryRepository.capture` sent the unfiltered lifecycle census to `planCutoverReconstruction`, while `evaluateCutoverOpening` already excluded explicitly shipped source/package records, ignored channel acknowledgments/receipts, and shipped outbound-review headers from its active projection. This caused the review to demand retirement of records the opening already treated as closed history.

`selectActiveCutoverWork` in `server/modules/inventory-planning/domain/inventory-cutover-active-work.ts` now owns those existing rules. Both `evaluateCutoverOpening` and the repository's `capture` call it. The same repository capture serves the read-only review and the admitted retirement recheck; there is no relaxed apply-only path. Pending, review, failed, unknown and other non-excluded statuses remain in scope. Previously retired records still require exact validated audit evidence.

The complete original census remains the source of the evidence hash, current-order checks, immutable retirement audit and opening's historical findings. Exclusion from outstanding processing is **not** evidence of delivery or a stock movement. Changed closed history invalidates a previously reviewed command; reopened work must be reviewed again. The change adds no migration, production data repair, new ATP formula, channel setting or automatic retirement/activation.

#### Evidence and validation on base `f8698204394424bcb7f978e53a0fd4a98fab8c47`

- A PostgreSQL regression test reproduced the defect before the change: one ignored receipt and one shipped header incorrectly blocked review. With the shared selector, review and concurrent identical retirement calls select only the two pending historical records; exactly one apply commits, the replay is idempotent, original business records remain unchanged, and current demand remains in the opening.
- Three PostgreSQL cases reject stale approval after an excluded receipt reopens, an excluded shipment reopens, or its retained source quantity changes. Two unit cases cover exact lifecycle selection, unknown-state retention, unchanged input and tampered retirement evidence.
- Full default suite: **18,720 passed, zero failed, 1,877 skipped** across 1,580 files. The first run had one `fetch failed` in the untouched picking-history HTTP test; its 17 cases passed immediately in isolation, then the complete suite passed without code changes or retries. That observation does not establish a root cause for the transient transport failure.
- Connected cutover run: **1,496 passed, zero failed or skipped**, 60 files, including **226 real PostgreSQL tests in ten integration suites**. This run covers history review/apply, admission, opening, reconstruction, receipt evidence and reservation/capture contracts; it is not a claim to have rerun every repository PostgreSQL suite.
- `npm run check`, `npm run check:tests`, and the client/server/opening-capture production build passed. The client retains its large-bundle warning. No UI code changed; the browser suite was not rerun for this follow-up.
- Offline replay of the read-only production capture from **2026-09-27T21:03:36.881Z** through the actual shared selector removed **1,727 extraneous history-review blockers**, while preserving the identical **1,887 retirement decisions** (1,770 receipts, 117 shipment headers, 229 source items) and **261 current order items across 114 orders**. The original capture hash was checked before and after replay. Four current-demand identity findings for two blaster lines remain visible; the fix does not suppress them.

The raw capture and reports remain private local evidence, not PR attachments. Capture SHA-256: `6ab0f6d175944ad67524adfa46f93c37114b0bb51daf71814e3ddd368e90838b`. Offline proof SHA-256: `0be5f139eb68d8e8a375e4fa67deb8378afcfab71daa72988ba83a03239b6b76`. Test reports are the isolated worktree's ignored `test-results/cutover-history-scope-full-final.json` and `test-results/cutover-history-scope-connected.json`.

**Remaining boundary:** these are code and dated-snapshot results, not a deployed correction or approval to retire history, change quantities, link catalog records, publish channels or activate canonical authority. Obtain a fresh review after deployment and retain the separate production approval steps above. Optional blaster catalog remediation is not a dependency of this code release.
