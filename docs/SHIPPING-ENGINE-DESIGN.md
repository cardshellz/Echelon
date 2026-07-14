# Cardshellz Shipping Engine — Design v1 (2026-07-02)

Mini-Amazon shipping engine: checkout sells **service levels** (Standard/Expedited/…), the engine finds the **cheapest carrier+method** satisfying the promise, and the WMS hands the pack station an **optimized box/split plan**. Replaces Parcelify.

> **Implementation update — 2026-07-13:** standalone cartonizer v3.1 now performs real non-overlapping 3D placement with six rotations and emits unit coordinates/orientations. Dropship and WMS test adapters can use the same core. WMS enforcement is intentionally deferred: plans can be generated explicitly, and an opt-in shadow mode can observe packing handoffs without blocking or changing order status. The earlier volume-only/sorted-dimension cartonizer description below is superseded where noted.

> **Architecture decision — 2026-07-14 (superseding): shipping launches before cartonization.** Shopify and future first-party websites use the shared runtime quote service with a weight-only parcel provider. eBay keeps external fulfillment policies in its channel adapter. Dropship surfaces managed shipping configuration in its portal. The cartonizer remains a replaceable parcel provider and standalone WMS test path; product dimensions, boxes, split planning, and verified carton placement do not gate shipping-engine launch.

## Verified current state (all claims checked in-file or against prod 2026-07-02)

**Exists and reusable:**
- **Dropship shipping stack in Echelon** (deployed 6/26, seed-data only, vendor-scoped — a TEMPLATE to generalize):
  - `dropship.dropship_box_catalog` (dropship.schema.ts:798-813) — code/name/L/W/H mm/tare/max-weight/active. Prod: 1 row ("Baby Box" 8×6×4).
  - `dropship.dropship_package_profiles` (:815-834) — optional dropship overrides such as ship-alone, default box, and carrier/service preferences. Catalog variants own physical weight/dimensions. Legacy `max_units_per_package` is not a runtime cartonization input.
  - `dropship_rate_tables` + `_rows` (warehouse, zone, weight band, cents) + `dropship_zone_rules` (postal-prefix→zone, priority) (:836-878). Prod: 1 rate row, 1 zone rule.
  - Markup/insurance bps policies + `dropship_shipping_quote_snapshots` (idempotency_key, request_hash, quote_payload) (:880-939).
  - **Standalone cartonizer v3.1** `server/modules/cartonization`: expands ordered quantities into physical units, tests all six rotations, rejects overlapping/out-of-bounds placements, returns per-unit coordinates, and splits on geometry or packed weight. WMS test/shadow paths and dropship may consume this provider; Shopify checkout no longer requires it. No max-units cap is used.
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
1. CarrierService callback: gets origin/destination/items(grams, price, sku, properties) — **NO customer, NO metafields, NO dims**; ~10s/5s/3s dynamic timeout, no retry; responses cached ~15 min NOT keyed on customer. ⇒ Checkout rates must be **member-agnostic, precomputed, stateless**. Initial shipping uses every line's channel-provided weight; dimensions are not joined or required. Member pricing must come from the Functions layer.
2. Functions can only **reduce** an existing rate (100%/partial discount) — never create or raise one. ⇒ Base rates are the ceiling; "member-exclusive express" is structurally impossible — express must be offered to all, discounted per plan.
3. Metafields >10KB arrive NULL in Functions (the 22KB plan_benefits incident) — compact projections only (523B pattern proven).
4. Rate naming is load-bearing across delivery profiles: same-named rates SUM into one line; different names collapse to cheapest generic "Shipping."

## Architecture — two planes, one engine

```
QUOTE PLANE (checkout, member-agnostic, <1s)
Shopify checkout ──► CarrierService callback (Echelon, new)
  every cart line ──► weight-only parcel provider ─► one shipment ─► Rates (local tables)
             ─► ETA (cutoff + transit table) ─► service-level offers (Standard/Expedited/Express + dates)
  member benefits: shipping-discount Function (club app — LIVE) discounts per plan on top

OPTIONAL FULFILLMENT PLANE (pack station, exact; separately approved)
order ingest ─► test/shadow SHIP PLAN (cartonize with order-final items)
  ─► pack instruction (v1 ShipStation customField "BOX: …"; v2 Echelon Packing page)
  ─► label buy (ShipStation, existing C9) ─► webhook captures actual cost/box/weight
  ─► CALIBRATION LOOP: quoted vs actual → rate-table corrections
```

**Ownership:** runtime quote contracts, rates, service levels, and callbacks = `server/modules/shipping-engine`; physical cartonization = optional channel-neutral `server/modules/cartonization`; persisted plans and box data = `shipping` Postgres schema; execution = WMS packing station. Callback endpoint is hosted by Echelon (Heroku), registered once via the club-app token (owns write_shipping). Member policy stays in the club app + Function for Shopify. eBay policy selection stays in the eBay adapter. Dropship owns its portal-managed shipping configuration until an explicit adapter migration is approved.

## Modules & contracts

1. **Runtime quote contracts** — `shipping-channel.ts` declares runtime vs channel-policy ownership; `shipment.ts` defines channel-neutral lines and parcels; injected parcel/rate providers keep channel parsing, rating, and packing independent.
2. **Weight-only parcel provider** — initial Shopify/internal strategy requires positive weight for every physical line and produces one weight-based shipment. It never skips a line and never guesses dimensions or boxes.
3. **Cartonizer v3.1** `cartonize(items, boxes) → candidatePackings[]` — optional standalone pure-domain engine with multi-SKU packing, physical units for every ordered quantity, all six orthogonal rotations, non-overlap and box-boundary enforcement, per-unit placement output, own-container passthrough, fill-factor clearance, and geometry/weight-driven multi-carton splits. Every ordinary carton is capped at 22,679 g (under 50 lb); a box may set a lower structural maximum. It is not part of the initial Shopify quote path and cannot gate WMS status. Verified unit placements persist on `shipping.pack_plan_parcels` (migration 135).
   **DECIDED 2026-07-02 (user confirmed): co-mingling = RIDER/VOID model, not group×group rules.** Shipping groups stay the default partition (storage boxes ship flat, separately). Rider consolidation now defaults off because cubic void alone cannot prove physical placement. Re-enable it only after void regions have real dimensions and can use the same non-overlap checks. Policy/physics separation remains: free-shipping thresholds key on shipping-group spend; rates key on parcels.
4. **Split Planner** `plan(order) → shipments[]` — deferred until cartonization/multi-origin work. The initial quote path deliberately treats the cart as one weight-based shipment.
5. **Rates Engine** `quote(shipment, destination) → base quotes[]` — local deterministic tables (`shipping.rate_tables/_rows/zone_rules`, generalized from dropship incl. effective dating + cheapest-wins) serve Shopify in the hot path. The rate-provider port retains full parcel fields so live/dimensional providers can be added later without changing channel adapters.
6. **Carrier Adapters** — rating port is separate from the C9 fulfillment port. The local table provider is first. ShipStation API v2/direct-carrier providers remain offline calibration or later special-destination implementations; they do not block the initial Shopify launch.
7. **Service Levels** `shipping.service_levels` — e.g. Standard (3–7d), Expedited (2–3d), Express (1–2d); each maps to eligible carrier services + transit windows per zone. Checkout offers levels; fulfillment re-solves cheapest carrier meeting the promised date (Amazon decoupling).
8. **ETA** — ship date (existing cutoff/SLA) + `shipping.transit_matrix` (zone × service → business days, seeded from carrier standards, corrected by actuals) → `min/max_delivery_date` on every rate (checkout shows dates for the first time).
9. **Membership Policy** (club app — mostly DONE) — extend BenefitKind with `express_discount` / per-group express pricing; project into the compact metafield; Function discounts express/standard per plan. Base = full price for guests.
10. **Packer Execution** — v1: "BOX: 12X10X4 ×2" via ShipStation customField (zero UI, days to ship). v2: Echelon Packing page consuming the persisted ship plan, confirming actual box/weight into outbound_shipment_items → closes the calibration loop.

## Phasing

- **P0 — Shipping contracts:** channel-neutral shipment/rate ports; Shopify/internal runtime mode; eBay external-policy mode; dropship managed-policy mode. No activation.
- **P1 — Shopify weight readiness + shadow comparison:** complete positive weights for every active physical variant, validate local tables and mappings, replay representative carts through the same runtime service, and compare against Parcelify.
- **P2 — Checkout cutover (Standard only):** register CarrierService (club-app token → Echelon URL); serve Standard with ETA dates alongside Parcelify; verify member Function discounts; soak, roll back cleanly if needed, then decommission Parcelify.
- **P3 — Channel expansion:** first-party authenticated quote API and Shellz Club benefit-policy adapter; dropship managed-policy UI; retain eBay fulfillment-policy selection in its adapter.
- **P4 — Service levels and providers:** Expedited/Express, live/direct carrier providers where they add value, and multi-origin routing when required.
- **P5 — Optional cartonization:** dimensions/box capture, explicit plan tests, non-blocking shadow, pack-station actuals, calibration, and only then a separately approved enforcement proposal.

## Walkthrough decisions from 2026-07-02

These remain useful design inputs except where the July 14 shipping-first decision supersedes their launch order. Cartonization, multi-origin splitting, and a ShipStation v2 key are no longer v1 checkout gates.
1. **Cart display**: static, rate-table-sourced, "Estimated for continental US" copy. No zip-entry UX.
2. **Checkout rating**: hybrid — local tables lower-48, LIVE ShipStation v2 call for HI/AK/PR (2s timeout → padded table fallback; callback always returns a rate).
3. **Co-mingling**: rider/void model (see Cartonizer v3). Groups = default partition. Rider absorption remains disabled until void regions have physical dimensions and can pass the same placement checks.
4. **Fill math**: flat ~85% volume clearance plus real 3D placement; items are rectangular bricks that may use any of six rotations. Per-SKU constraints are added only when fragility, nesting, or orientation rules are known, not as arbitrary max-unit limits.
5. **Multi-warehouse**: retain the eventual inventory-aware, split-across-origin design, but defer it until after the single-origin Shopify engine is stable. OMS still needs one order → multiple warehouse-scoped shipments before this can be activated.
6. **SIOC**: manual `ships_in_own_container` checkbox per variant in Echelon; system pre-suggests sealed case-level variants from the pack hierarchy; user approves.
7. **Carrier accounts (verified via V1 API 7/2)**: FedEx = OWN account; USPS (stamps_com), UPS (ups_walleted), DHL Express, GlobalPost = ShipStation wallet. v2 quotes = real negotiated costs.

## Pending user action
- No ShipStation v2 credential is required for the initial local-table Shopify launch. Generate one later when live-rate calibration or a live provider is ready to be tested.

## Original design questions (superseded by the locked list above)

1. **CCS enablement basis** — must confirm in Shopify admin billing/settings BEFORE uninstalling Parcelify (annual plan? add-on? unknown). Human check.
2. **Box suite + measurement program** — how many physical box/mailer sizes? who measures items (form-factor templating acceptable?); I build the capture tooling first.
3. **ShipStation plan/API v2 access** — does the current ShipStation tier include API v2 rate shopping? FedEx via wallet or own account?
4. **Express model confirmation** — express offered to ALL at full price; members get it free/discounted via Function (member-EXCLUSIVE express impossible per Shopify constraint). OK?
5. **Promise policy** — carrier published transit standards (free, decent) vs paid p90 predictions (EasyPost SmartRate) for the dates we promise. Who owns late-delivery exposure?
6. **v1 scope cuts** — international (9 intl/90d) defer? split-across-origins defer? dropship keeps its own stack short-term?
7. **Ownership confirm** — engine in Echelon (`shipping` schema + module), callback on Echelon Heroku, registered via club-app token.
8. **Own-container semantics** — manual flag with auto-suggest from case-level hierarchy, or pure auto-derive?
