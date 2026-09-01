# Inventory Channel Exposure Draft And Preview

## Scope

This slice adds the inactive channel-policy and fulfillment-source configuration
needed before canonical ATP can replace legacy channel allocation. It does not
activate ATP authority, change inventory or reservations, enqueue publication,
or call a provider.

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

## Persistence And Concurrency

Migration `0632_inventory_channel_exposure_policy.sql` adds:

- `inventory.channel_exposure_policy_versions`
- `inventory.channel_exposure_policy_heads`
- `inventory.publication_source_binding_versions`
- `inventory.publication_source_binding_members`
- `inventory.publication_source_binding_heads`

Draft commands use optimistic head revisions, deterministic advisory locks,
idempotency receipts, transactions, and audit events. Database guards keep
identity/request evidence immutable, restrict member edits to the current
draft, require complete channel defaults and nonempty source sets before
sealing, and defer head/lifecycle coherence checks until transaction commit.

## Admin Surface

`Channels -> Inventory Exposure` provides:

- exact channel connection and provider target selection;
- explicit internal/network/3PL fulfillment-node selection;
- channel/product/SKU policy inheritance;
- exposure versus partitioned semantics;
- the complete share/holdback/cap/cutoff calculation;
- canonical ATP summed only from selected source-node warehouses;
- configuration blockers and safe-zero results.

The page has no activation or publication action. It displays the retained
legacy runtime and the no-provider-write boundary explicitly.

## Still Required Before Cutover

- connect the full-catalog activation dry run to exact publication-target rows;
- validate partitioned share totals across every overlapping target/source pool;
- add exact target-plus-SKU external inventory mappings, replacing channel-plus-SKU
  feed identity;
- seal and activate policy/source versions only through the role-gated global
  activation state machine;
- route all inventory publications through the durable outbox and verified
  provider readback;
- retire legacy allocation/reserve writers and UI only after verified activation.
