# Shopify duplicate ownership repair

Status: implementation and validation only. Deployment is inert. No ownership
repair, catalog sync, inventory change, quantity publication, or configuration
change is performed by the migration or application startup.

## Confirmed pre-implementation evidence

The read-only production review on 2026-09-12 found 60 duplicated Shopify
product identities: 57 had one active owner with matching catalog/channel
evidence and 3 required manual review. This is a point-in-time observation, not
an apply manifest. The server always re-reads Shopify and local evidence before
an operator can apply a repair.

## Apply contract

`GET /api/channels/:channelId/shopify-mapping-reconciliation/ownership-review`
remains read-only. Each group includes a SHA-256 preview hash bound to:

- channel and normalized `myshopify.com` domain;
- remote existence, status, and shipping-group evidence;
- every local owner, mapping fingerprint, activity state, and channel evidence;
- the recommended owner and exact noncanonical owner set.

`POST /api/channels/:channelId/shopify-mapping-reconciliation/ownership-review/apply`
requires `inventory:edit`, an authenticated actor, an audit reason, a UUID
idempotency key, the reviewed store domain, and one to 100 product/hash pairs.

Automatic repair is allowed only when the fresh locked evidence still proves:

1. the remote Shopify product exists;
2. no more than 100 local products claim it (the explicit bounded request limit);
3. both local products use the same shipping group;
4. neither owner has conflicting mapping evidence;
5. exactly one owner has active sellable variants;
6. that active owner's catalog ID and channel evidence both match Shopify; and
7. every noncanonical owner still has no active sellable variant.

Any changed hash, ambiguous owner, changed store, active noncanonical variant,
or malformed receipt rejects the whole batch. There is no force option.

## Transaction and writes

The command acquires its idempotency lock, then Shopify product mapping locks in
numeric product-ID order, followed by brief mapping-table write fences. It
rebuilds the review inside the transaction before writing.

For only the proven inactive noncanonical owners, it:

- clears catalog Shopify product, variant, and inventory-item identities;
- clears all three Shopify feed identities, disables the retained feed, and
  clears stale publication/quarantine state;
- clears listing product/variant identity and URL and marks the retained
  listing as an explicit detached-mapping error;
- retains products, variants, SKUs, listing/feed rows, and operational history;
- records one immutable command receipt plus an audit event per repaired group.

The canonical owner is not rewritten. Inventory levels, ATP, reservations,
recipes, builds, orders, warehouses, channel allocation, and remote Shopify
quantities are not readjusted or published by this command.

## Product-family consolidation contract

Duplicate ownership repair only detaches proven inactive aliases. When two
active local products split the variants for one Shopify product, use the
separate product-family consolidation review:

- `POST /api/channels/:channelId/shopify-mapping-reconciliation/ownership-review/consolidation/preview`
  is read-only and requires `inventory:view`;
- `POST /api/channels/:channelId/shopify-mapping-reconciliation/ownership-review/consolidation/apply`
  requires `inventory:edit`, the exact preview hash and store, a UUID
  idempotency key, and an audit reason.

The preview chooses one existing variant ID for each exact UOM/package size.
Apply may reparent that retained ID to the selected canonical product and may
archive only a zero-quantity duplicate. It never transfers, combines, or
recalculates inventory. The transaction snapshots every affected inventory
level before and after and rolls back unless every quantity column and row
identity is byte-for-byte equivalent.

Apply is blocked when evidence includes any of the following:

- active transformation models or an inventory cutover freeze;
- incompatible product or variant fulfillment/inventory semantics;
- quantity, reservation, pick, pack, backorder, availability claim, open
  order/shipment/build/publication work, or active channel feed on a variant
  that would be retired;
- immutable product/variant history, recipes, or procurement mappings whose
  product identity would become inconsistent after a reparent;
- product- or variant-scoped channel, dropship, eBay, shipping, replenishment,
  marketplace, warehouse-slot, or procurement configuration that would be
  stranded;
- any local Shopify variant identity that Shopify reports as belonging to a
  different live product. This command never detaches such an identity and
  never performs a remote Shopify mutation.

Draft transformation models are not silently carried forward. Apply
supersedes each current draft and creates an empty, invalid replacement draft
that must be rebuilt and reviewed against the canonical family before
activation. The immutable command receipt records the locked evidence, exact
plan, result, actor, reason, request hash, preview hash, and completion time.
Variant-scoped assets and warehouse slots follow a retained variant when its
product ID changes. A slot on a variant that would be retired is a blocker and
must be resolved through slotting first. Product-level assets stay on the
archived source product; the command does not guess which images should become
canonical.

Before any production apply, run the PostgreSQL contract test against a
disposable database with both `ECHELON_TEST_DATABASE_URL` and
`ECHELON_TEST_DATABASE_DISPOSABLE=true`. A skipped database test is not apply
readiness. Then run preview again against the intended store and resolve every
blocker through its owning workflow; there is no force option.

The migration permits `channel_variant_id = NULL` only so an inactive retained
feed can relinquish a wrong remote identity. A new `NOT VALID` check immediately
rejects any new active feed without a nonblank variant ID without making deploy
depend on unreviewed legacy rows. Validation of the historical rows is a later,
explicit evidence gate.

## Operator sequence after deployment

1. Open Shopify channel mapping health and select **Ownership review**.
2. Inspect the clear/manual counts and representative owner rows.
3. With `inventory:edit`, choose **Resolve clear recommendations**. This loads
   one fresh bounded batch; it does not reuse the visible paginated table.
4. Review the exact group and detached-product counts, enter an audit reason,
   and explicitly apply.
5. If the result is uncertain, use **Retry same repair**. The client retains the
   exact body and idempotency key; the server returns the stored result without
   repeating writes.
6. Re-run mapping health. Confirm duplicate ownership falls by the returned
   resolved count and inspect every remaining manual group separately.
7. Only after ownership conflicts are gone should the existing canonical
   mapping repair/sync converge incomplete mappings. That is a separate action.

## Recovery boundary

Code rollback does not reverse a completed ownership repair. Command receipts
and audit records are append-only. A recovery must compare current evidence to
the command/audit snapshot and must not overwrite intervening catalog or
channel edits. There is intentionally no automatic reattach operation.
