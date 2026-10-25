# Saved Club rewards alongside a checkout reward

## Scope and authority

An order can retain its original Club reward and use another saved Club reward on eligible added merchandise. Ordinary coupon admission, capped Shopify coupon handling, and the existing combination policy are unchanged.

- `ShopifyOrderEditCodes.rules` and `retainedNativeRewards` identify both codes through Club. The original reward is recognized without reserving or redeeming it again. Only the new reward is validated and claimed.
- `ShopifyOrderEditCodes.assertCombinations` uses the existing `assertOrderEditCodeCombinations` engine, including the original reward's product, order and shipping permissions. No settings or permissions are overridden.
- `priceOrderEditPreviewItems`, `priceOrderEditCodes`, and `allocateOrderEditNativeCodePricing` keep the original native allocation separate from the new reward budget. The original $7.23 face value cannot become another $7.23 discount after an item is added.
- `stageCodes` preserves checkout-discounted rows and applies the new saving only to editable real merchandise. Shopify refuses an extra manual discount on an original native-discounted row. This path never creates a dummy product or negative line.
- `orderEditQuoteSchema` and `mapOrderEditCodeLines` bind the retained amounts to the original rows and actual native allocations. Discount application indexes are response positions, not durable identities; readback and recovery compare the complete semantic rule and exact line amounts.
- Club remains the sole owner of points and reward settlement. Its `PostgresOrderEditCodeRedemptionStore.evidence` now reads edited line nets from verified quote financials, rather than Shopify's raw editable subtotal, which excludes native order allocations.
- The existing shared widget is reused. A verified zero merchandise total explains why rewards cannot cover shipping or tax. An unavailable calculation is represented separately from a verified zero.

## Recorded verification

[Native provider proof](saved-reward-stacking-staging-2026-10-20.json) records Echelon source `42992b0be1a3d79bb355207b3af720a6c1650882` and the matching Club proof records source `432a8881c010439f4f08c6561e9945c6986f0d62`.

The real Shopify test store and the real Club issuance, identity, reservation, release and finalization services were exercised with a disposable local PostgreSQL ledger. The acceptance runner is `scripts/verify-order-edit-reward-stacking.ts` in Club; it invokes this repository's `scripts/verify-preserved-reward-staging.ts` with the saved-reward test mode enabled. Both runners assert the test-store domain. The Club runner also requires an explicitly disposable database on localhost.

1. Seed the historical incident as synthetic data: $7.23 original reward, $2.79 originally applied, original reward already used.
2. Issue one $2.33 reward through the existing canonical issuer. The synthetic 277-point balance becomes 44 points once.
3. Preview and quote added merchandise with the original $2.79 allocation unchanged and only $2.33 in new applications.
4. Lose a reservation response after the durable claim. Prove no native commit occurred, release through the existing service, and repeat release safely.
5. Submit an unpaid edit. Refuse reward finalization while payment is unresolved.
6. Recover the unpaid edit, verify the original order's exact contents and total, and release the same reward. No extra point debit is created.
7. Retry with that same reward, settle the synthetic order with a manual test payment, and finalize twice. The new ledger has one completed -233 entry; the old -723 entry is unchanged. A subsequent validation of the used reward is rejected.
8. Delete every synthetic native fixture and restore test inventory from 50 to 50. No live order, live points balance, card payment or refund is changed.

Local checks passed: 680 order-edit unit tests; 90 disposable PostgreSQL order-edit tests; 219 Club tests including PostgreSQL concurrency and retry cases; 100 desktop/mobile editor browser tests; six real shared-widget tests; 57 compiled-theme account tests; application and test typechecks in both services.

The exact customer example, original $2.79 plus an extra item at the $2.33 Club price with a new $2.33 reward, is covered by the provider tests, including six-percent tax and the unchanged paid total. The native acceptance uses a real $885.95 catalog variant so that unpaid recovery can also be exercised. The test store supplies zero tax; that run proves native tax/total reconciliation, not live Pennsylvania tax configuration.

A separate read-only production check confirmed that the actual original reward is used, the saved $2.33 reward is pending, their native IDs match Club, and both codes permit product, order and shipping combinations. Active member pricing permits order discounts. This check did not change settings, orders or points. Live reward codes and credentials are deliberately excluded from this document.

## Release and limits

Deploy the companion Club fix first, Echelon second, and the rebuilt unpublished theme `174740308127` last. The theme build manifest pins the tested source and byte hashes. Do not activate the live theme or apply a real order edit as part of deployment.

The original native-discounted rows cannot carry another manual discount. If editable merchandise cannot carry the full saved reward, admission remains blocked and the reward remains available. Other combination restrictions, merchandise-only redemption, customer ownership, expiry, single use and settlement verification remain enforced.

No historical points correction is included. No live financial submission was performed. A rollback must account for in-flight operations containing the new optional native pricing evidence; do not run an older parser against those operations.
