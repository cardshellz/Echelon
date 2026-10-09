# One photo resolver for eBay — implementation and proof

Date: 2026-10-07. Reviewed against main `c0cb84b0ccb3eb8f89ea53450a4a1f3574cf2de9`.
Branch: `codex/unify-ebay-photo-resolver`.

## What changed and why

Direct eBay push/sync, the settings preview/test listing, and native channel sync previously had URL-only photo paths. An uploaded Catalog file has no ordinary asset URL, so those paths could omit it. Dropship already used Catalog's uploaded-photo reader but retained a second URL-only fallback. Those selectors and the fallback are removed.

Catalog owns selection for all these consumers: product/size scope, primary/position order, selected file validation, content fingerprints, and public file URLs. One eBay domain projection owns URL validation, stable deduplication, the existing 12-photo replacement limit, and SKU/group gallery projection. Channels supplies its own inclusion, position, URL and exact SKU overlays to Catalog; it does not join another owner's tables in the new repository.

The orchestration is deliberately small. `ChannelEbayListingPhotoResolver` adds the direct-channel snapshot, identity and retention rules around the published Catalog reader. Dropship consumes that same Catalog reader through its existing preview port and hands the resolved intent to the same eBay projection. There is no separate Dropship file-selection algorithm.

## Current execution trace

| Responsibility | Exact source and function |
| --- | --- |
| Catalog product/size/asset identity | `server/modules/catalog/catalog-publication-images.reader.ts:123`, `readCatalogPublicationPhotoScope` |
| Sole per-size Catalog selection/order; exclusions before ranking/hashing | `server/modules/catalog/catalog-publication-images.reader.ts:155`, `readCatalogVariantPublicationImages` |
| Selected URL/file resolution and explicit issues | `server/modules/catalog/catalog-publication-images.reader.ts:80`, `resolveCatalogPublicationPhotos`; `:250`, `PgCatalogVariantPublicationPhotoReader.listPublicationPhotos` |
| Configured public HTTPS origin | `server/modules/catalog/catalog-public-image.ts:10`, `createCatalogPublicImageUrl` |
| Direct-channel read-only snapshot, exact channel SKU aliases, failure and retention policy | `server/modules/channels/ebay-listing-photos.service.ts:31`, `ChannelEbayListingPhotoResolver.resolve`; `:42`, `resolveValidated` |
| One provider projection and URL limit | `server/modules/channels/ebay-listing-photos.domain.ts:48`, `resolveEbayListingPhotoUrls`; `:72`, `buildEbayListingPhotoPlan` |
| Existing group/every exact SKU; provider failures are propagated | `server/modules/channels/adapters/ebay/ebay-listing-photos.reader.ts:11`, `readExistingEbayListingPhotos` |
| Shared listing payload builder consumes a resolved plan | `server/modules/channels/adapters/ebay/ebay-listing-builder.ts:109`, `EbayListingBuilder.buildListingDraft` |
| Direct POST push, SSE push, SSE sync | `server/routes/ebay/ebay-listings.routes.ts:492`, `:886`, `:1381`, route handlers |
| Single/all/rule-triggered sync | `server/routes/ebay/ebay-sync-helpers.ts:204`, `syncActiveListings`; resolver call `:474` |
| Settings preview and test listing | `server/routes/ebay-settings.routes.ts:420`, `:528`, handlers registered by `registerEbaySettingsRoutes` |
| Native adapter; images source-lock respected | `server/modules/channels/adapters/ebay.adapter.ts:212`, `pushSingleListing` |
| Skip legacy upstream image projection for eBay | `server/modules/channels/echelon-sync-orchestrator.service.ts:1319`; `server/modules/channels/product-push.service.ts:117`, `getResolvedProductForChannel` |
| Dropship Catalog photos, required dependency | `server/modules/dropship/application/dropship-listing-preview-service.ts:566`, `loadListingPhotos` |
| Dropship provider consumes pre-resolved intent, without another Catalog read | `server/modules/dropship/infrastructure/dropship-ebay-listing-push.provider.ts:737`, `buildDropshipEbayListingDraft` |
| Single-product sync failures cannot claim success | `client/src/pages/EbayChannelPage.tsx:692`, `syncProductMutation`; schema `shared/types/ebay-listing-sync.ts:5` |

Direct resolution runs `REPEATABLE READ READ ONLY` across Catalog scope, channel overlays and file fingerprints. It commits/releases before reading eBay or making any listing write. On a read failure it rolls back; a rollback failure discards the connection. Direct listing handlers now use per-statement metadata leases, avoiding a held outer connection while the resolver requests another.

A selected broken upload, missing public origin, excluded gallery, foreign SKU or malformed photo URL fails direct-channel photo preflight before inventory/offer/group publication. Errors identify the relevant photo/size where available. A provider read outage cannot be reinterpreted as missing photos. The typed not-found classifier uses actual HTTP/error identity instead of searching arbitrary error messages for the digits `404`.

Only a genuinely empty Catalog gallery can retain existing eBay photos. Retention reads the group and every exact requested SKU. An explicit images source-lock preserves the provider gallery's exact order/count rather than replacing it with Catalog images; a missing locked group gallery fails instead of erasing it.

Dropship keeps its existing warning/omit policy for an unpublishable individual file when other photos remain. The selection owner is shared; this consumer failure policy is unchanged. Its existing worker refreshes a queued intent through a current preview (`dropship-listing-push-worker-service.ts:269`; `dropship-listing-intent-refresh.ts:28`). Therefore a whole job retry is **not** promised to freeze all queued content. The provider receives the resolved intent and does not independently select newer Catalog photos.

Existing quantity-only mutations retain the provider item they already read. Existing listing replacement/recovery restores the durable provider snapshot rather than resolving newer Catalog content (`server/modules/marketplace-listings/infrastructure/providers/ebay/ebay-listing-replacement.provider.ts:180`, `:388`, `:668`). Neither is an additional Catalog photo selector.

## Validation

All results below were repeated after rebasing onto the exact main commit above:

- **449 unit tests, 22 files:** resolver contracts, URL/order/deduplication, exact SKU/channel scope, source locks, all route builder/settings callers, native adapter, quantity readback protections, Catalog/Dropship previews/providers, worker/replacement recovery, and PostgreSQL CI manifest protection.
- **13 integration tests, 2 files, real disposable PostgreSQL 17:** actual Catalog/channel SQL, uploaded-byte public readback, overlays before limits/hashing, one committed snapshot under concurrent edits, rollback and replay after repair, concurrent requests with a one-connection pool, and no quantity/Catalog mutation by the resolver. The new suite uses a reduced owner schema, not a full production migration rehearsal.
- **6 browser checks, desktop/mobile:** actual eBay page component with mocked APIs; failed upload plus retry, partial sync reported as incomplete, and malformed response rejected. External requests were blocked; no application server or production database was started.
- Application, server-test and client-test TypeScript projects passed with incremental output disabled. Server-test checks used an 8 GB Node heap; the initial default-heap attempt exhausted memory before the successful reruns.
- Production client/server bundles built successfully. Vite emitted a large-chunk advisory.
- `git diff --check` passed. No migrations were added, so no migration prefix allocation/collision exists in this batch.

The provider recovery test `server/modules/dropship/__tests__/unit/dropship-marketplace-listing-push-providers.test.ts:156` injects an HTTP 503 after offer creation, retries the same supplied intent, verifies the offer is created once and verifies identical deduplicated uploaded-photo URLs on both inventory writes. This is mocked provider evidence, not a live eBay recovery.

Detailed local logs are in `.codex-audits/ebay-photo-resolver-20261007/`: `unit-final-main.log`, `postgres-final-main.log`, `browser-final-main.log`, `typecheck-final-main.log`, `typecheck-server-tests-final-main.log`, `typecheck-client-tests-final-main.log`, and `build-final-main.log`.

## Assumptions, limits and remaining proof

- Uploaded files use the existing configured-origin contract (`CATALOG_PUBLIC_BASE_URL`, `PUBLIC_APP_URL`, `APP_BASE_URL`, or `HEROKU_APP_DEFAULT_DOMAIN`). There is no guessed host, request-header origin or production configuration change. Current deployment configuration was not inspected during implementation.
- After photo resolution commits, an asset can be replaced/deleted before eBay fetches it. `readPublicCatalogImage` (`catalog-publication-images.reader.ts:258`) checks the content fingerprint, so an old URL returns no image instead of serving different bytes. This change does not introduce durable blob versions or promise old URLs survive an asset edit.
- eBay listing publication remains the existing sequence of external requests. A later provider failure can leave earlier external work committed; local SQL rollback is not external rollback. Existing connector/worker/replacement recovery remains the owner of that follow-up work.
- No inventory algorithm, quantity authority, quantity-write guard, receipt, pick, shipment, cost data, production listing, connection configuration or activation was changed during this task. No incident recovery was rerun.
- The dirty primary checkout remains at `45312a58f42362113e7e7647326aa4c94ee9aeb2` with its ten pre-existing tracked modifications. The `order-63721-investigation` checkout still contains its uncommitted picking recovery code. The photo batch does not overlap those changed files.
- A PR, passing local tests, merge, deployment and current eBay behavior are separate evidence. Merge/deploy and a specifically approved real eBay publish/fetch/readback remain unperformed.
