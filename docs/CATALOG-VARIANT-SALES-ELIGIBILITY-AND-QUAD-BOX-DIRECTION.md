# Catalog Variant Sales Eligibility And Quad Box Direction

## Status And Scope

This record captures the approved catalog rule for variants that represent real
inventory or transformation supply but are not products a customer can buy.
The implementation is additive and does not change production catalog rows,
inventory, transformations, reservations, ATP authority, or channel quantities.

## Approved Domain Contract

`catalog.product_variants.sales_eligibility` has two values:

- `sellable`: the variant may be a customer promise target and may participate in
  channel configuration, listing, allocation, publication, and order reservation.
- `internal_only`: the variant remains a valid physical inventory and
  transformation identity, but can never be a customer promise target.

Sales eligibility is independent from:

- `is_active`, which controls catalog lifecycle;
- `requires_shipping` and `track_inventory`, which describe fulfillment and
  inventory management;
- transformation direction, which is owned by reviewed transformation paths and
  recipes;
- ATP quantity, which is computed from physical supply, claims, policy, and the
  active transformation model.

Missing legacy values are interpreted as `sellable`, and the additive database
column defaults to `sellable`. Therefore deployment alone does not reclassify a
variant or change current publication.

## Boundary Contract

| Boundary | `sellable` | `internal_only` |
| --- | --- | --- |
| Physical inventory and ledger | Included | Included |
| Transformation input or output | Allowed when an explicit path or recipe permits it | Allowed when an explicit path or recipe permits it |
| Canonical ATP planning supply | Included | Included |
| Customer-facing ATP target | Allowed | Excluded |
| Reservation or build promise for an order line | Allowed | Rejected |
| Channel feed, override, reservation, or allocation rule | Allowed | Rejected |
| Shopify/eBay/dropship registration or listing | Allowed | Excluded or rejected |
| Inventory publication/outbox target | Allowed | Rejected |
| Dropship order acceptance and quote processing | Allowed | Rejected |

A channel override can restrict a `sellable` variant. It cannot promote an
`internal_only` variant into a customer target.

## Transition And Concurrency Contract

Changing a variant from `sellable` to `internal_only` is a guarded catalog
transition, not an ordinary blind field update.

The application and database use the same variant-scoped PostgreSQL advisory lock.
While holding that lock, the transition rejects variants that still have Shopify
identity, dropship enablement, channel feeds/listings/allocation configuration,
dropship listings or overrides, active channel-availability demand, active marketplace
publication, pending inventory publication, or an open customer order line. Database
constraints and triggers enforce the same boundary for non-HTTP writers and concurrent
writes. Reopening a terminal OMS order also revalidates every linked variant while
holding the parent order and variant locks.

This ordering prevents both races:

1. A customer-facing writer cannot expose the variant after the transition check
   but before the catalog update.
2. A reservation cannot promise the variant after it has become internal-only.

## Quad Box Decision

The approved package relationship is directional:

```text
25 internal EA -> 1 sellable Quad Box
```

There is no reverse path:

```text
1 Quad Box -/-> 25 EA
```

The reason is a product fact: EA is not sold for this product. Exact physical Quad
Box inventory may satisfy Quad Box demand, but it does not create EA supply.
Internal EA inventory and explicitly buildable EA capacity may supply the forward
Quad Box conversion.

For a single planning snapshot, the intended expression is:

```text
QuadBoxATP = exactAvailableQuadBoxes
           + floor((availableInternalEA + explicitlyBuildableInternalEA) / 25)
```

The planner must deplete shared EA/component capacity once when producing a claim;
the formula is an explanation of one target, not permission to sum competing ATP
views.

## Planner And Backfill Contract

New planner snapshots record `salesEligibility` for every physical variant. Existing
sealed v1 evidence without the field remains parseable and retains the historical
sellable default. Internal-only variants remain in the snapshot and transformation
graph as supply, but projection, shadow, claim, and persistence boundaries reject them
as targets.

The deterministic Phase 3 algorithm is versioned as
`inventory_availability_backfill_v3`. Its input hash includes sales eligibility. A
managed product with no sellable variant is classified
`excluded_internal_supply_only`, not unmanaged. When migrating a legacy fungible pool,
v3 may infer an adjacent path into a sellable destination for review, but never infers
a path whose destination is internal-only. Thus an internal EA / sellable Quad pair
produces only the review candidate `25 EA -> 1 Quad Box`.

Marketplace registration performs the same eligibility recheck in the generic
transaction used by all adapters. Shopify import and mapping repair report an explicit
conflict instead of adopting an internal-only SKU. The obsolete, unreferenced dropship
repository that hand-calculated pick-bin inventory was removed so it cannot become a
future ATP bypass.

## Safe Operational Sequence

1. Deploy the additive column, application guards, and database invariants with all
   existing rows defaulting to `sellable`.
2. Requery the intended Quad Box variants and all dependency blockers from the
   deployed database. Do not rely on an old variant ID or old dependency snapshot.
3. Remove or retire verified customer-facing dependencies for the EA identity.
4. Mark that EA identity `internal_only` through the guarded catalog control.
5. Create or refresh the v3 candidate and review only the directed
   `25 EA -> 1 Quad Box` transformation path.
6. Run planner shadow evidence and channel publication preview. Confirm that EA is
   present as supply evidence, absent as a channel target, and Quad Box ATP consumes
   EA at exactly 25:1.
7. Activate only through the inventory-availability activation process after its
   existing full-catalog gates pass.

Steps 2 through 7 are operational work and are intentionally not performed by this
implementation slice.

## Failure Modes And Response

- A transition with live dependencies returns a conflict and leaves the variant
  unchanged. Remove the listed dependency, then retry.
- A non-HTTP writer attempts to expose an internal-only variant. The database rejects
  the transaction; the caller must log and surface the constraint failure.
- A stale queue item reaches a publisher or dropship order path. The boundary rechecks
  sales eligibility and skips or rejects it without external publication.
- A terminal order containing historical internal-only linkage is reopened. The OMS
  status update is rejected before the order becomes an active customer promise.
- Shopify import observes an internal-only SKU. The entire affected Shopify product
  group is skipped before product or variant mappings are written, and a structured
  conflict is returned.
- No valid forward transformation exists. Exact Quad Box inventory remains usable,
  but internal EA contributes zero Quad Box capacity until a valid path is reviewed.
- A reverse path is accidentally proposed. Review must reject it; no direction is
  inferred from UOM quantities or sibling variants.

## Verification Required Before Production Reclassification

- Current catalog IDs/SKUs and existing customer exposure.
- Open customer orders for the EA SKU.
- Current physical quantities by warehouse for EA and Quad Box.
- Exact active recipe/path versions and component constraints.
- Shadow ATP evidence showing 25:1 forward consumption and no EA publication target.
- Provider readback showing no customer-facing EA listing or quantity.
