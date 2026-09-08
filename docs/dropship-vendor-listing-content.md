# Vendor-owned listing descriptions

## Summary of changes

The existing Catalog workflow now supports a description draft per store and product variant, plus reusable store/group introductions and footers. No new navigation item, catalog mutation, or automatic marketplace update is introduced.

- `DropshipListingContentService.getForMember / previewForMember / saveForMember` in `server/modules/dropship/application/dropship-listing-content-service.ts` authorizes the member, store, exposure and selection before accessing a listing draft.
- `resolveListingContent` in `server/modules/dropship/application/dropship-listing-content-resolver.ts` composes introduction + listing body + catalog-owned product details + footer. It is the source of the exact HTML passed into the marketplace listing intent.
- `DropshipContentTemplatesPanel` in `client/src/pages/dropship/DropshipContentTemplatesPanel.tsx` lives in Catalog. `DropshipListingContentEditor` lives inside the existing listing preview drawer.
- `PgDropshipListingContentRepository.execute` in `server/modules/dropship/infrastructure/dropship-listing-content.repository.ts` writes immutable revisions, the current pointer and before/after audit in one transaction. Saves share the store advisory lock used by queue creation.
- `generatePreviewForContext / createListingPushJob` in `server/modules/dropship/application/dropship-listing-preview-service.ts` compile current content and require the browser's reviewed content hash. `PgDropshipListingPreviewRepository.createListingPushJob` rechecks it under the queue transaction, with catalog row/membership locks, before storing the immutable payload.
- Existing eBay `buildDropshipEbayListingDraft` in `server/modules/dropship/infrastructure/dropship-ebay-listing-push.provider.ts` consumes that intent description through `descriptionHtmlOverride`. No new direct eBay write path exists.

## Authoring decisions and limits

These are application choices, not claims about marketplace limits:

- Vendor-authored descriptions are plain text (20,000 characters); paragraphs and line breaks are preserved. HTML entered by a vendor is literal text.
- Inherited catalog HTML preserves only basic formatting through a strict server sanitizer: paragraphs, simple headings/lists/tables, no attributes, links, images, scripts or styles. Listing images remain in the existing image pipeline.
- The description box has Edit and Reset directly beneath it. Edit replaces the preview with a text box and Save/Cancel/Reset. Opening Edit alone does not create an override or change catalog formatting; typing creates the local custom draft. Save returns to the rendered description.
- Reset stages the current catalog body and formatting; Save applies it, and Cancel retains the saved description. Store/group templates still apply. Formatting explanations and product facts are in collapsed Description details; retry/reconciliation controls appear only when needed.
- Introduction and footer are each limited to 4,000 characters. A profile supports 100 groups and 10,000 total named-listing assignments. Category, product-line and product groups avoid large explicit ID lists.
- One winning group replaces the default wrapper, never stacks with it. Lowest priority number wins; an equal-priority tie blocks affected previews.
- Shared profile hashes and named-group membership sets are prepared once per batch. Individual editor bodies are loaded on demand. Catalog selectors retain the existing keyset scan and 50-choice pages; named target discovery retains the existing 10,000-selected-item ceiling. Existing publication requests retain their separate batch cap.
- The assembled HTML is capped at 200,000 characters. Oversized/empty content is blocked, not silently truncated.
- The browser renders sanitized HTML in an opaque, scriptless, network-blocked sandboxed frame. Marketplace styling can differ.

## Integrity and failure modes

- Null custom text means inherit; a reset is still an audited revision.
- Saving a description checks listing revision, catalog facts/description hash and template revision. A stale tab gets an explicit conflict.
- When catalog facts change, custom text is retained, but publication is blocked until the vendor reviews and saves an acknowledgement or resets.
- Product fields such as SKU, pack size, condition and item specifics remain catalog-owned. The editable prose is **not** semantically verified: vendors remain responsible for truthful claims and consistency with accepted policies.
- Ambiguous save responses keep the original retry key and disable edits until retry/reload. Old retries never roll back a newer draft.
- A successful save followed by failed preview refresh offers read-only recovery; it does not issue a second new write.
- Pending writes invalidate the parent preview and block queueing. A later queue request must carry the exact reviewed content evidence. Old browser tabs without content evidence must refresh.
- Already queued jobs remain frozen. Subsequent local edits do not rewrite or cancel them, and this feature does not add a content-only live-update endpoint. The existing explicit full-listing publication workflow remains the only publication path.
- Template changes do not fan out writes to every listing; they affect newly resolved local previews. Live listings remain untouched until explicitly queued.
- Free-text claim accuracy and a real eBay publication were not verified in this implementation. No live store writes were performed.

## Migration and rollback

Migration `0660_dropship_vendor_listing_content.sql` is additive: four tables, ownership/predecessor foreign keys, immutable revision triggers, and guarded current pointers. Apply it before starting the new application version. It does not backfill or alter catalog descriptions.

Rolling the application back leaves the additive tables intact, but the older application will not understand saved content overrides. Pause listing queue creation before rolling back if overrides have already been adopted. Do not delete revision/audit history.

## Test coverage

- `dropship-listing-content.test.ts`: safe compilation, malformed/active HTML, size limits, group precedence, deterministic 1,000-listing resolution, catalog-change review, ownership, token-health-independent local drafts, conflicts, replay and template saves.
- `dropship-listing-content.routes.test.ts`: authentication on every endpoint, no-store responses, strict field/target validation, public error classification, and malformed output rejection.
- `dropship-listing-preview-service.test.ts`: exact description intent, missing/stale evidence rejection, catalog review blockers, and fail-closed incomplete content reads.
- `dropship-listing-content.integration.test.ts`: real PostgreSQL migration syntax, simultaneous saves, idempotency, store isolation, immutable history, predecessor/FK enforcement and audit rollback.
- `dropship-listing-price.integration.test.ts`: description changes between preview/queue and frozen content after later edits, alongside the existing pricing transaction tests.
- `test/browser/dropship-content-editor.spec.ts`: desktop/mobile button placement/count, edit-save-cancel-reset, inherited formatting preservation, uncertain retries, conflict reconciliation, refresh recovery without another write, hidden template draft preservation, group selectors and open-preview refresh.
- Existing pricing browser journeys, full unit suite, typecheck, production build, writer-ratchet and migration-prefix guard are included in validation. Browser tests use synthetic local APIs, not customer data.

## Deployment acceptance test

1. Open Catalog, generate a fresh preview, and open one selected listing. Its description should inherit the catalog and show catalog-owned product details.
2. Click Edit beneath the description box, type, and Save. The text box should return to the rendered description, and the drawer and parent preview should refresh without a browser reload. No marketplace job should be created by saving. Repeat with Cancel and verify the saved description is unchanged.
3. Click Reset beneath the box. It should stage the catalog body without saving. Cancel should retain the custom description; repeat Reset then Save to restore the catalog body and formatting.
4. Add a store introduction/footer. Confirm it appears in a fresh listing preview without creating per-listing overrides.
5. Add a category/product-line/product/named-listing group, choose its priority, and save. Check a matching and nonmatching listing.
6. Open two tabs on the same listing. Save in one, then try saving the older draft in the other. It must require reconciliation and retain the unsaved text.
7. After reviewing title, images, description, price, policies and readiness, explicitly queue **one** listing through the normal verification flow. Check the resulting eBay description against the reviewed content before trying a larger batch.

The implementation is isolated in `codex/dropship-vendor-listing-content`; unrelated changes in the original checkout were not used.
