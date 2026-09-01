# Inventory Channel Exposure Draft And Preview

## Scope

These readiness slices add the inactive channel-policy, fulfillment-source,
exact publication-target, and target/SKU mapping configuration needed before
canonical ATP can replace legacy channel allocation. They do not activate ATP
authority, change inventory or reservations, enqueue publication, or call a
provider.

The live allocator remains
`server/modules/channels/allocation-engine.service.ts`. The new workspace is a
draft and preview surface only.

## Contracts Added

### Channel exposure policy

Policy is versioned at three scopes:

1. channel default;
2. product override;
3. SKU override.

Each field resolves independently in SKU -> product -> channel order. Missing
required fields are blockers and calculate zero; there is no legacy-rule or
raw-ATP fallback.

All absolute values are sellable-SKU units. Share is integer basis points. A
maximum has an explicit `unlimited` mode so `null` can retain its single meaning:
inherit from the broader scope.

The equation is:

```text
if not eligible:
  published = 0
else:
  shared = floor(canonicalAtpUnits * shareBps / 10_000)
  afterHoldback = max(0, shared - holdbackSellableUnits)
  capped = min(afterHoldback, maxPublishSellableUnits or infinity)
  published = capped < minPublishSellableUnits ? 0 : capped
```

### Publication source binding

A publication target owns a separate versioned set of fulfillment
nodes. The new preview uses only those nodes. It never falls back to the legacy
single-node column and never expands a missing assignment to all active
warehouses.

The legacy `inventory.inventory_publication_targets.fulfillment_node_id` column
is retained for compatibility until controlled cutover. It is labelled as
legacy in the new UI and is not treated as proposed source authority.

### Exact destination and SKU mapping

An operator with `inventory_planning:edit` may register an exact provider
destination, but it is always created in `disabled` state. Each physical,
tracked, customer-sellable SKU then owns a versioned provider inventory-item
mapping under that exact target. Legacy feed identities are displayed only as
suggestions and are never accepted implicitly. A target-wide lock and deferred
database invariant prevent two local SKUs from selecting the same provider
inventory item in one destination.

The reversible `disabled <-> preview` readiness transition requires
`inventory_planning:activate`, an optimistic target revision, an idempotency
key, and an operator reason. The endpoint does not accept `live`.

## Persistence And Concurrency

Migrations `0632_inventory_channel_exposure_policy.sql` and
`0633_inventory_publication_readiness.sql` add:

- `inventory.channel_exposure_policy_versions`
- `inventory.channel_exposure_policy_heads`
- `inventory.publication_source_binding_versions`
- `inventory.publication_source_binding_members`
- `inventory.publication_source_binding_heads`
- `inventory.publication_variant_mapping_versions`
- `inventory.publication_variant_mapping_heads`
- optimistic revisions on exact publication targets; and
- provider inventory-item identity snapshots on readback evidence.

Draft commands use optimistic head revisions, deterministic advisory locks,
idempotency receipts, transactions, and audit events. Database guards keep
identity/request evidence immutable, restrict member edits to the current
draft, require complete channel defaults and nonempty source sets before
sealing, and defer head/lifecycle coherence checks until transaction commit.

## Admin Surface

`Channels -> Inventory Exposure` provides:

- exact channel connection and provider target selection;
- audited creation of disabled exact provider targets;
- explicit internal/network/3PL fulfillment-node selection;
- exact target/SKU provider identity drafts, with legacy values as suggestions;
- channel/product/SKU policy inheritance;
- exposure versus partitioned semantics;
- the complete share/holdback/cap/cutoff calculation;
- canonical ATP summed only from selected source-node warehouses;
- target-aware full-catalog readiness evidence and cross-target partition checks;
- configuration blockers and safe-zero results.

The page has no live activation or publication action. Its role-gated readiness
button only includes or removes a target from preview. It displays the retained
legacy runtime and the no-provider-write boundary explicitly.

## Still Required Before Cutover

- seal and activate policy/source versions only through the role-gated global
  activation state machine;
- implement live claim/reservation authority against canonical warehouse ATP;
- route Echelon-authoritative publications through the durable outbox worker and
  require provider readback whose captured inventory-item identity matches the
  selected target/SKU mapping;
- atomically switch runtime authority only after a complete reviewed readiness
  run succeeds; and
- retire legacy allocation/reserve writers and UI only after verified activation.
