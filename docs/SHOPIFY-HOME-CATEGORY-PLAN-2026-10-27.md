# Echelon owns each Shopify product's home category

Status: **plan only.** No code, schema, catalog or Shopify data was changed. Every fact below was checked on October 27, 2026 against `origin/main` `198543a22`, the production database and the Shopify Admin API (2025-07, card-shellz.myshopify.com).

## Goal

Each US storefront product's breadcrumb reads Home › *Category* › Product, where *Category* is a collection page Echelon chose. Echelon stores the category; Shopify gets it as the product metafield `cardshellz.home_category` (`collection_reference`). The theme then needs no further changes.

## What is true today

**Theme** (cardshellz-theme PR #179, `snippets/breadcrumb-category.liquid`; **still open, not merged**). The theme picks the category in this order:

1. `cardshellz.home_category`, if it points to a published collection (`collections[handle]` only resolves published ones).
2. Otherwise, the first collection from Theme settings › Breadcrumbs › Category collections that the product belongs to. The seeded order is toploaders, sleeves-and-bags, glove-fit, magnetic-holders, hero-case, psa-submission-holders, storage-accessories, binders, armalopes, wax-for-all, graded-cards, football, basketball, pokemon-for-all, pokemon, breaker-materials.
3. Otherwise, Shop All.

**Shopify**
- The metafield definition **already exists**: `MetafieldDefinition/125894590623`, "Home category", `collection_reference`, storefront `PUBLIC_READ`, pinned, **0 values set**. No creation step is needed, but confirm someone meant to create it.
- 292 products: 244 ACTIVE, 47 DRAFT, 1 ARCHIVED. 157 of the 244 active products have a blank productType.
- Two hub collections are smart collections keyed on productType: `toploaders` (TYPE = Toploader) and `glove-fit` (TYPE = Glove-Fit). `binders`, `breaker-materials` and `wax-for-all` are keyed on tags.
- These are unpublished on the Online Store: `graded-cards` (112 products) and its four sport sub-collections, `tough-box` (a published duplicate, `tough-box-1`, exists), `magnetic-holders-copy` and `all-products-but-membership`.
- Only `pokemon` carries a collection-level `cardshellz.access_rule`. The brief says `football` and `basketball` are also member-restricted. I have not checked how they are gated.

**Echelon catalog** (`catalog.product_categories`, 13 rows, all active, every `sort_order` = 0; there is no column that links to a collection):

| id | name | products (active / on Shopify) |
|---|---|---|
| 1 | Donation | 7 / 0 |
| 2 | Quad Box | 5 / 2 |
| 3 | Armalope | 3 / 3 |
| 4 | Toploader | 30 / 28 |
| 5 | Magnetic Holder | 13 / 12 |
| 6 | Accessories | 19 / 14 |
| 7 | Sleeves and Bags | 4 / 4 |
| 8 | Semi-rigid | 3 / 3 |
| 9 | Armalopes | 1 / 1 (product 34, ARM-ENV-SGL-NM) |
| 10 | Easy Glide | 13 / 13 |
| 11 | Glove-Fit | 16 / 15 |
| 12 | Tough Box | 1 / 1 |
| 13 | Hero | 1 / 1 |

- Products: 444 total; 120 have a `category_id`. 433 are active, and 116 of those have one. 282 active products have a `shopify_product_id`.
- Of the 244 active Shopify products, 87 map to an active Echelon product that has a category. (The brief's figure was 88.) 11 have no Echelon product at all; they are all sealed wax. One is mapped by two active Echelon products: `7117934559391` → 39 EG-SLV-STD and 103 EG-SLV-STD-5PCK.
- The denormalized `products.category` matches the category name on every categorized row. 28 uncategorized rows hold `''`.

**Import fights Echelon.** In `server/modules/catalog/product-import.service.ts`, `resolveImportedProductCategory` (line 71) runs on every product matched by the manual "Sync products" buttons (`POST /api/shopify/sync-products` and `/api/shopify/sync`, from Products.tsx and ShopifyChannelPage.tsx). The call sites are lines 437, 785 and 930. It has three problems:
- It **overwrites** `category_id`/`category` from Shopify productType. A blank type sets them to null, so one click would wipe any backfill on the 157 blank-type products.
- It **auto-creates** a category for any productType text it hasn't seen. That is how both "Armalope" and "Armalopes" exist.
- When the slug insert collides (`23505`), it re-selects by slug **without** the `is_active` filter, so it can return a retired category.

**The push side is dormant.** Both `product-push.service.ts:573` and `shopify-listing.connector.ts:325` send `product_type = category name`. Neither runs today: the `/api/channel-push/*` product routes return 403, and the listings step in `echelon-sync-orchestrator.service.ts` (~line 1546) is commented out. If either is re-enabled after a category rename (for example Toploader → Toploaders), it would empty the `toploaders` smart collection.

**There is a precedent to copy.** `server/modules/catalog/shipping-group-sync.ts` writes `cardshellz.shipping_group`:
- It enqueues into the shellz-club-app outbox `membership.shopify_metafield_outbox`, in the same transaction as the catalog change. The dedupe key is `product:<gid>:cardshellz:<key>`. A null value enqueues a delete.
- It refuses a Shopify product owned by more than one active Echelon product.
- The club app worker needs the key registered in `server/sync/metafield-registry.ts`, or it terminal-fails the row. The worker passes a string `value` through unchanged, so a `gid://shopify/Collection/…` string works.
- The one-time backfill pattern is `scripts/backfill-shipping-group-metafields.ts`.

**Other readers of category** that a cleanup must respect:
- Dropship: `dropship_category_listing_settings` and `…_revisions` have a foreign key to `product_categories` (0 rows today). `dropship_product_category_seen` has no foreign key. It holds rows for category ids **3** and **10**. According to its schema comment, a trigger refuses deletes and identity changes there; I haven't checked the trigger in the database.
- Dropship vendor Shopify push sets `productType = category` on vendor stores.
- The eBay fallback category matches on a substring of the category name (`ebay-category-map.ts:289`).
- Shipping-engine product sets can select by category; none do (all 4 are `manual`).
- `PATCH /api/product-categories/:id` re-slugs on rename by default and re-copies the name onto products. This happens in a separate statement, not in one transaction.

## Target design

1. **One category → one collection.** Each active category points to exactly one US storefront collection, or explicitly to none (Donation, for example). Several categories may share a collection: Easy Glide and Sleeves and Bags can both point to `sleeves-and-bags`.
2. **A mapping table, keyed by channel**, because `Shopify-Canada` (channel 37) is a separate store with different collection IDs:
   - Table `catalog.product_category_storefront_collections (category_id, channel_id, shopify_collection_gid, shopify_collection_handle, verified_at)`, primary key `(category_id, channel_id)`.
   - The GID is the identity, and it is also what the metafield needs.
   - The handle is a display cache that a verifier refreshes.
   - Only the US Shopify channel (36) is filled now.
3. **Echelon writes the metafield.** `enqueueHomeCategoryMetafields(tx, productIds)` mirrors the shipping-group sync. It sets the mapped GID, or enqueues a delete when the product has no category or the category has no mapping. It runs in the same transaction as:
   - a product's `category_id` change (`PUT /api/products/:id`, catalog.routes.ts ~1131),
   - a category's mapping change, which re-enqueues every product in that category,
   - deactivating a category.
4. **Shopify productType is no longer coupled to category.**
   - Import stops writing `category_id`/`category` and stops auto-creating categories.
   - Push stops sending `product_type`. The REST PUT leaves an omitted field unchanged, so Shopify keeps owning productType and the two TYPE-based smart collections keep working.

## Phases

Each phase is its own branch and PR off the latest `origin/main`. Every migration is first run as `BEGIN … ROLLBACK` against the shared database.

**P0 — Stop the import overwrite (code, small).** `product-import.service.ts`:
- Never change `category_id`/`category` on an existing product.
- On create, set the category only on an exact active slug match; never insert a new category.
- Report unmatched productTypes in the sync result.
- Tests at the three call sites.
- P0 must land before P1, because a rename that changes a slug would otherwise make the next sync re-create the old category.

**P1 — Clean up categories (migration + data, needs D1/D2 approval).**
- Migration: add the mapping table (and, optionally, a unique index on `lower(name)`).
- Data, in one reviewed script under one transaction:
  - Merge 9 Armalopes into **3** (keep id 3 because a dropship "seen" row references it), then retire 9.
  - Rename per D2, keeping each slug stable unless the rename requires a new one.
  - Split Accessories per D2.
  - Add the new categories.
  - Insert the US mappings.
- Check before applying: no eBay fallback match is lost (the names still contain the old substring), and the dropship settings tables are still empty.

**P2 — Categorize the uncategorized (read-only report → user review → apply).**
- A script lists every active Echelon product mapped to an active Shopify product. Each row shows its current category, its Shopify collections and a **proposed category**. The proposal is the theme's first-match collection order, mapped back through the P1 table.
- Output is a CSV with a `decision` column. Rows where the proposal disagrees with an existing category are flagged, and nothing is written for them unless the user says so.
- The user edits the CSV. Applying it writes `category_id` and `category` and enqueues the metafields (P3 must already be live), all in one transaction per batch.
- Sizing today:
  - 130 active products have a published theme pick; 87 of them already have a category.
  - 32 more can be filled from collections: 43 have a pick, minus the 11 with no Echelon product.
  - 111 sit only in the unpublished `graded-cards`.
  - 3 are not catalog items: the donation and two memberships.
- 160 Echelon products have no Shopify ID (151 of them active). They are out of scope for the breadcrumb, but the user may want them categorized in the same pass.

**P3 — Sync (code; two repos, deploy in this order).**
1. shellz-club-app: add `"cardshellz.home_category": "collection_reference"` to `metafield-registry.ts`, and a matching entry in `scripts/define-metafields.ts` (the definition already exists, so the script must be idempotent). Deploy.
2. Echelon: add `home-category-sync.ts`, the enqueue calls listed under Target design, and audit events (`catalog.home_category.changed`). Remove `product_type` from both push payloads. Add tests that copy the shipping-group sync tests.

**P4 — One-time metafield backfill and verify.**
- `scripts/backfill-home-category-metafields.ts` enqueues every mapped product.
- A read-only verifier compares Shopify's `cardshellz.home_category` with Echelon's expected GID for all 244 active products and reports any difference.
- Spot-check a few PDP breadcrumbs, but only once theme PR #179 is merged.

**P5 (optional) — Drift check.** A daily read-only comparison, like P4's verifier, plus a check that every mapped collection GID still exists and is published.

## First-pass category → collection proposal

The first pass reproduces the breadcrumbs the theme shows today, so nothing visible changes until the user decides it should. "Today" is the theme's pick for those products.

| Category (id) | Today | Proposed collection | Change |
|---|---|---|---|
| Toploader (4) | toploaders | `toploaders` | rename → "Toploaders"? (D2) |
| Magnetic Holder (5) | magnetic-holders | `magnetic-holders` | rename → "Magnetic Holders"? |
| Glove-Fit (11) | glove-fit | `glove-fit` | — |
| Sleeves and Bags (7) | sleeves-and-bags ×2, glove-fit ×2 (BGS and CSG/CGC slab sleeves) | `sleeves-and-bags` | the 2 slab sleeves: move to Glove-Fit? (D2) |
| Easy Glide (10) | sleeves-and-bags | `sleeves-and-bags` | or `easy-glide-penny-sleeves` (D1) |
| Armalope (3) + Armalopes (9) | armalopes | `armalopes` | merge into 3, name "Armalopes" |
| Hero (13) | hero-case | `hero-case` | — |
| Semi-rigid (8) | psa-submission-holders | `psa-submission-holders` | — |
| Tough Box (12) | psa-submission-holders | `psa-submission-holders` | or `storage-accessories` (D2) |
| Quad Box (2) | storage-accessories | `storage-accessories` | — |
| Accessories (6) | storage-accessories ×4, binders ×4, breaker-materials ×1, armalopes ×1 (a stamp) | split | new **Binders** → `binders`, **Breaker Materials** → `breaker-materials`; the rest → `storage-accessories`; stamp → Armalopes or a new Shipping Supplies → `card-shipping-supplies` (D2) |
| Donation (1) | — | none | stays on Shop All |
| **new** Wax | wax-for-all ×18, football ×12, basketball ×7 | `wax-for-all` | D4 |
| **new** Pokémon | pokemon-for-all ×3, pokemon ×2 | `pokemon-for-all` | D4 |
| **new** Graded Cards | (Shop All) | `graded-cards` | D3 |

## Decisions for the user

- **D1 — Granularity.** I recommend keeping the existing narrower categories (Easy Glide, Semi-rigid, Quad Box, Tough Box) and letting several point to one hub collection. The alternative is to point them at their sub-collections (for example `easy-glide-penny-sleeves` or `quad-boxes-only`), which changes up to 16 visible breadcrumbs.
- **D2 — The list.** Approve the table above, in particular:
  - the Accessories split,
  - where the stamp and the two slab sleeves go,
  - Tough Box's home,
  - the renames: Toploader → Toploaders, Magnetic Holder → Magnetic Holders, and keeping Armalopes as the merged name.
- **D3 — Graded cards.** Map Graded Cards → `graded-cards` now. It is harmless while unpublished, because the theme ignores unpublished collections. Then decide separately whether to publish `graded-cards` (and its sport sub-collections) so the 111 products get a real breadcrumb.
- **D4 — Sealed wax.** Choose one Wax category → `wax-for-all` (recommended), or per-sport categories → `football`/`basketball`. If the sport collections are member-restricted, the breadcrumb would send non-members to a gated page. Pokémon sealed: `pokemon-for-all` (recommended) or the gated `pokemon`.
- **D5 — Import.** I recommend that import never writes the category of an existing product, as in P0. The alternative is to keep productType → category for new products only.
- **D6 — productType.** I recommend that Shopify owns productType and Echelon stops sending it. The alternative is a per-category `shopify_product_type` field that Echelon pushes, which is only needed if product push is re-enabled.
- **D7 — Canada.** US only now; the mapping table is keyed by channel so Shopify-Canada can follow.
- **D8 — Data fixes before P2:**
  - The 11 wax products on Shopify with no Echelon product: map them in Echelon, or leave them on the theme fallback.
  - The duplicate mapping on Shopify product `7117934559391` (EG-SLV-STD and EG-SLV-STD-5PCK). The sync refuses it until one of the two is unmapped.
  - `2023-optic-football-blaster` is in `pokemon-for-all`, which looks wrong.
- **D9 — Approvals.** Writing product data (P1, P2) and enqueueing metafields (P4) each need an explicit OK. The definition already exists, so there is nothing to create.
