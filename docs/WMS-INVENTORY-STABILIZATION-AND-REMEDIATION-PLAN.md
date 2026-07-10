# WMS Inventory Stabilization And Remediation Plan

## Status And Authority

This document is the execution plan for the production inventory findings captured
in `docs/WMS-PRODUCTION-INVENTORY-BASELINE-2026-07-09.md`.

It supersedes the completion claims in `WMS-INVENTORY-REFACTOR.md` where the live
July 9 baseline contradicts them. The older roadmap remains useful design history,
but a phase marked complete there is not evidence that its production invariant is
currently satisfied.

The required sequence is non-negotiable:

1. Stop writers from creating new discrepancies.
2. Prove the stabilized writers remain clean under replay and concurrency.
3. Repair current operational discrepancies with compensating operations.
4. Classify historical gaps that cannot be reconstructed without inventing data.
5. Lock the repaired invariants into database constraints and continuous controls.

No bulk counter correction starts before the stabilization gate in this document is
met. Repairing data while defective writers remain active would produce temporary
numbers, destroy evidence, and allow the same defects to recur.

## Verified Starting Point

The production baseline was captured at `2026-07-09T23:40:54.311Z` through one
read-only, repeatable-read transaction. The material findings are:

- 55 shipped WMS orders retain 118 signed reservation units across 66 lines.
- 141 variant/location cells have level-to-lot drift.
- 15 lots have negative on-hand totaling 165 units.
- `inventory_levels` has no negative aggregate buckets at the snapshot.
- Four aggregate bucket checks are absent and the posted inventory journal is not
  immutable at the database boundary.
- 1,166 case-break/assembly rows have no durable operation identity, including 100
  rows created in July.
- Two completed cycle counts have pending items, one inline replenishment is blocked,
  two operator adjustments lack an actor, two hierarchy links are invalid, and two
  products have multiple active base-unit variants.

The current reservation defect is directly supported by these code paths:

- `InventoryUseCases.pickItem` in
  `server/modules/inventory/application/inventory.use-cases.ts` calculates the
  reservation release from the shared location-level `reservedQty`.
- `ReservationService.releaseOrderReservation` in
  `server/modules/channels/reservation.service.ts` derives an order quantity but
  decrements shared variant/location counters without a durable owner allocation.
- `markOrderShipped` in `server/modules/orders/order-status-core.ts` transitions the
  order state without enforcing zero residual reservation ownership.
- `cancelWmsOrderAndRelease` and the completed-order wrapper in
  `server/modules/orders/cancel-wms-order.ts` have release behavior, so terminal
  state handling is not one authoritative lifecycle operation.

The committed writer-ratchet baseline also proves that inventory state is not yet
single-writer:

- `inventory.inventory_levels` is written by catalog, channels, inventory, and a
  repair script bucket.
- `inventory.inventory_lots` is written by inventory and procurement.
- `inventory.inventory_transactions` is written by channels, inventory,
  diagnostics, and a repair script bucket.

The ratchet prevents an unreviewed new writer bucket from appearing, which is useful,
but it freezes the current multi-writer topology. It must shrink as each write path is
moved behind the inventory application boundary.

## Interim Containment Rules

These rules apply from the first stabilization deployment until Gate C passes:

- Freeze new features that introduce inventory DML. New callers may use only an
  existing canonical inventory command or wait for the owner API.
- Do not run direct production SQL to change inventory quantities, reservations,
  lots, or posted movements.
- Do not auto-clean current baseline findings. Quarantine or surface affected entities
  where needed, but preserve their evidence until a repair run is authorized.
- Emergency operational corrections use a named actor, reason, approved scope, and a
  canonical compensating command. They become part of the audit, not an exception to it.
- Any deployment that adds or worsens a blocker is disabled or rolled back before
  feature work continues.

## Non-Negotiable Inventory Contracts

Every implementation phase must preserve these contracts:

1. **Single authority:** only `modules/inventory` may post inventory state changes.
   Catalog, channels, procurement, orders, WMS, routes, jobs, and scripts call a
   typed inventory application API.
2. **One transaction:** owner allocation, level buckets, lot quantities, cost
   layers, and movement events change atomically or not at all.
3. **Operation identity:** every retriable command has one durable idempotency key.
   Every child movement belongs to one operation and has a unique sequence/key.
4. **Owner identity:** reserved inventory belongs to an order item and exact
   warehouse/location allocation. A different order cannot consume or release it.
5. **Physical and financial separation:** refunds do not return stock. Only an
   authorized physical return receipt/disposition can add sellable inventory.
6. **Compensation, not erasure:** posted movements are immutable. Corrections append
   reversing or compensating movements linked to the original operation.
7. **No silent normalization:** an impossible state becomes a durable exception with
   actor, source, context, and next action. It is never converted to zero or ignored.
8. **Deterministic concurrency:** rows are locked in a documented order; guarded
   updates must verify affected-row counts; duplicate commands return the previously
   committed result.
9. **Exact units and money:** quantities are integers in the SKU's declared UOM.
   Costs remain integer mills/cents. Conversions prove base-unit conservation.
10. **Derived counters are reproducible:** allocation and movement events can rebuild
    materialized level, lot-location, and order-line counters.

## Program Gates

The program has three release gates. A later stage cannot begin because a calendar
date was reached; its evidence gate must pass.

### Gate A: Writer Containment

- Every production inventory writer is enumerated by table, column, module,
  function, command, and idempotency strategy.
- No route, startup hook, diagnostic endpoint, reconciliation loop, or one-off script
  directly mutates inventory state.
- The CI ratchet allows only the inventory owner for levels, lots/lot quantities,
  reservation allocations, and posted movement events.
- Every current mutation verb has a typed command and integration test.

### Gate B: No New Drift

- Continuous audit records no new terminal reservation leak.
- Continuous audit records no new negative lot or aggregate bucket.
- Continuous audit records no new level/lot drift.
- Every new conversion has an operation identity and balanced base-unit movements.
- Every new receipt, pick, unpick, transfer, shipment, cancellation release, return,
  and count adjustment has an idempotency key and immutable event.
- The gate remains green for seven full operating days **and** includes at least one
  exercised event of every production mutation type. A missing low-frequency event
  must be covered by a production-like concurrency/replay test before the gate passes.

### Gate C: Repaired And Enforced

- Current discrepancies are either compensated to zero or recorded as explicit,
  approved exceptions with no effect on operational ATP.
- Database constraints are validated, not merely present as `NOT VALID`.
- Posted movement rows cannot be updated or deleted through the application role.
- Rebuilding projections from canonical allocations and movements reproduces the
  production materialized counters exactly.
- The same continuous audit remains green for another seven operating days after
  repair.

## Stage A: Stop Creating New Errors

### A0. Publish The Measurement And Exception Contract

**Purpose:** make new drift distinguishable from historical drift before changing
writer behavior.

Deliverables:

- Publish `scripts/audit-wms-inventory-integrity.ts`, its tests, runbook, and July 9
  baseline.
- Add an `inventory.integrity_exceptions` registry (or a dedicated audit schema)
  keyed by stable check ID plus entity fingerprint. Store first seen, last seen,
  resolved at, severity, affected entity IDs, evidence JSON, observed metric history,
  and remediation run ID. Fingerprints identify the entity, not its changing quantity,
  so the same cell can be detected as worsening instead of appearing as a new row.
- Run the read-only audit on a schedule under a read-only database role. Only the
  exception registry writer may persist audit findings.
- Alert on **new** blocker fingerprints, worsening metrics on an existing fingerprint,
  recurrence after resolution, and blocker-count growth. Historical rows remain
  visible but do not repeatedly page operations.
- Record a stabilization start watermark. Every later gate reports both total findings
  and findings first seen after that watermark.

Tests:

- Query preparation against an empty and production-shaped schema.
- Stable fingerprint generation independent of row order.
- Repeated observations update `last_seen_at` without duplicating exceptions.
- A larger drift magnitude on the same entity records a worsening event.
- Resolution and recurrence create an auditable lifecycle.

Exit:

- A scheduled report can answer exactly which discrepancies are new since
  stabilization started.

Implementation checkpoint:

- The read-only audit, stable entity fingerprints, quantitative magnitude contract,
  lifecycle registry schema, immutable observations, dry-run preview, and atomic
  recorder were deployed in release `v2321`.
- The first production dry-run/execute/dry-run sequence completed on July 10, 2026.
  Run `864c28b7-f8c8-4146-963d-1e89ae02e099` is the verified all-check baseline:
  31 checks, 1,773 blockers, 25,888 warnings, and 27,661 stable findings.
- Measurement activation adds the explicit stabilization watermark, read-only-role
  enforcement, advisory-locked scheduled runner, and durable alert outbox. The
  watermark must be activated and the scheduled path must pass dry-run before the
  hourly scheduler is enabled.

### A1. Close And Shrink The Writer Topology

**Purpose:** ensure future fixes cannot be bypassed by another module.

Deliverables:

- Extend the writer inventory from module buckets to exact file/function/column
  ownership for:
  - `inventory.inventory_levels`;
  - `inventory.inventory_lots` and the future lot-location quantity table;
  - `inventory.inventory_transactions`;
  - reservation allocation state and events;
  - cycle-count state;
  - procurement receipt-to-inventory posting.
- Add CI failures for inventory DML in routes, startup code, diagnostics, jobs,
  repair scripts, or non-owner modules.
- Detect raw SQL and unresolved dynamic table writes. The current scanner documents
  dynamic-table calls as an accepted blind spot; inventory state cannot retain that
  blind spot.
- Create a typed, transaction-composable `InventoryMutationPort` in
  `modules/inventory`. It must accept a caller transaction when the business command
  spans modules, while inventory remains the only code that constructs inventory DML.
- Move and ratchet one writer family per PR. The baseline must shrink in the same PR;
  it may never be regenerated merely to accept an unowned inventory writer.
- Remove production repair scripts from the normal writer allowlist. Approved repair
  tooling must call the same application commands as production and identify itself
  with a remediation run ID.

Exit:

- CI proves one owning module for all inventory state tables.
- A repository scan reports zero unresolved inventory writes.

### A2. Materialize Reservation Ownership

**Purpose:** prevent one order from consuming or releasing another order's stock.

Target model:

- `inventory.reservation_allocations`: current owner/location projection keyed by
  WMS order item, variant, warehouse, and location.
- `inventory.reservation_allocation_events`: immutable reserve, consume, unconsume,
  move, release, and terminal-release events linked to one operation ID.
- Allocation invariants prove granted quantity equals open plus consumed plus
  released quantity, with every component non-negative.
- Aggregate `inventory_levels.reserved_qty` equals the sum of open owner allocations
  at the same variant/location.

Rollout:

1. Expand schema with foreign keys, unique owner/location key, integer checks, event
   idempotency key, and version column.
2. Shadow-create allocation records for new reserves while the old aggregate remains
   authoritative. Shadow mode may not change ATP twice.
3. Compare owner allocation sums with aggregate reserved counters continuously.
4. Move reserve, pick, unpick, reservation move, and release commands to owner rows.
5. Cut over atomically so owner allocations become authoritative and aggregate
   `reserved_qty` becomes a projection maintained in the same transaction.
6. Remove the old shared-counter release algorithms.

Required lifecycle behavior:

- Pick consumes only the current order item's allocation at the actual source
  location.
- Unpick reverses the exact consumption and reopens the owner allocation unless the
  order has become terminal.
- Cancellation releases only open owner quantity. Picked stock requires an explicit
  unpick/return-to-stock operation; cancellation cannot invent on-hand stock.
- Shipment consumes picked state but cannot release another order's reservation.
- Shipped, cancelled, and completed states all use one idempotent terminalization
  command with a zero-open-owner-reservation postcondition.
- A terminalization sweeper retries incomplete terminal commands by operation key and
  dead-letters persistent failures with an actionable exception.

Tests:

- Duplicate reserve/release/pick/unpick/terminal commands.
- Two orders reserving the same variant/location concurrently.
- Pick from a different location than originally allocated.
- Partial pick, partial cancellation, split shipment, and order edit.
- Terminal-state race against pick/unpick.
- Crash after each write boundary, followed by replay.

Exit:

- Gate B reservation checks remain green and the aggregate projection equals owner
  allocation sums for every non-legacy cell.

### A3. Make Inventory Movements Atomic And Operation-Addressable

**Purpose:** stop level/lot drift and make every multi-row mutation replay-safe.

Deliverables:

- Add an inventory operation header with globally unique idempotency key, operation
  type, actor, source system, business reference, status, and timestamps.
- Link each posted movement to its operation and enforce a unique child sequence or
  semantic movement key.
- Define one canonical mutation transaction that:
  1. validates the command contract;
  2. locks owner allocations, level rows, and lot rows in deterministic order;
  3. calculates guarded integer deltas;
  4. updates current projections;
  5. appends movement and cost events;
  6. validates level-to-lot and quantity conservation postconditions;
  7. commits once.
- Replace read-then-write quantity checks with guarded updates and verified affected
  row counts.
- Replace updates to posted movement rows (including any current void marker) with an
  append-only void/compensation event before installing journal immutability.
- Derive actor identity from authenticated/system execution context. Do not trust an
  actor supplied by an HTTP request body.
- Add a temporary database guard that rejects a newly negative or more-negative lot
  while allowing an already-negative historical lot to move toward zero. Replace it
  with a strict non-negative constraint after remediation.
- Add and validate the missing non-negative checks on aggregate level buckets because
  the July 9 baseline found no existing aggregate negatives.

Movement semantics to pin in tests:

- Receive posts the exact purchased SKU/UOM. It does not implicitly break a case.
- Pick moves exact source stock into picked state and consumes the matching owner
  reservation.
- Unpick is the exact inverse of the referenced pick movement.
- Ship consumes picked state once and links the physical shipment item.
- Transfer is a balanced two-sided movement under one operation and preserves lot
  identity, cost, and original receipt timestamp.
- Adjustment requires an actor and reason. System corrections require a named system
  actor and remediation run ID.
- Case break/assembly is a balanced conversion operation. Source base units must equal
  target plus explicit remainder base units; cost lineage must balance.

Exit:

- New operations cannot create level/lot drift or an unbalanced conversion under
  unit, replay, integration, and concurrent tests.

### A4. Harden Every Operational Verb

**Purpose:** close workflow-specific gaps after the common transaction contract exists.

#### Receiving

- Idempotency is keyed to the external receipt event and receiving line, not merely
  receipt/variant/location.
- Partial receipts are separate events and cannot suppress a later valid receipt.
- Inventory posting and receiving-line/header rollup commit together or through a
  durable outbox with a proven retry state.
- Landed-cost finalization changes cost attribution through an immutable cost event;
  it does not bypass inventory ownership.

#### Replenishment And Conversion

- Rule evaluation remains advisory; execution posts one identified transfer or
  conversion operation.
- Automatic case-break replenishment and manual replenishment use the same mutation
  command and conservation checks.
- `inline` execution cannot remain indefinitely blocked without an exception owner,
  retry/dead-letter status, and operator action.
- No picker-facing flow silently fabricates source inventory. A short source becomes
  an andon/exception while the physical pick can follow an explicitly authorized
  variance policy.

#### Cycle Count

- Freeze ownership blocks every non-count mutation at a counted location.
- Count completion and item resolution are one guarded transaction.
- A count cannot become completed while an item remains pending.
- Count variance creates an identified adjustment operation; it never directly sets
  counters without movement evidence.

#### Returns, Refunds, And Cancellations

- Refunds are financial only.
- Return authorization, physical receipt, inspection, disposition, and restock/scrap
  are distinct idempotent events.
- Only restock disposition adds sellable inventory.
- Cancellation before pick releases owner reservations.
- Cancellation after pick requires explicit unpick or exception handling.
- Cancellation after ship requires return processing; it never reverses shipment stock.

#### Picking, Packing, And Shipping

- Pick and unpick reference exact prior movements and actor/session identity.
- Packing cannot exceed picked quantity.
- Shipping cannot exceed packed/picked entitlement and is idempotent per physical
  shipment item.
- Split packages and repeated provider webhooks replay the same physical shipment
  operation rather than posting inventory twice.

Exit:

- Each verb has a state-transition matrix, command schema, replay test, concurrency
  test, failure-injection test, and compensating-operation test.

### A5. Enforce The Contracts In PostgreSQL

**Purpose:** make invalid state impossible even if application validation regresses.

Apply constraints through expand/validate/contract migrations:

- unique level per variant/location;
- unique reservation owner/location projection;
- non-negative open allocation and all aggregate/lot quantity buckets;
- allocation conservation checks;
- operation idempotency and unique operation-child keys;
- foreign keys from movement events to operation, owner, location, lot, order item,
  receipt line, return line, and shipment item where applicable;
- immutable posted movement trigger;
- prohibition on hard deletion of posted operations/events;
- application role permissions that prevent direct DML outside approved stored or
  application boundaries where deploy topology allows it.

Stage A installs and validates constraints whose existing rows already pass, including
the aggregate level buckets. Constraints blocked by preserved baseline discrepancies
are installed in containment form and tracked explicitly. Their full validation is a
Gate C requirement after repair, not a reason to edit data prematurely.

Migration rules:

- Every migration has an explicit preflight query.
- `NOT VALID` may be used to block new bad rows while retaining historical evidence,
  but the phase is not complete until validation succeeds.
- A constraint is not deployed until the canonical writer handles its error as a
  classified domain result rather than a raw 500.

Exit:

- Invalid-state integration tests fail at both application and database boundaries.

### A6. Stabilization Soak

During the soak:

- Run the integrity audit at least every 15 minutes for current-material checks and a
  full historical audit daily.
- Report new exception fingerprints, not only aggregate counts.
- Reconcile owner allocations to aggregate reservations and movements to level/lot
  projections after every deployment.
- Block Stage B if any new blocker appears. Classify and fix the writer first, reset
  the soak watermark, and restart the gate period.

Stage B begins only when Gate B passes.

## Stage B: Repair Current Operational Discrepancies

### B0. Repair Tooling Contract

Every repair tool must:

- default to dry-run;
- require an explicit `--execute` and bounded scope;
- create a remediation run with actor, reason, code version, input fingerprint, and
  approval reference;
- lock candidates and revalidate preconditions before posting;
- call canonical inventory commands, never issue direct counter DML;
- use stable per-candidate idempotency keys so restart is safe;
- write before/after evidence and resulting operation IDs;
- checkpoint progress and resume without repeating committed work;
- refuse ambiguous rows and route them to manual review;
- correct mistakes through compensating operations, not destructive rollback.

### B1. Terminal Reservation Repair

Scope: the 55 shipped orders and any new pre-watermark terminal leaks.

Classification:

1. Exact owner allocation and location can be reconstructed.
2. Owner is known but location is ambiguous.
3. The order was picked/consumed but reservation release was not posted.
4. No sufficient evidence exists.

Actions:

- Post terminal-release compensation only for proven open owner quantity.
- Never decrement a shared reserved counter without owner evidence.
- Ambiguous rows become exceptions until a physical/operational decision resolves
  them.
- Rebuild aggregate reservation projections and require zero terminal owner balances.

### B2. Level/Lot And Negative-Lot Repair

Scope: 141 drift cells and 15 negative lots from the baseline, plus any resolved
pre-watermark findings.

Evidence hierarchy:

1. Canonical posted movements after the stabilization watermark.
2. Latest trustworthy closed cycle count plus subsequent canonical replay.
3. Proven receipts, transfers, picks, shipments, returns, and conversions.
4. A new physical count when records do not establish physical truth.

Rules:

- Do not assume `inventory_levels` or `inventory_lots` is correct merely because it
  is a current table.
- Do not zero negative lots without identifying where the units and cost belong.
- Quantity compensation and cost-layer reattribution are separate evidence-backed
  decisions under one remediation run.
- If physical quantity is ambiguous, freeze the affected cell and require a count.
- After each batch, replay movements and require exact level/lot parity before moving
  to the next batch.

### B3. Conversion Lineage Repair

Scope: 1,166 pre-operation-identity case-break/assembly rows.

- Group only rows that can be proved to be one conversion by transaction context,
  actor, timestamp, variants, locations, quantities, and cost.
- Attach a historical operation identity without changing quantity only when the
  grouping is exact.
- Post compensation for conservation/cost differences only when evidence proves the
  correct result.
- Preserve unprovable rows as historical conversion exceptions.

### B4. Workflow Cleanup

- Reopen or correctly finish the two completed counts with pending items through the
  cycle-count state machine.
- Resolve the blocked inline replenishment through retry, cancellation, or an explicit
  exception disposition.
- Attribute actorless adjustments only if identity can be proved; otherwise assign a
  named legacy-unknown actor and preserve that limitation.
- Correct hierarchy/base-unit conflicts through catalog-governed, audited changes,
  then rerun conversion and ATP checks.

## Stage C: Classify Historical Gaps

Historical rows are not automatically current inventory work.

- The 300 February ledger arithmetic mismatches, 24,717 pre-cutover unsigned
  reservation rows, 357 completed-order pick/ledger gaps, 859 completed-order
  pick/COGS gaps, 25 historical receipt/ledger gaps, and one receiving-header mismatch
  require evidence-based classification.
- If source documents prove a missing movement, post a dated remediation event linked
  to the original business event and current remediation run.
- If the correct state cannot be proved, record an immutable historical exception.
  Do not fabricate a balancing transaction merely to make an audit count zero.
- Historical exceptions must be excluded from active operational work queues while
  remaining visible in financial/inventory audit reporting.

## Stage D: Complete Lot Identity And Location Separation

The current schema stores quantity/location concerns on lot rows. The existing roadmap
already identifies the enterprise target: lot identity and cost remain on
`inventory_lots`, while a dedicated `lot_location_quantities` projection stores
quantity by lot and location.

This storage migration follows current-model stabilization and discrepancy repair. It
must not be mixed into either task because doing so would make it impossible to tell
whether a variance came from the old writer, the repair, or the storage cutover.

Rollout:

1. Add lot lineage (`origin_lot_id` or equivalent) and lot-location quantity tables.
2. Backfill only from the repaired, reconciled source state.
3. Shadow-write the new projection while current storage remains authoritative.
4. Prove lot-location sums equal level projections for every bucket.
5. Cut reads and writes to the new model under one deployment gate.
6. Remove location quantity from lot identity only after a successful soak.

Exit:

- Lot identity/cost is immutable per layer.
- Transfers move lot quantity without rewriting lot receipt identity or cost.
- Conversions create explicit source/target lineage.
- `inventory_levels` equals the sum of lot-location quantities for every supported
  bucket.

## Pull Request Sequence

Each PR must be deployable, reversible at its declared boundary, and independently
tested.

1. **Measurement foundation:** read-only audit CLI, tests, runbook, baseline,
   finding fingerprints, and the inert lifecycle registry. No scheduler is enabled.
2. **Measurement activation:** production dry-run/execute/dry-run verification,
   scheduled auditor, stabilization watermark, and alerts.
3. **Writer control:** exact inventory writer inventory, dynamic/raw SQL detection,
   owner API scaffold, and first ratchet shrink.
4. **Reservation schema:** allocations/events and shadow projection only.
5. **Reservation cutover:** owner-aware reserve/pick/unpick/release and unified
   terminalization.
6. **Operation identity:** operation header, child movement identity, immutable event
   contract, and current-model atomic mutation primitive.
7. **Writer migration:** move catalog, channels, procurement, diagnostics, jobs, and
   scripts behind inventory commands; shrink ratchet with each move.
8. **Verb hardening:** receiving, transfer, conversion/replenishment, cycle count,
   returns, cancellation, packing, and shipping.
9. **Database enforcement:** checks, uniqueness, foreign keys, immutability, role
   restrictions, and validation.
10. **Soak report:** signed Gate B evidence and repair authorization.
11. **Reservation repair:** bounded dry-run and execute tooling.
12. **Lot/level repair:** evidence classification, count queue, compensation tooling.
13. **Conversion/workflow repair:** operation grouping and small current violations.
14. **Historical classification:** remediation events or immutable exceptions.
15. **Final enforcement:** validate deferred constraints, projection rebuild, Gate C
   report.
16. **Lot identity migration:** expand, backfill, shadow-compare, cut over, and contract
   to the lot-location quantity model.

## Deployment And Rollback Discipline

- Use expand/dual-write/compare/cutover/contract migrations. Never combine schema
  creation, behavior cutover, old-path deletion, and data repair in one deployment.
- Dual-write means one authoritative production mutation plus one shadow projection.
  It must never post inventory twice.
- Feature flags may select old versus new command routing before cutover. Once a
  canonical operation commits, rollback is a compensating operation, not deletion.
- Every worker/reconciler uses advisory ownership or `FOR UPDATE SKIP LOCKED`, bounded
  batches, retry classification, and terminal dead-letter state.
- A deployment that creates a new blocker fingerprint automatically fails its phase
  gate and is rolled back or disabled before remediation resumes.

## Required Evidence Per Phase

Every phase closes with:

- exact changed writer list;
- schema and migration preflight output;
- unit, integration, replay, concurrency, and failure-injection results;
- production canary identifiers and resulting operation IDs;
- before/after integrity audit;
- new-exception count since the phase watermark;
- rollback or compensation procedure;
- known unknowns and deferred rows.

## Known Unknowns To Resolve During Design

The baseline does not prove the answers to these questions. They must be resolved from
code, production schema, and business policy before their corresponding cutover:

- Whether allocation splits across multiple locations must remain one row per
  location or require a separate allocation header/child model.
- Which current table is authoritative for packed quantity and whether packing is
  location-owned or shipment-item-owned.
- Which historical cycle counts are trustworthy enough to establish physical truth
  for a drifted cell.
- Whether every current return disposition maps cleanly to restock, quarantine,
  refurbish, or scrap.
- Which reconciliation jobs still write inventory indirectly through dynamic helper
  functions not detected by the current scanner.

These are design inputs, not permission to guess. A cutover PR must cite the evidence
that resolves each relevant item.

## Final Exit Criteria

The inventory subsystem is remediation-complete only when:

- new discrepancies remain at zero through Gate C;
- every inventory state table has one owner and no unresolved writer;
- terminal orders have zero open owner reservations;
- all quantity buckets are non-negative and database-enforced;
- level, lot-location, owner allocation, and order-line projections replay exactly;
- every conversion conserves base units and cost;
- every receipt, transfer, pick, unpick, pack, ship, return, cancellation, refund
  interaction, replenishment, and count is idempotent under duplicate/concurrent input;
- every posted event is immutable, attributed, operation-addressable, and linked to
  the business object that authorized it;
- unresolved historical facts are explicit exceptions, not hidden counter edits.
