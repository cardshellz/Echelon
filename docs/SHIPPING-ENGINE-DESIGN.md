# Cardshellz Shipping Engine — Design v1 (2026-07-02)

Mini-Amazon shipping engine: checkout sells **service levels** (Standard/Expedited/…), the engine finds the **cheapest carrier+method** satisfying the promise, and the WMS hands the pack station an **optimized box/split plan**. Replaces Parcelify.

## Verified current state (all claims checked in-file or against prod 2026-07-02)

**Exists and reusable:**
- **Dropship shipping stack in Echelon** (deployed 6/26, seed-data only, vendor-scoped — a TEMPLATE to generalize):
  - `dropship.dropship_box_catalog` (dropship.schema.ts:798-813) — code/name/L/W/H mm/tare/max-weight/active. Prod: 1 row ("Baby Box" 8×6×4).
  - `dropship.dropship_package_profiles` (:815-834) — per-variant dims/weight/ship_alone/default box/max_units. Prod: 1 row.
  - `dropship_rate_tables` + `_rows` (warehouse, zone, weight band, cents) + `dropship_zone_rules` (postal-prefix→zone, priority) (:836-878). Prod: 1 rate row, 1 zone rule.
  - Markup/insurance bps policies + `dropship_shipping_quote_snapshots` (idempotency_key, request_hash, quote_payload) (:880-939).
  - **Working v1 cartonizer** `cartonizeDropshipItems` (server/modules/dropship/domain/shipping-quote.ts:112-171): ship_alone→1/box, max_units cap, weight+tare cap, smallest-volume-first. **Limitation confirmed: one SKU per package, single-unit dim check only.**
  - Clean provider seams: `DropshipCartonizationProvider`, `DropshipShippingRateProvider` — plug-and-play interfaces already in the codebase's idiom.
- **Membership policy plane — DONE & LIVE** (club app, PRs #171-183, ahead of the stale local clone): `plan_benefit_assignments` with `shipping_group_id` dimension → compact **523-byte** `cardshellz.shipping_thresholds` shop metafield (verified live, 6 plans, updated 6/23) → `cardshellz-shipping-discount` Function (ACTIVE DiscountAutomaticApp) → member free shipping rendering $0 on live orders. The proven pattern for all member shipping benefits.
- **C9 ShippingEngine port** (server/modules/shipping/engine.ts:26-106): push/hold/cancel/markShipped via ShipStation V1 with hardened 429 backoff; carrier normalization stamps_com→USPS, ups_walleted→UPS. Fulfillment-side only, zero rating.
- **Warehouse cutoff/SLA** (warehouses.order_cutoff_local + tz; resolveSlaDueAt) — the ship-date half of ETA. Single real origin: LEON, PA 16066, 12:00 ET cutoff, 99%+ of stock.
- **Catalog columns waiting for data**: product_variants.weight_grams/length_mm/width_mm/height_mm (catalog.schema.ts:145-148) + pack hierarchy (units_per_variant, hierarchy_level, is_base_unit).
- Packer landing spots: `wms.outbound_shipment_items.box_id` + `weight_oz` (0/8,278 populated); sort_rank→ShipStation customField1 precedent.
- Shopify: CCS demonstrably enabled (Parcelify api-type carrier works on base plan); club-app token has write_shipping → `carrierServiceCreate` executable today; 2 delivery profiles (General 412 variants / Storage Boxes 4).

**Verified voids:**
- **0/324 variants have weight or any dimension** in catalog (prod query 7/2). Shopify has weights for ~94% of sampled variants (backfillable); dims exist NOWHERE.
- No rating code for checkout anywhere (no CarrierService callback in any repo).
- No actual-cost capture: outbound_shipments.carrier_cost_cents = 0 on all ~3.5k 90-day shipments.
- No ETA at checkout (Parcelify returns no delivery dates). No express/second service option in 40 straight observed lower-48 orders.
- Carrier mix 90d: USPS 2,038 / UPS 1,354 / FedEx 381; ~43 shipments/day.

**Hard Shopify constraints (verified):**
1. CarrierService callback: gets origin/destination/items(grams, price, sku, properties) — **NO customer, NO metafields, NO dims**; ~10s/5s/3s dynamic timeout, no retry; responses cached ~15 min NOT keyed on customer. ⇒ Checkout rates must be **member-agnostic, precomputed, stateless**; dims joined engine-side by SKU. Member pricing must come from the Functions layer.
2. Functions can only **reduce** an existing rate (100%/partial discount) — never create or raise one. ⇒ Base rates are the ceiling; "member-exclusive express" is structurally impossible — express must be offered to all, discounted per plan.
3. Metafields >10KB arrive NULL in Functions (the 22KB plan_benefits incident) — compact projections only (523B pattern proven).
4. Rate naming is load-bearing across delivery profiles: same-named rates SUM into one line; different names collapse to cheapest generic "Shipping."

## Architecture — two planes, one engine

```
QUOTE PLANE (checkout, member-agnostic, <1s)
Shopify checkout ──► CarrierService callback (Echelon, new)
  cart items ──► sku→dims join ─► Split Planner ─► Cartonizer v2 ─► Rates (local tables)
             ─► ETA (cutoff + transit table) ─► service-level offers (Standard/Expedited/Express + dates)
  member benefits: shipping-discount Function (club app — LIVE) discounts per plan on top

FULFILLMENT PLANE (pack station, exact)
order ingest ─► persist SHIP PLAN (re-cartonize with order-final items)
  ─► pack instruction (v1 ShipStation customField "BOX: …"; v2 Echelon Packing page)
  ─► label buy (ShipStation, existing C9) ─► webhook captures actual cost/box/weight
  ─► CALIBRATION LOOP: quoted vs actual → rate-table corrections
```

**Ownership:** engine = new `shipping` Postgres schema + `server/modules/shipping-engine` module in **Echelon** (owns catalog, boxes, warehouses, WMS, pack station). Callback endpoint hosted by Echelon (Heroku), registered once via the club-app token (owns write_shipping). Member policy stays in club app + Function (proven). Dropship keeps its stack short-term; converges on shared tables later.

## Modules & contracts

1. **Box Catalog** `shipping.box_catalog` — generalize dropship shape + add `kind` (box|mailer|envelope|own_container) + `cost_cents` (materials) + `carrier_dim_class` (e.g. USPS cubic tier). Admin CRUD (copy dropship routes).
2. **Item Shipping Attributes** — populate `catalog.product_variants` dims/weight (canonical physical truth, per sellable variant now; UoM base-unit roll-up later) + `shipping.variant_shipping_attrs` (ship_alone/own_container, packing_class, fragility). Admin write path + CSV/measure-station bulk entry (none exists today). Shopify-weight backfill as seed.
3. **Cartonizer v2** `cartonize(items, boxes) → candidatePackings[]` — generalize the dropship function: (a) multi-SKU mixed-box via volume-fill FFD + sorted-dims feasibility, (b) quantity volumetrics (N units bounded by volume fill factor AND weight), (c) own-container passthrough, (d) emit 1–3 candidate packings so rates picks the cheapest (breaks the cost-aware circularity), (e) never throws — degrades to a fallback packing + warning. Keep the provider seam (Paccurate can A/B later).
   **DECIDED 2026-07-02 (user confirmed): co-mingling = RIDER/VOID model, not group×group rules.** Shipping groups stay the default partition (storage boxes ship flat, separately). Exception mechanism: `rider_eligible` flag on soft/thin variants (sleeve packs) + `rider_void` caps (volume/weight/count) on own-container variants (large storage boxes). Consolidation pass runs after cartonization and absorbs riders ONLY if it eliminates an entire parcel (kill-a-label-or-do-nothing — behavior stays binary, cost always ≤ today). PackPlan makes it explicit to the packer ("add-in: 3× sleeves, tuck flat"); v2 packing UI "didn't fit — split out" action records deviations → calibration disables chronically failing rider combos. Policy/physics separation: free-shipping thresholds key on shipping-group SPEND (unchanged); rates key on parcels — riders never touch threshold logic.
4. **Split Planner** `plan(order) → shipments[]` — v1: single origin, split = cartonizer output grouping; deliberate rate-naming strategy for multi-profile carts. Split-across-origins deferred (99%+ single-origin).
5. **Rates Engine** `rate(packing, dest, serviceLevel) → quotes[]` — local deterministic tables (`shipping.rate_tables/_rows/zone_rules`, generalized from dropship incl. effective dating + cheapest-wins) serving the callback in <100ms for LOWER-48. **DECIDED 2026-07-02 (user): hybrid** — HI/AK/PR destinations make a LIVE ShipStation v2 rate call inside the callback (~0.75% of orders; hard 2s timeout, fallback to padded HIPRAK table row — the callback must ALWAYS return a rate). Matches Parcelify's existing Domestic-49 + HIPRAK zone split. **Cart display DECIDED: stays STATIC** (62.5% of orders sub-$69 but lower-48 paid rates cluster $5-$14; HI/AK only 0.75%) — sourced from the rate table's typical lower-48 band instead of the hardcoded 899/1099 cents in main-cart-shellz.liquid:557, with copy "Estimated for continental US — final rate at checkout." No zip-entry UX in cart.
6. **Carrier Adapters** — NEW rating port (separate from C9 fulfillment port, same conventions): `getRates(packing, dest) → carrier quotes`, `getTransit(...)`. v1 adapter: **ShipStation API v2 (ShipEngine)** — quotes the same stamps_com/ups_walleted wallet accounts labels are bought on ⇒ quote = actual label cost. Used OFFLINE to build/refresh rate tables + spot-calibrate, not at checkout.
7. **Service Levels** `shipping.service_levels` — e.g. Standard (3–7d), Expedited (2–3d), Express (1–2d); each maps to eligible carrier services + transit windows per zone. Checkout offers levels; fulfillment re-solves cheapest carrier meeting the promised date (Amazon decoupling).
8. **ETA** — ship date (existing cutoff/SLA) + `shipping.transit_matrix` (zone × service → business days, seeded from carrier standards, corrected by actuals) → `min/max_delivery_date` on every rate (checkout shows dates for the first time).
9. **Membership Policy** (club app — mostly DONE) — extend BenefitKind with `express_discount` / per-group express pricing; project into the compact metafield; Function discounts express/standard per plan. Base = full price for guests.
10. **Packer Execution** — v1: "BOX: 12X10X4 ×2" via ShipStation customField (zero UI, days to ship). v2: Echelon Packing page consuming the persisted ship plan, confirming actual box/weight into outbound_shipment_items → closes the calibration loop.

## Phasing

- **P0 — Data (gating, parallel with all code):** catalog the physical box suite; dims capture for ~300 active variants (form-factor templates: measure one toploader model, apply to family); Shopify weight backfill; build the dims-entry admin + CSV path first so the capture program has a tool.
- **P1 — Engine core (shadow):** `shipping` schema; generalize box/rate/zone/cartonizer; ShipStation v2 adapter; nightly rate-table build; SHADOW MODE — quote every real order internally, compare to Parcelify-charged + actual label cost, tune until quote≈cost.
- **P2 — Checkout cutover (Standard only):** register CarrierService (club-app token → Echelon URL); serve Standard w/ ETA dates gated to cardshellz-test; verify member Function discounts stack correctly on our rates; progressive rollout; transcribe Parcelify rules + resolve CCS-enablement question; decommission Parcelify.
- **P3 — Service levels:** Expedited/Express w/ dates; pick-priority hookup (priority.shipping_base already has standard/expedited/overnight vocabulary).
- **P4 — Pack station:** v1 customField instruction → v2 Packing page + actuals capture → calibration dashboards (quoted vs actual).
- **P5 — Member express benefits:** BenefitKind extension + projection + Function update; plan-tier express pricing.

## Walkthrough decisions LOCKED 2026-07-02
1. **Cart display**: static, rate-table-sourced, "Estimated for continental US" copy. No zip-entry UX.
2. **Checkout rating**: hybrid — local tables lower-48, LIVE ShipStation v2 call for HI/AK/PR (2s timeout → padded table fallback; callback always returns a rate).
3. **Co-mingling**: rider/void model (see Cartonizer v2). Groups = default partition; riders absorb only when a whole parcel is eliminated.
4. **Fill math**: flat ~85% volume fill factor, items treated as rectangular bricks; per-SKU overrides added ONLY when pack-station feedback shows chronic misfit. No per-product nesting factors in the measuring program.
5. **Multi-warehouse**: FULL multi-origin in v1 (user explicitly chose over model-only) — inventory-aware origin selection, split-across-origins, combined quotes. ⚠️ Implication: OMS must support one order → multiple warehouse-scoped shipments (today wms.orders has a single warehouse_id; routing-at-ingestion is single-origin). This is the largest v1 work item.
6. **SIOC**: manual `ships_in_own_container` checkbox per variant in Echelon; system pre-suggests sealed case-level variants from the pack hierarchy; user approves.
7. **Carrier accounts (verified via V1 API 7/2)**: FedEx = OWN account; USPS (stamps_com), UPS (ups_walleted), DHL Express, GlobalPost = ShipStation wallet. v2 quotes = real negotiated costs.

## Pending user action
- Generate a ShipStation **v2 API key** (Settings → Account → API Settings) → `heroku config:set SHIPSTATION_V2_API_KEY=<key> -a cardshellz-echelon`. If no v2 section exists on the plan, adapter falls back to EasyPost/direct-carrier — architecture unchanged.

## Original design questions (superseded by the locked list above)

1. **CCS enablement basis** — must confirm in Shopify admin billing/settings BEFORE uninstalling Parcelify (annual plan? add-on? unknown). Human check.
2. **Box suite + measurement program** — how many physical box/mailer sizes? who measures items (form-factor templating acceptable?); I build the capture tooling first.
3. **ShipStation plan/API v2 access** — does the current ShipStation tier include API v2 rate shopping? FedEx via wallet or own account?
4. **Express model confirmation** — express offered to ALL at full price; members get it free/discounted via Function (member-EXCLUSIVE express impossible per Shopify constraint). OK?
5. **Promise policy** — carrier published transit standards (free, decent) vs paid p90 predictions (EasyPost SmartRate) for the dates we promise. Who owns late-delivery exposure?
6. **v1 scope cuts** — international (9 intl/90d) defer? split-across-origins defer? dropship keeps its own stack short-term?
7. **Ownership confirm** — engine in Echelon (`shipping` schema + module), callback on Echelon Heroku, registered via club-app token.
8. **Own-container semantics** — manual flag with auto-suggest from case-level hierarchy, or pure auto-derive?
