# Inventory Availability Phase 5H: Active Claim Replacement

## Scope

This slice adds an inactive, repository-level command that replaces one exact active
whole-order claim after accepted order demand changes. It does not construct a runtime
service, route order mutations to canonical claims, change inventory authority, or write
production data.

The command binds `orderId`, `expectedClaimId`, `idempotencyKey`, actor, and reason. The
expected predecessor prevents a stale caller from superseding a newer claim.

## Atomic replacement contract

`PostgresInventoryAvailabilityClaimRepository.replaceOrderClaim` runs under serializable
isolation and performs the following work in one transaction:

1. Replay an exact immutable `replace` receipt, or reject reuse of its idempotency key.
2. Require canonical runtime authority and load the expected active predecessor.
3. Read current order demand, reject unchanged or non-claimable demand, and lock the
   union of the predecessor and current-order transformation graphs.
4. Lock active planning-policy heads, the order and its items, the active predecessor,
   and the bounded inventory levels and FIFO lots in the established global order.
5. Cancel only unexecuted build handoffs and release only open, unconsumed, unpicked
   predecessor resources through the inventory-owned mutation port.
6. Mark the predecessor `superseded`, recapture the post-release supply state, and replan
   the complete remaining order demand once.
7. Insert the next claim revision with a same-order `supersedes_claim_id`, reserve its
   exact FIFO resources, and append the replacement command plus predecessor/successor
   events before commit.

Any validation, planning, inventory, persistence, serialization, or commit failure rolls
back both the predecessor release and successor reservation. A blocked plan therefore
cannot leave the order with no active claim.

## Remaining-demand comparison

Replacement is driven by accepted demand, not by normal fulfillment progress. Before
releasing anything, the repository validates each mutable claim-line row against the
hashed planner line and derives its remaining demand as:

```text
remaining claim demand = requested target quantity
                       - released target quantity
                       - consumed target quantity
                       - picked target quantity
```

That remaining line set is compared with the locked WMS order's remaining physical,
tracked, sellable demand. A normal pick that reduces both sides equally is therefore
`ORDER_DEMAND_UNCHANGED` and does not churn reservations. A customer/order edit that
changes the remaining quantity, SKU identity, or fulfillment warehouse requires the
replacement transaction. Missing, extra, or inconsistent claim-line evidence fails
closed as `CLAIM_DEMAND_LINEAGE_MISMATCH`.

## Lock order

The transaction acquires shared-resource locks in this order:

1. transformation-model product advisory locks, then legacy reservation product locks;
2. active location and safety-policy heads;
3. WMS order and order items;
4. active claim and claim-line demand evidence;
5. the preliminary snapshot's inventory levels, then FIFO lots, in deterministic order;
6. open claim build handoffs and operations, followed by their claim-aware build
   cancellation locks;
7. predecessor claim resources and exact lot allocations; and
8. successor claim rows and exact inventory reservation writes.

The graph and active-claim locks serialize competing commands before paths that touch
the same physical ownership can diverge. The post-release snapshot is recaptured only
after the predecessor's open reservation has been returned inside the transaction.

## Database guarantees

Migration `0649_inventory_availability_claim_replacement.sql` adds a same-order composite
foreign key for `supersedes_claim_id`, permits only one successor to reference a given
predecessor, rejects self-reference, and requires the successor to start active at the
immediately following revision after a predecessor already marked `superseded` in the
same transaction. Replacement lineage cannot be rewritten after insertion. The
migration also adds `replace` to the canonical command discriminator. Existing claims
remain valid with a null predecessor.

## Deliberate boundaries

- Terminal orders and orders with no remaining claimable demand continue to use the
  existing release/cancel command; replacement always creates one successor.
- The old claim and its consumed or picked lineage remain retained audit evidence. Only
  its still-open ownership is released before the remaining demand is replanned.
- This repository contract has no HTTP route, scheduler, order-mutation caller, or
  dependency construction. Deployment remains inert until runtime routing is reviewed.

## Remaining blockers before activation

1. Decide whether operations needs the separately authorized claim-aware reversal of an
   already-completed build; current release correctly leaves completed output in stock.
2. Construct canonical services and authority-aware runtime routing for ATP, order
   acceptance/demand changes, reservation/release, picker completion/unpick, and every
   inventory publisher.
3. Run the separately reviewed Step C activation and full publication under explicit
   production authorization.
