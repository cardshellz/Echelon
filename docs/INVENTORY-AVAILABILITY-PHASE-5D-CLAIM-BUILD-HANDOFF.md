# Inventory Availability Phase 5D: Claim-Owned Build Handoff

## Scope

This slice adds the inactive handoff from one canonical `component_build` operation
to one inventory build order. It does not register the canonical claim repository in
runtime services, route order acceptance, change ATP authority, execute a claim-owned
build, publish inventory, or change picker behavior. Canonical commands still require
the singleton runtime authority to already be `canonical`.

## Gap closed

The existing build-order contract stores one `source_location_id` per component, but
the canonical planner can claim one component variant from several eligible locations.
The build reservation table already supports several FIFO lots per component, so the
handoff now makes those exact lot allocations the ownership boundary:

- every adopted `build_component_reservations` row has
  `reservation_owner = 'availability_claim'`;
- every adopted row references one exact `(availability_claim_lot_allocation_id,
  availability_claim_id)` pair;
- one claim lot allocation can be adopted only once;
- a multi-location component keeps `build_order_components.source_location_id` null
  instead of recording a false single source;
- a single-location component retains that location as a compatibility/read-model
  value, while the exact reservation rows remain authoritative.

The handoff inserts no inventory-level update, inventory-lot update, or inventory
transaction. Physical reservation counters were already incremented by the canonical
claim and are not incremented again.

## Handoff transaction

`PostgresInventoryAvailabilityClaimRepository.handoffBuildOperation`:

1. starts a serializable transaction and checks the exact idempotency receipt;
2. requires canonical runtime authority;
3. locks the claim transformation graph using transformation locks before legacy
   reservation locks, then locks the order, active claim, operation, resources, and
   claim lot allocations;
4. verifies the relational operation, inputs, and resources against the hashed planner
   payload and requires all child operations to be complete;
5. invokes `CanonicalClaimBuildMutationPort` in the same transaction;
6. records the one-to-one claim-operation/build-order handoff, advances the operation
   from `pending` or `ready` to `executing`, and writes an idempotent command receipt
   plus append-only event before commit.

`PostgresCanonicalClaimBuildRepository.handoffOperation`:

1. locks and validates the exact transformation recipe binding, live immutable recipe
   version, component snapshots, warehouse scope, and output location;
2. requires claimed input quantities to equal recipe component quantities multiplied
   by planned builds and requires the claimed output to reconcile to the recipe output;
3. locks every participating inventory level and FIFO lot in ascending ID order;
4. verifies level/lot identity, warehouse, active status, reserved balances, and exact
   PO/packaging/landed mill-cost snapshots;
5. creates one released build order and its immutable component snapshots;
6. adopts each claim lot allocation as one build component reservation without any
   physical reservation write.

## Database invariants

Migration 0644 adds:

- `availability_claim_build_handoffs`, with one handoff per claim operation and one
  claim handoff per build order;
- composite claim ownership on adopted build reservations;
- a unique index preventing one claim lot allocation from being adopted twice;
- an explicit reservation-owner check that makes legacy build-owned and canonical
  claim-owned rows mutually exclusive;
- the `handoff_build` canonical command type.

## Deliberate blockers still in place

- No runtime service constructs or calls the canonical claim or build-handoff
  repositories.
- Claim-owned builds cannot execute through the generic build endpoint yet. Execution
  fails with `CLAIM_BUILD_EXECUTION_NOT_AVAILABLE` until the build transaction can
  consume multi-location reservations and atomically return exact committed output
  ownership to the claim.
- Claim-owned builds cannot use generic cancellation. Cancellation fails with
  `CLAIM_BUILD_CANCEL_REQUIRES_CLAIM_COMMAND` so the build cannot independently
  unreserve inventory that remains owned by the claim.
- A whole-claim release with an active handoff fails with
  `CLAIM_BUILD_HANDOFF_RELEASE_REQUIRED` until claim-aware cancellation is installed.
- Picker consumption, partial claim replacement, ATP/reservation authority routing,
  Step C activation, and publication remain blocked.

## Required next slices

1. Execute claim-owned builds using the exact adopted lots across all source locations,
   then reserve only committed output for the claim and leave batch surplus unreserved.
2. Add claim-aware build cancellation and reversal that transfer ownership exactly once.
3. Add claim-aware pick, unpick, discrepancy, and reconciliation commands.
4. Implement atomic claim replacement for changed or partially released order demand.
5. Route ATP readers and reservation callers through the authority switch only after all
   execution consumers are ready.
6. Review and run the separately authorized Step C activation and full publication.
