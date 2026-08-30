# Inventory Transformation Architecture And Migration Plan

## Status And Authority

This document is the cold-start design and execution plan for replacing Echelon's
exclusive product inventory-strategy switch with an explicit, versioned supply and
transformation model.

It is a planning record only. It does not authorize production inventory writes,
configuration changes, recipe activation, channel inventory publication, or data
repair. Every production mutation remains subject to preview, explicit approval,
transactional execution, and read-only post-verification.

Reviewed decisions made after the original cold-start draft supersede four older
patterns that still appear in historical sections of this document: directed
transformation paths are the only conversion authority (not equivalence groups),
reverse authority requires its own path, rollout has no required canary cohorts,
and the first authority cutover cannot roll back to legacy ATP. Phase 3 follows
the implementation record in
`docs/INVENTORY-AVAILABILITY-PHASE-3-BACKFILL-AND-REVIEW.md`.

The program must preserve existing physical inventory, reservations, lot costs,
channel mappings, and operational history. The migration changes how availability
is derived and reserved; it does not rewrite inventory to make the new model fit.

## Fast Resume

Start a new conversation with this document and the current repository state:

```powershell
cd C:\Users\owner\Echelon
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
```

Then ask Codex to:

> Read `docs/INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md`,
> verify its baseline against current `origin/main`, report any drift, and begin
> Phase 0. Do not change production data or configuration.

Do not assume the commit, schema, deployment, or production quantities recorded
here remain current. Reverify them at the start of implementation.

## Verified Repository Baseline

This plan was written against:

- Repository: `cardshellz/Echelon`
- Verified `origin/main`: `c58c092115bd3b1dc074e186cbdf74db7cce0321`
- Merge at that commit: PR #1261, finished-package ATP for recipe-managed products
- Verification date: 2026-08-24
- Production deployment state: not checked while writing this document
- Production database state: not queried while writing this document

No production data, configuration, recipe, inventory level, reservation, channel
quantity, or Shopify value was changed while creating this plan.

## Problem Statement

The current catalog presents one mutually exclusive `inventory_strategy` for each
product:

- `physical_fungible`: sibling packages share a base-unit pool and permit direct
  break/assemble operations.
- `recipe_managed`: transformations require recipes and auditable build orders.
- `physical_only`: each variant is available only from exact physical stock.

That model combines two independent questions:

1. How can supply be produced?
2. Which finished package variants can supply one another?

A product can validly have all of the following at once:

- Exact physical finished inventory.
- Component inventory that can be assembled into a finished item.
- Finished package sizes that can be built up or broken down.
- Directional transformations that are not freely reversible.

The current radio choice cannot express that combination without implicit behavior.
PR #1261 now lets recipe-managed ATP include finished sibling package inventory, but
the permission to pool those packages is still implied by the product strategy rather
than represented by explicit transformation master data.

## Current Code Trace

The following behavior is verified at the repository baseline.

### Catalog strategy

- `shared/catalog/inventory-strategy.ts` defines the three exclusive strategies.
- `usesFungibleBaseUnitPool` and `allowsDirectPackageConversion` return true only
  for `physical_fungible`.
- `requiresBuildRecipe` returns true only for `recipe_managed`.
- `client/src/pages/ProductDetail.tsx` renders those definitions as the editable
  Inventory behavior radio group.
- `server/modules/catalog/inventory-strategy-policy.ts` prevents moving away from
  `recipe_managed` while build recipes exist.

### Recipe master data

- `inventory.build_recipes` is versioned and stores immutable output snapshots.
- `inventory.build_recipe_components` stores component-variant snapshots.
- `server/modules/inventory/domain/build.domain.ts` enforces:
  - conversion recipes use variants from one catalog product;
  - conversion recipes preserve exact base units;
  - assembly recipes require at least one cross-product component.
- `server/modules/inventory/infrastructure/build.repository.ts` permits only one
  active recipe per output variant.
- `server/modules/inventory/domain/recipe-capacity.domain.ts` rejects ambiguous
  active outputs and detects recipe cycles during graph planning.

### ATP and channel publication

- `server/modules/inventory/atp.service.ts` supplies product and warehouse ATP.
- `server/modules/inventory/application/inventory-levels.query.ts` replaces the
  displayed available quantity with recipe ATP for `recipe_managed` products.
- `server/modules/channels/allocation-engine.service.ts` obtains ATP per variant and
  warehouse before applying channel allocation policy.
- `server/modules/channels/echelon-sync-orchestrator.service.ts` runs allocation and
  pushes the resulting quantities through channel adapters.
- `server/modules/channels/adapters/shopify.adapter.ts` writes Shopify inventory
  levels through the Shopify inventory API.

### Reservation authority

- `server/modules/channels/reservation.service.ts` branches on product strategy.
- Recipe-managed products delegate to
  `server/modules/wms/application/recipe-build-promise.service.ts`.
- `RecipeBuildPromiseService.lockRecipeGraph` takes deterministic advisory locks for
  every product in the recipe graph before planning and claiming supply.
- Existing recipe demand and inventory transactions provide durable order-item
  ownership evidence.

### Inventory-change notifications

- `server/modules/inventory/application/build.use-cases.ts` notifies affected
  variants after recipe version changes and build-order inventory changes.
- Notification failure is logged, but it is not transactional channel-publication
  evidence. The target design therefore requires a durable outbox for activation
  and publication cutovers.

## Non-Negotiable Contracts

Every implementation phase must preserve these contracts.

1. **Physical truth stays exact.** Physical inventory remains recorded by exact SKU,
   lot, warehouse, and location. ATP must never materialize virtual package stock as
   physical stock.
2. **Variants own identity and UOM.** Catalog variants remain authoritative for SKU,
   product, UOM, `units_per_variant`, active state, and channel mapping.
3. **Transformations own permission.** Versioned transformation relationships are
   the only authority for assembly, build-up, breakdown, or reversible package use.
4. **One planner.** Admin ATP, channel ATP, order reservation, build demand, and
   allocation previews must use the same planner contract and model version.
5. **Alternative ATP is not additive inventory.** `2,200 EA`, `440 P5`, and `88 C25`
   can be simultaneous promises against one shared capacity, but one sale reduces all
   competing alternatives atomically.
6. **Exact physical stock is always eligible for its own SKU.** A transformation
   model may add convertible or buildable capacity; it cannot hide valid exact stock.
7. **No inferred reversibility.** The system never assumes that a conversion can run
   backward merely because base-unit math balances.
8. **No reciprocal recipe cycles.** Lossless reversible package relationships are
   represented as one equivalence relationship, not two opposing recipes.
9. **No hidden cost creation.** Package equivalence transfers existing lot cost.
   Component assembly combines source costs only when executed. ATP projection does
   not create lots, costs, or inventory transactions.
10. **Atomic ownership.** A reservation or build promise claims the underlying shared
    resource graph in one transaction with deterministic lock order.
11. **Immutable activation evidence.** Every model activation records actor, reason,
    prior version, new version, request hash, and before/after ATP evidence.
12. **Rollback does not rewrite inventory.** Rollback reactivates a prior model and
    republishes availability; it never reverses physical inventory merely because a
    policy version changed.

## Target Source-Of-Truth Model

There is not one table that owns every concept. There are five explicit authorities:

| Concern | Authority |
| --- | --- |
| SKU identity, UOM, package quantity | Catalog product variants |
| Physical quantity, reservations, lots, costs | Inventory ledger and lot records |
| Permitted transformations | Active versioned transformation model |
| Customer promise target eligibility | Catalog variant `sales_eligibility` |
| Sellable availability | Deterministic ATP projection from the preceding authorities |

The editable catalog Inventory behavior radio is removed after migration. The catalog
may display derived status badges, but those badges cannot become a second rule source.

## Transformation Types

### Component assembly

Component assembly consumes variants from one or more different catalog products and
produces a finished output variant.

Example:

```text
1 BASE-PC1 + 1 LID-PC1 + 1 DIV-PC1 -> 1 QUAD-BOX-TOP-EA
```

This relationship is directional. Disassembly requires a separate explicit recipe
with its own quantities, yield, cost treatment, and operational controls.

### Directional package conversion

A directional conversion changes package form within one product while conserving
base units.

Examples:

```text
5 EA -> 1 P5        build up only
1 P5 -> 5 EA        break down only
```

Use a directional conversion when packaging materials, labor, quality checks, waste,
or operational policy prevent free reversibility.

### Reversible package equivalence

A reversible relationship states that either finished package may satisfy demand for
the other without loss or additional constrained components.

```text
5 EA <-> 1 P5
5 P5 <-> 1 C25
```

Connected reversible variants form one finished-resource equivalence group. ATP can
be expressed in every member UOM, but reservation consumes one canonical base-unit
capacity. The relationship is not executed as two recursive build recipes.

### Exact-only finished variants

No transformation relationship means a variant can be promised only from its exact
physical supply or from a directed recipe that explicitly outputs that variant.

## Proposed Data Model

Exact naming may be adjusted during Phase 0 schema design, but the following contracts
must remain explicit.

### `inventory.transformation_models`

One immutable, versioned policy aggregate per product revision.

- `id`
- `product_id`
- `version`
- `status`: `draft`, `shadow`, `ready`, `active`, `retired`
- `definition_hash`
- `supersedes_model_id`
- `change_reason`
- `created_by`, `created_at`
- `activated_by`, `activated_at`
- `retired_by`, `retired_at`

Constraints:

- Unique product/version.
- At most one active model per product.
- Activation and retirement evidence must be complete.
- Definition hash is immutable.

### `inventory.transformation_model_recipes`

Binds a model version to exact immutable recipe versions. Existing build-recipe
history remains intact.

- `model_id`
- `recipe_id`
- `relationship_role`: `assembly`, `directional_conversion`, `disassembly`

### `inventory.package_equivalence_relationships`

Stores explicit lossless reversible package relationships.

- `model_id`
- `left_variant_id`, `left_qty`
- `right_variant_id`, `right_qty`
- snapshotted product IDs and `units_per_variant`

Activation validates that both sides belong to one product and conserve exact base
units. The canonical ordering of variant IDs prevents duplicate reversed rows.

### `inventory.transformation_shadow_results`

Immutable or append-only comparison evidence:

- model and product version
- warehouse and variant
- physical, reserved, picked, packed
- legacy ATP and proposed ATP
- difference and classified reason
- calculation timestamp and input fingerprint

### `inventory.transformation_activation_runs`

Records preview, conservative publication, activation, full publication, completion,
failure, and rollback evidence. Retried commands use idempotency keys.

### Transactional outbox

Model activation writes a channel-resynchronization event in the activation
transaction. The event is retried until every intended channel/location result is
recorded. A process log message alone is not sufficient evidence.

## Admin UI Design

### Product detail summary

Replace the editable Inventory behavior radio with a read-only
**Supply & Transformations** summary:

```text
Physical inventory       Tracked by exact SKU
Component assembly       1 active recipe
Package sharing          EA <-> P5 <-> C25
Model status             Active v3

[Manage transformations]
```

The summary is derived from the active transformation model. It is not editable in
place and cannot disagree with Build Relationships.

### Supply and transformations page

Use a full page rather than a modal. It contains five sections.

#### 1. Finished package path

Display package variants in ascending base-unit order. Each adjacent relationship
has a segmented direction control:

- None
- Build up only
- Break down only
- Reversible

Example:

```text
EA             5 EA           P5             5 P5           C25
Each       [ reversible ]   Pack of 5     [ reversible ]   Case of 25
```

The UI displays both human quantities and normalized base units. It rejects a
relationship if conservation cannot be proven.

#### 2. Component builds

Display active, draft, and historical versioned recipes:

```text
BASE-PC1 + LID-PC1 + DIV-PC1 -> QUAD-BOX-TOP-EA
```

Creating or editing a recipe uses the existing full-page recipe editor. Saving an
edit creates a new immutable recipe version with a required reason.

#### 3. ATP preview

For each variant and warehouse, show:

- exact physical supply;
- exact outstanding reservations;
- convertible finished supply;
- buildable component capacity;
- total proposed ATP;
- currently published channel quantity;
- difference from the active/legacy model.

Alternative quantities must carry a **Shared capacity** label and explanatory
tooltip. They must not be presented as independent inventory totals.

#### 4. Validation

Block readiness on:

- inactive, archived, duplicate, or missing variants;
- invalid UOM or non-positive/non-integer units;
- non-conserving conversions;
- reversible relationships with constrained materials, yield, or cost;
- directed graph cycles;
- multiple active production recipes for one output;
- missing output or component locations;
- reservations greater than capacity;
- missing channel mapping for an intended published variant;
- unexplained ATP difference;
- channel dry-run failure.

#### 5. Migration and audit

Display:

- legacy/shadow/ready/active status;
- current and proposed model versions;
- latest shadow comparison;
- readiness blockers;
- activation history;
- required reason and authenticated actor;
- Preview, Mark ready, Activate, and Roll back commands.

Activation and rollback are commands with confirmation dialogs, idempotency keys,
and explicit evidence. They are not ordinary form saves.

## ATP Semantics

For a requested target variant, ATP is computed from one mutable planning snapshot:

1. Use exact target physical supply first.
2. Use available finished supply from its explicit equivalence group.
3. Use directed conversion paths that are allowed by the active model.
4. Use component-recipe capacity where the target or an equivalent finished variant
   can be produced.
5. Subtract existing exact reservations and durable shared-resource claims once.
6. Return the target UOM quantity plus an evidence breakdown and model version.

The planner must never sum capacities that depend on the same underlying stock.
Component recipes that share a component must compete in the same planning snapshot.

### Quad Box worked example

Quad Box is not a reversible package-equivalence case. The approved direction is:

```text
25 internal EA -> 1 sellable Quad Box
```

No `1 Quad Box -> 25 EA` path exists because EA is not sold. Exact physical Quad Box
inventory can satisfy Quad Box demand, while internal EA and explicitly buildable EA
may supply only the reviewed forward conversion:

```text
Quad Box ATP = exact available Quad Boxes
             + floor((available internal EA + explicitly buildable internal EA) / 25)
```

The internal EA identity remains visible in physical inventory and planner evidence,
but is excluded from customer/channel targets. Shared EA/component capacity is claimed
once; it cannot be counted again through another target view.

## Reservation And Fulfillment Semantics

ATP and reservation must share one domain planner. The planner returns a versioned
claim plan containing:

- requested product/variant/quantity;
- transformation-model version and definition hash;
- direct finished allocations;
- shared-equivalence base-unit claims;
- prerequisite build demands;
- component reservations;
- source and output locations;
- residual shortfall.

The application service then:

1. Locks all graph products in deterministic order.
2. Locks the order item and any existing claim.
3. Reloads current stock and reservations.
4. Recomputes against the active model.
5. Persists the claim, component reservations, build demands, and inventory journal
   evidence in one transaction.
6. Returns an idempotent prior result when the same order-item command is replayed.

Channel ATP may advertise alternatives, but only this atomic claim decides which
underlying stock owns an order. A later pick/build may choose the physical execution
path only within the committed claim constraints.

## Safe Migration Program

The rollout is additive, shadow-first, product-scoped, and reversible. No phase may
advance because code merged; its evidence gate must pass.

### Phase 0 - Baseline and detailed design

Deliverables:

- Reverify current main, production release, and applied migrations.
- Trace every consumer of ATP and every reservation entry point.
- Enumerate products by current strategy and active recipe count.
- Capture read-only variant/UOM/hierarchy/configuration anomalies.
- Define exact schema, DTOs, planner contract, error taxonomy, locks, and outbox.
- Define the production reconciliation queries and evidence retention period.
- Confirm whether any storefront or marketplace bypasses channel allocation ATP.

Gate 0:

- No unknown ATP or reservation consumer remains.
- The target graph and activation transaction have an approved written contract.
- No production mutation occurred during discovery.

### Phase 1 - Additive schema and draft admin model

Deliverables:

- Add versioned transformation-model tables and constraints.
- Add domain validation and repository/application boundaries.
- Add draft-only admin APIs and the Supply & Transformations page.
- Retain `inventory_strategy` as the only runtime authority.
- Add writer-ratchet ownership and audit coverage.

Gate 1:

- Schema migration is additive and backward compatible.
- Creating/editing drafts cannot change ATP, reservations, builds, or channels.
- Versioning, idempotency, and concurrent activation constraints pass integration
  tests.

### Phase 2 - New planner and shadow evidence

Deliverables:

- Implement the transformation graph and one pure planning domain.
- Add legacy and proposed adapters so both calculators consume one captured snapshot.
- Persist shadow comparisons without affecting operational behavior.
- Add graph conservation, no-double-counting, and concurrency property tests.
- Add shadow health and variance dashboards.

Gate 2:

- Legacy ATP remains the only operational ATP.
- Proposed calculations are deterministic under replay.
- Every difference is classified or blocks readiness.
- Planner and claim simulation use the same graph semantics.

### Phase 3 - Deterministic backfill and review

Backfill rules:

- `physical_only` -> no package relationships.
- `physical_fungible` -> draft paired, explicit directed paths between adjacent
  package sizes. Each direction is independently reviewable; multi-step traversal
  reproduces the existing base-unit pool without granting implicit reversibility.
- Existing build recipes -> bind their exact current active versions.
- `recipe_managed` package relationships -> require explicit review; do not infer
  reversibility merely because sibling variants exist.

Deliverables:

- Idempotent dry-run/backfill command with input and result hashes.
- Full product migration queue in the admin UI.
- Per-product ATP and channel-publication preview.
- No inventory-level, lot, transaction, reservation, or channel writes.

Gate 3:

- Every active product is classified.
- Backfill reruns produce identical drafts.
- Quad Box has an explicitly reviewed model with internal EA supply and only the
  approved `25 EA -> 1 Quad Box` package direction.

### Phase 4 - Unified claim path and dry-run publication

Deliverables:

- Make the new planner capable of producing reservation claim plans.
- Preserve the legacy live path while running non-writing claim simulation.
- Run the allocation engine with proposed ATP in dry-run mode.
- Compare proposed channel/location quantities with current published values.
- Add durable activation-run and outbox infrastructure.

Gate 4:

- Recent and synthetic order cohorts produce explainable claim results.
- Concurrent claims cannot over-consume shared capacity.
- Proposed channel quantities never exceed planner ATP.
- No adapter is called during dry run.

### Phase 5 - Controlled full-catalog activation

There are no required product canaries or activation cohorts. Activation occurs
only after the complete active catalog and every external publication target pass
review.

#### Step A: Revalidate

- Lock the catalog activation state and selected model/policy heads.
- Recompute legacy and proposed ATP from current inventory.
- Verify all open demand is representable by durable claims.
- Verify every fulfillment node, mapping, channel, and provider location.
- Abort on any stale preview or definition-hash mismatch.

#### Step B: Conservative publication

For every provider variant/channel/location key with valid authoritative readback,
publish:

```text
safe provider quantity = min(current provider observed quantity, new desired quantity)
```

Missing or stale required readback blocks activation; it is never guessed. Verify
provider acknowledgement before the authority switch. This may temporarily
understate availability, but it cannot raise an external promise before the new
planner is authoritative.

#### Step C: Atomic activation

In one database transaction for the complete catalog:

- revalidate the full catalog preview and current snapshot;
- activate every reviewed immutable model and policy version;
- switch ATP readers, order acceptance, claims, admin views, and publishers to the
  new planner together;
- record actor, reason, hashes, and ATP evidence;
- write target-scoped channel-resynchronization outbox events.

After commit, new ATP reads and reservation claims use the same active model.

#### Step D: Full publication

- Publish full proposed ATP through the existing allocation engine.
- Record each channel/location request and provider response.
- Read back Shopify/provider state where the API supports authoritative verification.

Gate 5:

- Physical quantities, lots, costs, and existing reservations are unchanged.
- Admin ATP, allocation ATP, all storefront targets, and claim plans share the
  catalog activation version.
- Test reservation, cancellation, and concurrency behavior pass.
- No unexplained channel drift or order shortfall occurs during the observation
  window.

### Phase 6 - Post-cutover verification and stabilization

- Keep the new planner authoritative across the complete catalog.
- Retry idempotent target-scoped publication until provider acknowledgement and
  required readback are verified.
- Monitor order acceptance, claim shortfalls, transformation execution, provider
  drift, and multi-warehouse fulfillment evidence.
- A post-cutover failure does not reactivate legacy ATP. Later model rollback may
  select only a previously provider-verified version of the new model.

Gate 6:

- All products have active, explicit models or a documented approved exclusion.
- No unexplained ATP variance, publication drift, or graph-claim failure remains.

### Phase 7 - Legacy retirement

Only after the agreed stability period:

- Make transformation models authoritative for all products.
- Remove the editable Inventory behavior radio.
- Retain a read-only legacy classification during rollback retention.
- Remove strategy branching from ATP and reservation application services.
- Delete legacy schema/code only in a later migration after rollback retention expires.

Gate 7:

- No runtime consumer reads `inventory_strategy` for behavior.
- Legacy removal tests prove every product has one valid active model.
- Operational runbook and support tooling are complete.

## Activation State Machine

```text
draft -> shadow -> ready -> conservative_publishing -> activating
      -> publishing -> active

Any pre-activation failure -> failed (legacy remains authoritative)
Any post-activation blocker -> rollback_pending -> rolled_back
```

State transitions are guarded commands, not direct status updates. Invalid transitions
return structured conflict errors.

## Rollback Plan

Rollback is product-scoped and versioned.

1. Freeze further model changes for the product.
2. Recompute current and rollback-model ATP from one locked snapshot.
3. Block rollback if current durable reservations cannot be represented.
4. Publish `min(current, rollback)` ATP and verify acknowledgement.
5. Atomically reactivate the prior model and record rollback evidence.
6. Enqueue and verify full channel resynchronization.
7. Preserve the failed model, activation run, claims, and provider responses.

Rollback never deletes a model, recipe, build order, reservation, inventory movement,
lot, or audit row.

## Observability And Alerts

Required structured dimensions:

- product, variant, warehouse, channel, provider location;
- model ID/version/hash;
- legacy ATP, proposed ATP, published ATP, and difference;
- physical, reserved, picked, packed, convertible, and buildable evidence;
- order, order item, claim, recipe, build demand, and operation IDs;
- activation run, outbox event, attempt, actor, and trigger.

Alert on:

- published quantity greater than current backend ATP;
- provider quantity drift after verified publication;
- unexplained legacy/proposed variance;
- cycle, ambiguity, missing-location, or overflow errors;
- reservation failure after positive availability was published;
- model-version mismatch between ATP and reservation;
- negative or over-reserved inventory;
- activation outbox age or repeated adapter failure;
- rollback blocker.

## Test Plan

### Domain and property tests

- Exact base-unit conservation for package conversions.
- Reversible equivalence closure without reciprocal recipe cycles.
- No capacity double counting across alternative outputs.
- Shared-component contention across multiple outputs.
- Integer overflow, zero, negative, inactive, duplicate, and malformed inputs.
- Deterministic output for identical snapshots and model versions.

### Repository and migration tests

- Unique active model per product under concurrency.
- Immutable version, hash, activation, and retirement evidence.
- Idempotent backfill and activation replay.
- Foreign keys and archived-variant guards.
- Additive migration against production-shaped fixtures.

### ATP and reservation integration tests

- Exact physical plus finished-equivalent plus component-buildable capacity.
- Existing reservations deducted once.
- Two concurrent orders requesting competing package sizes.
- Cancellation/release restores shared alternatives once.
- Replay returns the committed claim without duplicate reservations or builds.
- Warehouse isolation and deterministic graph lock order.

### Channel tests

- Proposed ATP flows through allocation rules per warehouse.
- Dry run never calls an adapter.
- Conservative first-cutover publication uses
  `min(current provider observed, new desired)` for each verified provider key.
- Activation outbox retries without duplicate harmful writes.
- Shopify/provider failures remain visible and resumable.
- Provider read-back mismatch blocks completion.

### UI tests

- Catalog summary is derived and read-only.
- Direction controls clearly distinguish build up, break down, reversible, and none.
- Shared-capacity labels prevent additive interpretation.
- Search/filter state survives navigation.
- Draft validation exposes actionable correction paths.
- Activation and rollback require actor/reason confirmation and show progress.

### Production cutover checks

- Read-only before/after inventory and reservation snapshots.
- Channel target and provider read-back by mapped location.
- One controlled reserve/release smoke test using an approved non-customer command.
- Monitor real order claims without manually altering inventory.

## Failure Modes And Required Response

| Failure | Required behavior |
| --- | --- |
| Shadow calculator fails | Record blocker; legacy remains authoritative |
| Proposed ATP differs unexpectedly | Block readiness; inspect evidence |
| Provider conservative push fails | Abort activation; retry from durable run |
| Definition changes after preview | Reject stale activation by hash/version |
| Reservation cannot fit active graph | Return classified shortfall; alert if ATP was positive |
| Activation commits but publication fails | Keep durable retry active; cap exposure and surface critical state |
| Rollback model cannot represent claims | Block rollback and require operational review |
| Graph cycle or duplicate output | Reject draft activation before runtime |

## Implementation Slices

This should be delivered in a few meaningful, reviewable chunks rather than many tiny
PRs. Each slice remains independently deployable and backward compatible.

### Slice 1 - Master data and admin foundation

- Add versioned transformation schemas and constraints.
- Add domain/repository/application contracts.
- Add draft Supply & Transformations UI.
- Add explicit graph validation and audit evidence.
- No ATP, reservation, or publication behavior changes.

### Slice 2 - Planner, shadow ledger, and backfill

- Add the unified transformation planner.
- Add legacy/proposed shadow comparison and health UI.
- Add deterministic dry-run/backfill commands.
- Version sellability-aware deterministic evidence as
  `inventory_availability_backfill_v3`; internal-only variants remain graph supply,
  are omitted as customer targets and inferred path destinations, and internal-only
  products are explicitly excluded from customer ATP migration.
- Bind existing recipe versions and prepare Quad Box draft.
- Legacy remains authoritative.

### Slice 3 - Claims and downstream cutover controls

- Make claim simulation and reservation use the shared planner contract.
- Add activation runs, transactional outbox, channel dry-run, and provider evidence.
- Add conservative publication and rollback commands.
- Do not activate products yet.

### Slice 4 - Full-catalog activation operations

- Complete full-catalog model and channel review, including Quad Box.
- Execute the role-gated catalog activation using the runbook.
- Verify backend, claims, allocation, all configured providers, and readback behavior.
- Add activation monitoring and support controls.

### Slice 5 - Legacy retirement

- Migrate remaining products.
- Remove the catalog strategy editor and runtime branching.
- Retain rollback evidence, then remove obsolete schema in a later release.

## Decisions Recorded

- Build Relationships becomes the sole editable authority for transformations.
- Catalog variants remain authoritative for identity and UOM math.
- Physical inventory remains exact and is never synthesized from ATP.
- Physical finished stock and component-buildable capacity may coexist.
- Package directions are explicit; reversibility is never inferred.
- Reverse conversion authority requires a separate explicit directed path.
- Catalog variant customer eligibility is explicit: `internal_only` identities remain
  physical/transformation supply but cannot become customer-facing ATP, reservation,
  listing, allocation, or publication targets.
- Quad Box consumes 25 internal EA in the forward direction only; physical Quad Box
  stock does not create EA supply.
- Admin ATP, channel ATP, and reservation share one planner/model version.
- Migration is shadow-first across the full active catalog, followed by one
  controlled catalog-wide activation.
- Channel cutover uses conservative publication before activation.
- The first cutover never returns to legacy ATP; later rollback selects only a
  previously verified version of the new model and never rewrites physical history.

## Open Questions To Resolve In Phase 0

1. Which channels and storefront paths consume allocation-engine ATP, and does any
   active path bypass it?
2. What provider read-back evidence is available per channel/location?
3. What stability duration and order volume are required before legacy retirement?
4. Which package changes require labor, packaging materials, quality control, or yield,
   and therefore cannot be reversible equivalence?
5. Should alternate BOMs be supported now, or remain deferred behind one active recipe
   per output?
6. How should build lead time affect published ATP when assembly cannot be completed
   within the fulfillment SLA?
7. Which active products have malformed hierarchy/UOM data that must be corrected
   before draft backfill?
8. What channel safety cap should apply while an activation publication is incomplete?

## First Task For The Next Conversation

Begin Phase 0 with a read-only code and production-path inventory. Produce one evidence
table containing every ATP reader, reservation caller, channel publisher, and
configuration writer. Then propose the final schema and planner DTOs before editing
code. Do not activate recipes, change `inventory_strategy`, run builds, adjust
inventory, or push channel quantities during that discovery.
