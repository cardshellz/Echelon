# Inventory Availability Phase 5L - Refund Demand Reconciliation

## Scope

This slice closes the Shopify refund grouping blocker left by Phase 5J. A
refund cascade now submits its complete event-attributed WMS demand reduction
through one `reconcileRefundOrderDemand` command after the durable OMS/WMS
refund state transaction commits.

This deployment does not change the authority row or activate canonical claims.
Under `legacy` authority, future refund events retain their existing
event-attributed reservation releases but execute a multi-line refund as one
grouped transaction. The slice does not perform a production backfill, edit
configuration, publish quantities on deployment, or call an external provider.

## Refund command contract

The command contains one WMS order ID, the durable Shopify refund ID, a
nonempty and duplicate-free set of `{ orderItemId, quantity }` release targets,
an audit reason, and an optional actor. IDs and quantities are positive
PostgreSQL integers. Targets are normalized into ascending order-item order at
the reservation boundary.

The refund cascade invokes this command once per event, including an
idempotent webhook replay whose earlier attempt may have committed OMS/WMS
demand before reservation reconciliation completed. For a return, fulfilled or
picked units remain excluded while the unconsumed part of a partially fulfilled
line is released. Already-cancelled demand, non-shippable lines, and lines
without a persisted catalog variant remain excluded by the refund
release-target derivation.

## Legacy authority

Legacy behavior retains the event-keyed line-ledger release calculation. The
grouped command first locks all target WMS rows, resolves their persisted
catalog identities, and acquires every product advisory lock in ascending
product-ID order. It then performs all line releases in ascending order-item
order within the same database transaction. Missing or malformed identity,
partial target resolution, or any line-release failure rejects the complete
group instead of committing a partial multi-line refund.

Channel synchronization is registered as a post-commit effect. It cannot run
for a transaction that rolls back, and an effect failure keeps the durable
refund inbox event retryable. Replays register the affected variants again so
a transient post-commit failure cannot permanently suppress the quantity push.

The result reports the target-variant units actually released during this
attempt. Existing `shopify_refund` ledger references make a replay return zero
for quantities already released by the same event.

## Canonical authority

Canonical routing never performs an item-level release. It invokes the Phase
5K whole-order reconciliation once, using the exact active claim predecessor
and the locked remaining WMS order demand. The result compares each targeted
`order-item:<id>` line's prior and replacement `plannedQty`, caps that decrease
by the refund target quantity, and reports the summed target-variant units.

An unchanged-plan replay therefore reports zero. If the refund removes the
last claimable demand, the guarded whole-claim release is used and only the
event's targeted line quantities are included in the compatibility result.
Any claim, replacement, projection, or guarded-release failure remains
`CANONICAL_DEMAND_RECONCILIATION_FAILED`; canonical routing never falls back to
legacy reservations.

## Verification

Unit and source-contract coverage proves:

- a two-line refund reaches the cascade helper in one call with both targets;
- a partially fulfilled return releases only its unconsumed demand;
- legacy targets and product locks are deterministic and share one transaction;
- duplicate targets fail before a transaction begins;
- canonical multi-line refunds perform exactly one claim replacement;
- canonical release reporting uses planned target-line deltas and event caps;
- unchanged refund retries report zero;
- zero-demand refunds use guarded whole-claim release;
- canonical failures remain retryable without legacy fallback;
- caller-owned transactions remain prohibited under canonical authority; and
- production refund composition no longer calls item-level release.

## Remaining activation blockers

Phase 5M subsequently closes cycle-count claim repair. Canonical authority remains
prohibited until canonical reservation-status projection, transaction-aware picker
routing, complete canonical publisher coverage, concurrency and crash-recovery
verification, and provider readback are closed. Production activation remains a
separately reviewed and explicitly authorized operation.
