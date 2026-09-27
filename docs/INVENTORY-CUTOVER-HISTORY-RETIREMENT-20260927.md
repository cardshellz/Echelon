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

Validation results are recorded below after the final combined-main checks. Fixtures distinguish actual audit/admission migrations from reduced foreign-owner schemas; a reduced empty lookup table is not migration proof. Disposable local PostgreSQL tests are not production proof.

Assumptions: the previously agreed bin-on-hand baseline remains the opening policy, not a new physical count. The operator reviews a fresh exact cohort before any production apply. No assumption is made that unknown channels can be inferred or that terminal statuses prove historical delivery/accounting correctness.

Not proven here: current production readiness, carrier delivery, a fresh warehouse count, provider readbacks, or a completed authority cutover. Those are operational checks, not additional ATP implementation or a UI redesign.
