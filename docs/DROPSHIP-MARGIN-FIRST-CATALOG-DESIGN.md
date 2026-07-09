# Dropship Margin-First Catalog — Design

Status: Decisions recorded 2026-07-05; ready to build
Date: 2026-07-05
Depends on: `docs/DROPSHIP-DEEP-REVIEW-2026-07-05.md` §8 (product review); owner decisions in §5 below
Goal: the vendor sees **cost, suggested retail, and live product margin** at every pricing moment, and their **Card Shellz costs** on every order — using the exact numbers the wallet will later debit. Card Shellz never estimates the vendor's marketplace fees or computes their profit (owner decision).

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
- **Labeling (owner decision 2026-07-05):** the margin is **product margin only** and the UI must say so prominently — column header "Product margin" with a persistent sub-label/tooltip: *"Excludes Card Shellz shipping (charged at order time) and your marketplace fees — those are yours to factor in."* Card Shellz never estimates marketplace fees, on principle: we show OUR numbers authoritatively and never guess THEIRS.
- Missing data behavior (fail-closed, consistent with the quote path): if retail cache AND `pv.price_cents` are both null → Cost/Suggested render "—" with a "Pricing unavailable" badge; the row stays selectable but the preview will block it (it already does: price is a preview requirement).

### 2.2 Listing preview table

Add **Cost** and **Margin** columns next to Price (preview rows already carry the final resolved price). Blockers/warnings unchanged, same "product margin" labeling. The margin here is the committed one — this is the last look before push.

### 2.3 Orders — costs, not P&L (owner decision 2026-07-05)

Card Shellz does not compute vendor profit. We reliably ingest what was ordered and we authoritatively know what we charged; we do not reliably know the vendor's marketplace fees or their net payout, so we don't pretend to.

- **List**: add one money column — **Total debit** on accepted orders (blank/quoted-pending before acceptance). No profit column.
- **Detail**: keep the existing Acceptance Economics block (Wholesale / Shipping / Insurance / Total debit) and additionally render the already-in-DTO `feesCents`; keep the Marketplace Totals section as-is (informational, "as reported by the marketplace"). **No computed P&L/profit line.**
- Dashboard "profit" tile: **dropped.** A "Card Shellz spend (30 days)" tile (sum of debits) may come later — it's our number and always correct.

### 2.4 Shipping rates — clarification recorded (owner question 2026-07-05)

Two unrelated "shipping rates" exist and must not be conflated:
1. **Buyer-facing shipping** on the vendor's marketplace (their eBay business policy / their Shopify store settings). Echelon never reads or controls it; that revenue is the vendor's.
2. **Card Shellz's charge to the vendor** for fulfillment: the dropship rate stack (`dropship_rate_tables/_rows` keyed by warehouse + zone + weight band, zone rules, markup bps, insurance bps), quoted at acceptance and debited from the wallet. It does **not** follow any Shopify store configuration.

**Decision: one rate table and rule set for all marketplaces** — which is what is already built (platform is not a dimension anywhere in the rate schema; an eBay and a Shopify order for the same SKU/zip get the same charge). No per-marketplace rate extraction. Long-term the stack converges onto the shared shipping-engine tables (owner Decision 5 in the deep review) — still one rule set.

Because #2 is Card Shellz's own price list (not a guess), showing it at pricing time is legitimate and desirable: **v1.1 adds a read-only `estimate` mode** to the quote service (no snapshot, no idempotency — verified that no such path exists today) behind a per-SKU "Estimate shipping" affordance with a zone/destination picker. v1 ships with the "excludes shipping" label only.

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

## 5. Decisions — recorded 2026-07-05 (owner)

- **Q1 — Marketplace fee estimate: NO, never.** Card Shellz is not in the business of guessing eBay's fees. The margin column shows product margin (price − our cost) only, with prominent labeling that it excludes marketplace fees and shipping — those are the vendor's to determine. (See §2.1 labeling.)
- **Q2 — Shipping in the margin view:** v1 = label-only ("excludes shipping"); v1.1 = read-only `estimate` mode on the quote service showing **Card Shellz's own shipping charge** (our price list, not a guess). Clarification of the rate model recorded in §2.4: one marketplace-agnostic rate table/rule set — already how it's built; no per-marketplace rates.
- **Q3 — Vendor P&L: NOT computed.** We show our costs authoritatively (debit breakdown incl. the currently-unrendered `feesCents`) and the ingested marketplace totals as informational; we do not claim to know the vendor's revenue/net. Orders list gets a Total debit column; no profit anywhere. (See §2.3.)
- **Q4 — Discount percent: shown.** Cost and the .ops discount % are both displayed (tooltip: "your .ops discount: X%"). It doubles as membership marketing.

## 6. Phasing & tests

- **PR 1 (server)**: shared retail-price SQL fragment; catalog + preview + order-list DTO fields; unit tests (formula parity test; retail-resolution parity test; null-price fail-soft).
- **PR 2 (UI)**: catalog columns + thumbnails + live margin with the exclusion label; preview columns; "Suggested" placeholder; missing-pricing badge.
- **PR 3 (UI, small)**: orders Total-debit column; render `feesCents` in the economics block.
- **v1.1 (separate design ticket)**: quote-service read-only estimate mode + per-SKU "Estimate shipping" affordance.
- Not blocked by, and does not block, the dogfood order test — but PR 1+2 before external vendors (deep review §8.5 Batch B).

## 7. Explicit non-goals

Vendor profit/P&L computation (owner decision, Q3), marketplace fee estimates (owner decision, Q1), repricing automation, MAP enforcement changes (stays warn-only), suggested-retail admin overrides, currency other than USD.
