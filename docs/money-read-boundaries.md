# Money read boundaries

Audit baseline: `719b60983453a5723f27d224953a536f30502b57`. Scope: numeric ingress from SQL, providers and forms; existing financial and pricing policies retain their owners. This change performs no historical correction or data migration.

## Source units and authority

`shared/money-read.ts` owns exact two-decimal amount conversion, integer-cent/mills reads, overflow checks, sums and decimal serialization. Source units are explicit: `readIntegerCents("100")` means 100 cents; `parseDecimalCents("100")` means 10,000 cents. Both accept the corresponding number representation without guessing units from its JavaScript type. Invalid, missing and unsafe amounts raise a classified `MoneyInputError`. Optional-field defaults remain explicit at callers.

| Source / consumer | Verified path and change |
| --- | --- |
| Shopify/eBay order ingress | `ShopifyChannelAdapter.mapShopifyOrder`, `EbayChannelAdapter.mapEbayOrder`, `oms-webhooks.ts` and `ebay-order-ingestion.ts` delegate decimal reads to the shared reader. Shopify adapter shipping, tax and allocation sums use checked cents. |
| Raw Shopify SQL to OMS | `bridgeShopifyOrderToOms` reads stored cent columns before adding line discounts. PostgreSQL text such as `"233"` plus `"46"` can no longer concatenate. Malformed or unsafe amounts stop before `ingestOrder`. |
| Reconciliation and line normalization | `shopify-order-reconciliation.ts` and `normalizeShopifyLineItems` use declared decimal units. Existing discount allocation, unit-price rounding and quantity ownership remain in those modules. |
| Order edits and customer refunds | `shopify-order-edit-money.cents` and `shopify-customer-refund.provider.ts` delegate to the shared conversion while retaining their existing provider/domain error codes. |
| Return Case SQL snapshots | `loadItemSnapshots` reads integer cents and translates invalid money to `RETURN_CASE_ITEM_MONEY_INVALID` before case writes. |
| Procurement, inventory, costs, wallets and reporting | Raw cent/mills conversions in repositories, services, command input adapters and operational scripts use declared-unit readers. Signed credits/adjustments remain explicitly permitted at their existing owners. Already exact BigInt/Decimal allocation and rounding policies remain in place. |
| Shipping and subscriptions | `parseProviderAmountCents`, storefront rate previews and subscription revenue aggregates distinguish provider decimals from integer cents. |
| Manual cost entry and recost | Cent-labelled entry fields use integer-cent readers. Per-piece dollar recost uses existing exact `dollarsToMills` with four-place precision and its established rounding policy, before invoking `recostLotPerPiece`. |
| Application guards and UI | `CentsSchema`/`PositiveCentsSchema` reject unsafe integers. Manual cost/deposit forms validate declared units before requests. Order display never turns a partially numeric string into a price. |

Mills in this repository mean 1/10,000 currency unit for per-piece costs. They must not be read as cents. Human `dollarsToCents` input retains formatted-input and truncation behavior, with exact signed sub-dollar conversion and bounds; provider amounts do not inherit that permissive form policy.

Numeric-dollar compatibility DTOs and Shopify/ShipStation numeric wire contracts are serialized after validation. `centsToJsonDollars` verifies a cent-exact numeric round-trip; it is not an arithmetic helper. Shopify's [draft discount input](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DraftOrderAppliedDiscountInput) declares `value` as `Float`.

## Regression prevention and limits

`server/__tests__/unit/money-read-boundaries.test.ts` runs the AST guard in `scripts/money-read-boundaries.mjs` across server, shared and operational-script source. It catches numeric coercions of monetary fields and float-to-cent multiplication. Exceptions are exact expressions with documented owners: bounded BigInt conversion in the existing mills helpers and listing recipe evaluator, and checked numeric-dollar serialization. IDs, versions, quantities, measurements and percentage rates are separate units.

This is a bounded source guard: generic aliases, implicit arithmetic coercion or a new external contract still require a traced review. It does not prove every financial policy or provider response correct. A malformed required amount now blocks processing instead of producing a rounded, partial or zero amount; that can expose previously hidden bad source data and requires correction at its source.

## Validation

- Full official unit lane passed 30,898 tests before the final additive guards/regressions; 4,900 focused tests passed after the boundary review, including procurement, money contracts, raw SQL text, invalid/overflow amounts and order edit compatibility.
- Application and test TypeScript checks, build and the official PostgreSQL shards are recorded separately in the change's validation results.
- The native Shopify development-store refund/cancellation recovery runner passed with one refund command, successful replay/recovery and fixture cleanup. It uses synthetic warehouse/rewards ports; PostgreSQL and Club settlement tests supply the separate database evidence.
- No existing customer order, payment, points balance or warehouse hold was changed during verification. Production acceptance requires a separately authorized release.
