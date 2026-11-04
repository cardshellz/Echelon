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
| Legacy inventory feed persistence | `server/modules/inventory/infrastructure/inventory.repository.ts`, `upsertChannelFeed` | It can write the whole feed and looks it up by local variant and channel type, not channel ID. Confirm its callers and retire or delegate this writer without conflating it with Inventory's quantity authority. |
| Maintenance scripts | `scripts/relink-shopify-variant-ids.ts`, apply transaction; `scripts/_ca-backfill.ts`; `scripts/cleanup-prod60.ts` | These scripts directly change or delete channel identities; the cleanup script also calls eBay. Retire them or make them call the same reviewed command so an operational repair cannot bypass ownership and outstanding-work fences. No claim is made here that they are currently scheduled. |
| eBay publication projections | `server/modules/channels/infrastructure/ebay-listing-push.repository.ts`, `projectSuccess`; `server/modules/channels/infrastructure/ebay-listing-sync.repository.ts`, `projectPublication`; `server/modules/channels/infrastructure/ebay-listing-mapping.repository.ts` | Their verified provider IDs must be projected through the shared owner under the same transfer fence; the original publication evidence remains immutable. |
| Registered marketplace identity | `migrations/0609_marketplace_listing_registration.sql`, `marketplace.provider_identity_claims` and its immutable trigger | These are immutable publication claims with account-scoped uniqueness. Transfer must preserve them as historical evidence and integrate them with the current-owner decision. |
| Marketplace registration and replacement projections | `server/modules/marketplace-listings/infrastructure/pg-listing-registration.repository.ts`, `assertCompatiblePublication`; `pg-listing-replacement-execution.repository.ts`, staged publication/member updates | Both compare or write provider identities on publication members. The current compatibility check rejects a different variant owner even after a legitimate transfer; replacement cannot independently recreate the old owner. |
| Archived-source publication gate | `server/modules/marketplace-listings/infrastructure/pg-listing-member-lifecycle.repository.ts`, `assertArchivedMemberPublicationAllowed` | This gate checks retained archived sources by provider/account/market/SKU. A successor using that same remote SKU needs an ownership-aware decision; copying the mapping alone can still block publication. |
| Dropship mapping | `server/modules/dropship/infrastructure/dropship-listing-push-worker.repository.ts` and `server/modules/dropship/infrastructure/dropship-listing-end.repository.ts` | Cover the exact vendor/store/account identity and existing remote-member lock. A direct connection and a Dropship connection can refer to the same seller account. |
| Dropship listing readback | `server/modules/dropship/infrastructure/dropship-marketplace-listing-sync-state.repository.ts`, `applyMarketplaceListingStatusWithClient` | Its conditional `external_listing_id` update is another identity writer and must participate in the cutover. |
| Dropship order intake | `server/modules/dropship/infrastructure/dropship-order-processing.repository.ts` and `dropship-order-acceptance.repository.ts` | These also search current or historical remote listing IDs. Check their exact variant and vendor scoping when switching readers to the shared owner; preserve bound historical order identity. |
| Archive-driven member removal | `server/modules/marketplace-listings/application/listing-lifecycle.service.ts`, `processDue` and `reconcile-archived-member-retirement.ts` | The old automatic archive discovery writer is removed. Proven-unsent old requests are superseded; uncertain requests remain in readback recovery. An existing explicit recovery authorization retains its original scope. |
| Archive-driven eBay availability | `migrations/0606_channel_variant_availability_sync.sql`, `channels.enqueue_variant_availability_sync` and `server/modules/channels/variant-availability-sync.service.ts`, `processClaim` | Reconcile queued and in-flight work during ownership changes. The trigger queues a false `desired_active` when a mapped variant is archived, and the worker routes quantity publication; changing listing ownership alone does not stop it. |
| Explicit eBay variant exclusion | `server/routes/ebay/ebay-config.routes.ts`, `PUT /api/ebay/variant-exclusion/:variantId`; `server/routes/ebay/ebay-listing-state.ts`, `zeroEbayVariantListing` / `markVariantListingZeroed` | The route saves inclusion and performs its own provider quantity operation. It then sets the listing projection to `synced` and clears the error, including when no SKU was found. Move the command and completion decision into the shared lifecycle and quantity owners, preserving honest publication status and the explicitly requested exclusion. |
| Archived-member visibility | `server/modules/channels/infrastructure/ebay-listing-feed.reader.ts`, variant query; `client/src/pages/EbayChannelPage.tsx`, expanded variant switches | The regular feed includes only active, sellable variants. The archive confirmation alone therefore does not establish that an archived member can be explicitly unpublished from this workspace. Provide and test an actual separately authorized action for retained archived identities. |

`channels.channel_variant_availability_sync` stores a desired state and revision,
but no reason identifying whether a false request came from archive or the
`queueVariantAvailabilityRepair` path used by the eBay status scan. Existing false requests
therefore cannot safely be bulk-cancelled as archive work. The cutover needs a
durable origin for new requests and a conservative disposition for existing
requests, while preserving any in-flight or already-sent provider work.

The local queue prototype preserves an in-flight lease, retains distinct newer
requests in order, distinguishes a recorded stock repair from a legacy request
whose origin is unknown, and records immutable follow-up history. PostgreSQL
tests exercise completion, rollback, races, reactivation, and an older worker
completing during deployment. The schema is currently in
`.verification/archive-separation.sql`; it is not an allocated production
migration. The prototype routes both Catalog sellability guards through one
decision that accounts for queued activations; PostgreSQL tests cover an
internal-only transition racing an activation. This is not a completed cutover:
the prototype parks some uncertain requests in `needs_review` without a
connected recovery action, and ownership transfer is not fenced against legacy
writers. The prototype must not be deployed until those gaps are addressed.

The above is a list of evidenced boundaries, not a claim that every writer in
the repository has already been enumerated. Any proposed cutover needs a
complete writer/read-path inventory and database enforcement that prevents
legacy paths from bypassing the owner.

The legacy `recordNonShopifyInventorySyncSuccess` and
`recordPermanentPushFailure` methods in `echelon-sync-orchestrator.service.ts`
can also fall back to the local variant ID when constructing a channel variant
ID. That value is not provider identity evidence. The cutover must retire or
replace these paths with verified identity projection; silently preserving the
fallback would allow a fabricated mapping to reach the new owner.

For an enrolled product, the variant-exclusion route's updates also invalidate
`inventory.publication_selection_work` through the triggers in
`migrations/0743_publication_selection_work.sql`. The same user action then
calls `zeroEbayVariantListing` directly. These are two producer paths for one
stock decision; admission and outbox behavior must be traced before retiring
the direct path, including products that are not enrolled. Merely removing the
direct call would leave those unenrolled products without the same fallback.

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
The existing member processor also marks a changed-source request retired when
provider readback no longer finds the member, including when dispatch status is
`unknown` (`processListingMemberRetirement`, changed-source branch). That
observation confirms the current listing state; it does not, by itself, prove
that a previously submitted request can no longer arrive after a transfer.
The cutover must retain and evaluate exact dispatch-finality evidence separately
from the listing-state observation. Do not use a `retired` label alone as the
transfer gate.

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

## Local verification of the partial work

The affected lifecycle, mapping, queue, and Catalog policy suites passed 231
tests against a disposable PostgreSQL instance and unit fixtures. The archive
and recovery browser selection passed 12 desktop/mobile tests with mocked APIs.
Those browser tests do not exercise an ownership transfer. The queue tests load
`.verification/archive-separation.sql` directly; the suite is in the
PostgreSQL CI manifest, but that prototype must be replaced with an allocated
production migration before a release candidate is valid.
