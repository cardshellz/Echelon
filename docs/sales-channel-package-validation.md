# Sales-channel package validation (Phase 2)

Catalog owns physical package measurements for each variant. No listing-level
dimensions are imported, copied between variants, or invented by this flow.
Existing provider fields are preserved during full-replacement updates where
Catalog has not supplied a replacement.

## Ownership and rules

`prepareChannelPackage` is the shared owner of package validation, source
selection and structured warnings. An adapter supplies normalized requirements
and proves the operation context. Optional missing measurements can produce a
warning; a required field, invalid supplied value, or partial dimension set
remains a validation failure. Dimensions are an atomic three-value set.

The eBay policy catalog supplies the same requirements to store, category,
product and variant policy resolution. For calculated shipping, publication
requires dimensions. Maintenance can recommend dimensions only after the adapter
proves an exact existing published offer and an unchanged fulfillment policy.
For other policies, the local recommendation does not prevent eBay from rejecting
an operation that has a service-specific requirement; that actual refusal remains
an actionable failed job with its original response evidence.

| Operation | Missing dimensions | Evidence/boundary |
| --- | --- | --- |
| New calculated-shipping inventory/offer publication | Block | Documented Inventory API publication requirement |
| Adding an unpublished variation with calculated shipping | Block | No existing published member identity |
| Changing to a calculated-shipping fulfillment policy | Block | Existing policy differs from desired policy |
| Maintaining an exact published offer with the same shipping policy | Warn and preserve | SKU, marketplace, offer ID, listing ID, published state and policy must agree |
| Publication with locally optional dimensions | Warn | Required provider refusals still stop completion |
| Incomplete/invalid supplied dimensions | Block | Cannot emit a partial container or combine separate packages |
| Unknown identity/policy or failed provider read | Stop/recheck | Never reinterpret missing evidence as permission to publish |

The exact maintenance proof is included in the prepared content hash and checked
again before mutation. A concurrent change returns the job to preparation. A
maintenance write reuses the offer reads already resolved by its sync owner,
rather than adding an identical lookup for each variant. A
warning never bypasses inventory admission, unresolved response evidence, final
provider readback, or archived-member clearing obligations.

## Verified execution paths

- `prepareActiveEbayListingSync` ->
  `EbayMarketplaceListingConnector.prepareExistingListingSyncDraft` ->
  `prepareEbayListingPackages` -> shared `prepareChannelPackage`.
- `prepareEbayPublicationCompletion` -> `preparePushDraft` uses the same package
  adapter. An already-observed publication can use maintenance; an unpublished
  target keeps publication validation.
- Generic `EbayAdapter.pushSingleListing` -> connector `pushListing` first
  discovers/validates publication identity, then selects package requirements.
  Discovery consists of reads and cannot run the first-mutation hook early.
- Reviewed listing updates use the same package adapter. Rebuilds retain
  publication requirements because they may withdraw and republish a listing.

The actual Inventory API writes remain `PUT inventory_item/{sku}`, `POST offer`,
`PUT offer/{offerId}`, `POST offer/{offerId}/publish`, and
`POST offer/publish_by_inventory_item_group`. Their existing request admission,
journaling and completion owners are unchanged.

## Provider contract evidence and limits

[eBay's Inventory API guide](https://developer.ebay.com/api-docs/sell/static/inventory/inventory-item-to-offer.html)
documents package measurements for calculated shipping. It also establishes
fulfillment policy as a listing-level setting common to a variation group's
offers. This does not establish that every maintenance operation without
per-SKU dimensions is rejected.

Production receipts inspected on 2026-10-25 include accepted inventory-item
maintenance PUTs and subsequent weight-only Inventory-item observations. The
request journal retains hashes, not historical request bodies; those receipts
are not a byte-for-byte reconstruction of the old requests.

A fresh read on 2026-10-25 additionally confirmed that both offer endpoints can
omit `fulfillmentPolicyId` on one member while a verified sibling on that exact
published listing supplies it. The adapter can use that listing-level fact. It
does not use a different listing, an unpublished offer or a local default as
evidence. An unresolvable or conflicting read retains a typed read diagnostic
and the existing bounded recovery behavior.

Only production credentials were present in the inspected connection. No new
live listing was created for a test, and no production package data was changed.
Publication contract coverage therefore combines official documentation with
the actual application composition and mocked provider responses; it is not a
claim of live acceptance of a newly published listing.

## Durable results and regression coverage

Warnings identify product, variant and SKU. The saved job's existing JSON result
stores them atomically with verified completion, and both list/status projections
retain them. The listing feed and status dialog show the warning and the exact
Catalog editor link after the modal is closed. A later corrected result no
longer carries the old warning. Warning scope is checked before projection.

Real PostgreSQL tests exercise the existing production job, command, response,
event, registration and admission migrations, including single-offer and group
publication with required and optional dimensions: concurrent enqueue/claim,
idempotency, warning persistence, read-only completion, policy changes, partial
dimensions, actual HTTP rejection receipts, source correction and warning scope.
The policy suite covers store/category/product/variant resolution. Connector
tests cover both single-offer and variation-group publication and the first
mutation boundary. Desktop/mobile browser tests verify warning persistence and
required-field actions. ATP calculations and Phase 3 are outside this change.
