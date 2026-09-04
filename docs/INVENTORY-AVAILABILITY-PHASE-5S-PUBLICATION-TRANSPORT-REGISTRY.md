# Inventory Availability Phase 5S: Exact-Destination Publication Transports

## Outcome

This slice generalizes the durable canonical inventory publisher from a
Channels-only connection to an exact publication destination. The canonical
planner still calculates one warehouse-aware ATP and channel-exposure result.
The transport layer receives that already-final absolute quantity and may only
resolve credentials, translate the provider payload, publish it, and read it
back.

The transport registry is keyed by both destination owner kind and provider:

- `channel_connection:shopify` uses the existing exact Shopify channel
  connection and location-scoped absolute inventory operation;
- `channel_connection:ebay` uses the existing exact eBay channel connection,
  provider-verified OAuth account, and account-scoped absolute inventory
  operation; and
- `dropship_store_connection:ebay` uses the exact Dropship store connection,
  verified eBay provider account, and store-owned OAuth credential.

No direct TikTok transport is registered. TikTok continues to be represented by
its current Shopify transport path until a separately proven thin adapter is
added. No Dropship Shopify inventory transport is registered by this slice.

The migration creates no publication target, source binding, mapping, outbox
row, activation state, provider request, or inventory quantity change.

## Durable identity

`inventory.inventory_publication_outbox` now snapshots exactly one transport
owner:

- `destination_kind_snapshot = 'channel_connection'` requires
  `channel_connection_id_snapshot` and forbids
  `dropship_store_connection_id_snapshot`;
- `destination_kind_snapshot = 'dropship_store_connection'` requires
  `dropship_store_connection_id_snapshot` and forbids
  `channel_connection_id_snapshot`.

Existing outbox rows remain Channels-owned through the non-destructive column
default. The insert guard binds every new snapshot to the target's immutable
owner, logical allocation channel, provider, scope, external account/location,
and target revision. The update guard makes the new owner fields immutable.

Provider request keys and request hashes include the exact destination kind and
owner identifier. Provider readback evidence records the same owner snapshot.

## Transport contract

`InventoryPublicationTransportAdapter` accepts either
`AbsoluteInventoryPublicationRequest` or `AbsoluteInventoryReadRequest`. Its
publication request includes the exact destination, provider scope, external
scope, catalog variant, provider inventory identity, provider SKU, and the
already-calculated nonnegative safe-integer quantity.

The contract intentionally exposes no ATP reader, allocation policy, warehouse
inventory repository, recipe planner, or channel dial. A provider implementation
therefore has no input from which to invent a second availability formula.

The eBay Dropship implementation verifies all of the following before network
I/O:

1. the store connection exists and is connected;
2. its platform is eBay;
3. the refreshed credential belongs to the same vendor and store;
4. the credential has a verified `provider_user_id`; and
5. that provider account exactly equals the publication target's external
   account scope.

The eBay registration observer records the eBay inventory-item identity as its
SKU. Both eBay transports therefore use the immutable provider inventory-item
ID as the request key, tolerate an absent optional SKU, and reject a conflicting
SKU before provider I/O.

The Dropship transport reads the existing eBay Inventory Item, replaces only
`availability.shipToLocationAvailability.quantity` with the supplied absolute
quantity, writes the complete item back, and reads the quantity from the same
provider inventory-item key for verification. A rejected access token is
invalidated for refresh and classified as retryable; deterministic owner,
scope, mapping, and account identity failures are non-retryable.

## Ordering and stale-revision suppression

Runtime enqueue and provider dispatch use the same PostgreSQL advisory-lock key:
`(publication_target_id, product_variant_id)`. Immediately before provider I/O,
the worker acquires the lock and proves that it still owns the lease and that no
newer desired revision exists. A stale claim records a `superseded` attempt and
makes no provider request.

The lock remains held through publication, readback, and durable attempt
recording. A newer runtime enqueue waits until that operation finishes, then
creates the next monotonic absolute revision. Expired-lease recovery uses a
non-blocking advisory-lock attempt, so it cannot reclaim a row whose provider
operation is still protected by the same key.

## Authority and activation

This slice does not change `inventory.availability_runtime_authority` or create
runtime state. Existing authority-aware routing remains the exclusive decision
point: legacy authority invokes the legacy callback, while canonical authority
enqueues the exact-target durable outbox result. Provider adapters never choose
authority and never call a legacy ATP reader.

Dropship-owned eBay targets can now participate in canonical readback,
conservative publication, and full runtime publication using the same planner
result as Channels-owned targets. An unregistered destination/provider pair
fails closed before provider I/O.

## Verification contract

- Registry tests prove exact `(destination kind, provider)` routing and duplicate
  registration rejection.
- Channels bridge tests prove the exact connection and scope are preserved.
- Dropship eBay tests prove exact owner and verified-account matching, absolute
  quantity payloads, readback, and access-token failure classification.
- Runtime tests prove Channels and Dropship targets consume the same canonical
  exposure result and persist their exact owner snapshots.
- Outbox tests prove stale-revision suppression, retry behavior, immutable
  readback ownership, and conservative/full activation semantics.
- Migration tests prove XOR ownership, target-bound identity, immutability,
  append-only superseded-attempt evidence, and the absence of seeded state.
