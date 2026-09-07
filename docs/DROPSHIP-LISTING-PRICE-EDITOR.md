# Persisted vendor listing prices

## User workflow

In the vendor portal, generate a listing preview and choose **Edit price** in its table row or **View preview** to edit in the drawer. Both surfaces use the same editor and persisted setting. Uncheck **Use catalog default** to enter an override, then choose **Save listing price**. Checking the default option and saving creates an explicit reset. Canceling an unsaved edit changes nothing.

The price is USD per sellable pack. It is the vendor's selling price, not the vendor's product cost, a shipping charge, or a suggested retail price. Suggested pricing remains deferred. The old unsaved Retail price input in Available catalog is removed so the UI has one price-editing authority.

Saving updates only local draft settings. It does not publish, alter an existing eBay listing, create a listing-push job, request MFA, or debit the wallet. The drawer remains open while the preview regenerates. Queue is disabled until a fresh preview succeeds. A confirmed write followed by a failed refresh offers a read-only retry, not another save.

## Price authority and persistence

- `shared/dropship/listing-price.ts::resolveListingPrice`: legacy request override (applied by preview) precedes the saved draft setting; absent a draft setting, the prior listing price precedes catalog retail.
- A saved null setting explicitly selects catalog retail and never resurrects the old listing price. Existing listings without a new setting retain their prior behavior.
- `DropshipListingPriceService` validates input/output and vendor/store/catalog authority. Local saves permit recoverable connection statuses (`connected`, `needs_reauth`, `refresh_failed`), not paused/disconnected connections. Active entitlement and selected, exposed variants are required; existing publication gates remain unchanged.
- `PgDropshipListingPriceRepository` owns the transaction. Settings are scoped by store and variant, with owner foreign keys, immutable revisions, predecessor checks, optimistic revision comparison, member-scoped requests, and before/after audit events. Reusing a key with different intent is rejected. Retrying the same key replays its recorded result without overwriting a later revision.
- Migration `0657_dropship_listing_price_settings.sql` creates settings/revision tables and guards. It does not backfill or rewrite queued/published listing state.

## HTTP contract

GET/PUT `/api/dropship/listings/stores/:storeConnectionId/variants/:productVariantId/price` require the existing dropship session. PUT accepts `priceCents` (positive integer cents or null), `expectedRevisionId` (positive integer or null), and `idempotencyKey`. The maximum cents value is the existing PostgreSQL integer storage bound, not a pricing recommendation. Responses are non-cacheable, and saves are rate limited.

Preview reads saved settings in a batch. The current client sends the displayed price revision and effective cents when queueing; a different saved revision or catalog-default price requires a fresh preview. Queue creation rechecks the local revision under the same store lock as price saves before creating immutable job snapshots. This does not rewrite already queued jobs or guarantee that unrelated listing content, quantity, or policy settings remain unchanged after preview.

Older API callers may still submit requested prices or omit the new expected-price maps for compatibility. The updated portal does not use transient requested-price overrides.

## Verification and release checks

Automated coverage includes exact decimal parsing, invalid/zero/overflow prices, reset and legacy fallback semantics, ownership/status/selection gates, version conflicts, stable idempotent retries, preview precedence, and reviewed-price queue checks. PostgreSQL integration executes the new migration and exercises concurrency, audit rollback, immutable history, and ownership/coherence constraints in an isolated disposable database. CI runs the new database suite.

The browser acceptance checks use the real catalog/preview/editor components with synthetic intercepted API data; they do not prove deployed API or eBay behavior.

Validated locally on September 6, 2026:

- Broader dropship/client regression run: 156 files, 1,363 tests passed, including writer-ratchet and migration-prefix guards.
- New PostgreSQL integration suite: 12 tests passed against an isolated PostgreSQL 17 cluster, including actual migration execution, concurrent writers/retries, audit rollback, queue-race rejection, and queued-snapshot immutability. The generated cluster was stopped and removed afterward.
- Headless Chrome: 11 synthetic workflow checks passed; desktop/mobile screenshots reviewed. No page errors, live requests, or user-session access.
- Non-incremental TypeScript and production build passed. The build reports the existing large-client-chunk warning.
- Independent final scoped review found no introduced blocker; its focused 168-test run and diff whitespace check passed.

No deployment or live seller-price change was performed during implementation or validation. A completed queue request retried after later price/config changes may return a conflict instead of the old job, consistent with the existing regenerate-before-replay behavior; it does not create a duplicate job. Unchanged retries are covered.

After deployment:

1. Preview one selected variant, open its drawer, and save an explicit price. Confirm the drawer stays open and both saved price and preview price update.
2. Reload the page and generate a preview. Confirm the same store/variant retains the saved override; another store must not inherit it.
3. Check Use catalog default and save. Confirm the preview uses current catalog retail, including for an already listed item.
4. Open the same listing in two tabs. Save in one, then attempt an older edit or queue from the other. Confirm a conflict requires reloading/previewing.
5. A price saved while policy/price validation blocks publication must remain editable, but must not bypass publication blockers.
6. Verify no eBay listing is changed merely by saving. Queueing remains a separate explicit action with its existing verification requirements.

## Separate known work

The `.ops` preview product-cost lookup is corrected separately in [the product-cost contract](DROPSHIP-OPS-PRODUCT-COST.md). Product cost and selling price remain separate authorities. This editor does not change eBay authorization, add suggested-price calculation, automatic repricing, shipping-charge edits, or bulk price changes.
