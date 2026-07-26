# Cardshellz Shipping Engine — Design v1 (2026-07-02)

Mini-Amazon shipping engine: checkout sells Card Shellz-owned **service levels** (Standard/Priority/Overnight/Pallet Freight), independently assigned rate books set the customer or vendor charge, and the WMS can later choose an eligible carrier method and optimized pack plan. Replaces Parcelify.

> **UX design brief:** [SHIPPING-RATE-MANAGEMENT-UX-DESIGN-SPEC.md](./SHIPPING-RATE-MANAGEMENT-UX-DESIGN-SPEC.md) defines the target administrator experience for pricing programs, destination groups, parcel bands, pallet bands, revisions, validation, and activation. The current shipping-settings UI is an engineering scaffold, not the target visual design.

> **Service-level pricing decision — 2026-07-16:** checkout pricing is never keyed to a provider-owned carrier or service code. `shipping.rate_tables` belongs to an internal service level and declares either `shipment_weight` or `pallet_count` pricing. Parcel rates use total shipment weight once. Pallet Freight uses pallet-count bands with an optional total-weight ceiling. The freight quote contract also reserves freight class and accessorial inputs for later live freight providers. Carrier-method mappings remain a separate fulfillment concern and cannot change the checkout option the customer bought.

> **Implementation update — 2026-07-13:** standalone cartonizer v3.1 now performs real non-overlapping 3D placement with six rotations and emits unit coordinates/orientations. Dropship and WMS test adapters can use the same core. WMS enforcement is intentionally deferred: plans can be generated explicitly, and an opt-in shadow mode can observe packing handoffs without blocking or changing order status. The earlier volume-only/sorted-dimension cartonizer description below is superseded where noted.

> **Architecture decision — 2026-07-14 (superseding): shipping launches before cartonization.** Shopify, future first-party websites, and dropship vendor fulfillment use one runtime rating engine with independently assigned rate books. Echelon catalog variant weight is canonical; Shopify request weight is a warned transition fallback. eBay shopper checkout keeps external fulfillment policies in its channel adapter. Dropship selects a vendor-fulfillment rate book, then applies insurance/handling/wallet policy. The cartonizer remains a replaceable parcel provider and standalone WMS test path.

> **Rate-book foundation — migration 137:** `shipping.zone_sets`, `shipping.rate_books`, and deterministic channel/warehouse assignments now own rate selection. Existing `shipping.*` zones and tables backfill into the active `shopify-retail-default` book. The live dropship `$8.00` provider/table is deliberately unchanged until a later import + dual-run proves identical vendor charges.

> **Operator geography decision — migrations 139 and 0597:** rates are configured by US postal region and weight, with an optional 1-5 digit ZIP-prefix override. Supported regions include states, DC, territories, and AA/AE/AP military mail. Operators never create or assign zones. The engine generates internal pricing-area keys and routing rules so rate selection and transit contracts remain reusable. ZIP overrides win over the matching region default; the longest ZIP prefix wins between overrides.

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
1. CarrierService callback: gets origin/destination/items(grams, price, sku, properties) — **NO customer, NO metafields, NO dims**; ~10s/5s/3s dynamic timeout, no retry; responses cached ~15 min NOT keyed on customer. ⇒ Checkout rates must be **member-agnostic, precomputed, stateless**. SKU resolves canonical Echelon weight; Shopify grams are fallback only. Dimensions are not required. Member pricing must come from the Functions layer.
2. Functions can only **reduce** an existing rate (100%/partial discount) — never create or raise one. ⇒ Base rates are the ceiling; "member-exclusive express" is structurally impossible — express must be offered to all, discounted per plan.
3. Metafields >10KB arrive NULL in Functions (the 22KB plan_benefits incident) — compact projections only (523B pattern proven).
4. Rate naming is load-bearing across delivery profiles: same-named rates SUM into one line; different names collapse to cheapest generic "Shipping."

## Architecture — two planes, one engine

```
QUOTE PLANE (checkout, member-agnostic, <1s)
Shopify checkout ──► CarrierService callback (Echelon, new)
  every cart line ──► Echelon weight (Shopify fallback) ─► one shipment ─► Rates (local tables)
             ─► ETA (cutoff + service promise) ─► service-level offers (Standard/Priority/Overnight + dates)
  member benefits: shipping-discount Function (club app — LIVE) discounts per plan on top

OPTIONAL FULFILLMENT PLANE (pack station, exact; separately approved)
order ingest ─► test/shadow SHIP PLAN (cartonize with order-final items)
  ─► pack instruction (v1 ShipStation customField "BOX: …"; v2 Echelon Packing page)
  ─► label buy (ShipStation, existing C9) ─► webhook captures actual cost/box/weight
  ─► CALIBRATION LOOP: quoted vs actual → rate-table corrections
```

**Ownership:** runtime quote contracts, canonical weight resolution, rate books, rates, service levels, and callbacks = `server/modules/shipping-engine` backed by the `shipping` Postgres schema; physical cartonization = optional channel-neutral `server/modules/cartonization`. Member policy stays in the club app + Function for Shopify. eBay policy selection stays in the eBay adapter. Dropship owns its vendor rate-book configuration surface plus insurance/handling/wallet policy, but delegates rating to the shared engine. Its current duplicate provider and `dropship.dropship_rate_*`/zone tables are migration debt; distinct dropship prices are not.

### Rate books and pricing context

The engine receives a pricing context separately from the physical shipment: `pricingChannel` identifies the program selecting prices and `purpose` distinguishes customer checkout from vendor fulfillment. Shopify retail and dropship vendor fulfillment therefore share weight, zone, effective-date, band-selection, quote, and audit behavior while resolving different rate books. A dropship order sourced from eBay still uses the dropship vendor rate book; eBay's fulfillment policy controls only what the marketplace buyer sees.

Rate tables remain attached to reusable `shipping.rate_books`, and geography remains reusable through `shipping.zone_sets`. The current runtime selects a book through string-keyed `shipping.rate_book_assignments`; those assignments are compatibility state. A canonical `engine_quoted` channel-policy route references the selected rate book directly. The old assignments are removed only after shadow parity and per-channel cutover.

### Canonical channel routing and destination authority

`channels.channels.id` is the canonical business-channel key. Marketplace store connections are adapter context and never create per-store shipping policy. Customer checkout pricing and dropship vendor fulfillment charges are different policy purposes, so an eBay buyer-facing rate may remain marketplace-managed while the dropship vendor charge for that order is still engine-quoted.

One versioned `shipping.channel_policies` revision owns the complete decision set for a channel and purpose. Its `shipping.channel_policy_routes` choose one of three modes:

- `engine_quoted`: Echelon selects the referenced rate book and returns the price.
- `channel_managed`: the marketplace or storefront owns the displayed price.
- `disabled`: the destination is not offered for that channel and purpose.

Eligibility authority is explicit and independent where a route is enabled: `engine`, `channel`, or `intersection`. A disabled route has no eligibility authority and no rate book. This supports the initial Shopify shape of engine-quoted US destinations plus channel-managed international destinations without requiring Echelon to duplicate Shopify Markets. It also allows eBay checkout shipping to remain marketplace-managed while other channels opt into the engine.

Reusable `shipping.destination_scopes` contain country, region, and postal-prefix members as authoring aids. Saving a policy route copies those members into `shipping.channel_policy_route_destinations`; later edits to the reusable scope cannot silently change an active policy revision. Resolution is deterministic: an exact warehouse route wins over a global route; within that warehouse scope, postal prefix wins over region, region wins over country, and country wins over catch-all. A longer postal prefix wins between postal matches. Equal-specificity matches fail closed as configuration ambiguity; operator-entered priority is not used.

During the compatibility expansion, the new tables are empty and existing `shipping-channel.ts` behavior remains authoritative. Legacy fallback is permitted only when no active canonical policy exists. Once a policy is active, missing or ambiguous routes fail closed instead of escaping to legacy behavior. New channels have no legacy fallback and therefore remain disabled until explicitly configured.

The Shopify CarrierService callback binds to a canonical channel only through
`SHOPIFY_CHECKOUT_CHANNEL_ID`. An unset binding deliberately preserves the
legacy US-engine/non-US-Shopify split without inferring a channel from provider
name or store connection. A configured binding must identify an active Shopify
channel; missing, inactive, or provider-mismatched bindings fail empty. The
callback loads that channel's active `customer_checkout` policy, passes an
`engine_quoted` route's exact `rate_book_id` to the shared quote service, and
returns no Echelon rate for `channel_managed` or `disabled`. Checkout snapshots
record the channel, policy version, route, authority mode, pricing program, and
failure code. No policy or channel binding is seeded by migration.

### Product-aware pricing policies

Destination pricing remains the required default. Product policies are explicit exceptions or restrictions attached to one draft `shipping.rate_tables` revision; they never replace destination coverage and they do not create a second rate-book resolver.

Reusable product sets are authoring tools backed by `shipping.product_sets` and `shipping.product_set_members`. An administrator may select exact variants, a shipping group, product line, category, or the SIOC catalog attribute. Saving a rule materializes the exact active variant IDs into `shipping.rate_rule_members`. The live revision therefore cannot change because a product is later recategorized, moved between product lines, or assigned to another shipping group. A new draft must be created and activated to change live behavior.

Each rule has one typed purpose:

- **Base-charge exception:** free, fixed, fixed weight bands, or base plus each started pound for the matched products.
- **Surcharge:** a fixed charge added after all base buckets are priced.
- **Free-shipping threshold:** zeroes the matching product bucket when matching merchandise value reaches the configured integer-cent threshold.
- **Restriction:** blocks the service for matching products and destinations before any charge is returned.

The evaluator is deterministic and integer-based. Restrictions run first. Each line may match at most one base-charge rule; overlapping base rules fail activation and fail closed at runtime. Unmatched lines use the destination table's default price based only on their residual weight. Matching buckets are then priced, thresholds are applied, and surcharges run last. The quote snapshot records the selected table, normalized line facts, whether product policy changed the quote, and a calculation trace.

Rules may measure all matching units together or each item independently. Carton is reserved in the contract but activation rejects carton-scoped rules until verified cartonization is connected to checkout. This prevents an administrator from publishing a promise the current weight-only checkout path cannot enforce.

The admin workflow is organized by destination group: **Default pricing**, **Product exceptions**, **Restrictions**, and **Test rate**. Draft testing evaluates the same draft rows and product rules that activation validates. Product-rule creates, updates, and deletes persist the authenticated operator and complete before/after rule snapshots through the shared audit API in the same transaction as the change. Activation locks the revision, revalidates product policies inside the activation transaction, and then supersedes the prior active revision atomically.

### Pricing-program coverage model

The pricing program (`shipping.rate_books`) is the configuration owner.
Destination groups and service levels are equal axes beneath it. The admin
detail view renders destination groups as rows and shipping options as columns;
one rate-table revision owns each service-level column's prices.

Named program geography is stored in
`shipping.rate_book_destination_groups` and
`shipping.rate_book_destination_group_members`. A rate-table revision freezes
its group name, lock version, destinations, warehouse override, and explicit
availability in `shipping.rate_table_coverages` and
`shipping.rate_table_coverage_destinations`. The expanded
`shipping.rate_table_rows` remain the only amount authority used by runtime
selection.

One destination group may have one all-warehouse rate scope plus exact
warehouse overrides within the same service-level revision. Those scopes share
one geography identity and optimistic-lock version; availability and amount
rows remain scope-specific. Runtime selection continues to prefer an exact
warehouse row over the all-warehouse default.

Each destination-group / service-level cell is exactly one of:

- **Offered:** every frozen destination must have rate rows.
- **Not offered:** the frozen destinations are intentional exclusions and must
  have no rate rows.
- **Unconfigured:** the revision has no manifest entry for the group.

Activation validates manifest intent against expanded rows in the same
transaction as the lifecycle transition. Editing a program group increments
its optimistic-lock version but cannot rewrite active revision snapshots.
Admin read models surface the resulting version drift until a new revision
explicitly adopts the current geography.

## Modules & contracts

1. **Runtime quote contracts** — `shipping-channel.ts` declares runtime vs channel-policy ownership; `shipment.ts` defines channel-neutral lines and parcels; injected parcel/rate providers keep channel parsing, rating, and packing independent.
2. **Weight resolution + weight-only parcel provider** — exact SKU first loads `catalog.product_variants.weight_grams`. A positive channel weight is a warned fallback only when Echelon is missing. Missing both contributes zero; an all-missing shipment uses a 1g floor. The same normalized input serves Shopify, first-party sites, and dropship vendor charges without dimensions or boxes.
3. **Cartonizer v3.1** `cartonize(items, boxes) → candidatePackings[]` — optional standalone pure-domain engine with multi-SKU packing, physical units for every ordered quantity, all six orthogonal rotations, non-overlap and box-boundary enforcement, per-unit placement output, own-container passthrough, fill-factor clearance, and geometry/weight-driven multi-carton splits. Every ordinary carton is capped at 22,679 g (under 50 lb); a box may set a lower structural maximum. It is not part of the initial Shopify quote path and cannot gate WMS status. Verified unit placements persist on `shipping.pack_plan_parcels` (migration 135).
   **DECIDED 2026-07-02 (user confirmed): co-mingling = RIDER/VOID model, not group×group rules.** Shipping groups stay the default partition (storage boxes ship flat, separately). Rider consolidation now defaults off because cubic void alone cannot prove physical placement. Re-enable it only after void regions have real dimensions and can use the same non-overlap checks. Policy/physics separation remains: free-shipping thresholds key on shipping-group spend; rates key on parcels.
4. **Split Planner** `plan(order) → shipments[]` — deferred until cartonization/multi-origin work. The initial quote path deliberately treats the cart as one weight-based shipment.
5. **Rates Engine** `quote(shipment, destination, rateContext) → quotes[]` — a rate-book resolver selects independently priced local tables from `shipping.*`. Each table prices one internal service level by either total shipment weight or pallet count. Parcel destination groups explicitly choose fixed bands or base plus each started pound; a fixed final band may be open-ended. Formula pricing applies once to total shipment weight and rounds upward using the same normalized gram boundaries as fixed bands (454 g = 1 lb, 907 g = 2 lb, 908 g = 3 lb). Rates and calculations remain integer cents. Shopify retail and dropship vendor fulfillment share selection and audit behavior while using separately assigned books. `FreightRatingContext` carries pallet count, optional total weight, freight class, and reserved accessorials so a later live freight provider does not require a channel-contract rewrite.
6. **Carrier Adapters** — rating port is separate from the C9 fulfillment port. The local table provider is first. ShipStation API v2/direct-carrier providers remain offline calibration or later special-destination implementations; they do not block the initial Shopify launch.
7. **Service Levels** `shipping.service_levels` — internal offers with a fulfillment mode and optional business-day promise: Standard, Priority, Overnight, and Pallet Freight. A rate table determines what the option costs. Future fulfillment mappings determine which carrier methods may satisfy it.
8. **ETA** — ship date (existing cutoff/SLA) + the service level's promised business-day range → `min/max_delivery_date`. Carrier transit observations can later validate or tighten fulfillment choices without becoming the checkout pricing key.
9. **Membership Policy** (club app — mostly DONE) — extend BenefitKind with `express_discount` / per-group express pricing; project into the compact metafield; Function discounts express/standard per plan. Base = full price for guests.
10. **Packer Execution** — v1: "BOX: 12X10X4 ×2" via ShipStation customField (zero UI, days to ship). v2: Echelon Packing page consuming the persisted ship plan, confirming actual box/weight into outbound_shipment_items → closes the calibration loop.

## Phasing

- **P0 — Shipping contracts:** channel-neutral shipment/rate ports; canonical Echelon weight resolution; explicit pricing channel + rate purpose; Shopify/internal/dropship runtime quotes; eBay external-policy checkout. No activation.
- **P1 — Shopify weight audit + shadow comparison:** improve active-variant weight coverage, validate local tables and mappings, replay representative carts through the same runtime service, quantify intentional undercharges from missing weights, and compare against Parcelify. Missing weight is an accuracy issue, not a checkout gate.
- **P2 — Checkout cutover (Standard only):** register CarrierService (club-app token → Echelon URL); serve Standard with ETA dates alongside Parcelify; verify member Function discounts; soak, roll back cleanly if needed, then decommission Parcelify.
- **P3 — Channel expansion:** import dropship's distinct vendor rates into a dropship-assigned `shipping.*` book, dual-run old/new providers, then switch only after parity; add the first-party authenticated quote API and Shellz Club benefit-policy adapter; retain eBay fulfillment-policy selection in its adapter.
- **P4 — Service levels and providers:** Priority/Overnight/Pallet Freight, live/direct carrier and freight providers where they add value, fulfillment-method enforcement, and multi-origin routing when required.
- **P5 — Optional cartonization:** dimensions/box capture, explicit plan tests, non-blocking shadow, pack-station actuals, calibration, and only then a separately approved enforcement proposal.

### Cross-channel rollout approved 2026-07-24

1. **Foundation:** add destination scopes, versioned channel policies, deterministic pure resolution, and observable legacy fallback. No policy seed and no runtime behavior change.
2. **Runtime and admin:** add transactional draft/activate/retire commands, shared audit events, dynamic channel administration, and shadow comparison against legacy decisions.
3. **Membership contract:** Shellz Club continues to own plan benefits and projects channel-ID-aware benefit facts; it does not select rate books or channel adapters.
4. **Adapter capabilities:** each thin channel adapter declares whether it can accept engine quotes, manage its own rates, and enforce destination eligibility. Unsupported combinations fail validation before activation.
5. **Shopify enforcement:** connect US engine quotes and channel-managed international eligibility, then verify delivery-group benefit behavior against the same canonical shipping-group IDs.
6. **Cutover and cleanup:** activate one channel/purpose at a time behind a kill switch, compare production evidence, remove string-keyed legacy routing only after parity, and retain a rollback revision.

Implementation status on 2026-07-24:

- Steps 1 and 2 are merged. Canonical policies remain configuration and shadow-comparison state only.
- Step 3 was re-verified against Shellz Club's channel-ID policy projections and focused benefit tests; Shellz Club does not select Echelon pricing programs or adapters.
- Step 4 declares immutable adapter capabilities in code. An engine-quoted route requires engine-quote support, a channel-managed route requires channel-rate support, and channel/intersection eligibility requires channel destination enforcement. A channel-managed route also requires destination enforcement because Echelon is not in that checkout request. Unknown providers may activate only an explicit `disabled` route. These checks do not cut over quote traffic.
- Step 5 runtime wiring is implemented but dormant by default. With no
  `SHOPIFY_CHECKOUT_CHANNEL_ID`, the callback records and uses the legacy
  ownership decision. With an explicit active Shopify channel binding, an
  active canonical policy controls the route and exact rate book; invalid
  active policy state fails empty and never escapes to legacy. The existing
  `SHOPIFY_CHECKOUT_RATE_MODE=off|test|live` gate still controls every
  `engine_quoted` response. No policy activation, Heroku config change,
  CarrierService assignment, or delivery-group benefit cutover is part of the
  runtime-wiring PR.

#### Canonical Shopify delivery-group benefit contract

- `catalog.shipping_groups.id` is the internal relational identity used by
  Echelon products and Shellz Club plan-benefit assignments.
- `catalog.shipping_groups.code` is the immutable wire identity. Echelon writes
  that exact code to the product metafield `cardshellz.shipping_group`; Shellz
  Club resolves plan threshold rows from group ID to that same code before
  writing `cardshellz.shipping_thresholds`; the Shopify Function joins the two
  values without provider-specific translation.
- An Echelon catalog shipping-group change and its Shopify metafield outbox
  command commit in one transaction. Missing products, invalid canonical codes,
  malformed Shopify product identities, or outbox failures abort the catalog
  change. Products not yet mapped to Shopify are explicitly counted as skipped
  and remain eligible for reconciliation after a mapping exists.
- Shipping-group projection also verifies that exactly one Echelon product owns
  each Shopify product identity before any outbox command is written. Duplicate
  owners abort the complete batch; owners with different group codes are
  reported as an explicit mapping conflict. The pending-outbox dedupe key must
  never become an implicit last-writer-wins resolver for catalog identity.
- A Shellz Club per-group threshold change and both shop-metafield outbox
  commands commit in one transaction. New thresholds may target only active
  catalog groups; an inactive or deleted group may still be cleared. Catalog
  lookup or projection failure aborts the write so Shopify keeps the last
  known-good policy instead of silently falling back to a whole-cart threshold.
- These guarantees harden persistence and projection only. Production outbox
  drain, exact Shopify product/shop metafield values, delivery-profile
  separation, and Function behavior still require controlled verification
  before checkout activation.

#### Shopify mapping readiness gate

The global Shopify IDs on `catalog.products` and
`catalog.product_variants` describe only the provider-default Shopify channel.
A live mapping-health scan therefore runs only against that channel. Its
candidate set includes products with a catalog parent ID plus products whose
active feed or listing evidence survives without that parent ID, and checks:

1. Shopify product IDs are valid and the remote products still exist.
2. One and only one Echelon product owns each remote Shopify product.
3. Catalog, feed, and listing identities remain internally consistent.
4. A duplicate owner cannot project conflicting shipping-group codes.
5. The live `cardshellz.shipping_group` product metafield matches Echelon.

Duplicate ownership review is a separate, operator-requested read model. It
returns at most 50 groups per page and never adds ownership groups to the
existing mapping-health payload. A canonical owner is recommended only when
one active local product has matching catalog and channel evidence, the remote
Shopify product exists, and every owner has the same shipping group without a
mapping conflict. Every other case remains manual review. A recommendation is
evidence only: this review does not change catalog IDs, feeds, listings,
metafields, policies, or checkout routing.

A remote-missing mapping may be retired only through the audited reconciliation
command. The command rechecks the optimistic-lock fingerprint, then asks Shopify
again for the product and every referenced active or archived variant. It makes
no change if any node still exists. When every node is absent, one transaction
clears current catalog Shopify identities, disables current channel feeds,
resets current listing identities, and records before/after audit evidence.
Echelon products, variants, orders, and historical audit records are preserved.

Before Shopify checkout activation, operators must run this scan, resolve every
duplicate-owner and shipping-group conflict, retire or repair remote-missing
mappings, drain the metafield outbox, and verify the resulting storefront
metafields. The scan is evidence for this gate; it does not activate a shipping
policy or change checkout routing.

Initial capability declarations:

| Provider | Accepts Echelon quotes | Manages channel rates | Enforces channel destination eligibility |
| --- | --- | --- | --- |
| Shopify | Yes | Yes | Yes |
| eBay | No | Yes | Yes |
| Manual/internal | Yes | No | No |

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
