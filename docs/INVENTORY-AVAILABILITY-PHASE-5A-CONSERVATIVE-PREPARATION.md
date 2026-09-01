# Inventory Availability Phase 5A: Conservative Publication Preparation

## Status and safety boundary

This slice implements Phase 5 Step B and the operator controls needed to enter
and leave that step. Deployment alone is inactive:

- runtime authority is initialized and remains `legacy`;
- there is no HTTP contract, application method, repository method, or command
  type that can commit canonical ATP authority;
- no migration changes physical inventory, reservations, recipes, channel
  configuration, or provider quantity;
- publication occurs only after an operator with
  `inventory_planning:activate` captures provider evidence, completes a fresh
  ready dry run, and explicitly prepares conservative publication.

The missing live canonical claim/execution path is a hard cutover blocker. It
must exist before Phase 5 Step C can be designed or exposed. A database row that
said `canonical` while reservations still executed legacy
`inventory_strategy` behavior would be split-brain authority.

## Operator sequence

1. `POST /api/inventory-planning/admin/publication-readbacks/capture` reads each
   preview/live Echelon-owned publication target by its exact connection, scope,
   target revision, inventory item, and external SKU.
2. `POST /api/inventory-planning/admin/activation-runs/dry-run` recomputes the
   full catalog and rejects missing, stale, future-dated, or identity-mismatched
   provider evidence. Readback evidence is valid for at most 15 minutes.
3. `POST /api/inventory-planning/admin/activation-runs/prepare` revalidates the
   selected immutable definitions, obtains the single global configuration
   freeze, and enqueues one absolute quantity per exact publication identity:

   ```text
   conservative quantity = min(latest exact provider observation, proposed quantity)
   ```

4. The durable worker leases only activation rows, writes the absolute value,
   reads the same provider identity back, and marks the row verified only when
   the observed value equals the desired value.
5. `GET /api/inventory-planning/admin/activation-runs/open` restores the open
   preparation and progress after page reload. The exact-run status endpoint is
   `GET /api/inventory-planning/admin/activation-runs/:activationRunId/status`.
6. `POST /api/inventory-planning/admin/activation-runs/abort` cancels mutable
   queued work, records the failure transition, and releases the freeze. Abort
   is rejected while a provider write is leased so an old write cannot overlap
   a later preparation and every in-flight outcome remains auditable. It does
   not attempt to increase quantities that were already conservatively published.

## Provider routing contract

Every canonical write and readback carries an immutable context:

- Echelon channel ID;
- exact channel-connection ID;
- provider key;
- supported scope type (`location` for Shopify, `account` for eBay);
- exact external scope ID;
- exact provider inventory-item identity and external SKU; and
- publication-target revision.

The service fails closed when an adapter cannot address the configured scope
without inference. Shopify never falls back to the historic environment
location for canonical work. eBay fails closed if more than one connection is
configured for a channel because its current OAuth token store is channel-, not
connection-, scoped.

Provider writes are idempotent absolute assignments. Each attempt and exact
readback is durable. Retryable failures use bounded exponential backoff. A
permanent failure or the tenth failed attempt dead-letters the row, fails the
pre-authority run, cancels its remaining mutable rows, and releases the freeze
after every already-leased sibling has recorded an outcome.

## State and locking contract

This slice can use only these operational states:

```text
ready dry run -> publishing -> publication_verified
                         \-> failed
publication_verified -----\-> failed (operator abort)
```

`activating` and `active` remain reserved database states for the future atomic
cutover. No shipped application path can enter them.

Prepare and abort use a serializable transaction and the cutover advisory lock.
The database permits only one open full-catalog activation and one unreleased
configuration freeze. While frozen, transformation models, location promise
policies, safety policies, channel exposure policies, source bindings, variant
mappings, and publication targets reject ordinary writes.

## Difference from the migration plan

This slice matches Phase 5 Step B exactly: current provider state is read, stale
or missing evidence blocks, and the first write is `min(observed, proposed)`.
It intentionally stops before Step C. The migration plan describes Step C as
one transaction that switches ATP readers, order acceptance, live claims,
configuration heads, admin views, and publishers together. Current `main` has a
planner claim simulation but no live claim writer/executor, so implementing only
the authority flag would violate that atomic contract.

Recommended continuation:

1. implement the live canonical whole-order claim, release, cancellation, and
   transformation execution path with the approved lock order;
2. route every order-acceptance and reservation caller through that contract;
3. add concurrency and failure-recovery integration coverage;
4. only then add a separately reviewed Step C command that revalidates the
   frozen catalog, promotes the selected definitions, switches all runtime
   readers/writers atomically, and enqueues full publication;
5. execute production cutover only through a reviewed runbook. Deployment of
   this slice is not production activation authorization.

## Verification boundary

Unit and adapter tests cover request validation, idempotent replay, exact target
routing, supported-scope enforcement, readback drift, dead-letter behavior,
role-gated routes, and the absence of an authority-commit path. The disposable
PostgreSQL integration suite loads migration 0638 and verifies legacy authority,
the restricted command type, and rejection of an early authority switch. That
suite requires the repository's disposable PostgreSQL test environment.
