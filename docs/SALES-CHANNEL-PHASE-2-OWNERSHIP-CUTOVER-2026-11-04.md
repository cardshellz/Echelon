# Phase 2 channel-variant ownership: cutover still required

This worktree contains archive and recovery changes, not a completed ownership
cutover. It must not be deployed as a complete fix for duplicate or transferred
channel links. It does not transfer the five historical Shopify mappings or
change ATP calculation.

## Current identity writers and lifecycle boundaries

| Responsibility | Evidence | Cutover requirement |
| --- | --- | --- |
| Catalog Shopify mapping | `server/modules/catalog/shopify-product-mapping.service.ts`, `repair` | Replace its independent checks and writes to Catalog, channel feeds, and channel listings with the shared ownership command. |
| Shopify identity retirement | `server/modules/catalog/shopify-product-mapping-reconciliation.repository.ts`, `retireStaleMapping` and `applyOwnershipRecommendations` | Retire these independent detach writers or delegate them to the shared transfer command; preserve their existing immutable repair receipts. |
| Single-variant Shopify linking | `server/modules/catalog/catalog.routes.ts`, `/api/product-variants/:id/shopify-link` | This route independently checks and writes the same mapping copies; it must use the same command and exact-account fence. |
| Generic catalog variant writes | `server/modules/catalog/catalog.routes.ts`, `POST /api/products/:productId/variants` and `PUT /api/product-variants/:id` | Both accept Shopify identity fields through their general payloads. Restrict identity changes to the shared command without breaking unrelated variant edits. |
| Verified channel catalog mappings | `server/modules/channels/channel-catalog.repository.ts`, `saveMappings` / `saveOne` | Convert its feed/listing writes and conflict checks into projections of the same ownership decision. |
| Generic channel projection writers | `server/modules/channels/channel-catalog.storage.ts`, `upsertChannelListing`; `server/modules/channels/channels.storage.ts`, `createChannelFeedDirect` | Route identity-changing inserts and upserts through the same owner, and fence activation of existing feeds. |
| Order intake reader | `server/modules/oms/infrastructure/order-line-catalog-identity.repository.ts`, `byChannelVariant`; `server/modules/oms/domain/order-line-catalog-identity.ts`, `selectOrderLineCatalogIdentity` | Resolve current orders against the authoritative owner while retaining the existing guard against silently changing an already-bound order line. The existing reader can return both archived and active copies as an ambiguous match. |
| Legacy channel mapping and synchronization | `server/modules/channels/channel-identity.service.ts`, `server/modules/channels/echelon-sync-orchestrator.service.ts`, and `server/modules/channels/variant-availability-sync.repository.ts` | Audit every identity-changing path, including retries, so none can reintroduce an old owner after transfer. Quantity computation remains with Inventory. |
| eBay publication projections | `server/modules/channels/infrastructure/ebay-listing-push.repository.ts`, `projectSuccess`; `server/modules/channels/infrastructure/ebay-listing-sync.repository.ts`, `projectPublication`; `server/modules/channels/infrastructure/ebay-listing-mapping.repository.ts` | Their verified provider IDs must be projected through the shared owner under the same transfer fence; the original publication evidence remains immutable. |
| Registered marketplace identity | `migrations/0609_marketplace_listing_registration.sql`, `marketplace.provider_identity_claims` and its immutable trigger | These are immutable publication claims with account-scoped uniqueness. Transfer must preserve them as historical evidence and integrate them with the current-owner decision. |
| Dropship mapping | `server/modules/dropship/infrastructure/dropship-listing-push-worker.repository.ts` and `server/modules/dropship/infrastructure/dropship-listing-end.repository.ts` | Cover the exact vendor/store/account identity and existing remote-member lock. A direct connection and a Dropship connection can refer to the same seller account. |
| Dropship listing readback | `server/modules/dropship/infrastructure/dropship-marketplace-listing-sync-state.repository.ts`, `applyMarketplaceListingStatusWithClient` | Its conditional `external_listing_id` update is another identity writer and must participate in the cutover. |
| Archive-driven member removal | `server/modules/marketplace-listings/application/listing-lifecycle.service.ts`, `processDue` and `reconcile-archived-member-retirement.ts` | The old automatic archive discovery writer is removed. Proven-unsent old requests are superseded; uncertain requests remain in readback recovery. An existing explicit recovery authorization retains its original scope. |
| Archive-driven eBay availability | `migrations/0606_channel_variant_availability_sync.sql`, `channels.enqueue_variant_availability_sync` and `server/modules/channels/variant-availability-sync.service.ts`, `processClaim` | Reconcile queued and in-flight work during ownership changes. The trigger queues a false `desired_active` when a mapped variant is archived, and the worker routes quantity publication; changing listing ownership alone does not stop it. |

`channels.channel_variant_availability_sync` stores a desired state and revision,
but no reason identifying whether a false request came from archive or the
`queueVariantAvailabilityRepair` path used by the eBay status scan. Existing false requests
therefore cannot safely be bulk-cancelled as archive work. The cutover needs a
durable origin for new requests and a conservative disposition for existing
requests, while preserving any in-flight or already-sent provider work.

The above is a list of evidenced boundaries, not a claim that every writer in
the repository has already been enumerated. Any proposed cutover needs a
complete writer/read-path inventory and database enforcement that prevents
legacy paths from bypassing the owner.

## Archive and recovery work in this worktree

Archiving excludes local content updates without issuing a new removal. The
catalog confirmation says the listing may still be live. Previously requested
explicit unpublishes and quantity work remain separate obligations.

The shared member lifecycle no longer supersedes a possibly dispatched removal
merely because the source link changes. It can observe the exact saved member,
but a changed source cannot authorize or dispatch another removal. An
unresolved old receipt remains visible to the lifecycle reader even when a new
generation exists. This does not fence every listing or quantity writer from a
concurrent ownership transfer; that fence is part of the unfinished cutover.

Older code could already mark an uncertain request `superseded`. A read-only
production census found one such record. The request journal contains rejected
deletions for the same offer and time window, but does not persist the lifecycle
operation ID, so it cannot by itself establish which deletion belongs to that
receipt. The local reader now exposes these records and permits a read-only
provider observation without changing the immutable history or authorizing
another deletion. An incomplete or malformed event stream is also treated as
unconfirmed. This is visibility, not durable settlement or a safe transfer
gate: both remain required before this cutover can be called complete.
The eBay member adapter's `retire` method does not forward the lifecycle
operation ID to `clearOffer` or `deleteOffer`; future requests need an exact,
durable association between the shared lifecycle operation and provider journal
entries so recovery need not guess from matching timestamps.

## Required acceptance evidence

1. One account-scoped current owner per exact remote member, with immutable
   transfer history and projections that cannot write ownership independently.
2. Atomic, idempotent transfer under a common remote-member fence; concurrent
   reactivation, mapping, provider writes and archive transitions cannot
   create two active owners or clear the successor's inventory.
3. Old unsent automatic removals are superseded; uncertain or accepted sends,
   explicit unpublish commands, pending quantity work and late provider writes
   remain visible and reconciled before the identity is reused.
4. Real PostgreSQL tests exercise production indexes and triggers, historical
   alias adoption, distinct variants under the same parent listing, accounts,
   concurrency, reactivation, replay and rollback. Browser tests exercise a
   transfer and actionable ambiguous cases through the actual UI.
5. After deployment only, verify the five historical examples with channel
   readback. No production data or channel state was changed by this worktree.
