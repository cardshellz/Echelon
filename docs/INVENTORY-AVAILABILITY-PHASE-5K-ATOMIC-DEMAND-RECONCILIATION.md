# Inventory Availability Phase 5K - Atomic Demand Reconciliation

## Scope

This slice closes the accepted-order demand-change blocker left by Phase 5J. The
deployed `reconcileOrderDemand` boundary now reconciles canonical claims instead
of rejecting canonical authority. Legacy authority retains its existing
transaction-bound release-then-reserve behavior.

Phase 5L subsequently applies this whole-order lifecycle to grouped Shopify
refund demand reductions.

This deployment remains inert while runtime authority is `legacy`. It does not
change the authority row, activate canonical claims, publish channel quantities,
backfill data, or call an external provider.

## Canonical decision path

The durable upstream `sourceEventId` is included in deterministic command keys.
The current claim cursor selects one of these guarded paths:

1. No active claim: invoke the existing serializable whole-order claim command.
2. Active claim with changed demand: invoke the existing serializable replacement
   command with the exact expected predecessor claim ID.
3. Active claim with unchanged demand: record the existing claim through the
   validated claim command without releasing or reserving inventory.
4. Active claim with no remaining claimable demand: after the replacement
   transaction rejects the empty order without mutation, invoke the serializable
   release command with both the exact expected claim ID and
   `requireNoClaimableDemand: true`. The WMS status observed by the rejected
   replacement is also an exact precondition for the release transaction.

The guarded release locks the WMS order and active claim, then rechecks all three
conditions before releasing any resource. If demand reappears, the order status
changes, or another claim becomes active, the transaction rolls back. A cancelled
order cancels the claim; other zero-demand or terminal states release it. The
router never falls back to legacy after canonical authority has been selected.

## Retry and failure contract

The `demandChanged` flag remains advisory under canonical authority. A retry must
still reconcile even when the earlier attempt already persisted the WMS line
change. Exact claim IDs and locked WMS demand, rather than that flag, authorize a
canonical mutation.

Any canonical replacement, claim, projection, or guarded-release failure is
classified as `CANONICAL_DEMAND_RECONCILIATION_FAILED`. WMS sync and the Shopify
webhook boundary rethrow that code so the durable inbox event remains retryable.
Legacy reservation failures retain their deployed warning behavior.

## Verification

Unit coverage proves:

- changed demand replaces the exact active claim;
- zero demand releases only the exact active claim;
- nonempty locked demand rejects release before inventory writes;
- changed locked order status rejects release before inventory writes;
- stale claim identity rejects release before inventory writes;
- unchanged demand records a no-mutation claim receipt;
- retries reconcile canonical state even when `demandChanged` is false;
- canonical failures remain retryable and never fall back to legacy; and
- caller-owned transactions remain prohibited after canonical cutover.

## Remaining activation blockers

Canonical authority remains prohibited until the remaining Phase 5J blockers are
closed: cycle-count claim repair, canonical reservation-status projection,
transaction-aware picker routing, complete canonical publisher coverage,
concurrency/crash-recovery verification, and provider readback.
