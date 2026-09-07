# Shellz Club .ops product costs and inline listing prices

## Product-cost authority

`PgShellzClubProductCostAdapter.loadProductCosts` is a read-only membership-source adapter. Its input is the already authorized vendor plus a bounded batch of catalog variant IDs, not a plan or price supplied by the browser. It checks the vendor's entitlement-linked plan/subscription and dropship channel eligibility, then resolves exact catalog-to-Shopify identities. It never chooses a plan by tier, name, or a different newest subscription.

`resolveDropshipProductCost` follows the Shellz Club runtime source precedence: collection exclusion, active exact-variant override (`exclude`, `fixed_price`, or `flat_percent`), then explicitly configured plan/channel wholesale fallback. Exclusion means undiscounted retail. Fixed prices are decimal strings converted to integer cents; percentage rules subtract the rounded discount with BigInt arithmetic. The vendor's selling price is never an input. Inactive overrides do not apply, and duplicate active overrides do not select an arbitrary price.

Source reads share a repeatable-read, read-only transaction. The adapter returns source/plan/override provenance internally, with a source label exposed in preview economics. The membership override tables have no revision timestamp; this is a consistent current read, not a claim that the Shopify cache is freshly synchronized or that a price is locked for an order. Schema/connection failures remain unavailable with sanitized diagnostic context, never a fabricated zero or discount.

The legacy economics `channelDiscountPercent` field remains null for compatibility. It no longer drives the preview. Missing retail does not suppress a valid fixed product price. Invalid sellable-pack size still prevents presenting a per-pack cost.

## Inline selling-price edits

The table lazily opens one compact price editor at a time; it does not make one price request per listing. The modal and table reuse the same revision-aware, idempotent save implementation. Save updates the local draft price and regenerates preview; a confirmed save followed by failed preview refresh retries the read, not the write. Draft cancellation, catalog-default reset, stale-tab conflict, pending save, and uncertain-write retry retain their existing safety rules. Publication and wallet actions remain separate.

## Financial boundary and remaining work

**Do not treat this change as live-order acceptance approval.** `loadVendorContextForUpdate` and `mapListingCandidateRow` in `dropship-order-acceptance.repository.ts` still use the older partner-profile discount. That value feeds wholesale totals, wallet debit, and immutable acceptance snapshots. Connecting acceptance to the same `.ops` cost contract requires its own transaction, snapshot, concurrency, and wallet-charge tests. Browser preview cents must never authorize a debit.

The existing entitlement adapter can select a non-dropship subscription when a member holds multiple products. This cost reader rejects an incoherent/noneligible projected plan instead of silently selecting another one. Correcting upstream multi-subscription provisioning is separate work.

Suggested selling price remains deferred under DSP-PRICE-01. This change does not publish listings, update live eBay prices, alter membership prices, or modify wallet charging.

## Acceptance checks

1. Generate a new preview for an exact `.ops` fixed-price variant; compare product cost with its active Shellz Club plan price, not catalog retail or selling price.
2. Edit the selling price in the table and save. Confirm the refreshed table and modal agree while product cost is unchanged.
3. Edit in the modal, close it, and reopen the table editor. Confirm it loads the current saved revision.
4. Cancel an edit; reset to catalog default; test two-tab version conflict. None may silently overwrite a newer saved price.
5. Simulate saved-price success followed by preview failure: queue must remain disabled until read-only refresh succeeds.
6. Do not queue or accept real orders as part of these read/draft checks.

## Verification evidence (2026-09-07)

- Read-only database verification for `ARM-ENV-SGL-P50` found an active `.ops` fixed-price override of `8.09`. Executing the actual new adapter in a session forced read-only returned `status: available`, `unitCostCents: 809`, and `source: variant_fixed_price`. No source prices or other live state were changed.
- Broader dropship/portal regression suite: 152 files, 1,310 tests passed. The explicit price/preview client contract run passed 87 tests across four files; these paths are now in CI. Before publication, the branch was fast-forwarded to current main (`de7f48c4`), then the combined regression/client contract run passed 1,379 tests across 154 files.
- Disposable PostgreSQL 17: 25 new cost-reader tests plus 12 existing listing-price persistence tests passed. Coverage includes exact qualified source tables, wrong plan/subscription/variant, exclusions, inactive/duplicate overrides, channel fallback, zero, concurrent source edits, and failure cleanup.
- Isolated headless browser checks used synthetic intercepted data: lazy 50-row mounting with 10,000 previews, cancel/default reset, modal/table synchronization, invalid amounts, stale-revision reload, identical-key uncertain-save retries, read-only recovery after a confirmed save, and stale-preview queue gating. No live APIs or user browser session were used.
- Independent backend review found no introduced actionable issue. Deployment and end-to-end validation of the deployed UI remain pending. These checks do not validate the unchanged acceptance wallet-pricing path.
- Final non-incremental TypeScript check and production build passed. The build retains the existing large-client-chunk warning. The disposable database cluster and diagnostic script were removed; the change contains only scoped source, tests, CI, and documentation.
