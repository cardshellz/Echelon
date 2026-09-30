# Vendor Catalog redesign — final design

Portal page: `cardshellz.io/catalog` (`client/src/pages/dropship/DropshipPortalCatalog.tsx`, mounted at `client/src/App.tsx:269`).
Status: for owner approval. Date: 2026-09-30.

Evidence note. File and line citations were produced by the mapping pass. In this writing pass the following were re-read and confirmed: `DropshipPortalCatalog.tsx:186-187, 264, 323-331, 376-399, 1382-1392`; `DropshipListingPriceEditor.tsx:110-118, 197-198`; `dropship-auth.tsx:23, 61`; `dropship-selection-dtos.ts:11-79, 86-96`; `dropship-selection-atp-service.ts:229-305, 373-392`; `dropship-selection-atp.repository.ts:147-224`; `vendor-selection.ts:13-25, 88-105`; `catalog-exposure.ts:103-123`; `dropship-listing-preview-service.ts:339-380, 626-731, 818-859, 955, 1002-1068`; `dropship-listing-preview.repository.ts:327-369, 626-665, 720-728, 759-791`; `dropship-listing-push-worker.factory.ts:17-41`; `dropship-listing-push-worker-service.ts:180-185, 530-537`; `dropship-listing-push-worker.repository.ts:206-233, 291-325`; `dropship-listing-push-job-runner.ts:20-23, 88-105`; `dropship-use-case-dtos.ts:48-61`; `dropship-listing-dtos.ts:8`; `dropship-selected-catalog.ts:14-43`; `dropship-pricing-rules-service.ts:66-75, 96-100, 144`; `dropship-pricing-rules.routes.ts:13-16`; `dropship-listing-content.routes.ts:15-21`; `dropship-listing-content-service.ts:38-53`; `dropship-listing-content-resolver.ts:46-58`; `pricing-rules.ts:8-29, 84-98`; `catalog-scope.ts:1-31`; `listing-content.ts:15-26`; `listing-price.ts:56-62`; `dropship-vendor-catalog.routes.ts:22-56`; `dropship-listing.routes.ts:51-55`; `dropship-auth.routes.ts:81-87`; `domain/auth.ts:70`; `dropship-ebay-store-category-dtos.ts:10-23`; `dropship-ebay-store-category-service.ts:116-132`; `dropship-ebay-listing-setup-service.ts:82`; `ebay-taxonomy.routes.ts:24-30, 64-72, 183-215`; `rate-table-admin-body.middleware.ts:23-33, 44-52`; `inventory-cutover-opening-body.middleware.ts:5-10`; `server/index.ts:126`; `0086:187-212, 262-283, 294-340`; `0660:73-76`; `0713:12-60, 86-127`. No virtualizer is installed (`package.json` has neither `react-virtual` nor `react-window`). Anything marked HYPOTHESIS is not measured.

---

## 1. Goals and non-goals

### Goals

1. A vendor can pick what to sell, set how it lists, and publish, without reading instructions. One step on screen at a time. One primary button per step.
2. Every setting (price, eBay category, description, policies, store shelf) is set the same way: pick a scope, set values, save once. Scopes: one listing, a checked set, a catalog category, a product line, a product, or all listings.
3. The page works at 10,000 selected SKUs. The browser never holds the whole selection. Counts come from the server. 10,000 selected listings per vendor is a hard launch cap: `loadSelectedCandidates` refuses more (`dropship-selected-catalog.ts:35-39`), and the design says what the UI does above it (section 8).
4. The vendor eBay category rules layer ships as part of this: store default, rules by scope, first match wins, verified leaf categories, Card Shellz mapping as the base default. The base default does not depend on the Card Shellz listing toggle. The resolved category is publish evidence: a rules change after the vendor's check is refused at queue time and at push time, never published silently.
5. Every invariant in the map stays: server-side access gate, step-up before push, exclusive evidence modes, queue re-check under the store lock, idempotency key on every mutation, integer cents, below-cost warns and never blocks, tier gating, content review hold, cost-change holds, no client price overrides.
6. Reuse what exists: `catalogScopeSchema`, `buildScopedSelectionReplacement`, the pricing review → apply contract, `useContentDraft`, `EbayListingPolicyBulkDialog`, `ListingPreviewTable` and the detail sheet, `describeListingPushOutcome`, `ListingSetupCombobox`, the per-route JSON parser pattern (`parseRateTableAdminBulkJson`).

### Non-goals

- No change to admin tools, admin exposure rules, the eBay listing builder, or the push provider.
- No change to how selection is protected. Selection has no step-up today (`dropship-vendor-catalog.routes.ts:35-38`). The UI must not imply that it does.
- No change to the precedence rule "a matching exclude always wins" (`vendor-selection.ts:88-105`).
- No release control for cost-change holds. No control that overrides tier quantity.
- No redesign of the portal shell nav (`DropshipPortalShell.tsx:24-34` untouched).
- No new float money anywhere. Integer cents only.
- Launch is eBay-only. `dropship_vendor_listings.platform` allows `shopify | tiktok | instagram | bigcommerce` too (`0086:281`), but the preview gates every eBay load on `context.platform === 'ebay'` (`dropship-listing-preview-service.ts:362-376`) and Step 2 has no rows for any other platform. A non-eBay connection is listed in the rail as "Not supported yet" and cannot be chosen.

---

## 2. What is wrong today

- One 1,662-line page with eight equal panels stacked in one scroll (`DropshipPortalCatalog.tsx:657-800`). The primary action (push) is the last panel.
- The catalog table shows 50 rows of page 1 only. `catalogUrl` hard-codes `page: 1, limit: 50` (`:186-187`) and `CatalogTable` (`:1427-1560`) has no pager. A category with 300 rows cannot be browsed.
- Selection is one variant rule per SKU. Each click PUTs the whole rule set (`:288-307`; `buildVariantSelectionReplacement`, `dropship-ops-surface.ts:4747`). The server refuses more than 500 rules (`dropship-selection-dtos.ts:65`). That is the ceiling on how much a vendor can select. The scope builder that would avoid this exists (`buildScopedSelectionReplacement`, `:4776`) and is never called from the page.
- Every unrelated action wipes the MFA state. `invalidateListingPreview` clears `emailCodeSent` and `verificationCode` (`:323-331`) and runs on selection change, filter apply, store change, store-category save, setup change, and pricing apply.
- Per-SKU price edits exist only inside a generated preview and each save regenerates the whole preview for every selected id (`:390, 333-364`; `DropshipListingPreview.tsx:127-133`).
- Pricing rules support only markup (`basis × (1 + %) + flat`; `DropshipPricingRulesPanel.tsx:119`). There is no "set price to $X" by group.
- eBay Store shelf assignment saves on every combobox change with a fresh idempotency key per call and no revision check. The input schema has no `expectedRevisionId` to check (`dropship-ebay-store-category-dtos.ts:10-23`), so none can be added on the client alone.
- The whole selection is loaded into memory in sequential pages of 200 (`fetchAllSelectedCatalogRows`, `:118-142`). 10,000 SKUs is 50 requests before the policy panel renders.
- Push polling stops for good after one failed GET (`retry: false`, `:1387`) or after 100 answers (`dropship-listing-push-status.ts:58`), then says "refresh later" with no job link.
- A vendor cannot set the eBay browse category per store. The preview falls back to the catalog value in two places (`dropship-listing-preview-service.ts:1034-1037, 1065-1068`). Push evidence covers content hash, rule-price hash, price revision and price cents only (`assertPreviewMatchesReviewedEvidence`, `:818-859`); the category is not evidence, and the worker rebuilds the intent from current state at push time (`dropship-listing-push-worker.factory.ts:17-24`).
- Cost-change holds are invisible on the page. A hold is a row in `dropship.dropship_cost_change_listing_holds` (`0713:12-60`); "awaiting review" is an action row in `dropship_cost_change_listing_actions` (`0713:86-127`). The preview has no blocker or warning for either (the only mention is the comment at `dropship-listing-preview-service.ts:955`), so a held listing shows as quantity 0 with no reason. `dropship_vendor_listings.paused_reason` (`0086:279`) is never written by any code; `status = 'paused'` means only a non-live listing mode (`dropship-listing-push-worker.repository.ts:232`).
- Every JSON body is parsed under the 100 KiB global limit (`GLOBAL_JSON_LIMIT_BYTES`, `rate-table-admin-body.middleware.ts:23`; installed at `server/index.ts:126`). A 500-id reviewed push with four evidence maps is already near it.
- Errors show in up to six banners at the top of the page (`:616-655`), far from the control that failed.

---

## 3. Information architecture

### Routes

| Route | Name | What lives there |
|---|---|---|
| `/catalog` | redirect | PR2: always to `/catalog/choose`. PR10 (when the runs list and listing status endpoint exist): to `/catalog/status` when the store has any listing row or push run, else to `/catalog/choose`. |
| `/catalog/choose` | 1 · Choose what to sell | Facet tree, browse table, checked set, bulk bar, "Your rules". Vendor-wide (selection rules key on `vendorId`). |
| `/catalog/setup` | 2 · Set how it lists | Per store. Store defaults card. Rules by group table. Exceptions list. Store shelves (optional). Linked from Settings → Stores too, so a vendor can find it later. |
| `/catalog/publish` | 3 · Publish | Per store. Readiness tiles, "Needs attention" groups, spot-check table, Publish button. |
| `/catalog/status` | Status | Per store. Publish runs, "Your listings on <store>" table, Fix links. |

Filters, page, sort and the open row (`?variant=<id>`) are URL query state. Back button and reload keep the vendor's place.

### Step rail

Sticky under the shell header. Three steps plus Status. Each tick is server-derived:

- Step 1 done: catalog summary `selected > 0` (PR4). Until PR4: `GET selection-rules` returns at least one active include rule.
- Step 2 done: eBay setup `missingFields` empty (`dropship-ebay-listing-setup-service.ts:82`). Pricing profile, content profile and category default are optional. Publishing does not need a pricing profile: with none, `loadRulePricesWithClient` returns an empty map (`dropship-listing-preview.repository.ts:723-724`), `listingPriceFollowsRules` is false for an untyped price (`listing-price.ts:56-62`), no `pricing_rules_not_configured` blocker is raised, and the catalog default price applies. The Store defaults card shows "Catalog retail price (no rules yet)" and "Catalog description (no template yet)" for null profiles, not a blocker.
- Step 3 done: the store has at least one completed push run (PR7). Until PR7 the Status entry is a plain link with no tick.

The store selector sits in the rail, once. It auto-picks the first launch-ready eBay connection (`listLaunchReadyStoreConnections`). The last choice is remembered per vendor in `localStorage` as a convenience only.

### Sticky action bar

Bottom of every step. Left: context summary. Right: the one primary button for the step. Action errors render here, next to the button. Access blocks (`describeListingAccess`) render here with `ListingAccessLinkButton`.

### Error rule (two surfaces)

An error shows inline next to the control that failed, plus one toast with Retry. Never a stack of page-top banners.

### One draft hook

`useMutationDraft` (generalised `useContentDraft`) drives every save. Phases: `editing | saving | uncertain | conflict | refresh_error`. It carries `expectedRevisionId` and a fingerprint-reused idempotency key. A 409 shows "Reload and keep my draft". The draft is never discarded by the hook.

---

## 4. Layout

### 4.1 Step 1 · Choose what to sell

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Card Shellz · Dropship portal      [Dashboard] [Catalog] [Cost changes] [Orders] …    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Catalog                                                    Store: [ MyShop (eBay) ▾ ] │
│ ● 1 Choose what to sell ──── ✓ 2 Set how it lists ──── ○ 3 Publish ──── ▸ Status      │
│   312 selected                setup complete             not checked yet              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ STEP 1 · Choose what to sell      Selection applies to all your stores.               │
│ ┌ Sell by group ─────────────┐ ┌ Browse ───────────────────────────────────────────┐ │
│ │ Categories                 │ │ [🔍 product, variant or SKU ]  Show: [All      ▾]  │ │
│ │ ☑ Envelopes           142  │ │ ☐ │ Product · Variant        │ Category  │Units│St │ │
│ │ ◪ Toploaders   118 / 311   │ │ ☑ │ Armalope Env · Pack 50   │ Envelopes │  50 │ ● │ │
│ │ ☐ Sleeves             960  │ │ ☑ │ Armalope Env · Case 500  │ Envelopes │ 500 │ ⚠ │ │
│ │ Product lines              │ │ ☐ │ Ultra Sleeve · 100 ct    │ Sleeves   │ 100 │ ○ │ │
│ │ ☑ Armalope             58  │ │ ☐ │ Shellz Pro Top · 25 ct   │ Toploaders│  25 │ ✕ │ │
│ │ ☐ Shellz Pro          120  │ │   … windowed rows, 200 per server page …           │ │
│ │ ▸ Your rules (4)           │ │ 1–200 of 1,433                         [Load more] │ │
│ └────────────────────────────┘ └────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ 312 selected · 2 exceptions                            [ Continue to Set how it lists ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
Legend  ● selected via rule   ○ not selected   ✕ exception (excluded)   ⚠ selected, tier not on sale
        ☑ whole group selected   ◪ part of group selected (118 of 311)   ☐ none
```

The ◪ state needs `selectedCount` per facet (9.2, PR4). Until PR4 the facet checkbox reflects rules only: ☑ when a scope include rule for that facet exists, ☐ otherwise, no partial state.

Ticking a facet does not save. It opens the bulk bar (two-step):

```
┌ Bulk bar (after ticking "Toploaders") ───────────────────────────────────────────────┐
│ Applies to: all 311 in Toploaders, and any Toploaders SKU added later.               │
│                                    [ Sell these 311 ]  [ Stop selling these ]  [ × ] │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌ Bulk bar (after checking rows) ──────────────────────────────────────────────────────┐
│ 2 checked · Only these 2.                                                            │
│ [ Sell these ]  [ Stop selling these ]  [ Set how these list → ]  [ Select all 311 ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Facet-level "Stop selling these" removes the matching scope include rule and every `variant` / `variants` include rule inside that scope. It never adds a scope-level exclude: under exclude-always-wins (`vendor-selection.ts:88-105`) a category exclude would block the category for good and every later include would be ignored. Only row-level "Stop selling these" creates excludes, and only on rows that are selected by a broader rule.

"Select all N matching" appears when a filter is active. It becomes a scope (category / product line / product) only when the filter is exactly one facet with no search and no Show filter. Otherwise it fetches the matching ids (`idsOnly=true`, section 8) and becomes a snapshot: "Only these 1,433".

```
┌ Your rules (4) ────────────────────────────────────────────────────────────────────┐
│ [All Envelopes · 142 ×]  [Product line Armalope · 58 ×]  [112 single SKUs ×]       │
│ [2 exceptions ×]         Individual listings (112) → Convert to a category rule     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Chip counts: scope chips use the facet `selectedCount` (PR4; facet `rowCount` before that); `variants` chips use the rule's own id count.

First run (nothing selected):

```
┌ STEP 1 · Choose what to sell ─────────────────────────────────────────────────────┐
│ Nothing selected yet. Tick a category on the left to sell everything in it, or   │
│ check single rows on the right.                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 0 selected                                        [ Continue ] (disabled)        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Above 10,000 selected the bar reads "10,412 selected · over the 10,000 limit — rules and publishing are paused until you reduce it" and Continue stays enabled so the vendor can see Step 2's explanation.

### 4.2 Step 2 · Set how it lists

```
┌ STEP 2 · Set how it lists · MyShop (eBay) ───────────────────────────────────────────┐
│ ┌ Store defaults — used unless a rule below says otherwise ────────────────────────┐ │
│ │ ✓ Policies       Fulfillment: Standard · Return: 30 days · Payment: Managed [Change]│
│ │ ✓ Price          Product cost + 35 %, round to .99                         [Change]│
│ │   ↳ base         Catalog retail price (read-only)                                  │
│ │ ✓ eBay category  Card Shellz mapping per product type (recommended)        [Change]│
│ │   ↳ base         e.g. Trading Card Sleeves → 183435 (from Card Shellz)             │
│ │ – Description    No template yet — catalog description is used             [Change]│
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Rules by group — top to bottom, first match wins · 3 of 100 rules ·               │
│ │   1,212 of 10,000 named listings                                     [+ Add rule] ┐ │
│ │ ⋮ 1  Category: Envelopes (142)    +30 %       183435 Trading Card…  Env intro   — │ │
│ │ ⋮ 2  Product line: Armalope (58)  —           261328 Card Supplies  —           — │ │
│ │ ⋮ 3  12 checked listings          $9.99 fixed —                     —      Ret. B │ │
│ │      Applies to | Price | eBay category | Description | Policies* | Store shelf*  │ │
│ │      * checked listings only, up to 500, until scoped rules ship (PR12)           │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│ ▸ Exceptions on single listings (7)     fixed prices 4 · descriptions 2 · policies 1 │
│ ▸ eBay Store shelves (optional)                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Unsaved: 1 rule · affects 142 listings                            [ Save & continue ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

The "(142)" per rule and the "affects 142" in the bar come from `POST …/rules/impact` (7.4): matched count per rule under first-match, over the selected candidates. It runs on load and after each save. Nothing on this step is a facet total.

First-time vendors see only the Store defaults card expanded. The rules table shows one empty row: "No rules yet. Everything uses the store defaults."

Over the cap: when any profile GET or the impact call returns `DROPSHIP_CATALOG_TARGETS_TOO_LARGE` / `DROPSHIP_PRICING_REVIEW_TOO_LARGE`, the step shows one banner — "Your selection has more than 10,000 listings. Rules can't be reviewed until it is 10,000 or fewer. [Go to Step 1]" — the rules table is read-only and "Save & continue" is disabled.

Rule sheet:

```
┌ Rule ────────────────────────────────────────────────┐
│ Applies to   [Category ▾]  [🔍 Envelopes           ]  │
│              All 142 in Envelopes, and any Envelopes │
│              SKU added later.                        │
│                                                      │
│ Price        (•) Inherit  ( ) Markup  ( ) Fixed      │
│              Basis [Product cost ▾] + [30] %         │
│              round [.99 ▾]                           │
│                                                      │
│ eBay category [🔍 trading card sleeves            ]  │
│              ✓ 183435 · Collectibles › Trading Cards │
│                › Storage & Supplies › Sleeves (leaf) │
│                                                      │
│ Description  [Template: Env intro ▾]                 │
│ Policies*    Fulfillment [Inherit ▾] Return [Inherit▾]│
│ Store shelf* [Inherit ▾]                             │
│ * checked listings only, up to 500                   │
│                          [ Cancel ]  [ Done ]        │
└──────────────────────────────────────────────────────┘
```

The "Applies to" search is debounced 500 ms; each keystroke is one `/targets` request that scans the selected catalog and spends the pricing routes' 30/min budget (`dropship-pricing-rules.routes.ts:13-16`). A snapshot ("Only these N") rule that would push the named-listing total over 10,000 is refused in the sheet: "Named listings are limited to 10,000 across all rules. Use a category, product line or product."

Impact summary (shown inline after "Save & continue", before anything is written):

```
┌ Impact ──────────────────────────────────────────────────────────────────────────────┐
│ Price:          142 change · 0 preserved (typed prices kept) · 0 blocked             │
│ eBay category:  142 move to 183435 Trading Card Sleeves        [see first 50 ▾]      │
│ Description:    142 use "Env intro"                                                  │
│                                                       [ Back ]  [ Confirm and save ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

When the pricing review reports `blocked > 0`, the Price line reads "142 change · 3 blocked — fix these and review again" with the three rows and their guardrail reason (`issues`), and "Confirm and save" saves the other parts but skips the pricing part. The server would refuse it anyway (`DROPSHIP_PRICING_REVIEW_BLOCKED`, `dropship-pricing-rules-service.ts:69-71`). When apply returns `DROPSHIP_PRICING_REVIEW_STALE` (`:68, 73`; also from `buildImpact` on a revision mismatch, `:100`), the UI runs one new review, re-shows the summary, and waits for a second confirm. The pricing part is never applied without a confirm on the summary the vendor is looking at.

Save result lines (per part, never re-sent once confirmed):

```
│ ✓ Prices applied (142)   ✓ eBay category rules saved   ✗ Description save failed    │
│                                                        [ Retry description save ]   │
```

Conflict state (409 on any part):

```
│ ! Someone changed these rules since you opened this page.                           │
│   [ Reload and keep my draft ]   Your unsaved rule is kept.                         │
```

eBay Store shelves (optional), until PR12: the grid edits are held in the draft and written on Save as one per-variant `PUT` each (`replaceDropshipEbayStoreCategoryAssignmentForMember`), at most 100 per Save, sequential, one idempotency key per `(variant, payload)` reused on retry. There is no revision check, so shelf edits are last-write-wins per variant until PR12; the card says "Saved per listing. Changes made elsewhere are overwritten."

### 4.3 Step 3 · Publish

Checking:

```
┌ STEP 3 · Publish to MyShop (eBay) ───────────────────────────────────────────────────┐
│ Checking readiness ▓▓▓▓▓▓▓▓░░░░ 1,200 of 1,433                                       │
│ Runs again after a change to your selection or rules, or after 10 minutes.           │
│ [ Re-check now ] is always available.                                                │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Checking…                                          [ Publish ] (disabled)            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Ready:

```
┌ STEP 3 · Publish to MyShop (eBay) ───────────────────────────────────────────────────┐
│ Checked 1,433 · 2 min ago                                              [ Re-check ]  │
│ ┌ Ready 290 ┐ ┌ With warnings 8 ┐ ┌ Blocked 6 ┐ ┌ Live 1,129 · 2 held · 1 review ┐  │
│   (tiles are disjoint filters for the table below; every row is in exactly one)      │
│ Needs attention — fix by group                                                       │
│ ┌ 8  Priced below your cost (warning; publishes anyway)     [ Review prices → Step 2]│
│ │ 2  No eBay category                                       [ Add category rule ]    │
│ │ 1  Description needs review (catalog facts changed)       [ Open listing ]         │
│ │ 3  Case tier not on sale (reserve below tier)             [ Wallet ]               │
│ │ 2  Held: price below new cost (live, quantity 0)          [ Cost changes ]         │
│ │ 1  Price change awaiting your review                      [ Cost changes ]         │
│ │ 0  Card Shellz has to fix this — contact support          (no button)              │
│ └────────────────────────────────────────────────────────────────────────────────────┘
│ Spot check  [🔍]  Show: [Ready ▾]  Reason: [All ▾]   [flat table]                     │
│   Title · SKU │ Price │ Qty │ eBay category (source)           │ Status │ [View]      │
│   … ListingPreviewTable, 50 mounted rows, windowed …                                 │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ 298 ready · 8 with warnings                        [ Publish 298 ready listings ]    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

The Publish count is Ready + With warnings. Blocked rows are never sent. Held and awaiting-review rows come from the preview warnings `cost_change:held` / `cost_change:awaiting_review` (9.5); they have no release control here, only the link. Publish is disabled while any sheet save or single-row re-preview is pending (today's rule, `DropshipPortalCatalog.tsx:376-399`, kept). The run body is built from the readiness cache at click time, after the updated rows from any sheet save have replaced their cached rows.

Confirm publish (step-up modal, opened right before the POST):

```
┌ Confirm publish ───────────────────────────────────┐
│ Publish 298 listings to MyShop (eBay).             │
│ 8 are priced below your cost and will publish.     │
│                                                    │
│ We emailed a 6-digit code to a…@example.com        │
│ [ _ ] [ _ ] [ _ ] [ _ ] [ _ ] [ _ ]      Resend    │
│                    [ Cancel ]  [ Verify & publish ]│
└────────────────────────────────────────────────────┘
(passkey vendors see the OS prompt instead of the code row)
```

The email code is requested on open only when `isDropshipSensitiveProofActive` (`dropship-auth.tsx:61`) is false. With a live proof (10-minute TTL, `domain/auth.ts:70`) the modal shows "Verified 3 min ago" and a plain Publish button. Step-up endpoints allow 30 requests per 15 minutes (`dropship-auth.routes.ts:81-87`); a code per modal open would spend that on re-opens. The detail sheet's one-row publish uses the single-job endpoint, which needs the same `bulk_listing_push` proof (`dropship-listing.routes.ts:51-54`), so it opens the same modal.

Stale after a long check:

```
│ ! 37 listings changed since you checked. Re-check and publish again.                │
│                                                     [ Re-check 37 ]                  │
```

37 is the count of run targets the server marked `stale` (9.4), never a chunk size.

### 4.4 Status

```
┌ STATUS · MyShop (eBay) ──────────────────────────────────────────────────────────────┐
│ Publishes                                                                            │
│ Run #92 · 2 min ago · 298 sent · batch 1 of 1 ── ✓ 291 live · ✗ 7 failed [Retry 5] [▾]│
│   ▾ 5 retryable: eBay rate limit (5)        2 permanent: Item specifics missing (2)   │
│     Contact support for permanent failures.                                          │
│ Run #90 · yesterday · 1,121 sent · 3 batches · 41 min ── ✓ 1,121 live            [▾] │
│                                                                                      │
│ Your listings  [Live 1,412] [Queued 0] [Failed 7] [Blocked 3] [Paused 0]             │
│                [Needs update 0] [Not listed 9]     Cost changes: [Held 2] [Review 1] │
│ [🔍]  Show: [Failed ▾]                                                               │
│   Product · Variant        │ Status  │ Reason                    │ Next step │        │
│   Armalope Env · Pack 50   │ Failed  │ Item specifics missing    │ Support   │ [Fix]  │
│   Ultra Sleeve · 100 ct    │ Live · Held │ Price below new cost  │ Cost chg. │ [View] │
│   … server-paged 200, windowed …                                                     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ 7 need a fix                                     [ Choose more ]  [ Publish 9 not listed ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Count pills are clickable filters. The seven status pills partition the ten listing statuses (`deriveListingLane()`, 9.5). Held and Review are overlays on live rows from the cost-change tables, not statuses. `[Fix]` deep-links `?variant=<id>` into the same detail sheet as Step 3.

"Retry failed (5)" re-checks those five ids through the readiness chunker, then opens the step-up modal and creates a new reviewed run for the rows that are still ready. Permanent failures (`retryable = false`) are excluded from the set.

---

## 5. Key flows with click counts

### (a) Select 300 SKUs of one category, set their eBay category and price

| # | Action | Clicks | Requests |
|---|---|---|---|
| 1 | Step 1: tick "Envelopes (300)" | 1 | 0 |
| 2 | Bulk bar: "Sell these 300" | 1 | `POST selection-rules/changes` (1) + refetch catalog page and rules (2) |
| 3 | "Continue to Set how it lists" | 1 | Step 2 profile GETs, ≤4, cached; rules impact (1) |
| 4 | "+ Add rule" | 1 | 0 |
| 5 | Applies to: Category → pick Envelopes | 1 | `GET …/targets` (1, debounced 500 ms) |
| 6 | Price: "Markup", type 30 | 1 + 1 typed | 0 |
| 7 | eBay category: type "trading card sleeves", pick the leaf | 1 + 1 typed | search proxy (1), leaf check on pick (1) |
| 8 | "Done" | 1 | 0 |
| 9 | "Save & continue" → impact summary | 1 | pricing review (1), category impact (1), rules impact (1) |
| 10 | "Confirm and save" | 1 | pricing apply (1), category rules PUT (1), refetch (2), rules impact (1) |

Total: 10 clicks, 2 typed fields, about 19 requests, four full selected-catalog scans (review, category impact, two rules impacts). Today: at least 24 clicks and 40 requests to select (if facets slice cleanly), about 600 clicks and 1,200 requests for per-SKU prices, and no per-store category at all.

### (b) Fix one blocked listing

1. Step 3 (or Status → Fix): group "Description needs review (1)" → "Open listing" (1 click). The detail sheet opens with `DropshipListingContentEditor` mounted (1 GET). Publish is disabled while the sheet has a save in flight.
2. "Acknowledge catalog changes" or edit the text (1 click).
3. "Save description" (1 click) → `PUT …/variants/:id/content` with `expectedRevisionId`, `expectedCatalogHash`, `expectedProfileRevisionId`, retained key. On 409: conflict phase, "Reload and keep my draft".
4. The sheet re-previews that one variant (`POST /listings/preview` with one id), replaces its cached readiness row and its five evidence values, updates the tiles, closes.

Total: 3 clicks, 3–4 requests. Nothing else is regenerated.

### (c) Publish everything ready

1. Step 3 loads readiness on entry. Button reads "Publish 298 ready listings" (ready + warning rows; blocked rows are never sent).
2. Click it (1). The step-up modal opens: passkey → OS prompt; email → code sent on open if no proof is live, type 6 digits, "Verify & publish" (1).
3. `POST /api/dropship/listing-push-runs` once, with all ready ids and the five evidence maps (`reviewMode: 'reviewed_preview'`), built from the readiness cache at click time. Step-up is checked once by middleware on this POST. Body: about 260 bytes per id by arithmetic (three 64-hex map entries, two integer map entries, the id), so about 77 KB at 298 ids and about 2.6 MB at 10,000; the route has its own parser (9.4).
4. Route to `/catalog/status`. The run card polls one endpoint until the run finishes.

Total: passkey 1 click + OS prompt; email 2 clicks + 6 keystrokes. Requests: step-up 0–2, run POST 1, then polling.

### (d) Stop selling 12 SKUs that sit inside a selected category

1. Check the 12 rows, across pages and searches (12 clicks). The checked set survives paging.
2. "Stop selling these" (1 click) → one `POST selection-rules/changes` adding one `variants` exclude rule with 12 ids. Rows show the ✕ Exception pill. "Your rules" shows "12 exceptions".

Total: 13 clicks, 1 write + 2 refetches. Re-ticking the category later does not un-exclude them (excludes win). "Sell these" on 3 of those 12 rows sends one change: `remove: [<that rule id>]`, `add: [same exclude with the 9 remaining ids]`. The other 9 stay excluded. Excludes are evaluated as whole rules (`vendor-selection.ts:88-105`), so a rule is never removed while any of its ids should stay excluded. When no ids remain, the change is `remove` only.

---

## 6. The bulk model

One sentence for every setting: **a rule is a target plus values, saved once, applied to N.**

### Targets (pure lib, `client/src/lib/dropship-listing-targets.ts`, tested)

```
type TargetSet =
  | { kind: "all" }                                         // catalog scope
  | { kind: "scope"; scope: CatalogScope }                  // category | product_line | product
  | { kind: "checked"; productVariantIds: number[] }        // rows the vendor ticked
  | { kind: "snapshot"; productVariantIds: number[]; filter: FilterDescription }; // "all N matching"
```

`describeTargetSet()` produces the sentence shown in every bulk bar and Rule sheet:

- scope: "All 142 in Envelopes, and any Envelopes SKU added later."
- checked / snapshot: "Only these 312."
- all: "All your listings, now and later."

"Select all N matching" becomes `scope` only when the active filter is exactly one facet with no search and no Show filter. Otherwise it becomes `snapshot` (ids fetched once, section 8). The count in the sentence is always the server total of the current query, never a facet `rowCount`.

### How each target lands on the server

| Setting | Scope target | Checked / snapshot target | Single listing (exception) |
|---|---|---|---|
| Selection | include rule `category` / `product_line` / `product` / `catalog` (`buildScopedSelectionReplacement`) | one `variants` include or exclude rule holding ≤10,000 ids (new scope type, section 9.3) | same, one id |
| Price | pricing group with `scope` | pricing group with `scope.type = "listings"` | `PUT …/variants/:id/price` (existing) |
| eBay category | category rule with `scope` | category rule with `listings` scope | category rule with `listings: [id]` |
| Description | content group with `scope` | content group with `listings` scope | `PUT …/variants/:id/content` (existing) |
| Policies | PR12 policy profile group | `EbayListingPolicyBulkDialog`, ≤500 | same dialog, one row |
| Store shelf | PR12 store-shelf profile group | per-variant PUT (existing), ≤100 per Save, last-write-wins | same |

Until PR12, the Policies and Store shelf columns are labelled "checked listings only, up to 500" in the sheet. The promise is partial for those two columns and the UI says so.

### Precedence (one rule, every setting)

Rules apply top to bottom; the first matching rule wins. Exceptions on single listings win over every rule.

- That is what the server does. `resolvePricingRule` (`pricing-rules.ts:84-98`) and `resolveListingContent` (`dropship-listing-content-resolver.ts:55-58`) pick the lowest `priority` among matching groups and treat a tie as a conflict. Specificity is never considered: a Category rule ordered above a Product rule wins for that product. The table order is the order. The UI writes `priority = (index + 1) × 10` on save, so drag-reorder never creates a tie.
- Because one table order is written into every profile, a reorder re-saves each profile whose priorities changed: pricing review + apply, content `PUT`, category rules `PUT`. The bar says "Reorder affects prices, descriptions and categories — review before saving".
- eBay category rules are an ordered array (section 7). No priorities.
- Per-listing exceptions (typed price, custom description, policy override, shelf assignment) sit above all rules. That is how the server already resolves them.
- Selection is the one place where "first match" is replaced by "exclude always wins" (`vendor-selection.ts:88-105`). The UI shows every exclude as an Exception pill so this is visible.

### One save sequence

"Save & continue" runs a deterministic, per-part sequence. Each part has its own `expectedRevisionId` and a fingerprint-reused idempotency key:

1. Pricing review (`POST …/pricing-rules/reviews`), category impact (`POST …/ebay-category-rules/impact`) and rules impact (`POST …/rules/impact`) → impact summary → vendor confirms. Blocked and stale handling as in 4.2.
2. Pricing apply (`reviewId`, `reviewHash`, retained apply key). Skipped, not failed, when the review was blocked.
3. Category rules `PUT`.
4. Content profile `PUT`.
5. Store shelves: N per-variant `PUT`s (≤100 per Save, sequential, one key per `(variant, payload)`); policy bulk `PUT` (when present).

A part that succeeded is never re-sent when a later part fails. The bar shows per-part result lines and one Retry for the failed part only. Readiness is recomputed from the server afterwards, so the vendor sees the actual result, not the draft.

Multi-profile saves are not atomic (risk 12.1). A single atomic rule-set endpoint is a larger server change and is not in this plan.

### Rules table assembly

The Step 2 "Rules by group" row is the union of groups that share one `id` across the pricing profile, content profile and category rules document. Assembly and disassembly are pure functions with a lossless round-trip test. Legacy groups whose ids differ across profiles show as separate rows until edited. The table header shows "N of 100 rules · M of 10,000 named listings"; M is the sum of `listings` ids across the table's rows and is enforced client-side for all three profiles (the content profile enforces it server-side, `listing-content.ts:20-23`; the category rules document does the same, 7.1).

---

## 7. eBay category rules

"eBay category" here means the marketplace browse category (a leaf of the eBay taxonomy). "Store shelf" means an eBay Store custom category. They are different settings and stay in different columns.

### 7.1 Data model

Mirror migration `0660` (content profile): one revision per save, a head pointer, a linear-history trigger.

```sql
-- Column types and key shapes follow migrations/0660_dropship_vendor_listing_content.sql
-- (integer identity ids, composite keys that pin a revision to its vendor and store).
CREATE TABLE dropship.dropship_ebay_category_rule_revisions (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id            integer NOT NULL,
  store_connection_id  integer NOT NULL,
  previous_revision_id integer,
  rules                jsonb  NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  idempotency_key      varchar(200) NOT NULL,
  request_hash         varchar(64)  NOT NULL,
  actor_type           text NOT NULL,
  actor_id             text NOT NULL CHECK (btrim(actor_id) <> ''),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, vendor_id, store_connection_id),
  UNIQUE (vendor_id, idempotency_key),
  FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id),
  FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_ebay_category_rule_revisions(id, vendor_id, store_connection_id)
);
CREATE TABLE dropship.dropship_ebay_category_rules (
  store_connection_id  integer PRIMARY KEY,
  vendor_id            integer NOT NULL,
  revision_id          integer NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id, vendor_id, store_connection_id)
    REFERENCES dropship.dropship_ebay_category_rule_revisions(id, vendor_id, store_connection_id)
);
-- trigger: NEW.previous_revision_id must equal the current head for the store (0660:73-76 pattern)
```

Document (`shared/dropship/ebay-category-rules.ts`, Zod, `.strict()`):

```ts
{
  version: 1,
  defaultCategory: { categoryId: string, categoryName: string, breadcrumb: string[] } | null,
  rules: [{
    id: string,                 // ^[A-Za-z0-9_-]{1,80}$, unique
    name: string,               // 1..120
    scope: CatalogScope,        // catalog-scope.ts:10-16
    categoryId: string,         // ≤40
    categoryName: string,
    breadcrumb: string[],
  }]                            // ≤100 rules; ≤10,000 named listing ids in total (same refine as listing-content.ts:20-23)
}
```

Save input mirrors `saveContentProfileInputSchema` (`listing-content.ts:26`): `{ expectedRevisionId, idempotencyKey, rules }`. Array order is precedence. There are no priority numbers, so there are no ties. A document with 10,000 named ids is about 70 KB of ids plus names and breadcrumbs, over the 100 KiB global limit, so the `PUT` and `impact` routes get the dedicated parser (9.4).

### 7.2 Resolution order and evidence (pure resolver, `application/dropship-ebay-category-resolver.ts`)

For each candidate, prepared once per batch like `prepareContentProfile`:

1. The first rule, in saved order, whose scope matches (`matchesCatalogScope`; `listings` via a precomputed Set).
2. Else the store default.
3. Else the Card Shellz base: `candidate.ebayBrowseCategoryId/Name`. This is the existing `COALESCE(product override, product-type mapping)` in `listCatalogCandidates` (`dropship-listing-preview.repository.ts:327-335, 356-369`). It has no `listing_enabled` predicate; the comment at `:352-356` says why. **Keep it that way.** PR1 pins it with a test: a product-type mapping with `listing_enabled = false` still supplies the base default.
4. Else none. The provider blocks with `ebay_browse_category_required` as today (`provider.ts:66`). No change there.

Output per row:

```ts
{ categoryId, categoryName, source: "rule" | "store_default" | "catalog" | "none",
  ruleId, ruleName, rulesRevisionId,
  evidenceHash }   // sha256 of { categoryId, source, ruleId, rulesRevisionId }
```

Plug-in point: `dropship-listing-preview-service.ts:1002`. The `content` passed to `buildListingIntent` gets `ebayBrowseCategoryId/Name` from the resolver. The two fallbacks at `:1034-1037` and `:1065-1068` are replaced by the resolved value. The resolved id already enters `previewHash` (`marketplaceCategoryId`, `:1023-1046`), which affects only replay (`previewHash` is part of `requestHash`, `:675-679`); it is not what refuses a stale publish. What does:

- Preview rows gain `marketplaceCategoryEvidenceHash` (the resolver's `evidenceHash`), `marketplaceCategorySource` and `marketplaceCategoryRuleName`.
- `createListingPushJobInputSchema` (`dropship-use-case-dtos.ts:48-61`) gains `expectedMarketplaceCategoryEvidenceHashesByVariantId`, 64-hex per id like the two existing hash maps. `assertPreviewMatchesReviewedEvidence` (`:818-859`) compares it row by row. `hashListingPushJobRequest` (`:675-679`) hashes it. `carriesReviewedPreviewEvidence` includes it, so a `current_preview` push that carries it is refused as today.
- The repository re-check under the store lock (`dropship-listing-preview.repository.ts:626-665`) reads the head revision and re-runs the resolver for the rows, and refuses with `DROPSHIP_LISTING_CATEGORY_VERSION_CONFLICT` (409) on any difference, beside the existing content and rule-price re-checks.
- Queue → push: `refreshListingIntent` rebuilds the intent from current rules at push time (`dropship-listing-push-worker.factory.ts:17-24`). The queued `marketplaceCategoryId` is stored on the job item at queue time (new column `queued_marketplace_category_id` on `dropship_listing_push_job_items`, `0086:316-332`). The worker compares it with the refreshed intent and fails the item as permanent (`retryable: false`) with `DROPSHIP_LISTING_CATEGORY_CHANGED_SINCE_QUEUE`, the shape of `DROPSHIP_LISTING_PRICE_AWAITING_REVIEW` (`worker.factory.ts:31-39`). The vendor re-checks and publishes again. Nothing publishes a category the vendor did not see.

The push provider and `ebay-listing-builder` are untouched. Step 3 and the sheet show "Category: 183435 Trading Card Sleeves · from rule Envelopes".

### 7.3 Verification

- Every category the vendor can pick comes from `GET …/ebay-category-search?q=`, a new vendor route over the Taxonomy port (9.1). It returns `{ categoryId, categoryName, breadcrumb: string[], leaf: boolean }[]`, at most 10. It is not the admin route: `/api/ebay/category-search` returns `breadcrumb` as one joined string, has no leaf flag, and sits behind admin `requireAuth` (`ebay-taxonomy.routes.ts:183-215`).
- On pick, the sheet calls `GET …/ebay-category-search/:categoryId` → `{ categoryId, categoryName, breadcrumb: string[], leaf: boolean } | 404`. Leaf is derived from `get_category_subtree` (`childCategoryTreeNodes` empty), the derivation the admin tree route uses (`:64-72`). Non-leaf picks are refused in the sheet with "Pick a more specific category".
- On save, the service re-verifies every distinct `categoryId` through the port (deduped, cached per id, TTL 24 h). A non-leaf or unknown id fails the whole save with `422 DROPSHIP_EBAY_CATEGORY_RULE_INVALID { ruleId, categoryId }` (mirror of `DROPSHIP_EBAY_STORE_CATEGORY_INVALID`, `dropship-ebay-store-category-service.ts:116-132`). The server stores `categoryName` and `breadcrumb` from its own lookup, never from the client, so the table never shows a bare id.
- Repository: `pg_advisory_xact_lock` on the store id; replay by `(vendor_id, idempotency_key)` with `request_hash` (same payload → 200 replay; different → 409 `DROPSHIP_IDEMPOTENCY_CONFLICT`); `expectedRevisionId` mismatch → 409; insert revision with `previous_revision_id`; upsert head; one `dropship_audit_events` row with before → after. All in one transaction.
- The resolver never calls eBay. Leaf status is checked only at save.

### 7.4 Impact preview

Two read-only endpoints, both over `loadSelectedCandidates` (`dropship-selected-catalog.ts:14-43`; one keyset scan of the catalog each, 250 ids per batch, refused above 10,000 selected):

- `POST …/ebay-category-rules/impact { expectedRevisionId, rules }` runs the resolver and returns `{ moved: n, byCategory: [{ categoryId, categoryName, count }], byRule: [{ ruleId, matched }], unchanged: n, first50: [...] }`. The Step 2 impact summary shows "142 move to 183435 Trading Card Sleeves" before the vendor confirms. This is the guard against the wrong category on 800 listings.
- `POST …/rules/impact { rules: [{ id, scope }] }` returns `{ byRule: [{ id, matched }], unmatched }` under first-match over the given order. It is profile-agnostic, so one call gives the per-rule counts for the Price, eBay category and Description columns and the "Description: 142 use Env intro" line. The content profile has no review endpoint of its own (`dropship-listing-content.routes.ts:15-21`); this is its source.

### 7.5 UI

- Store defaults card, "eBay category" row: `defaultCategory` when set; else "Card Shellz mapping per product type (recommended)". A read-only base line under it shows the mapping for the current filter's product type so the vendor sees the whole fallback chain.
- Rules by group table, "eBay category" column: the rule's category or "—" (inherit). Per-rule hit counts come from `rules/impact` on load and after each save.
- "N of 100 rules · M of 10,000 named listings" counter on the table. After three single-listing category rules, the sheet nudges: "Prefer a product rule. Single-listing rules use up your 100."
- Step 3 group "No eBay category (n)": the fix button opens the Rule sheet with scope prefilled to the affected product. When all affected rows share one product, scope = that product. Otherwise scope = listings with those ids.

### 7.6 Routes

```
GET  /api/dropship/listings/stores/:storeConnectionId/ebay-category-rules
PUT  /api/dropship/listings/stores/:storeConnectionId/ebay-category-rules          (bulk parser)
POST /api/dropship/listings/stores/:storeConnectionId/ebay-category-rules/impact   (bulk parser)
POST /api/dropship/listings/stores/:storeConnectionId/rules/impact                 (bulk parser)
GET  /api/dropship/listings/stores/:storeConnectionId/ebay-category-rules/targets   (reuse selectedCatalogTargets)
GET  /api/dropship/listings/stores/:storeConnectionId/ebay-category-search?q=
GET  /api/dropship/listings/stores/:storeConnectionId/ebay-category-search/:categoryId
```

All require a dropship session. PUT takes the key from body or `Idempotency-Key` header (`resolveIdempotencyKey`). No step-up (same posture as content profile). Rate limit 60/min per member (the content-profile figure, `dropship-listing-content.routes.ts:15-16`).

---

## 8. Scale behaviour at 10,000 SKUs

The page never holds the whole selection. The "selected" identity is `(storeConnectionId, selectionRevisionId)` from the server, not a joined id string.

| Surface | Behaviour at 10,000 | Requests |
|---|---|---|
| Step 1 page load | Catalog page 1 (limit 200, with facets incl. `selectedCount`, and summary) + selection rules | 2 |
| Step 1 full scroll | Server paging, "Load more", windowed rows (`@tanstack/react-virtual`, to be added) | ≤50 on demand |
| Counts | `summary { exposed, selected, excludedByException }`, facet `selectedCount` / `excludedCount`, query `total` — all from the server | 0 extra |
| Checked set | Client `Set<productVariantId>`; survives paging, filters, sort. Row identity is `productVariantId`, never the mounted row | 0 |
| "Select all N matching" | One facet → scope rule (0 extra). Else `GET /catalog?…&idsOnly=true` returns `{ productVariantIds, total }` up to 10,000 with no ATP read | 1 |
| Selection write | `POST selection-rules/changes` with the delta only. A checked set becomes one `variants` rule (≤10,000 ids, about 70 KB), not N rules. Bulk parser | 1 + 2 refetch |
| Over the cap | Step 1 warns above 10,000 selected. Step 2 targets, pricing review, category impact and rules impact all refuse (`DROPSHIP_CATALOG_TARGETS_TOO_LARGE`, `DROPSHIP_PRICING_REVIEW_TOO_LARGE`); Step 2 shows the one banner and disables Save. Step 3 still checks and publishes | — |
| Step 2 | Profile GETs lazy per card, cached with `staleTime`; rules impact on load. Rules: ≤100 per profile, `listings` ≤10,000 ids. Budgets: pricing routes 30/min per member (targets, reviews, apply), content routes 60/min, category routes 60/min. A save costs 2 of the pricing budget plus one per debounced targets keystroke | ≤5 |
| Step 3 readiness, ≤2,000 selected | Chunked `POST /listings/preview`, ≤200 ids per request, sequential, progress bar. Cached by `(store, selectionRevisionId, pricing/content/category revisionIds)` with `staleTime` 10 min and an always-available Re-check, because `previewHash` also depends on tier eligibility, ATP, package readiness, costs, guardrails and the eBay capability hash (`:1023-1046`), none of which is a revision id. Per-row `checkedAt` shown in the sheet | ≤10 |
| Step 3 readiness, >2,000 | Same chunking at launch: 50 requests, minutes (HYPOTHESIS on timing; each request does ATP reads and eBay preflight, `selection-atp-service.ts:262-266`). Successor: readiness projection (section 9.9), Step 3 reads the snapshot and shows "Checked 8,400 of 10,000 · 2 min ago" with a freshness pill | 1 |
| Publish | One `POST /listing-push-runs`, about 260 bytes per id (about 2.6 MB at 10,000), on a 4 MiB route parser. Server snapshots the target set and evidence, expands into child jobs of ≤500 in the background | 1 |
| Run duration | HYPOTHESIS: one worker, jobs sequential per sweep (`dropship-listing-push-job-runner.ts:88-105`), items sequential per job (`worker-service.ts:180-185`), sweep every 10 s, batch 10 (`job-runner.ts:20-23`). Duration ≈ chunks × (one ≤500-id preview) + items × (one 1-id preview + one marketplace push). At 1–2 s per item (not measured) a 10,000-item run is 3–6 hours. The Status card shows elapsed time; the vendor can leave | — |
| Status board | Runs list (20 newest) + listing status, server-paged 200, windowed | 2 per view |
| Polling | Only unfinished runs. 3 s for two minutes, then 15 s. Transient GET failures retried with backoff. No answer cap. Reload resumes from the server list | bounded |
| JSON bodies | Global limit 100 KiB (`rate-table-admin-body.middleware.ts:23`). Bulk parser (9.4) on: run POST (4 MiB); selection changes POST, category rules PUT + impact, rules impact, content-profile PUT, pricing reviews POST (1 MiB each) | — |

Why the readiness chunk size is 200 and not the 500 the API allows: the comment at `selection-atp-service.ts:262-266` records that ATP reads across a full catalog blew Heroku's 30 s router limit. A 500-id preview with eBay preflight is the same risk on an HTTP request. 200 is a guess. It is tunable in one constant. Run expansion is background work with no router limit, so its chunk is the 500-id job cap (9.4), a separate constant.

No eBay call happens on scroll or keystroke. Search is server-side, debounced 300 ms (catalog) and 500 ms (targets picker).

Selection across pages: the checked set is ids only. "Sell these" and "Set how these list" send those ids. The sheet's `listings` scope takes them directly. Nothing depends on which rows are mounted.

---

## 9. Server changes

Each change names the file it extends. Everything keeps Zod at the boundary, idempotency keys, structured `DropshipError`, and audit rows.

### 9.1 eBay category rules layer (section 7)

- Migration: new file mirroring `migrations/0660_dropship_vendor_listing_content.sql`, plus `queued_marketplace_category_id varchar(40)` on `dropship.dropship_listing_push_job_items`.
- Shared schema: `shared/dropship/ebay-category-rules.ts` (uses `catalogScopeSchema` from `shared/dropship/catalog-scope.ts`, same named-listing refine as `listing-content.ts:20-23`).
- Resolver: `server/modules/dropship/application/dropship-ebay-category-resolver.ts`, sibling of `dropship-listing-content-resolver.ts`, returning `evidenceHash` per row.
- Reader: `server/modules/dropship/infrastructure/dropship-ebay-category-rules.reader.ts`, mirror of `dropship-listing-content.reader.ts:7-18`. Added to the `Promise.all` at `dropship-listing-preview-service.ts:339-380`, gated on `platform === 'ebay'`.
- Evidence: preview row fields `marketplaceCategoryEvidenceHash`, `marketplaceCategorySource`, `marketplaceCategoryRuleName` (`dropship-listing-dtos.ts:29-63`); `expectedMarketplaceCategoryEvidenceHashesByVariantId` on `createListingPushJobInputSchema` (`dropship-use-case-dtos.ts:48-61`), checked in `assertPreviewMatchesReviewedEvidence`, hashed in `hashListingPushJobRequest`, counted by `carriesReviewedPreviewEvidence`; lock re-check in `dropship-listing-preview.repository.ts:626-665`; worker check in `dropship-listing-push-worker.factory.ts:17-41`. The client preview DTO (`toDropshipVendorListingPreview`) and the existing job route forward the new field.
- Service + repository: mirror `dropship-ebay-store-category-service.ts` (leaf check) and `dropship-ebay-store-category.repository.ts:77-244` (lock, replay, revision, audit).
- Taxonomy port: `server/modules/dropship/infrastructure/dropship-ebay-taxonomy.directory.ts` with `searchCategories(q): Promise<TaxonomyCategory[]>` (≤10) and `describeCategory(id): Promise<TaxonomyCategory | null>`, `TaxonomyCategory = { categoryId, categoryName, breadcrumb: string[], leaf: boolean }`. Leaf from `get_category_subtree`. In-process cache: per id 24 h, per query 1 h. Credential decision is open question 13.1; either path goes through `withEbaySafeReadRecovery` when the vendor's connection is used.
- Impact: `ebay-category-rules/impact` and the generic `rules/impact` (7.4), both in the application layer over `loadSelectedCandidates`.
- Routes: `server/modules/dropship/interfaces/http/dropship-ebay-category-rules.routes.ts`, shape of `dropship-listing-content.routes.ts:16-21`, bulk parser on PUT and the two impact POSTs.
- Preview: `dropship-listing-preview-service.ts:1002, 1034-1037, 1065-1068`.
- Test pinning the toggle: `dropship-listing-preview.repository` candidate query with `listing_enabled = false` still yields the base default.
- Test pinning evidence: rules save between check and publish → `createListingPushJob` 409; rules save between queue and push → item fails `DROPSHIP_LISTING_CATEGORY_CHANGED_SINCE_QUEUE`, `retryable: false`.

### 9.2 Catalog GET additions

`server/modules/dropship/application/dropship-selection-atp-service.ts` (`previewCatalog`, `:229-305`) and `dropship-selection-dtos.ts:86-96`:

- Response gains `selectionRevisionId` (newest `dropship_vendor_selection_rule_set_revisions.id` for the vendor; rule rows already carry it, `dropship-selection-atp.repository.ts:210`) and `summary { exposed, selected, excludedByException }`.
- Each facet gains `selectedCount` and `excludedCount`. Today facets carry only `rowCount` from the search-only candidate list (`:229-248, 319-371`). The change evaluates `evaluateDropshipVendorCatalogSelection` over `exposedFacetCandidates` too (pure, `rawAtpUnits: 0`, no I/O; the same call already runs over the filtered `candidates` at `:265-276`) and counts per facet.
- `selectedOnly` becomes `selection = all | selected | unselected | exceptions`. `selectedOnly` stays accepted for one release.
- Facet counts respect the active filters. Build facets from the filtered list; keep the unfiltered list only for the facet tree's totals.
- `idsOnly=true` returns `{ productVariantIds, total }` up to 10,000 and skips the ATP read.
- Later: SQL `LIMIT/OFFSET` and `COUNT` in `dropship-selection-atp.repository.ts:246-326` so cost stops growing with catalog size per page.

### 9.3 Selection changes endpoint and `variants` scope

- Migration: `ALTER TABLE dropship.dropship_vendor_selection_rules ADD COLUMN product_variant_ids integer[]`; replace `dropship_selection_rules_scope_chk` to include `'variants'` and `dropship_selection_rules_target_chk` (`0086:203-212`) with a sixth arm: `scope_type = 'variants' AND product_variant_ids IS NOT NULL AND cardinality(product_variant_ids) BETWEEN 1 AND 10000` and every other target column NULL. `shared/schema/dropship.schema.ts` gains the column.
- DTO: `scopeType: 'variants'` with `productVariantIds` (1..10,000, unique, sorted on normalize) in `dropship-selection-dtos.ts:11-57`. `vendorSelectionRuleDedupeKey` and `hashVendorSelectionRules` (`dropship-selection-atp-service.ts:373-392`) include the sorted id list. Admin exposure rules (`dropship_catalog_rules`) do not accept it.
- Matcher: `dropshipCatalogRuleMatchesVariant` (`catalog-exposure.ts:103-123`) gains `case "variants"`, matching through `rule.productVariantIdSet`, a `Set` attached once when rules are normalized on load, so evaluation stays O(1) per candidate. Exclude-always-wins is unchanged.
- Endpoint: `POST /api/dropship/catalog/selection-rules/changes { add: rule[], remove: ruleId[], expectedRevisionId, idempotencyKey }` in `dropship-vendor-catalog.routes.ts`, bulk parser. `ruleId` is the `id` of an active rule as `GET selection-rules` returns it (`DropshipVendorSelectionRule.id`, `vendor-selection.ts:14`), valid for the `expectedRevisionId` it was read with. Under the existing per-vendor `pg_advisory_xact_lock` (`dropship-selection-atp.repository.ts:147-149`) the server: replays by key + hash as `replaceSelectionRules` does (`:151-181`); checks the head revision → 409 `DROPSHIP_SELECTION_REVISION_CONFLICT`; removes by id, appends adds, dedupes; writes the resulting set as a new revision through the existing deactivate-and-insert path (`:206-212`), which is why ids are per revision. `GET selection-rules` returns `revisionId`.
- Partial un-exclude: the client builds `remove: [ruleId], add: [exclude with the remaining ids]` in one change (section 5d). The server has no partial-rule operation; a `variants` rule is replaced whole.
- The 500-rule cap stays. A 10k catalog is expressible in a handful of rules.
- Before shipping: a dry-run script that evaluates every vendor's selected set before and after the matcher change and diffs the results. The PR ships only with an empty diff.
- No step-up is added. Selection is not MFA-protected today and the UI must not imply it.

### 9.4 Push runs

- Bulk JSON parser: `server/modules/dropship/interfaces/http/dropship-bulk-json.middleware.ts`, the pattern of `parseRateTableAdminBulkJson` (`rate-table-admin-body.middleware.ts:44-52`) and the cutover-opening parser (`inventory-cutover-opening-body.middleware.ts:5-10`): the global installer skips the listed paths and the route parses after `requireDropshipAuth` (and after `requireDropshipSensitiveActionProof` on the run route). `DROPSHIP_RUN_JSON_LIMIT_BYTES = 4 MiB` for the run POST; `DROPSHIP_BULK_JSON_LIMIT_BYTES = 1 MiB` for the selection changes POST, category rules PUT and impact, rules impact, content-profile PUT and pricing reviews POST. Test: a 10,000-id body parses on each; 100 KiB + 1 on an unlisted route is still 413.
- Tables: `dropship.dropship_listing_push_runs` (id, vendor_id, store_connection_id, status `preparing | processing | completed | partial | failed`, review_mode, idempotency_key, request_hash, target_count, chunk_count, actor, created_at, updated_at, completed_at; `UNIQUE(vendor_id, idempotency_key)`) and `dropship.dropship_listing_push_run_targets` (run_id, product_variant_id, chunk_index, expected_content_hash NULL, expected_rule_hash NULL, expected_category_hash NULL, expected_price_revision_id NULL, expected_price_cents NULL, outcome `pending | queued | stale | blocked | completed | failed`, stale_code, job_id, job_item_id, error_code, retryable, decided_at). The hash columns are nullable because the maps cover only rows that carry a hash: `assertPreviewMatchesReviewedEvidence` checks content hashes where `row.contentEvidenceHash` is set and rule hashes where `row.rulePriceEvidenceHash` is set (`:826-833`; a typed fixed price has none, `:1051`), while the two price maps must cover every id (`:837-857`). The run schema mirrors that per map.
- `POST /api/dropship/listing-push-runs` in `dropship-listing.routes.ts`, behind `requireDropshipSensitiveActionProof("bulk_listing_push")` (`:54`). Body: `storeConnectionId`, `productVariantIds` (1..10,000), `reviewMode: 'reviewed_preview'` (the only mode at launch), the five evidence maps, `idempotencyKey`. The route snapshots targets and evidence in one transaction under the store advisory lock and returns 202 with the run. It does not run previews.
- Expansion: a new service entry point `expandListingPushRun(runId)`, called by the sweep in `dropship-listing-push-job-runner.ts` before job processing, for each run with `pending` targets. It takes the next ≤500 `pending` targets by `chunk_index` (the `createListingPushJob` cap; a separate constant from the readiness chunk), runs `generatePreviewForContext` once for them, and compares each row against its target's five values. Rows that match go to the repository's `createListingPushJob` with `idempotencyKey = \`run:${runId}:${chunkIndex}\`` (well inside the 200-character bound, `dropship-listing-dtos.ts:8`) and the evidence slice for those rows; the repository re-verifies under the lock as today. Rows that differ are written `stale` with `stale_code` naming the value that moved; rows now blocked are written `blocked`. Target writes and the job insert share one transaction. If the lock re-check throws 409 (drift between the preview and the lock), the chunk is retried on the next sweep, up to 3 attempts, after which its remaining targets are `stale` with `DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT`. `createListingPushJob` in `reviewed_preview` mode throws before writing anything and none of its 409s names a variant (`:830-857`; repository `:638-662`), which is why the per-row comparison happens in the run service, not by catching those errors.
- Run status: `preparing` until the first chunk is decided; `processing` while any target is `pending | queued`; then `completed` (all completed), `partial` (any stale, blocked or failed), `failed` (none completed). Target outcomes mirror job item outcomes as items finish (`finalizeJob` pattern, `dropship-listing-push-worker.repository.ts:291-325`). `updated_at` moves on every target change.
- Ops alerting: `preparing` older than 5 minutes; `processing` with no target change for 30 minutes (the worker's own stale-processing figure, `job-runner.ts:22`). Child jobs of one run are sequential across sweeps at launch; parallel workers are a later decision (13.6).
- `GET /api/dropship/listing-push-runs?storeConnectionId=&limit≤20` and `GET /api/dropship/listing-push-runs/:runId` (vendor-scoped; other vendors' runs read as 404). Items carry `priceCents`, `marketplaceQuantity`, `outcome`, `staleCode`, `errorCode`, `retryable`, so the outcome view needs no in-memory preview and Step 3 can say "37 listings changed".
- Retry: no server endpoint. The Status board re-checks the retryable ids through the readiness chunker and creates a new reviewed run with fresh evidence, behind the step-up modal.
- The single-job endpoint stays for the detail sheet's one-row publish.

This is the "audited background job with explicit target snapshot" the map requires above 500 targets. It also removes the 10-minute proof TTL race across batches (`domain/auth.ts:70`).

### 9.5 Listing status endpoint and cost-change state

`GET /api/dropship/listings/stores/:storeConnectionId/status?lane=&search=&page=&limit≤200` in a new `dropship-listing-status.routes.ts`, service beside `dropship-listing-push-status-service.ts`. Reads `dropship.dropship_vendor_listings` (`0086:262-283`: status, `external_listing_id` → `listingUrl`) joined to catalog product/variant names, the latest `dropship_listing_push_job_items` row per listing (`error_code`, `error_message`, `result.retryable`; `0086:316-332`), `dropship_cost_change_listing_holds WHERE released_at IS NULL` (`0713:12-30`) and the latest `dropship_cost_change_listing_actions` row per listing (`0713:86-127`). `paused_reason` is not read. Response includes counts by lane. Private, no-store, vendor-scoped.

Lanes, `deriveListingLane(status)` in `shared/dropship/listing-lane.ts`, one pure function used by the SQL `CASE` (generated from the same table) and the UI, over all ten statuses:

| Lane | Statuses |
|---|---|
| Live | `active` |
| Queued | `queued`, `pushing` |
| Failed | `failed` |
| Blocked | `blocked` (every blocked preview row becomes a `blocked` listing row at job creation, `dropship-listing-preview.repository.ts:759-791`) |
| Paused | `paused`, `ended` (`paused` = non-live listing mode, `worker.repository.ts:232`) |
| Needs update | `drift_detected` |
| Not listed | `not_listed`, `preview_ready` |

Overlays, independent of status: `held` when a live hold row exists; `awaiting_review` when the latest action is `awaiting_review`. A `failed` item with `DROPSHIP_LISTING_PRICE_AWAITING_REVIEW` (`worker.factory.ts:31-39`) shows the reason "Price change awaiting your review" with the Cost changes link.

The same reader adds two preview warnings, `cost_change:held` and `cost_change:awaiting_review`, in the `Promise.all` at `dropship-listing-preview-service.ts:339-380`, so Step 3 groups them without a second endpoint. They are warnings, not blockers: the hold already zeroes the quantity at inventory planning, and the push writes the same (`:955`). There is no release control anywhere in the portal.

### 9.6 Pricing recipe `fixed` kind with schema version

`shared/dropship/pricing-rules.ts:8-14`: `pricingRecipeSchema` becomes a discriminated union `{ kind: 'markup', basis, markupBps, flatCents, rounding } | { kind: 'fixed', priceCents }` (integer cents, ≤ `MAX_LISTING_PRICE_CENTS`). Profiles carry `version: 2`. Existing profiles without `kind` parse as `markup`. `calculateRulePrice` returns `priceCents` for `fixed`. Reviews hashed under the old shape are refused as `DROPSHIP_PRICING_REVIEW_STALE` (`dropship-pricing-rules-service.ts:144`) rather than mis-applied. Evidence hashes and formatters unchanged.

### 9.7 Blocker resolution hints

Preview rows carry `resolution: { step: 'setup' | 'wallet' | 'listing' | 'support' | 'category_rule' | 'cost_changes', target? }` per blocker or warning code, mirroring the access-block `resolution` at `dropship-listing-preview-service.ts:742-754`. This starts as a client map layered on `formatListingPreviewIssue` (`client/src/lib/dropship-listing-preview.ts`) with no server change, and moves server-side in PR12.

### 9.8 Scoped policy rules and store-shelf rules (later)

A policy profile `{ defaults, groups[{ id, name, priority, scope, fulfillmentPolicyId|null, returnPolicyId|null, paymentPolicyId|null }] }` mirroring `listing-content.ts`, resolved in `buildBusinessPolicySelection` after per-listing overrides, validated against the store's current options at save (`override-service.ts:165-176`). Same shape for store shelves, resolved before per-variant assignments, with `expectedRevisionId` on the per-variant assignment input (`dropship-ebay-store-category-dtos.ts:10-23` has none today).

### 9.9 Readiness projection (later)

A `dropship.dropship_listing_readiness` row per `(store, variant)`: status, blockers, warnings, priceCents, the five evidence values, `preview_hash`, `computedAt`, `selectionRevisionId`, profile revision ids. An advisory-locked sweep runs `generatePreviewForContext` in chunks. The queue transaction writes blocked and stale rows back so Step 3 reflects send-time results. The status endpoint reads it and derives "Needs update" from `preview_hash != dropship_vendor_listings.last_preview_hash` (`0086:275`). Push runs may then reference the projection instead of carrying evidence maps, which removes the multi-megabyte run body.

---

## 10. What is removed

- The single 1,662-line page and its eight stacked panels (`DropshipPortalCatalog.tsx:657-800`).
- Draft filter state with Apply/Reset and the 10-term `hasActiveFilters` (`:154-159, 226-235, 549-568`). Filters are URL state.
- Per-row Select/Remove, "Select visible"/"Remove visible", and `pendingSelectionAction` disabling every button (`:288-321, 1523-1536`).
- Per-variant selection rules as the default mechanism. The page-1-only 50-row table (`:186-187`).
- `fetchAllSelectedCatalogRows` and `selectedCatalogRows` (`:118-142, 242`). The unpaginated "Selected items" table (`:1273-1313`). `previewContextKey`.
- `invalidateListingPreview` wiping `emailCodeSent` / `verificationCode` (`:323-331`), the inline OTP box (`:1321-1338`), and the two-click "Queue ready listings" → "Verify and queue push" relabel (`:413-435, 1646-1651`).
- "Preview selected" as a button and the "preview then push" copy.
- The per-variant price editor as the primary pricing path. It stays only as the exception editor in the detail sheet, re-previewing one id.
- The per-variant eBay Store shelf grid at 25 per page with save-on-change and a fresh key per call (`:962-1149`). Until PR12 the shelf grid stays as a draft-and-Save card (4.2).
- Six top-of-page Alert banners (`:616-655`) and the second error surface in the push card.
- The 100-answer polling cap and `retry: false` (`:1383-1392, 1402, 1410`; `dropship-listing-push-status.ts:57-58`).
- "The table below shows why" rendered below the table (`dropship-ops-surface.ts:4590-4598`).
- The store select inside the push panel (`:796`).
- "Reload saved price" discarding the draft on 409 (`DropshipListingPriceEditor.tsx:110-118, 197-198`).
- Client-side chunked publish. There is one publish path: the push run.
- Any read of `paused_reason`.

---

## 11. Build plan

Each PR is independently shippable. Category rules and the toggle pin come first.

| PR | Scope | Files | Tests |
|---|---|---|---|
| 1 | eBay category rules server layer + toggle pin + category evidence. Migration (rules tables, `queued_marketplace_category_id`), shared schema, resolver with `evidenceHash`, reader, service, repository, taxonomy port, routes incl. search, leaf check, category impact, generic rules impact, targets, bulk parser on PUT/impact. Preview plug-in; fifth evidence map through schema, assert, request hash, lock re-check, worker check. Test that the base default ignores `listing_enabled`. No UI. | 9.1, 9.4 (parser) | resolver first-match / default / catalog fallback / none; leaf rejection; replay; hash conflict; revision conflict; impact counts per category and per rule; rules save between check and publish → 409; rules save between queue and push → permanent item failure; `current_preview` with the fifth map refused; DI-stubbed transaction tests; toggle regression; 10,000-id PUT parses. |
| 2 | Routes and frame, no behaviour change. `/catalog/{choose,setup,publish,status}` under wouter, StepRail with ticks from existing fields (Step 1: any active include rule; Step 2: `missingFields` empty; Status: link only), StickyActionBar, store selector in the rail (eBay only), `/catalog` → `/catalog/choose`. Existing sections mounted under the steps as-is. | `App.tsx:269`, new `client/src/pages/dropship/catalog/*` | route → step mapping, tick derivation, redirect, non-eBay connection not selectable. |
| 3 | Step 1 selection by group. Facet checkboxes (rules-only state, no ◪ yet) with two-step bulk bar; facet Stop selling removes includes and never adds a scope exclude; checked set; `TargetSet` lib with `describeTargetSet`; row-level exceptions as `variant` exclude rules with pills; "Your rules" chips with remove and "Convert to a category rule"; URL filters; tri-state Show; server paging 200 + Load more + windowed table (`@tanstack/react-virtual`). Uses the whole-set PUT keyed by `vendorSelectionRuleDedupeKey`, with a soft warning at 400 rules. | `dropship-listing-targets.ts`, `dropship-ops-surface.ts:4747-4800` | rule builders per scope, exception round-trip, "Sell these" removes matching excludes, facet Stop selling removes inner includes and creates no exclude, 400-rule warning, checked set survives paging, `TargetSet` promotion rule. |
| 4 | Server catalog and selection: migration for `variants` (column, CHECK arms), dedupe key and canonical hash, matcher Set, `selectionRevisionId`, `summary`, facet `selectedCount` / `excludedCount`, `selection=` tri-state, filter-aware facets, `idsOnly`, `POST selection-rules/changes` with `ruleId` removal and bulk parser, dry-run diff script. Client switches to deltas, `ruleId`, the ◪ state, partial un-exclude, and the revision context key. | 9.2, 9.3 | DTOs, replay, hash conflict, revision conflict, facet counts incl. selected/excluded, `variants` matching, partial un-exclude keeps the other ids excluded, evaluator diff empty, admin rules reject `variants`, 10,000-id change parses. |
| 5 | `useMutationDraft` + Step 2 Store defaults card. Fold `EbayListingSetupPanel` logic, default recipe and default template into four status rows with Change → inline editors; null pricing/content profiles shown as "catalog … used", never as blockers. Move the price editor and setup save onto the hook. Base rows shown read-only. | `useContentDraft.ts`, `EbayListingSetupPanel.tsx`, `DropshipListingPriceEditor.tsx` | phase transitions; retry never re-sends a confirmed write; conflict keeps the draft. |
| 6 | Step 2 Rules by group + Rule sheet. One ordered table over pricing, content and category profiles; drag reorder → `priority = (index + 1) × 10` (legacy ties surfaced as a conflict before save; reorder re-saves every affected profile); per-rule counts from `rules/impact`; "Set how these list" hand-off from Step 1; impact summary from pricing review + category impact + rules impact with blocked and stale handling; sequenced per-part save with per-part retry and result lines; "N of 100 · M of 10,000"; snapshot rule refused over budget; targets picker debounced 500 ms; Exceptions card with search and "Release fixed prices" (`releaseFixedOverrides`); over-cap banner; shelf grid as draft + batched per-variant PUTs (≤100, keyed per variant + payload). | `DropshipPricingRulesPanel.tsx`, `DropshipContentTemplatesPanel.tsx`, `DropshipCatalogScopePicker.tsx` | assembly/disassembly lossless; no priority ties; sequence never re-sends confirmed parts; blocked review skips the pricing part; stale apply re-reviews and waits for confirm; impact shown before any write; budget refusal; over-cap disables Save. |
| 7 | Push runs server. Tables (nullable hash columns), POST/GET routes with the 4 MiB parser, five maps, `expandListingPushRun` with per-row stale/blocked outcomes, chunk keys from the run id, chunk 409 retry then `stale`, run aggregation, items with `priceCents`, `marketplaceQuantity`, `staleCode`, `retryable`, `processing` age alert. | 9.4 | snapshot is exact; chunk keys deterministic and ≤200 chars; replay; step-up enforced; blocked rows never become items; one drifted row is `stale` while the rest of its chunk queues; chunk conflict retries then stales; vendor scoping; 10,000-id body parses; run status aggregation. |
| 8 | Status server: listing status endpoint, `deriveListingLane()` shared, holds and actions joins, cost-change preview warnings. | 9.5 | vendor scoping; paging bounds; counts per lane over all ten statuses; held and awaiting-review overlays; `DROPSHIP_LISTING_PRICE_AWAITING_REVIEW` reason; preview warning appears for a held listing; Zod response. |
| 9 | Step 3 readiness + publish. Chunked cached readiness (≤200) with 10-minute `staleTime`, always-available Re-check and per-row `checkedAt`; disjoint tiles as filters; Needs attention groups incl. held / awaiting review with the client fix map; Reason facet and flat-table toggle; spot-check via `ListingPreviewTable` + sheet with single-row re-preview replacing the cached row; `?variant=` deep link; Publish disabled while a sheet save or re-preview is pending; run body built from the cache at click time with the five maps; step-up modal isolated from page state, code requested only when no proof is live; `DROPSHIP_STEP_UP_REQUIRED` → `refetchAuth`; stale count from run targets. | `DropshipListingPreview.tsx`, `dropship-listing-preview.ts`, `dropship-auth.tsx` | chunker; evidence map completeness per map rule; blocked rows never sent; stale → re-check that set with the server's count; proof TTL checked before POST and no code sent with a live proof; Publish disabled during pending saves; tiles disjoint; admin-owned blockers have no button. |
| 10 | Status board. Run cards (`describeListingPushOutcome`, retryable vs permanent, "Retry failed (N)" = re-check + new reviewed run + step-up for retryable ids only, elapsed time), listings table with lane pills and cost-change overlays, backoff polling without the cap, `/catalog` → status redirect. Remove `ListingPushOutcomeNotice`. | `dropship-listing-push-status.ts` | polling predicate with backoff; retry set excludes `retryable=false`; retry goes through the chunker and the modal; redirect; permanent failures show Contact support and no button. |
| 11 | Pricing recipe `fixed` kind with `version: 2` and stale-review refusal. Rule sheet Price radio. | 9.6 | integer-cents path; out-of-range; legacy profiles parse as markup; old-shape review refused. |
| 12 | Scoped policy rules and store-shelf rules with `expectedRevisionId`, resolution, routes, Rule sheet columns. Delete the per-variant shelf grid and the standalone policy panel. Server-side blocker resolution hints. | 9.7, 9.8 | resolution order (per-listing > rule > default); option validation at save; shelf revision conflict. |
| 13 | Delete legacy `DropshipPortalCatalog.tsx` sections and dead helpers. Port remaining tests. Readiness projection + sweep + "Needs update" chip for catalogs above ~2,000; runs reference the projection. | 9.9 | projection freshness; lane derivation shared by SQL and UI; queue writes blocked and stale rows back. |

Each PR carries its own test migration for `DropshipPortalCatalog.test.ts`. Static-markup tests wrap the new routes in wouter's `Router`.

---

## 12. Risks and failure modes

1. **Multi-profile saves are not atomic.** Pricing (review → apply), content, category rules and policies are separate transactions. A rule can be half-applied. Mitigation: per-part idempotent retry with retained keys, per-part result lines, server-recomputed readiness after every save. A single atomic rule-set endpoint is out of scope.
2. **Readiness cost and staleness at scale.** Each ≤200-id preview does ATP reads and eBay preflight. 10k SKUs is 50 sequential heavy requests. Timing is HYPOTHESIS. `previewHash` depends on wallet tier, ATP, package data, costs and the capability hash, none of them a revision id, so a revision-keyed cache alone goes stale after a top-up, a cost change or an admin fix. Mitigation: 10-minute `staleTime`, always-available Re-check, per-row `checkedAt`; the projection in PR13.
3. **Reviewed publish 409s after a long check.** Prices under cost-change review, a rules save in another tab, or a category rules save drift. Run expansion marks only the drifted rows `stale`; the UI shows the server's count and never resends the same evidence. A queued item whose category moved fails permanently at push and asks for a re-check.
4. **Priority remapping.** `(index + 1) × 10` on first save rewrites existing group priorities. Semantics are preserved, numbers are not. Ties in legacy data are surfaced as a conflict before save. A reorder re-saves every profile whose priorities changed. A dry-run diff per vendor runs before PR6 ships.
5. **Excludes always win.** An exception created by row-level "Stop selling these" survives re-ticking the category. The pills and chips make this visible. "Sell these" rewrites the exclude rule without the chosen ids. Facet-level Stop selling never creates an exclude.
6. **`variants` scope touches the shared matcher.** A bug there changes every vendor's selection. Mitigation: admin rules reject the scope; the evaluator diff script must be empty before merge.
7. **Facet counts ignore filters until PR4.** "Select all N matching" uses the query total, never facet `rowCount`. The ◪ state does not exist until PR4.
8. **Selection has no step-up.** Copy must not imply MFA. The changes endpoint keeps the same posture.
9. **Admin-owned blockers** (`listing_config_required`, `catalog_package_data_required`, `active_box_required`, `active_rate_table_required`; `dropship-listing-preview-service.ts:964-976`) cannot be fixed by the vendor. A first-time vendor can reach Step 3 with only "contact support". The Dashboard should surface these before Step 1 (out of this plan's scope; noted).
10. **Taxonomy proxy credential.** Admin token vs vendor credential is undecided (13.1). Leaf verification is one eBay call per distinct category per save and is cached 24 h per id.
11. **Policies and shelves stay checked-set-only until PR12,** and shelf saves are last-write-wins per variant with no revision check until then. The sheet and the shelf card say so.
12. **Push run expansion and processing are slow and serial.** One worker, sequential jobs and items. A 10,000-item run is hours (HYPOTHESIS, section 8). If the sweep is down, runs sit in `preparing`. Alerts: `preparing` older than 5 minutes, `processing` with no target change for 30 minutes. The Status card shows elapsed time.
13. **Windowed tables and checkboxes** change keyboard and screen-reader behaviour. Row identity is `productVariantId`; the checked set never depends on mounted rows. Sort/filter refetch is deferred while a row editor is open.
14. **Redirect surprise.** Vendors who bookmarked `/catalog` land on Status once listings exist (from PR10). Step 1 is one click away in the rail and "Choose more" is in the Status bar.
15. **Body sizes.** The global limit is 100 KiB. A 10,000-id run body is about 2.6 MB by arithmetic, and a 10,000-id `variants` rule, `listings` scope or category document is over 70 KB. Every such route gets its own parser (9.4) with a parse test at 10,000 ids; any route left on the global parser fails at roughly 1,200 ids.
16. **10,000-selected cap per vendor.** Above it, Step 2's targets, review and impacts refuse. The UI explains and points to Step 1; nothing is silently truncated.
17. **Rate limits.** Pricing routes 30/min, content and category routes 60/min, step-up 30 per 15 minutes. A Step 2 save spends 2 of the pricing budget; the targets picker spends one per debounced keystroke; the modal sends a code only without a live proof.

---

## 13. Open questions for the owner

1. **Taxonomy credential.** Should the vendor category search and leaf check use the Card Shellz admin eBay token (as `ebay-taxonomy.routes.ts` does) or the vendor's own connection through `withEbaySafeReadRecovery`? Admin token is simpler and works before the vendor connects; vendor credential keeps call volume on the vendor's quota.
2. **Store default for eBay category.** Should a vendor be allowed to set a store-wide default category at all, or only rules by scope with the Card Shellz mapping as the only fallback? A store-wide default is the easiest way to put 800 listings in the wrong category.
3. **Selection MFA.** Selection changes have no step-up today. Keep that, or add `manage_catalog_selection` (already defined in `dropship-auth.tsx:23` and `domain/auth.ts:18`) to the changes endpoint? Adding it means a code prompt on every "Sell these".
4. **Below-cost confirmation.** Below-cost rows publish as warnings today. Should the confirm modal require ticking "I understand 8 listings are below cost" before Publish, or is the line of copy enough?
5. **Launch cut.** Is PR1–PR10 the launch (category rules with evidence, selection by group, defaults, rules table, push runs, status), with `fixed` pricing, scoped policies and the projection after? Or must `fixed` pricing be in the first release?
6. **Run throughput.** Is a multi-hour 10,000-listing run acceptable at launch with one serial worker, or should PR7 include parallel child jobs across sweeps (a change to the advisory-locked sweep, `job-runner.ts:126`)?
7. **Selection cap.** Is 10,000 selected listings per vendor acceptable as a launch constraint, given the pricing review and the category impact both stop there?