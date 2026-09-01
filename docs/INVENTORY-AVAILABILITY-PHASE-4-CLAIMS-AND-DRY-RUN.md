# Inventory Availability Phase 4: Claims And Publication Dry Run

## Status

This phase is additive and inactive.

- Legacy ATP and reservation code remains the operational path.
- Claim simulations write evidence only. They do not reserve, release, build,
  adjust, pick, pack, or move inventory.
- Activation dry runs do not switch runtime authority, call a channel adapter,
  enqueue publication work, or change channel configuration.
- Publication targets default to `disabled`.
- Exact targets may be created only as disabled, and a role-gated command may
  move them only between `disabled` and `preview` for readiness evidence.
- No Phase 4 worker consumes the publication outbox.

## Whole-order claim simulation

`POST /api/inventory-planning/admin/claim-simulations` requires
`inventory_planning:edit`.

The request contains an idempotency key, an operator reason, and one canonical
claim request. All target variants are resolved to root products before supply
is captured. One `REPEATABLE READ READ ONLY` transaction captures the union of
the root products and their transformation/component graphs. Duplicate physical
resources are represented once.

The planner then processes every line against the same mutable in-memory supply
context. The result contains:

- per-line planned and short quantities;
- exact source inventory-level claim segments;
- required conversion/build operations;
- warehouse fulfillment groups;
- exact model/version/hash evidence; and
- the sealed snapshot fingerprint.

The result is persisted in `inventory.planner_claim_simulation_runs`. Database
constraints force `operational_write_attempted = false`, and the evidence is
append-only.

## Full-catalog activation dry run

`POST /api/inventory-planning/admin/activation-runs/dry-run` requires the
separate `inventory_planning:activate` ability. It also requires the exact input
and result hashes from the current migration queue. A stale catalog hash rejects
the command before product previews are run.

For every active product, the dry run records:

- migration/backfill approval state;
- selected draft and review evidence;
- sealed ATP shadow evidence;
- legacy channel calculations and exact target-aware proposed calculations;
- the proposed quantity, target revision, source-binding evidence, and exact
  provider inventory-item mapping for every target/SKU, plus the canonical ATP
  contribution of each selected source warehouse;
- the last quantity the legacy feed records as acknowledged; and
- provider readback evidence, including its captured provider inventory-item
  identity, when it exists.

`channel_feeds.last_synced_qty` is labelled as last-acknowledged write evidence.
It is not treated as provider readback. An active feed with no exact publication
target, no complete acknowledgement evidence, quarantine, or no provider
readback produces an explicit blocker.

The dry run also fails closed for missing target/SKU mappings, mapping or target
revision changes during capture, readbacks whose provider inventory-item
identity is missing or stale, account-scope overlap, and partitioned shares over
100 percent across overlapping warehouse source pools.

Every target/SKU evidence row is explicitly classified as `publish`,
`observe_only`, `skip_ineligible`, or `blocked`. Only an eligible row with
Echelon publication authority and complete source/mapping evidence can receive
`publish`; external-provider and manual authority are observation-only and can
never be mistaken for future outbox work.

The complete result and per-product hashes are stored in:

- `inventory.availability_activation_runs`;
- `inventory.availability_activation_product_evidence`; and
- `inventory.availability_activation_events`.

Phase 4 may create only terminal `dry_run` records in `blocked` or
`ready_for_publication`. Database constraints require all three side-effect
flags to remain false:

```text
runtime_authority_changed = false
provider_write_attempted = false
outbox_enqueued = false
```

## Activation state machine contract

The durable run states reserved for the controlled cutover are:

```text
validating
  -> blocked -> validating
  -> ready_for_publication
      -> publishing
          -> publication_verified
              -> activating
                  -> active
```

Any nonterminal activation step may enter `failed` only through a permitted
transition. Phase 4 exposes no activation command and cannot enter these live
states.

## Publication target and outbox contract

An exact publication target identifies:

- channel;
- channel connection;
- fulfillment node;
- provider scope type (`account` or `location`);
- provider scope identifier; and
- publication authority (`echelon`, `external_provider`, or `manual`).

Target state is `disabled`, `preview`, or `live`, and the database default is
`disabled`. The readiness writer can create only `disabled` targets and can
perform only audited, optimistic `disabled <-> preview` transitions. No exposed
request schema or route accepts `live`; that transition remains reserved for
the global cutover state machine.

Each exact target and sellable SKU has a versioned mapping head and immutable
version history for the provider inventory-item ID. Drafts are idempotent,
optimistically revisioned, advisory-locked, and auditable. The full-catalog dry
run records the selected mapping ID, version, and definition hash.

Each outbox row is an immutable absolute desired quantity for one exact target
and SKU. Its key includes a monotonically increasing revision. Zero is valid.
The database serializes revision insertion for each target/SKU with a transaction
advisory lock and rejects stale or duplicate revisions.

Delivery state is separate from desired state:

```text
desired -> queued -> leased -> acknowledged -> verified
                         |             -> drifted -> queued
                         -> retryable -> queued
                         -> dead_letter
```

Cancellation and supersession are explicit terminal outcomes. Delivery attempts
are append-only. Provider acknowledgement and provider quantity readback are
stored in different tables. A readback identifies the exact target and SKU and
may exist without an outbox row, which permits inventory observation for a 3PL
or other externally authoritative provider. Its provider inventory-item
identity is captured directly or inherited from its immutable outbox row. An
identity-less readback remains valid historical evidence but cannot satisfy
activation readiness. When a readback verifies an outbox write, the database
requires the target/SKU identity and match result to agree with that immutable
desired row.

## Lock order for the future live claim/cutover path

The implementation must preserve the reviewed global order:

1. Product/resource-graph advisory locks in ascending product ID.
2. Transformation, safety, channel-policy, and source-binding heads.
3. Order, order item, fulfillment group, and existing claim.
4. Inventory resources in warehouse/location/variant/lot order.
5. Claim/build allocations, activation audit, and outbox rows.
6. Commit before any provider call.

Phase 4 claim simulation is read-only and therefore does not acquire operational
claim locks. The live claim writer remains a later cutover step and must use this
order atomically before it can replace the legacy reservation path.

## Remaining activation blockers

Deployment of Phase 4 does not satisfy the production activation gate by itself.
The dry run is expected to identify unresolved work, including:

- products without current approved model evidence;
- stale or blocked ATP shadows;
- legacy channel warehouse fallback;
- active legacy feeds not mapped to exact publication targets;
- missing exact target/SKU mapping;
- missing or mapping-stale provider readback;
- overlapping account scopes or partitioned shares above source capacity; and
- proposed quantities that exceed canonical ATP.

The next operational review runs synthetic and recent-order simulations plus the
full-catalog dry run. No authority switch is permitted until its blocking results
are resolved and reviewed.
