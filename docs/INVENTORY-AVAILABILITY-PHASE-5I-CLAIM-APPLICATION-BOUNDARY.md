# Inventory Availability Phase 5I: Canonical Claim Application Boundary

## Scope

This slice introduces one application-owned service and persistence port for the
complete canonical claim lifecycle. Future OMS, WMS, picker, and build callers can
depend on this boundary instead of importing the PostgreSQL repository directly.

Deployment remains inert. This slice does not construct the service in the runtime
container, register an HTTP route, switch inventory authority, modify an order flow,
or write production data.

## Contract

`InventoryAvailabilityClaimService` exposes the existing audited commands for:

- whole-order claim, active-claim replacement, release, and cancellation;
- package and build execution plus build handoff; and
- claim-aware pick and unpick, including validated picker-observation commands.

Every method accepts unknown boundary input, validates the strict shared command
schema before invoking persistence, and validates the returned result schema before
returning it. Invalid input never reaches the store. An invalid store result fails
closed with the exact operation and schema issues. Classified repository failures are
preserved so a later interface can map authority, concurrency, and business failures
without losing their context.

The application-owned `InventoryAvailabilityClaimStore` port contains the complete
lifecycle contract. `PostgresInventoryAvailabilityClaimRepository` implements that
port but remains an infrastructure detail.

## Deliberate boundaries

- The PostgreSQL repository continues to own serializable transactions, exact
  idempotency receipts, lock ordering, and the canonical-authority gate.
- No automatic claim-versus-replace decision is inferred outside the transaction.
  Order-demand routing must carry an exact predecessor when replacement is required.
- No legacy/canonical runtime branch is installed by this slice. Existing production
  behavior remains unchanged until the separately reviewed routing and activation work.
- No new database object or migration is required.

## Verification

Unit coverage proves command validation, result validation, exact delegation for all
eight lifecycle operations, no store call after invalid input, and preservation of a
classified store failure. Existing repository and PostgreSQL suites continue to prove
the transactional behavior behind the port.

## Remaining blockers before activation

1. Construct this service with the inventory-owned mutation repository and build and
   picker-review ports.
2. Route every accepted-order demand mutation, cancellation, picker action, build
   action, ATP reader, reservation/release caller, and inventory publisher through one
   authority-aware composition boundary.
3. Prove concurrency and crash recovery across those actual callers.
4. Run the separately authorized Step C activation and full publication.
