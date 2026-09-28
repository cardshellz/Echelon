# ATP cutover: reuse existing listing identities

## Outcome and boundaries

This change removes the requirement to manually recreate mappings for listings Echelon already knows how to update. Preparation copies missing internal identity snapshots from those existing records, in the same audited transaction as initial publication membership. It does not create, replace, or edit provider listings.

It does **not** activate canonical inventory/ATP, change stock, enqueue inventory updates, or call Shopify/eBay. Deploying migration `0715_inventory_existing_listing_scope.sql` changes database guards only. Running preparation later changes preview configuration, missing draft identity snapshots, membership, and audit evidence; that remains a separate production action.

## Confirmed code trace

| Step | Evidence | Consequence |
| --- | --- | --- |
| Existing eBay quantity writer selects `listingExternalSku`, then `channelSku`. | `EchelonSyncOrchestrator.executeInventorySync`, [echelon-sync-orchestrator.service.ts:523](../server/modules/channels/echelon-sync-orchestrator.service.ts#L523); `getNonShopifyInventorySyncStates`, line 1636. | A null Shopify-style feed inventory ID does not mean an eBay listing lacks an identity. |
| Canonical eBay transport uses the exact inventory-item key, with an optional agreeing SKU. | `exactEbayInventoryItemKey`, [ebay.adapter.ts:1098](../server/modules/channels/adapters/ebay.adapter.ts#L1098). | eBay seller SKU is the inventory-item key; an offer or listing ID is not interchangeable with it. |
| Existing Shopify writer skips quarantined feeds, inactive/missing feeds, and missing inventory-item IDs. | `EchelonSyncOrchestrator.executeInventorySync`, [echelon-sync-orchestrator.service.ts:853](../server/modules/channels/echelon-sync-orchestrator.service.ts#L853). | Cutover must retain those skips, not turn them into a requirement to relink every old record or publish zero. |
| Initial-scope reader now takes existing channel listing SKU precedence and includes listing-only eBay identities. | `readInitialPublicationScopeFacts`, [inventory-publication-initial-scope.reader.ts:36](../server/modules/inventory-planning/infrastructure/inventory-publication-initial-scope.reader.ts#L36), specifically lines 66-96. | No manual duplicate mapping setup and no catalog-SKU guess. Shopify continues using its saved inventory-item ID. |
| Review distinguishes absent snapshots from conflicting or orphaned history. | `reviewInitialPublicationScope`, [inventory-publication-initial-scope.ts:39](../server/modules/inventory-planning/domain/inventory-publication-initial-scope.ts#L39), specifically lines 103-125. | Import only when there is no selected mapping, no history, and no existing head. Sources and ownership must agree. Existing snapshots are never overwritten. |
| Preparation revalidates under the authority fence and source-table locks, then writes one transaction. | `PostgresInitialPublicationScopeStore.prepare`, [inventory-publication-initial-scope.repository.ts:22](../server/modules/inventory-planning/infrastructure/inventory-publication-initial-scope.repository.ts#L22); `importExistingListingMappings`, line 84. | A stale review, competing command, failed insert, or missing audit rolls back the operation. Identical retries return the stored receipt. |
| Actual publication still calls the existing channel adapter with the desired quantity. | `ChannelInventoryPublicationTransportAdapter.publishAbsolute`, [channel-inventory-publication-transport.adapter.ts:28](../server/modules/channels/channel-inventory-publication-transport.adapter.ts#L28). | This is an existing-listing quantity update, not a new listing-publication project or another ATP engine. This transport is unchanged by the fix. |

The previous initial-scope implementation read `channel_inventory_item_id` for both providers and required a separately selected internal mapping before proceeding. These two checks caused false failures for existing eBay listings and missing internal snapshots.

## Controls retained

- Automatic exclusions are derived only from saved evidence: inactive/non-sellable catalog entries, entirely quarantined legacy feeds, or Shopify legacy feeds without an inventory-item ID. They are visible in the review, fingerprint, membership decisions, receipt, and audit.
- The request still permits only the already-supported explicit `unsupported_bundle` exclusion. Callers cannot inject identity imports or automatic exclusion reasons. See [inventory-publication-initial-scope.ts](../shared/types/inventory-publication-initial-scope.ts).
- A registered owner contradicting a feed, a conflicting inventory identity, missing ownership/history evidence, or an uncertain provider outcome still fails closed. No error is converted into an arbitrary SKU exclusion.
- Exact source identities and owner provenance are sealed into the review hash. Source changes require a new review.
- Draft snapshots remain inactive. The deferred database guard verifies the imported identity, actor, command, and draft head against the receipt before commit. See [migration 0715](../migrations/0715_inventory_existing_listing_scope.sql).

## Read-only production replay

At **2026-09-28T23:09:25.956Z**, the patched reader and pure review function were run against production in a repeatable-read, read-only transaction. No preparation, provider call, activation, or quantity write was performed.

| Target | Result with corrected review |
| --- | --- |
| Shopify US, target 1/channel 36 | Scope review ready: 204 included stock SKUs; 11 missing identity snapshots can be imported automatically. Nine saved legacy skips remain excluded. This is scope readiness, not proof of full cutover readiness. |
| Direct eBay, target 3/channel 67 | 192 included SKUs; no mapping failures; 12 missing snapshots can be imported automatically. Previously approved unsupported bundles 406 and 409 remain excluded. One unresolved listing-owner operation still blocks scope preparation. |
| Dropship, target 4/channel 103 | One failed listing remains uncertain with no exact provider identity; it is not silently treated as an empty destination. |

Shopify automatic exclusions in that observation: inactive variants 13, 14, 35; quarantined variant 100; missing provider inventory IDs for variants 205, 208, 463, 464, 509. These are not inventory adjustments and do not delete or change the provider listings.

### Two real unresolved operations, not mapping setup work

Follow-up read-only database inspection established:

1. **Direct eBay:** planned publication 6 in scope 1 has replacement operation 5 in `manual_recovery_required`, with four attempts, phase `compensate`, and error `MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR`. It is not proven to be an untouched draft. The existing pending-publication guard remains in place (`readRegisteredMembers`, reader lines 146 and 171).
2. **Dropship:** listing 1, variant 66 (`ARM-ENV-SGL-P50`), has failed push attempts and no external listing ID. The latest observed job item reported HTTP 400, eBay error 25709: `Invalid value for header Accept-Language.` The listing worker can fail after entering the provider flow, so `failed` alone does not establish that no partial provider action occurred. See `DropshipListingPushWorkerService` provider-push/complete/fail path in [dropship-listing-push-worker-service.ts](../server/modules/dropship/application/dropship-listing-push-worker-service.ts).

Those records were not modified. Their external provider state is **not proven** by this replay. Required next checks are owner-specific reconciliation of the eBay replacement and the Dropship failed push, not another whole-catalog remapping exercise. No cause beyond the recorded error codes is inferred here.

During final validation, `origin/main` advanced to `ee04fea4f` and independently included PR #1589's Dropship eBay header fix (`ebaySellRequestHeaders` in [ebay-sell-headers.ts](../server/modules/dropship/infrastructure/ebay-sell-headers.ts)). That is another workstream's change, not part of this fix. Its merge does not prove that the previously failed listing has been retried or reconciled in production.

## Validation

- Inventory-planning unit suite plus migration-prefix, PostgreSQL-manifest, and writer-ratchet guards: **142 files / 2,184 tests passed**.
- Existing Shopify/eBay adapter tests: **84 passed**; Dropship eBay inventory-publication adapter tests: **16 passed**.
- Real disposable PostgreSQL initial-scope suite: **42 passed**, including concurrent identical retries, competing commands, stale identities, downstream readback selection, retained skips, unresolved planned publication, failed Dropship listing, injected write/audit failures, omitted writes, and deferred identity-tampering rejection.
- Application and test TypeScript checks passed; no client UI was changed.

The PostgreSQL fixture uses the real inventory/membership/fence/receipt migrations and reduced read fixtures for other modules. It proves this preparation transaction, not the complete external listing-replacement workflow. Tests do not prove deployment, external provider success, or final ATP activation.

## Deployment and remaining authority

Merge and deploy this code without activation. A fresh review can then prepare supported preview destinations using existing identities once their genuine unresolved operations are reconciled. Final production ATP cutover remains separately approved. Canada/3PL configuration, inventory balances, reservations, recipes, channel throttles, listing contents, and provider quantities were not changed by this work.
