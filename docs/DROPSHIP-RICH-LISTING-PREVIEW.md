# Dropship Rich Listing Preview

Status: Implemented for review on 2026-09-06 in `codex/dropship-rich-listing-preview`. Source review, automated tests, isolated browser QA, and the production build passed as recorded below. Deployment, live database, and marketplace verification remain pending.

## Scope and authority

The richer preview is a read-only review surface for listing presentation, vendor product cost, and a destination/quantity scenario for Card Shellz fulfillment charges. It does not publish listings or turn a scenario into an accepted order or wallet debit.

Suggested pricing remains deferred under **DSP-PRICE-01** in [the historical margin-first design](DROPSHIP-MARGIN-FIRST-CATALOG-DESIGN.md#8-punch-list). That design's old Suggested/SRP scope is not authorization to implement a recommendation rule. No marketplace-fee estimates, vendor profit/P&L, automatic repricing, or live marketplace pushes are in this change.

## Implementation boundaries

### Safe listing presentation

- Present the resolved title and description, ordered image gallery, variant/SKU and pack information, selected listing price/quantity, and effective listing policies with their inheritance/override source.
- Treat catalog descriptions and asset metadata as untrusted. Render descriptions safely; do not execute embedded markup, scripts, event handlers, or unsafe URLs.
- Missing content or assets must have an explicit empty/unavailable state. Preserve preview validation and publication blockers rather than inventing content or relaxing requirements.
- File-only catalog images may be shown through a scoped, authorized preview delivery path. Label these **preview-only / not publishable**; being visible in this UI does not create a marketplace-ready image URL. Do not expose storage paths or bypass asset ownership checks.

### Vendor product cost

- Show what the vendor would pay Card Shellz for the product, using the current acceptance-channel discount and the same catalog-retail source, integer-cent arithmetic, and rounding rules as order acceptance.
- This is vendor purchase cost, not Card Shellz internal COGS, a suggested selling price, marketplace net payout, or profit. Do not derive it from the vendor's listing-price override.
- Identify the source and unavailable conditions. Missing or invalid pricing/discount inputs must not become a fabricated zero cost or an invented discount.

### Read-only scenario estimate

- Accept an explicit destination and positive quantity for the reviewed variant; validate both at the boundary.
- Use existing applicable Card Shellz rates and fee rules. The preview's product-cost data is separate from the shipping-estimate response, which includes the rate-table charge, shipping markup, insurance pool, and dunnage. Do not estimate marketplace charges.
- Label results as scenario estimates, not a committed quote, buyer-facing marketplace shipping price, accepted order, or actual wallet debit. Surface unsupported destinations, missing rates/weights, and unavailable pricing explicitly.
- Estimation must not create an order, persisted quote snapshot, reservation, ledger entry, or marketplace write. It must not change saved listing content, price, quantity, or policies.

## Verification checklist

Checked items were verified by source inspection and local fixtures, not by live marketplace or production-database calls. See the evidence and limitations below.

- [x] Trace the typed presentation/cost/estimate contracts from authenticated HTTP boundary through application/domain logic and repositories to the client.
- [x] Verify title, description, gallery order/fallbacks, SKU/pack information, price/quantity, and effective policies against representative fixtures.
- [x] Exercise hostile descriptions, unsafe/missing asset URLs, unauthorized file access, missing files, and file-only images; verify safe rendering and explicit non-publishable labeling.
- [x] Prove vendor product-cost parity with acceptance for the same retail and channel discount, including zero, missing/invalid inputs, rounding boundaries, and unsafe-integer cases; exclude internal COGS.
- [x] Prove destination/quantity estimates reuse existing rate/fee rules; cover supported/unsupported destinations, missing rates/weights, quantity bounds, and arithmetic overflow with injected calculation dependencies.
- [x] Inspect the estimate dependency graph and exercise repeated calls with read-only fakes: no quote snapshot, order, reservation, debit, or marketplace writer is available to this path.
- [x] Verify loading/error/retry states and stale-response handling when the reviewed variant, store, destination, or quantity changes.
- [x] Verify the new detail/estimate controls contain no saved-listing or publication mutation; isolated browser interaction issued only the expected estimate requests.
- [x] Run focused service, HTTP, and UI tests and the broader dropship regression group; record evidence and limitations below.
- [ ] Verify real database-backed media/cost/rate resolution and the deployed preview against the connected eBay store without queuing a listing.

## Inspected source trace

Paths below are relative to the repository root. These references establish implementation behavior, not production validation.

- **Presentation and transport:** `server/modules/dropship/application/dropship-listing-presentation.ts` (`enrichDropshipListingRows`, `buildDropshipListingPresentation`, `descriptionAsPlainText`) produces typed, plain-text advisory content. `toDropshipVendorListingPreview` in `application/dropship-listing-dtos.ts` explicitly omits worker-only `listingIntent` and its configuration from vendor HTTP responses. Both presentation and economics are validated with `shared/dropship/listing-presentation.ts`.
- **Publication parity:** `server/modules/dropship/infrastructure/dropship-listing-publication-preview.provider.ts` (`resolveDropshipPublicationPreview`) calls the eBay push provider's `buildDropshipEbayListingDraft` and `EbayListingBuilder`. It therefore uses that draft's title, description, condition, item specifics, and first 12 image URLs. Unsupported/unresolved publication content is labeled `catalog_fallback`; it is not claimed to be the final payload. Advisory enrichment leaves existing intent, quantity, price, readiness, and preview hashes unchanged.
- **Private files:** `DropshipListingPreviewService.imageForMember` in `server/modules/dropship/application/dropship-listing-preview-service.ts` checks member/store ownership, vendor/entitlement/store readiness, exposure, and selection before reading an image. `server/modules/catalog/catalog-media.reader.ts` (`PgCatalogVariantMediaReader.readImageFile`) requires the asset to belong to the variant or its product and limits file delivery to JPEG, PNG, WebP, and GIF. `registerDropshipListingRoutes` serves the scoped file route with private/no-store, nosniff, and sandbox CSP headers. Authenticated file URLs never become publication URLs.
- **Product-cost authority:** `PgDropshipListingPreviewRepository.loadChannelDiscountPercent` in `server/modules/dropship/infrastructure/dropship-listing-preview.repository.ts` resolves the configured Dropship OMS channel and reads its `channels.partner_profiles.discount_percent`. `listCatalogCandidates` uses the existing Shopify retail-cache lookup with catalog-price fallback. `buildDropshipListingEconomics` calls acceptance's `calculateDiscountedWholesaleUnitCostCents` and treats missing/invalid source data as unavailable; the listing-price override is not a cost input. This is a current reference, not a locked acceptance snapshot.
- **Estimate authorization and limits:** `shared/dropship/listing-shipping-estimate.ts` validates explicit store, variant, destination, and 1–1,000 sellable-pack quantity. `PgListingShippingEstimateContextReader.loadForMember` in `server/modules/dropship/infrastructure/dropship-listing-shipping-estimate.repository.ts` resolves owned store context and the same origin configuration as order processing. `DropshipListingShippingEstimateService.estimateForMember` checks active entitlement, allowed vendor/store status, and selected/exposed catalog scope; it does not require wallet funding or provision a vendor. `registerDropshipListingShippingEstimateRoutes` limits authenticated members to 30 estimate requests per minute.
- **Shared calculation, separate persistence:** `calculateDropshipShippingQuote` in `server/modules/dropship/application/dropship-shipping-quote-service.ts` reuses cartonization, the runtime legacy/shared rate selection, and current markup/insurance policies. Its dependency contract contains only calculation and fee reads. The estimate factory passes no snapshot, audit, order, wallet, or marketplace writer. Existing `DropshipShippingQuoteService.executeQuote` still owns order-quote idempotency, snapshot creation, and shadow observation; the estimator does not call it. Existing listing-preview generation separately retains its pre-existing vendor-provisioning path.
- **Client state:** `client/src/pages/dropship/DropshipListingPreview.tsx` bounds mounted table rows to 50, renders descriptions as text, marks non-publication gallery images, and keys the estimate by store, variant, and preview generation. `DropshipListingShippingEstimate.tsx` disables scenario edits while a read is pending, clears old results on edits, and invalidates pending responses on unmount. `client/src/lib/dropship-listing-shipping-estimate.ts` validates returned scenario identity and monetary breakdown before rendering. Viewing this detail or using its estimator contains no publication action.

## Local verification evidence (2026-09-06)

- **Broader regression:** 146 test files and 1,129 tests passed, including the table-writer ownership guard. Command:

  ```text
  npx vitest run server/modules/dropship/__tests__/unit client/src/pages/dropship/__tests__ client/src/lib/__tests__/dropship-listing-preview.test.ts client/src/lib/__tests__/dropship-listing-shipping-estimate.test.ts server/modules/catalog/__tests__/unit/catalog-media.reader.test.ts server/__tests__/unit/writer-ratchet.test.ts
  ```

- **Independent source review:** checked authenticated media access, outbound preview projection, product-cost authority, publication-builder reuse, estimate dependency isolation, existing persisted-quote behavior, and stale UI responses. No confirmed introduced defect was identified; this is review evidence, not a substitute for database or deployment tests.
- **TypeScript:** `npx tsc --noEmit --incremental false` passed after the temporary browser harness was removed.
- **Production build:** `npm run build` passed. Vite reported a bundle-size warning (the main client chunk exceeds 500 kB); build output was generated successfully.
- **Isolated browser QA:** a temporary local React harness with 101 synthetic listings and intercepted network fixtures passed twice in headless Chrome. It exercised 50-row pagination/search, drawer/gallery, non-executable descriptions, quantity defaulting to one pack rather than available stock, explicit estimates and fee breakdowns, result clearing on scenario edits, unavailable/error/retry behavior, and an in-flight response after a store switch. No browser errors were recorded. Desktop and 390-pixel mobile screenshots were visually inspected; the mobile drawer had no horizontal overflow. The harness and local server were removed after testing.
- **Scale boundary:** component/helper tests supplied 10,000 synthetic preview rows and verified at most 50 table rows are mounted. This bounds rendered UI rows; it does not prove server-side preview generation or payload transfer at that size.
- **Database/CI limitations:** no disposable test database URL or disposable-test flag was configured. Database interactions were verified with fakes, not live PostgreSQL. No remote CI, production data, eBay publication, carrier call, wallet mutation, or live configuration change was performed.

## Deployment smoke test

1. Generate a fresh preview for a selected listing and open **View preview**. Compare title, pack/SKU, price, effective policies, and included image order with the catalog and intended eBay listing. Authenticated catalog-only images must remain labeled as not included.
2. Compare the per-pack vendor product cost with catalog retail and the configured Dropship channel discount. Missing source data must display unavailable, not zero.
3. Enter a supported destination and purchase quantity; request an estimate. Compare the rate source and fee breakdown with the applicable configured Card Shellz rate table. Change quantity/destination and verify the prior estimate clears; exercise an unsupported/no-rate scenario.
4. Close/reopen or switch stores during an estimate and confirm no result from the previous scenario appears. Confirm saved listing values, wallet balances, orders, and marketplace listings are unchanged.
5. Test a scoped catalog file with a different member/store and confirm it cannot be read. Check real data scale separately from the local bounded-render test.

Suggested pricing is deliberately absent. Catalog reference retail is labeled as a reference, not a recommendation, and file-only preview media is not made publicly fetchable by eBay.
