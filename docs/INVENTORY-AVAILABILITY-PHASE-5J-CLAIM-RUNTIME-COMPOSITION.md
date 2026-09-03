# Inventory Availability Phase 5J: Canonical Claim Runtime Composition

## Scope

This slice constructs the canonical claim application service and its complete
dependency graph in the server service container. It does not route any OMS, WMS,
picker, build, reservation, or publication caller to that service.

Deployment remains inert because there is no claim HTTP route or runtime caller and
the PostgreSQL repository independently rejects every mutation unless the separately
controlled authority row is already `canonical`.

## Dependency graph

The service container constructs:

1. one `PostgresCanonicalClaimInventoryRepository` for inventory-owned mutations;
2. one `PostgresCanonicalClaimBuildRepository` using that same inventory writer;
3. one `PostgresCanonicalClaimPickerObservationReviewRepository` for durable review
   evidence;
4. one `PostgresInventoryAvailabilityClaimRepository` with the production database
   pool, an explicitly injected system clock, and the three mutation dependencies; and
5. one `InventoryAvailabilityClaimService` exposed through the typed service registry.

Sharing the inventory writer keeps package conversion, build execution, reservation,
release, pick, and unpick mutations behind the inventory module's public port. The
claim repository continues to own serializable transaction boundaries and passes its
transaction client to every writer.

## Deliberate boundaries

- No route, scheduler, webhook, worker, or legacy order path calls the service.
- No runtime-authority row is inserted or updated.
- Existing ATP routing and legacy inventory mutation behavior are unchanged.
- The service cannot bypass the repository's canonical-authority gate.
- Production activation remains a separate, explicitly authorized operation.

## Verification

The composition contract verifies the complete dependency graph, shared inventory
writer, production pool, injected clock, service-registry exposure, absence of a route,
and absence of an authority update. Existing lifecycle unit and PostgreSQL tests cover
command validation, authority rejection, transactions, locking, idempotency, and
rollback behavior.

## Remaining blockers before activation

1. Add one authority-aware application router for accepted-order creation, demand
   replacement, cancellation, picker actions, and build actions.
2. Migrate each existing caller to that router while legacy authority remains the
   selected branch.
3. Route every inventory publisher through canonical ATP and prove concurrency and
   crash recovery across the actual caller graph.
4. Run the separately authorized Step C activation and full publication.
