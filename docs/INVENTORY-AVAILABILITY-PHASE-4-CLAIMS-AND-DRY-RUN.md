# Inventory Availability Phase 4: Claims And Publication Dry Run

## Status

This phase is additive and inactive.

- Legacy ATP and reservation code remains the operational path.
- Claim simulations write evidence only. They do not reserve, release, build,
  adjust, pick, pack, or move inventory.
- Activation dry runs do not switch runtime authority, call a channel adapter,
  enqueue publication work, or change channel configuration.
- Publication targets default to `disabled`.
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
- legacy and proposed channel allocation calculations;
- the proposed quantity for every channel/SKU and warehouse breakdown;
- the last quantity the legacy feed records as acknowledged; and
- provider readback evidence, when it exists.

`channel_feeds.last_synced_qty` is labelled as last-acknowledged write evidence.
It is not treated as provider readback. An active feed with no exact publication
target, no complete acknowledgement evidence, quarantine, or no provider
readback produces an explicit blocker.

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
`disabled`. Phase 4 exposes no target writer. A future writer must require the
authorized transition and persist its audit evidence before selecting `preview`
or `live`.

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
or other externally authoritative provider. When a readback verifies an outbox
write, the database requires the target/SKU identity and match result to agree
with that immutable desired row.

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
- missing provider readback; and
- proposed quantities that exceed canonical ATP.

The next operational review runs synthetic and recent-order simulations plus the
full-catalog dry run. No authority switch is permitted until its blocking results
are resolved and reviewed.
