# Inventory Availability Phase 5Q: Runtime Publication Routing

## Outcome

Every inventory quantity write that reaches the Echelon sync orchestrator now
passes through one persisted-authority boundary. The same boundary also routes
the existing eBay variant-availability repair worker.

While `inventory.availability_runtime_authority` remains `legacy`, the current
allocation engine and provider adapters continue to run. The authority row is
held with a shared lock until the legacy call completes, so a cutover cannot
race an in-flight direct provider write.

After a separately authorized cutover to `canonical`, the same call sites no
longer invoke the allocation engine or provider adapters. They instead:

1. validate the active activation lineage;
2. capture the current canonical ATP snapshot;
3. load only live Echelon publication targets and their active sealed source,
   policy, and exact provider-mapping definitions;
4. calculate an absolute target quantity with the canonical ATP and channel
   exposure rules through the shared runtime channel-exposure planner; and
5. enqueue that desired state for the existing publication worker inside the
same serializable transaction.

The publication boundary reuses the side-effect-free planner introduced by
Phase 5Q rather than maintaining a second ATP or exposure calculation path.

The production composition root and all four inventory-sync scripts require
this router. The single-channel live script also scopes canonical planning to
its selected channel.

## Durable desired-state rules

Publication rows are serialized by exact target and variant. An identical
non-terminal desired state is coalesced. A changed desired state supersedes any
mutable older full-publication row and receives the next monotonic revision. A
terminal `dead_letter`, `cancelled`, or `superseded` row never prevents a new
revision from being queued.

Inactive variant repair can enqueue an exact zero from its active target
mapping without requiring the inactive variant to remain in the active ATP
snapshot. Canonical handoff completes the legacy trigger queue without writing
legacy feed or listing acknowledgement fields; provider acknowledgement and
readback remain owned by `inventory.inventory_publication_outbox`.

## Deployment safety

This slice does not update, insert, or delete the runtime-authority singleton.
Deployment therefore remains on legacy publication behavior. Canonical rows
are accepted only for an activation run whose persisted state is already
`active`.

## Remaining activation blockers

Canonical authority remains prohibited. Runtime publication still needs:

- trigger coverage for canonical live mappings on providers beyond the legacy
  eBay availability queue;
- removal of legacy feed and sync-setting preconditions that can suppress an
  event before it reaches the routed orchestrator;
- disposable-PostgreSQL proof of the new target-loading and full-row enqueue
  queries;
- concurrency and crash-recovery verification with the worker;
- production provider readback and external endpoint consumer verification;
  and
- the separately reviewed and explicitly authorized production activation
  operation.
