# Dropship Margin-First Catalog — Design

Status: Draft for review
Date: 2026-07-05
Depends on: `docs/DROPSHIP-DEEP-REVIEW-2026-07-05.md` §8 (product review), owner decisions §5
Goal: the vendor sees **cost, suggested retail, and live margin** at every pricing moment, and **profit** on every order — using the exact numbers the wallet will later debit.

## 1. Principle: one pricing truth, three surfaces

The number shown in the catalog must be the number debited at acceptance. Therefore this design **exposes the acceptance path's existing pricing logic** rather than adding a parallel computation. Every source below is verified in current code:

| Concept | Verified source (today, in the acceptance/debit path) |
| --- | --- |
| Card Shellz retail ("suggested retail") | `COALESCE(ROUND(retail_cache.price::numeric * 100)::bigint, pv.price_cents)` where `retail_cache` = `public.shopify_variants` matched by `shopify_variant_id`, falling back to case-insensitive SKU (`dropship-order-acceptance.repository.ts:534`; identical pattern in `dropship-listing-preview.repository.ts:277-294`) |
| Wholesale discount % | `channels.partner_profiles.discount_percent` joined on the **Dropship channel id** (`dropship-order-acceptance.repository.ts:417-421`) |
| Wholesale unit cost | `calculateDiscountedWholesaleUnitCostCents(retailCents, discountPercent)` = `retail − floor(retail × pct / 100)` — already an **exported pure function** (`dropship-order-acceptance-service.ts:351-364`) |
| Vendor retail (default) | vendor per-variant override → existing listing `vendor_retail_price_cents` → the same retail cache (`dropship-listing-preview-service.ts:547-549`) |
| Product images | `catalog.product_assets` lateral, primary-first — **already selected** by the listing-preview query (`dropship-listing-preview.repository.ts` `assets.image_urls`), just never exposed to the vendor catalog |
| Order money | already returned on the order-detail DTO (`marketplaceTotals`, `economicsSnapshot` incl. `feesCents`) — rendered incompletely |

Decision this design bakes in: **suggested retail = Card Shellz's current live retail** (the retail cache). It's the design-§7 "Card Shellz recommendation," it requires no new admin surface, and it's already the wholesale basis. An optional per-variant admin override column can come later without changing any of this.

## 2. What the vendor sees

### 2.1 Catalog table (DropshipPortalCatalog)

New columns, replacing today's Product/Variant/Category/Qty/Price-input/Status/Action layout:

| | Product (w/ 40px thumbnail) | Cost | Suggested | Your price (input) | Margin | Qty | Status | Action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

- **Cost** = wholesale unit cost (labeled "Your cost"; tooltip: "Card Shellz retail minus your .ops wholesale discount (X%)").
- **Suggested** = Card Shellz retail. The price input's placeholder becomes the actual suggested number, not the word "Default".
- **Margin** = computed client-side as the vendor types: `yourPrice − cost`, shown as `$X.XX (YY%)`, green ≥ threshold / amber low / red negative. Recompute on keystroke; no server round-trip.
- Explicit label on the column header: **"Margin before shipping & marketplace fees"** (see §5 for the fee estimate option).
- Missing data behavior (fail-closed, consistent with the quote path): if retail cache AND `pv.price_cents` are both null → Cost/Suggested render "—" with a "Pricing unavailable" badge; the row stays selectable but the preview will block it (it already does: price is a preview requirement).

### 2.2 Listing preview table

Add **Cost** and **Margin** columns next to Price (preview rows already carry the final resolved price). Blockers/warnings unchanged. The margin here is the committed one — this is the last look before push.

### 2.3 Orders

- **List**: add a money column — total debit once accepted (or quoted retail total before), plus a **Profit** value on accepted orders: `retailSubtotal − totalDebit` *(marketplace shipping collected is in `marketplaceTotals`; see open question Q3)*.
- **Detail**: add a computed P&L block above Acceptance Economics: Revenue (marketplace grand total) − Wholesale − Shipping − Insurance − Fees = **Profit**, each line from fields already in the DTO (`feesCents` exists but is unrendered today).

### 2.4 Dashboard (v1.1, small)

One "Profit (last 30 days)" tile = sum over accepted orders of the same P&L. No charting needed for v1.

## 3. Server changes

### 3.1 Vendor catalog endpoint (`GET /api/dropship/catalog`)

Extend the browse query in `dropship-selection-atp.repository.ts` with the two lateral joins that already exist verbatim in `dropship-listing-preview.repository.ts` (retail cache + product assets), plus the partner-profile discount (single value per vendor request — fetch once per request via the Dropship channel id, not per row).

DTO additions to `DropshipCatalogRow` (client mirror `dropship-ops-surface.ts:1413`):

```ts
suggestedRetailCents: number | null;   // retail cache ?? pv.price_cents
wholesaleUnitCents: number | null;     // calculateDiscountedWholesaleUnitCostCents(suggestedRetailCents, discountPercent)
wholesaleDiscountPercent: number;      // top-level on the response, not per-row
imageUrl: string | null;               // first of image_urls
vendorRetailPriceCents: number | null; // existing listing override, so the input can prefill
```

Wholesale is computed server-side with the **same exported function** the debit uses — the client never re-derives it.

### 3.2 Listing preview response

`DropshipListingPreviewResult.rows[]` += `wholesaleUnitCents`, `marginCents`, `marginPercent` (server-computed from the resolved price). The preview service already resolves the final price; the wholesale inputs are already in its repository query's reach.

### 3.3 Orders list response

`DropshipOrderListItem` += `totalDebitCents | null`, `retailTotalCents | null` (both already loaded for the detail; the list query needs the economics-snapshot join). Profit is client-computed from the two.

### 3.4 No schema changes

Nothing new is stored. All fields derive from existing tables at read time. (Optional later: `catalog.product_variants.suggested_retail_cents` admin override — explicitly out of scope here.)

## 4. Consistency guardrails

1. **Single formula**: catalog, preview, and acceptance all call `calculateDiscountedWholesaleUnitCostCents`. Add a unit test asserting the catalog endpoint's wholesale equals the acceptance plan's wholesale for the same variant/vendor (this is the §8 "same number" invariant).
2. **Single retail resolution**: the retail-cache COALESCE SQL now exists in 3 places (acceptance, preview, + new catalog). Extract it into one shared SQL fragment/view (e.g. `dropship_retail_price_source`) so drift is impossible. The known SKU-fallback ambiguity (deep review §3, listing P3) then has exactly one place to fix.
3. **Display ≠ quote**: margin shown in the catalog is *before shipping and marketplace fees*, and the UI says so on the column header — no fine print.

## 5. Open questions (answer before build)

- **Q1 — Marketplace fee estimate**: add an admin-configurable "estimated marketplace fee %" per platform (e.g. eBay ~13%, Shopify ~3%) so the margin column can show "est. net margin"? Recommended as a v1.1 toggle, clearly labeled estimate. Skipping it in v1 keeps the column honest ("before fees").
- **Q2 — Shipping estimate at pricing time**: the quote service has **no read-only path** (verified — every quote persists a snapshot + audit in one tx). Options: (a) v1 ships without shipping in the margin (labeled), (b) add an `estimate` mode to the quote service (no snapshot, no idempotency) behind a per-SKU "Estimate shipping" button with a destination-zone picker. Recommend (a) now, (b) as a fast follow — the estimate endpoint is also reusable by the future public quote API.
- **Q3 — Profit definition on orders**: is vendor revenue `marketplace grand total` (incl. buyer-paid shipping+tax) or `retail subtotal`? Marketplace tax is usually remitted by the marketplace, so recommended: **revenue = retail subtotal + buyer-paid shipping**, tax excluded. Needs a one-line decision.
- **Q4 — Wholesale visibility**: cost/discount% are shown to the authenticated vendor (it's their own price, per design §7 "wholesale cost: what vendor owes Card Shellz"). Confirm no reseller-agreement reason to hide the discount *percent* itself; if so, show only the computed cost.

## 6. Phasing & tests

- **PR 1 (server)**: shared retail-price SQL fragment; catalog + preview + order-list DTO fields; unit tests (formula parity test; retail-resolution parity test; null-price fail-soft).
- **PR 2 (UI)**: catalog columns + thumbnails + live margin; preview columns; "Suggested" placeholder; missing-pricing badge.
- **PR 3 (UI)**: orders money column + P&L block; dashboard profit tile.
- Not blocked by, and does not block, the dogfood order test — but PR 1+2 before external vendors (deep review §8.5 Batch B).

## 7. Explicit non-goals

Repricing automation, MAP enforcement changes (stays warn-only), suggested-retail admin overrides, currency other than USD, and marketplace fee *reconciliation* (actual eBay fees vs estimate) — all later.
