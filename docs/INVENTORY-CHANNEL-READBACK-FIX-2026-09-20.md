# Inventory channel quantity/readback correction

Date: 2026-09-20. Implementation base: refreshed `origin/main` at `ca8fd25e9efd5a8a03ac6279ac7b011c50f7e056`.

Branch: `codex/inventory-channel-readback-fix-20260920`. This is a provider-adapter correction, **not a new ATP engine, inventory cutover, or production activation**.

## What the code definitely does

| Boundary | Confirmed behavior after this change | Evidence |
| --- | --- | --- |
| Shopify exact-target readback | Requires exactly one matching inventory item/location and a numeric, nonnegative safe integer. Null, booleans, numeric strings, wrong identities and duplicates are errors, never successful zero observations. | [`ShopifyAdapter.readInventory`](../server/modules/channels/adapters/shopify.adapter.ts#L224); actual-adapter transport tests in [`channel-inventory-provider-readback.test.ts`](../server/modules/channels/__tests__/unit/channel-inventory-provider-readback.test.ts) |
| Shopify whole-location evidence | Preserves untracked items as null. `externalInventory` reports unmapped untracked items separately in `unavailableItems`; a mapped untracked item blocks the result. The pre-existing strict `inventory` method still rejects any untracked quantity. | [`ShopifyIdentityReader.inventory` / `inventoryLevels`](../server/modules/channels/adapters/shopify-identity.reader.ts#L67), [`ChannelIdentityService.externalInventory`](../server/modules/channels/channel-identity.service.ts#L72) |
| Shopify pagination | Uses the actual served version from `X-Shopify-API-Version`, pins it for the scan, and constructs subsequent requests on the configured store. Rejects foreign hosts/paths, invalid or changing versions, duplicate cursors and ambiguous next links. | [`ShopifyIdentityReader.inventoryLevels`](../server/modules/channels/adapters/shopify-identity.reader.ts#L78), [`channel-identity.test.ts`](../server/modules/channels/__tests__/unit/channel-identity.test.ts) |
| Shared eBay offer resolution | Bounded, complete discovery must resolve exactly one published offer for the exact SKU and configured marketplace. Drafts are not published; missing/ambiguous offers do not authorize a quantity write. | [`publishedOffer`](../server/modules/channels/adapters/ebay/ebay-inventory-quantity.ts#L45) |
| eBay canonical publication | Updates both the inventory-item quantity and published-offer quantity in one quantity-only bulk request. Checks the exact per-offer acknowledgement. Does not replace product metadata, create/relist offers, pick the first offer, or fall back to item-only PUT. | [`publishEbayInventoryQuantity`](../server/modules/channels/adapters/ebay/ebay-inventory-quantity.ts#L106), [`EbayAdapter.pushCanonicalInventory`](../server/modules/channels/adapters/ebay.adapter.ts#L456) |
| eBay canonical readback | Validates the returned SKU and both numeric quantities. Reports the lower provider limit and retains both observations plus the offer identity. | [`readEbayInventoryQuantity`](../server/modules/channels/adapters/ebay/ebay-inventory-quantity.ts#L86), [`EbayAdapter.readInventory`](../server/modules/channels/adapters/ebay.adapter.ts#L410) |
| Dropship eBay | Uses the same quantity protocol while retaining its own store connection, token refresh, verified account checks and credential-health handling. Quantity mutation still runs through the existing request-evidence collector; read requests are bounded and do not follow redirects. | [`EbayDropshipInventoryPublicationTransportAdapter.publishAbsolute` / `readAbsolute` / `quantityClient`](../server/modules/dropship/infrastructure/dropship-ebay-inventory-publication.adapter.ts#L102) |
| Failure propagation | Preserves nonretryable adapter readback errors through the exact-destination transport. A failed result is not treated as a valid zero observation. | [`ChannelInventoryPublicationTransportAdapter.readAbsolute`](../server/modules/channels/channel-inventory-publication-transport.adapter.ts#L57) |

The eBay minimum is a **provider quantity cap**, not another ATP calculation. Example: item quantity 50 and offer quantity 38 yield an observed provider quantity of 38. Publishing the already calculated absolute quantity 7 sets both fields to 7. eBay documents the interaction in its [bulk quantity update guide](https://developer.ebay.com/api-docs/sell/static/inventory/bulk-updates.html). Shopify documents null availability for untracked items in [InventoryLevel](https://shopify.dev/docs/api/admin-rest/2025-10/resources/inventorylevel), and the effective response-version header in [API versioning](https://shopify.dev/docs/api/admin-rest/usage/versioning).

## Unchanged authority and assumptions

- `desiredQuantity` is still supplied by the existing canonical planner/exposure/outbox flow; no ATP, safety-stock, warehouse-eligibility or channel-dial formula was edited. The port explicitly prohibits adapter recalculation: [`InventoryPublicationTransportAdapter`](../server/modules/inventory-planning/application/inventory-publication-transport.ts#L53).
- Existing no-context legacy eBay publishing remains on its legacy branch. This change fixes the canonical exact-target path; it does not retire the old allocator or activate its replacement: [`EbayAdapter.pushInventory`](../server/modules/channels/adapters/ebay.adapter.ts#L235).
- The existing configured marketplace is used: Channels `metadata.siteId`, Dropship `credential.config.marketplaceId`, with the existing `EBAY_US` default when absent. No marketplace, warehouse or provider-account configuration is changed.
- No schema migration, inventory movement, recipe, reservation, order, persisted preview/readback, mapping activation, target activation, Shopify quantity or channel setting was changed by this work. Tests use mocked external services. Unrelated work in the main checkout is excluded.

## Failure modes and remaining limits

1. Missing or multiple published eBay offers stop the operation with an explicit nonretryable ambiguity error. An operator must correct the identity/listing configuration; this adapter does not create a listing to conceal the issue.
2. Malformed, untracked or incomplete quantity evidence remains an error/unknown, not zero. No partial whole-location result is returned after an invalid page.
3. A lost write response or incomplete acknowledgement does not cause a second writer/fallback inside this protocol. Existing durable reconciliation remains responsible for uncertain outcomes. Existing suppression/admission checks remain in the actual eBay HTTP-client path.
4. eBay item and offer GETs are separate observations, not a provider-transaction snapshot. Concurrent orders/provider changes can still change quantities between requests. This change does not claim otherwise.
5. A provider quantity observation is not proof that a listing is purchasable under every marketplace/account policy, nor that physical warehouse counts are accurate.

## Validation

- `npm run check`: passed with the lockfile-matching direct dependencies.
- `npm run check:tests`: passed, including server and client test typing.
- Focused Channels, Dropship eBay, canonical transport and runtime-routing suite: **890 tests / 58 files passed**.
- Full local Vitest result: **15,857 passed, 1,434 skipped, zero failed; 1,329 files passed / 96 skipped**. The skipped database-dependent coverage was not executed; it remains a CI/disposable-database check, not production proof. Machine-readable local result: `test-results/inventory-channel-readback-vitest.json` (ignored test artifact).
- Added protocol, actual-adapter transport and actual-HTTP-client-with-mocked-network regression coverage: strict numeric validation; exact scope; duplicate/missing offers; bounded complete pagination; absolute zero/nonzero publication; both eBay limits; exact acknowledgements; no item replacement/fallback; suppression; uncertain write evidence; Shopify effective API versions and unmapped-vs-mapped untracked items.
- Local test setup was corrected without dependency/package changes: the initial shared install had newer packages than the lockfile. The final dependency junction uses an existing install whose 112 direct dependencies match the lockfile. Five untouched source files were temporarily formatted to Git's LF content because their existing text-contract tests assume Linux line endings; their original local CRLF formatting was restored afterward. They do not appear in the code diff.

## What is not proven / next checks

- This branch has not been deployed, activated, or tested by writing live provider quantities. Local tests do not establish production activation or quantity correctness.
- The previous production inventory/mapping observations were not refreshed here. They must not be presented as a current capture.
- Review this isolated patch, run PR CI, then deploy through the normal process. Re-run the read-only provider/planner comparison with the corrected adapters before considering any separately approved activation.
- Warehouse selection and the remaining physical/planner discrepancy review are separate from these adapter defects. Do not change warehouse inclusion or promise extra inventory to force comparisons to match.
