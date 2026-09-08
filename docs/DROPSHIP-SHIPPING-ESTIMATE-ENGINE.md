# Shipping estimate: engine integration and customer privacy

2026-09-08. Implemented on `codex/dropship-shipping-estimate-engine`; not deployed by this work. This is a pricing-source cutover, not a new rate card or a change to configured rate amounts.

## Confirmed cause

`readDropshipShippingCutoverConfig` in `server/modules/dropship/application/dropship-shipping-cutover-policy.ts` previously defaulted to `legacy`. Read-only deployment inspection confirmed `DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE` was unset. Consequently, `createDropshipShippingPricingProviderFromEnv` in `server/modules/dropship/infrastructure/dropship-shipping-quote.factory.ts` selected `CachedRateTableDropshipShippingRateProvider`, not the configured shared engine.

`CutoverDropshipShippingPricingProvider.quoteLegacy` in `application/dropship-shipping-pricing-service.ts` calls `assertEveryPackageHasRate`. That is the source of the exact reported error, `Active dropship shipping rate data is required before quoting shipping.` The two-pack carton weighed 1,225 grams and had no matching legacy rate. A one-pack carton weighed 635 grams and returned 824 cents including fees. The real shared engine successfully rated both cartons; this was not evidence that the configured shared rate card was missing.

Separately, the estimate form marked state/region optional, whereas the shared engine's `quoteShipmentRates` in `server/modules/shipping-engine/application/rate-quote.service.ts` requires a two-letter state. The form and input schema now require it. No state is guessed from the postal code.

The earlier fee-removal work was found uncommitted in another worktree. It was not in this branch's mainline base. Its intended privacy change was reapplied here; unrelated work in that checkout was preserved.

## Execution path and changes

1. `DropshipListingShippingEstimate` in `client/src/pages/dropship/DropshipListingShippingEstimate.tsx` submits explicit purchase quantity, country, region, postal code, store, and variant. One unit is one sellable pack, not one individual item inside the pack. Editing a scenario clears the previous estimate.
2. `registerDropshipListingShippingEstimateRoutes` in `server/modules/dropship/interfaces/http/dropship-listing-shipping-estimate.routes.ts` requires an authenticated member, rate-limits requests, and validates the strict public response. Invalid internal results cannot be serialized. Internal failures return a generic message, not provider diagnostics.
3. `DropshipListingShippingEstimateService.estimateForMember` checks store ownership, entitlement, catalog exposure/selection, and the configured fulfillment warehouse. Its calculation dependency has only read methods, not snapshot, order, wallet, or marketplace writers.
4. Both `createDropshipListingShippingEstimateServiceFromEnv` and `createDropshipShippingQuoteServiceFromEnv` call the same `createDropshipShippingPricingProviderFromEnv`. Missing mode now defaults to `live` (shared engine). Explicit `legacy` and store-scoped `test` settings still work. Invalid settings block quotes and log a configuration error; they never silently select another pricing authority or crash app startup.
5. `calculateDropshipShippingQuote` in `application/dropship-shipping-quote-service.ts` uses actual cartonization, passes the exact pack quantity and carton weights, and applies existing markup/insurance rules in integer cents. Its fee calculations were not changed.
6. `SharedEngineDropshipShippingQuoteProvider.quote` in `infrastructure/shared-engine-dropship-shipping.provider.ts` resolves warehouse/channel policy and calls canonical `quoteShipment` using pricing channel `dropship`, purpose `vendor_fulfillment_charge`, and the existing Standard service selection. The engine resolves the configured pricing program/rate card. No rate amount or rate-book ID was hardcoded into runtime code.
7. `listingShippingEstimateResultSchema` in `shared/dropship/listing-shipping-estimate.ts` permits only the final total/currency, requested scenario, timestamp, and allowlisted customer messages. Rate-table/book IDs, base charge, markup, insurance, dunnage, warehouse/package internals, and raw warnings are excluded from the customer API as well as the UI. Server-side warnings retain scenario and diagnostic context. Existing order quote snapshots retain their private calculation evidence.

## Current-data proof

At **2026-09-08 21:06:47 UTC**, a local diagnostic used current production data with PostgreSQL `default_transaction_read_only=on` enforced for the connection and verified with `SHOW`. It performed reads and pure calculations only. Store 1, configured warehouse 1, variant 66 (`ARM-ENV-SGL-P50`), destination US / PA / 16046:

| Quantity in packs | Carton weights, grams | Explicit legacy path | Fixed default path |
| --- | --- | --- | --- |
| 1 | 635 | 824 cents | 719 cents |
| 2 | 1,225 | Missing legacy rate | 719 cents |
| 5 | 1,225; 1,225; 635 | Missing legacy rate | 925 cents |

The fixed path reported source `shared`, selected pricing program 34 and rate table 5. Its channel-routing metadata reported `legacy_profile`, meaning the channel-policy fallback profile; that is distinct from the obsolete dropship rate provider. The actual selected rate source was the shared engine.

The diagnostic also called the complete `createDropshipListingShippingEstimateServiceFromEnv().estimateForMember` path with the mode unset for all three quantities. Each returned `status: estimated`, the totals above, USD, the correct scenario, and no warnings or private pricing fields. This proves the configured origin/catalog/rate resolution for these exact scenarios. It does not prove every destination or product.

No production configuration, rate table, credential, listing, order, quote snapshot, reservation, wallet balance, or ledger entry was changed. No eBay or carrier-purchase operation was called. Diagnostic credentials and script are not committed.

## Test coverage

- Broad dropship/shipping-engine unit, application, HTTP, client component, and writer-ownership checks: 223 files / 2,023 tests. Includes the historical legacy quantity failure and new runtime-factory tests for quantities 1, 2, and 5, explicit overrides, invalid settings, missing shared coverage, and shared-engine errors without legacy fallback.
- Disposable PostgreSQL: 7 files / 102 tests passed across dropship and shipping-provider integrations; the dedicated local database was stopped afterward.
- Desktop/mobile browser suite: 40 tests passed. Includes required region, quantity changes, stale-total clearing, unavailable/error/retry behavior, rejected private-field responses, no fee breakdown, and no horizontal overflow. Browser quote amounts are synthetic fixtures, not the current-data amounts above. Screenshots were visually inspected.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run build`: passed; Vite reports its large-bundle warning.
- Local checks are not remote CI or a deployed-production smoke test.

## Assumptions, risks, and failure modes

- No pricing amount, pack conversion, postal-to-state mapping, or new rate table was inferred. The existing shipping engine and saved configuration remain the authority.
- Deployment changes new quote amounts where shared pricing differs from legacy pricing. Estimates and new order quotes use the same decision. `DropshipShippingQuoteService.executeQuote` still owns persisted quote idempotency; existing snapshots are not rewritten by this change.
- An explicit deployment `legacy` override intentionally retains old behavior. The inspected deployment had no such override. Invalid configuration blocks quotes instead of charging an unintended amount.
- Missing weights, origin, fee policy, eligible Standard service, or rate coverage remains unavailable. There is no guessed zero quote or automatic fallback to an obsolete rate. Private diagnostics remain in logs.
- Deploy matching client/server assets together. An already-open old client may reject the narrowed response until it loads the new bundle. Private fields are not retained for old clients.
- This privacy boundary covers listing shipping estimates. It is not a claim that every other customer-facing order or billing surface was audited.

## Deployment smoke test

1. Load the deployed client, open this listing preview, and enter US / PA / 16046.
2. Estimate quantities 1, 2, and 5; confirm success using current configured rates. Re-read rate data if comparing after rates have changed.
3. Confirm changing quantity/destination removes the old result before estimating again.
4. Confirm the UI has only the estimated total/scenario and the HTTP response contains no breakdown, rate-book/table identity, or internal diagnostics.
5. Test a no-coverage scenario: unavailable, no stale amount, safe retry. Inspect private logs for the reason.
6. Separately verify an authorized new order's quote before enabling live purchases; this work did not place or debit an order.
