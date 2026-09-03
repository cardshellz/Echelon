# Inventory Availability Phase 5J — Runtime Claim Routing

> Phase 5K subsequently closes the atomic accepted-order demand-reconciliation
> blocker described below. Phase 5L closes the Shopify refund-grouping blocker.
> Phase 5M closes the cycle-count claim-repair blocker. Phase 5N closes the
> canonical reservation-status blocker. The other activation blockers remain in
> force.

## Scope

This slice routes the deployed reservation service container through the same
persisted runtime-authority row used by operational ATP reads. It does not
activate canonical authority, change the authority row, mutate configuration,
publish channel quantities, or backfill production data.

## Runtime contract

`AuthorityAwareReservationService` is the only reservation object constructed
by the composition root. `PostgresInventoryAvailabilityRuntimeClaimExecutor`
starts a repeatable-read transaction and reads
`inventory.availability_runtime_authority` `FOR SHARE`.

The composition root injects its single `InventoryAvailabilityClaimService`
instance into that executor. The router does not construct a second canonical
repository or writer graph.

Under legacy authority, the executor holds that shared lock through commit and
binds reservation queries, ATP reads, inventory writes, recipe-demand changes,
and build cancellations to the same Drizzle transaction. Caller-owned
transactions fail closed at this boundary because they cannot also own the
authority lock. The executor limits in-flight routing transactions to half of
the configured pool, leaving capacity for existing channel-sync and inventory
change notifications; a production pool configured with only one connection
fails at composition instead of deadlocking.

Legacy services preserve their existing business-level partial-reservation and
missing-mapping results. A caught database or inventory mutation exception is
re-thrown when running under the authority transaction so PostgreSQL rolls the
complete operation back; it is never converted into a successful outer commit.

Under canonical authority, the executor commits and releases the routing
connection before invoking the canonical service's serializable transaction.
This is safe only because migration 0638 rejects every `canonical -> legacy`
authority transition. Canonical evidence projections borrow and release their
own short-lived clients rather than retaining an outer connection.

The legacy reservation instance receives a legacy ATP calculator created only
inside this runtime factory. External ATP composition remains exclusively
authority-aware.

- `legacy`: delegate to the deployed `ReservationService` without changing its
  inventory formulas, while propagating one authority transaction through the
  complete database mutation.
- `canonical`: whole-order reserve calls use the validated
  `InventoryAvailabilityClaimService.claimOrder` command; release/cancellation
  calls use `releaseOrderClaim` with an explicit lifecycle disposition.
- Canonical claim writes retain their own serializable transaction and do not
  hold the routing connection while that transaction runs.

Canonical command keys are deterministic SHA-256 identities built from the
order, claim lifecycle cursor, actor, reason, and disposition. Claim results
are projected into the legacy response DTO only for existing callers; the
canonical claim plan remains the source of truth.

## Demand-change retry boundary

`WMS Sync.propagateOmsEditsToWms` no longer owns a naked
release-then-reserve sequence. It submits the WMS order, durable Shopify inbox
event identity, and whether this attempt changed WMS demand to
`reconcileOrderDemand`.

The event is submitted even when a retry observes no new WMS row changes. This
matters because an earlier attempt can persist WMS demand and then fail before
claim reconciliation. Legacy authority performs the same deployed idempotent
release-then-reserve sequence only when demand changed. Phase 5J initially
failed canonical reconciliation closed; Phase 5K replaces that temporary block
with exact-predecessor replacement and guarded zero-demand release.

## Explicit canonical blockers

The following operations fail closed under canonical authority instead of
falling back to legacy inventory state:

1. Item-level reserve (`reserveForOrder`).
2. Item-level refund release remains unsupported; Phase 5L routes the production
   refund cascade through one grouped whole-order demand reconciliation instead.
3. Cycle-count orphan trimming/reallocation until it updates exact claim
   ownership (closed by Phase 5M).
4. Legacy reservation-status projection until a canonical claim/resource DTO
   replaces it (closed by Phase 5N).
5. Any caller-owned Drizzle transaction passed across the reservation boundary.

Picker pick/unpick remains a separate activation blocker: the deployed picker
updates WMS state and inventory inside one caller-owned transaction, while the
canonical claim repository currently owns a separate serializable transaction.
It must be refactored as one transaction-aware orchestration before activation.

## Activation status

Canonical authority remains inactive. Phases 5M and 5N subsequently close
cycle-count claim repair and canonical reservation status. Activation is still
prohibited until transaction-aware picker routing is built and verified together
with ATP, publishers, reservation callers, and provider readback.
