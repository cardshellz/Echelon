# Inventory Availability Phase 5R: Exact Publication Destination Owners

## Outcome

This inactive slice separates the publication target's allocation-policy channel
from the exact connection that will eventually transport an absolute inventory
quantity. A target may now be owned by exactly one Channels connection or one
Dropship store connection. Existing targets remain Channels-owned through the
column default; the migration executes no `UPDATE` backfill.

The runtime planner uses the same canonical warehouse-aware ATP projection and
channel exposure policy for both destination kinds. The target's `channel_id`
continues to select the channel, product, and SKU allocation dials. The new
`destination_kind` and matching connection identifier select the exact transport
account. This permits an eBay-backed dropship storefront to use an explicit eBay
allocation dial without pretending that its Dropship store connection is a
Channels connection.

This slice does not create or activate a publication target, change runtime ATP
authority, enqueue a publication, call a provider, or change any provider or
inventory quantity.

## Data and domain contract

`inventory.inventory_publication_targets` now requires exactly one owner:

- `destination_kind = 'channel_connection'` requires
  `channel_connection_id` and forbids `dropship_store_connection_id`.
- `destination_kind = 'dropship_store_connection'` requires
  `dropship_store_connection_id` and forbids `channel_connection_id`.

Separate partial unique indexes protect the identity of each destination kind.
The target update guard makes both owner fields immutable. Readback evidence now
has matching destination snapshot fields so a future provider observation can be
bound to the exact transport account rather than only to the allocation channel.
Legacy readbacks with a channel snapshot but no destination-kind snapshot remain
valid; all newly recorded readbacks include the explicit owner kind.

Existing rows receive the non-destructive `channel_connection` default. The
migration contains no data inserts, target activation, authority change, outbox
enqueue, or quantity mutation.

## Application and UI contract

The inventory exposure admin view lists both Channels connections and Dropship
store connections. Creating a disabled target requires:

1. an exact destination owner;
2. an allocation dial channel;
3. the existing compatibility fulfillment node and future source binding;
4. provider scope and external scope identity; and
5. Echelon, external-provider, or manual publication authority.

The allocation dial is intentionally independent of transport ownership. It is
never inferred from the provider name or store platform. This makes policy
sharing explicit and prevents a new transport account from silently inheriting
an unintended channel policy.

## Runtime and activation safety

`InventoryChannelExposureRuntimeService.planProduct` calculates Dropship targets
through the same canonical ATP and exposure-policy pipeline used for Channels
targets. Draft definitions remain excluded and the calculation itself has no
provider side effect.

The deployed publication outbox is still Channels-specific. Therefore:

- direct readback of a Dropship-owned target fails with
  `PUBLICATION_READBACK_DESTINATION_UNSUPPORTED`;
- canonical activation rejects any Dropship-owned Echelon publication intent with
  `ACTIVATION_DROPSHIP_PUBLICATION_UNSUPPORTED`; and
- the existing Channels publisher behavior is unchanged.

These are deliberate fail-closed boundaries. A represented Dropship destination
must not be mistaken for a fully wired provider destination.

## Remaining next slice

The next slice must generalize the durable outbox identity and adapter registry,
then install exact provider implementations for each supported transport owner.
It must prove registration, listing identity, absolute-quantity publication,
readback, retries, stale-revision suppression, and legacy-writer exclusion before
canonical activation can admit that destination.

Shopify, direct eBay, eBay-backed Dropship, and any future direct TikTok adapter
must all consume the same exact-target runtime result. Provider-specific code may
translate credentials and API payloads, but it may not calculate ATP or allocation
independently.

## Verification

- Zod contracts prove exact-one destination ownership and backward-compatible
  normalization of existing Channels target requests.
- Migration contract coverage proves the foreign key, XOR constraint, partial
  unique identities, immutable owner fields, readback snapshots, and absence of
  seeded runtime state.
- Runtime service and repository coverage prove a Dropship target uses the same
  canonical ATP and exposure-policy calculation.
- Readback coverage proves Dropship remains explicitly unsupported until its
  adapter exists.
- The full TypeScript project typecheck and relevant inventory-planning unit
  suites must pass before merge.
