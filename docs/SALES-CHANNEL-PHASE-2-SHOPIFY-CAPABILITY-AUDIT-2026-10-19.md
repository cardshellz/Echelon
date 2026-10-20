# Shopify capability audit for Phase 2

This audit records the existing Shopify execution paths that must be accounted for before Shopify adopts the shared prepared-intent contract. Phase 2 adds the contract to the existing eBay and Walmart preparation owners. It does not switch Shopify execution ownership, start another worker, or establish live Shopify acceptance.

Source baseline: Echelon `356b9eaa1`, with the Phase 2 preparation changes in the current isolated worktree. The external Shellz source references below were read from the local checkout; its current deployed revision and effective account were not verified. Earlier connected-account counts in the Phase 0 census (historical, uncommitted local record: `C:/Users/owner/Echelon/docs/SALES-CHANNEL-PHASE-0-SHOPIFY-CATALOG-2026-10-18.md`) remain historical observations.

## What the code definitely does

| Capability or writer | Current evidence | Phase 2 disposition |
| --- | --- | --- |
| Internal Shopify product create and update | `ShopifyAdapter.pushListings` delegates to `ShopifyMarketplaceListingConnector.pushChannelListing`. Existing variants locate a product, then REST product PUT updates it; new products use POST. [Adapter](../server/modules/channels/adapters/shopify.adapter.ts#L91), [connector](../server/modules/channels/listing-connectors/shopify-listing.connector.ts#L97). | Existing transport capability. It does not prove shared Marketplace publication review, uncertain-create recovery, or buyer-visible publication. |
| Internal Shopify price transport | `ShopifyAdapter.pushPricing` sends an exact external variant ID to `/variants/{id}.json`. The existing formatter uses division and `toFixed`; this audit does not certify all money boundaries. [Adapter](../server/modules/channels/adapters/shopify.adapter.ts#L297). | Retain existing owner during discovery; exact-money and readback parity are migration gates. |
| Automatic full-sync listing and price execution | `EchelonSyncOrchestrator` retains `syncListingsForChannel` and `syncPricingForChannel`, but their calls from full sync are inside disabled comment blocks. [Full-sync composition](../server/modules/channels/echelon-sync-orchestrator.service.ts#L1527). | Do not advertise automatic listing/price sync from adapter presence. Do not enable these legacy branches as part of the common contract. |
| Legacy product push service | `pushProduct` contains a Shopify branch; `pushToShopify` selects the first channel connection with `limit(1)`. The production caller search found the service resolver used by the orchestrator, but no mounted caller of the exported push methods. [Product push](../server/modules/channels/product-push.service.ts#L191), [connection selection](../server/modules/channels/product-push.service.ts#L287). | Latent path requiring exact-connection consolidation before activation. The safer adapter credential check does not automatically protect this separate function. |
| Canonical stock publication and readback | `ShopifyAdapter.getCredentials` rejects ambiguous channel-only selection and never falls back from an absent explicit connection. Canonical inventory requires exact location scope, item ID and one matching returned level. The physical stock request requires quantity admission. [Credential scope](../server/modules/channels/adapters/shopify.adapter.ts#L627), [readback](../server/modules/channels/adapters/shopify.adapter.ts#L230). | Retain Inventory ownership and existing exact location guards. Listing-contract adoption must not introduce another quantity decision. |
| Direct media and mapping operations | Mounted Catalog `/api/images/push/shopify` and variant `shopify-link` routes remain; Channels also calls `ShopifyAdapter.pushImagesOnly`. [Catalog routes](../server/modules/catalog/catalog.routes.ts#L3192), [mapping route](../server/modules/catalog/catalog.routes.ts#L2231), [Channels images](../server/modules/channels/channels.routes.ts#L1119). | Each action must ultimately select the same reviewed media intent. No route retirement or execution cutover is included in this phase. |
| Dropship Shopify listing push | The provider router wires both eBay and Shopify. `ShopifyDropshipListingPushProvider.pushListing` loads credentials by exact vendor/store connection. Its `productSet` contains one variant, price, SKU, ACTIVE/DRAFT, metadata and at most 20 files. [Router](../server/modules/dropship/infrastructure/dropship-marketplace-listing-push.providers.ts#L37), [provider](../server/modules/dropship/infrastructure/dropship-shopify-listing-push.provider.ts#L39), [payload](../server/modules/dropship/infrastructure/dropship-shopify-listing-push.provider.ts#L153). | Transport exists. Product ACTIVE is not evidence of publication to a Shopify sales channel. The payload does not establish stock publication or image readback; the idempotency metafield is not a request-deduplication guarantee. |

## External Shellz worker dependency

Catalog's `enqueueShippingGroupMetafieldWrite` commits a durable `membership.shopify_metafield_outbox` entry with the Catalog source change. Its dedupe key is product GID plus namespace/key; it does not carry shop, channel connection, environment or credential revision. [Producer](../server/modules/catalog/shipping-group-sync.ts#L182).

The local Shellz checkout supplies the executor:

- `C:/Users/owner/shellz-club-app/server/index.ts:267` starts `startMetafieldOutboxWorker`.
- `server/sync/worker.ts:71` schedules the drain; `claimBatch:153` claims pending/failed rows with attempts below the retry limit using `FOR UPDATE SKIP LOCKED`.
- `processSets:190` and `processDeletes:250` dispatch `metafieldsSet` and `metafieldsDelete` through `shopifyService.graphqlAdmin`.
- `server/sync/metafield-registry.ts:42` registers `cardshellz.shipping_group`.
- `server/shopify.ts:159-183` constructs a global environment-backed session and then prefers global application settings during `ensureSession`. It does not derive the remote account from each outbox row.

The producer and external worker are one cross-application handoff. Starting an Echelon worker against the same effects would create competing dispatch owners. Retain this handoff until the external application's deployment, credential authority, queue ownership, accepted/unknown effects and rollback plan are verified together.

## Required migration contract and acceptance gates

1. **Exact account:** distinguish Channels ownership from Dropship vendor/store ownership. Bind connection, provider account/shop, environment, marketplace or sales-channel scope, inventory location and configuration revision. Preserve the adapter's ambiguity rejection; eliminate latent first-row account selection before enabling that path.
2. **Resolved intent:** carry the canonical media plan, immutable uploaded versions, exact cents/currency and source provenance into preview and preparation. Explicit manual media/price overrides must identify the reviewed draft owner. A Shopify adapter translates the supplied intent; it must not independently reselect images or prices.
3. **Truthful capabilities:** separately declare product resource create/update, sales-channel publication, member topology, media replacement/append, quantity-bearing effects and readback. An unimplemented or unverified capability remains explicit instead of inheriting eBay or Walmart behavior.
4. **Durable recovery:** before moving any writer, prove lost-create acknowledgement, uncertain writes, exact remote-ID adoption, duplicate/renamed SKU rejection, partial GraphQL user errors, replay and stale owner/configuration rejection with real PostgreSQL and mocked provider HTTP.
5. **External handoff:** agree a versioned producer/consumer contract for shipping-group metadata, including exact account routing and immutable delivery evidence. Preserve queued rows and unknown effects through any cutover. Do not add a second worker in Phase 2.

## Phase 2 envelope adoption boundaries

The saved eBay sync/publication owner records the full prepared envelope and pins its immutable media versions in the claimed job transaction before provider writes. Walmart's existing operation acceptance records its prepared snapshot and pins selected media versions. These additions do not replace either execution state machine.

Legacy persisted Walmart reviews without an envelope remain compatible. The legacy direct eBay update/rebuild paths validate prepared content but do not acquire a new durable operation receipt or per-operation media pin owner in this phase. Consolidating those paths belongs to the Phase 3 execution cutover. Catalog retains historical uploaded versions without garbage collection in this phase; the new envelope does not claim that legacy execution has gained durable replay evidence.

The propagation panel is automatic update history. Manual review or publication does not yet close an original `needs_review` delivery; operators must check the existing listing status for the later manual action. Connecting that review completion to the original change record remains deferred, and the panel states this limitation.

Walmart's current item readback does not expose listing images. New operation results therefore distinguish accepted content and verified item identity/price/status from unavailable image verification. An accepted feed is not image readback evidence.

## What remains unproven

No live Shopify or Shellz account, credential, queue, worker, buyer-visible publication, media readback or deployment state was accessed for this audit. The external worker observations describe local source only. The Shopify listing migration design must therefore remain conditional on the capability and ownership acceptance gates above.
