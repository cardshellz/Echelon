# Cardshellz Shipping Engine — Dev Team Handoff

*Updated July 16, 2026 · service-level pricing and pallet-freight support are in progress; the engine remains dormant. Full design: [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md).*

> **July 16 service-level pricing decision:** local rate tables price Card Shellz-owned checkout options, not carrier service codes. A table references a service level and uses either `shipment_weight` or `pallet_count`. Pallet Freight has a dedicated freight context with pallet count, optional total shipment weight, freight class, and reserved accessorials. Provider-method mapping and enforcement remain a later fulfillment capability.

> **July 14 shipping-first decision:** launch the shipping engine independently of cartonization. Shopify, future first-party websites, and dropship vendor fulfillment use one runtime rating engine with separately assigned rate books. Echelon catalog variant weight is canonical; Shopify weight is a warned transition fallback. eBay continues to use eBay fulfillment policies for shopper checkout. Dropship selects its own vendor rate book, then applies insurance/handling/wallet policy. Cartonization remains a standalone optional provider and a WMS test path until separately approved.

> **July 13 update (PR #909 + follow-up):** standalone cartonizer v3.1 replaces aggregate volume feasibility with real non-overlapping 3D unit placement, all six rotations, persisted placement coordinates, geometry-driven splitting, and an automatic under-50-lb handling ceiling. Dropship and WMS test adapters can delegate to the same core. WMS enforcement is not active: manual plan generation and opt-in shadow execution are the only rollout paths, and neither may block or change fulfillment status.

## 0 · TL;DR

The local zone/rate-table core, service levels, ETA data, callback shell, and snapshots are deployed but dormant. Migration 137 adds shared zone sets, rate books, and deterministic channel/warehouse assignments; existing retail data backfills into `shopify-retail-default`. The engine is **not cutover-ready yet**: active rate/service configuration is still absent, comparison testing against Parcelify remains, and dropship's distinct vendor rates still need import + dual-run before their provider can switch. Variant dimensions are not a checkout requirement. Echelon catalog weights win; Shopify weights fill temporary gaps; a line missing both is excluded with warnings so checkout can continue at a deliberately low estimate.

## 1 · Vision & model

Checkout sells **service levels** (Standard / Priority / Overnight / Pallet Freight), not carriers. The shared engine owns geography resolution, rate-book selection, service-level pricing, and delivery promises. Channel adapters own how that capability is consumed. Parcel checkout uses one total shipment weight; freight callers provide pallet context. The standalone cartonizer remains replaceable and optional.

- **Replaces Parcelify** (static zip/weight/value tiers) at checkout. Parcelify is still active today serving US zones only; its admin UI has stopped loading for us (unresolved, app-side), which raises the urgency of cutover.
- **Long-term replaces ShipStation** via the per-carrier provider seam (FedEx own account first ≈10% of volume, then USPS ≈54%, UPS ≈36%). Commercial gate: own-account rates vs ShipStation wallet rates.
- International checkout is **Global-e** (DHL/UPS carrier participants) and stays out of scope for v1. The engine's zone rules are deliberately US-only.

## 2 · Architecture — two planes

### Quote plane (checkout-facing, latency-critical)

```
Shopify checkout ──POST──▶ /api/shipping/rates-callback/:token   (CarrierService, token-gated)
   every item[sku?,qty,grams] ─▶ SKU→Echelon weight (Shopify fallback) ─▶ one shipment
   shipment ─▶ resolve rate book ─▶ ACTIVE service-level tables ─▶ quotes
   quotes ─▶ map directly to ACTIVE service_levels ─▶ Shopify rates (+promise dates)
   every request ─▶ shipping.quote_snapshots (source 'checkout')  ← calibration dataset
```

- No external calls in the hot path — DB reads only; hard 2s response deadline; every failure degrades to `{ rates: [] }` (never a wrong/free rate, never a 5xx).
- Every Shopify line remains in the request even when it has no SKU. Positive weights contribute to the shipment total; missing/non-positive weights contribute zero and create warnings. An all-missing cart uses a 1g floor to reach the cheapest available rate band.
- Member free shipping stays in the club app's Shopify Function (separate repo, §8) — engine quotes are member-agnostic because Shopify's CarrierService payload carries no customer identity.
- HI/AK/PR: local `US-HIPRAK` zone with conservative table rates now; live ShipStation v2 rating as a later enhancement (blocked on the v2 API key).

### Channel ownership

| Channel | Shipping mode | Owner |
|---|---|---|
| Shopify | Runtime quote | Shared shipping engine; member discount remains the Shopify Function |
| First-party/internal website | Runtime quote | Shared shipping engine, including first-party benefit policy |
| eBay | External marketplace policy | eBay channel adapter selects eBay fulfillment policies |
| Dropship | Runtime vendor-fulfillment quote | Shared engine selects the dropship rate book; dropship applies insurance/handling and charges the vendor wallet |

**Rate-book rule:** sharing the engine does not mean sharing prices. Shopify retail and dropship vendor fulfillment resolve independently assigned books. A dropship order sourced from eBay still selects the dropship vendor book; eBay's policy controls only the buyer-facing charge.

**Current-state exception:** dropship still calls `DropshipShippingRateProvider` backed by `dropship.dropship_rate_*` and duplicate zone tables. Migrate those distinct prices into a dropship-assigned book in `shipping.*`, delegate calculation to `shipment-quote.service.ts`, and retain dropship's configuration UI plus insurance/handling/wallet steps.

### Fulfillment plane (warehouse-facing)

```
order ─▶ optional pack-plan service (cartonize with full dims) ─▶ persisted test/shadow plan
      ─▶ pack-station UI (client pages: Packing, OutboundShipments)
      ─▶ actuals (chosen box, weight, label cost) ─▶ pack_plan actuals (mig 122)
      ─▶ calibration loop: quoted vs actual per shipment
```

## 3 · Code map

Everything lives in `server/modules/shipping-engine/` (hexagonal layout), registered in `server/routes.ts`.

| Layer | File | What it does |
|---|---|---|
| cartonization (standalone) | `server/modules/cartonization` | Public cartonizer v3.1 plus WMS adapter: real 3D placement with six rotations, non-overlap/bounds checks, box choice, geometry/weight splits, own-container handling, persisted placements, explicit test generation, and non-enforcing shadow observation |
| domain | `domain/zones.ts` | `resolveZone`: longest-prefix-wins postal matching; priority tiebreak; region-scoped rules skipped in v1 |
| domain | `domain/rate-selection.ts` | Geography and shipment-measure selection, returning one price per internal service level |
| domain | `domain/eta.ts` | Delivery window calendar math; checkout currently supplies the service-level promise |
| domain | `domain/rate-table-import.ts` | CSV grid import parsing/validation |
| domain | `domain/shipping-channel.ts`, `domain/shipment.ts` | Channel ownership/modes plus canonical shipment-line and parcel contracts |
| application | `application/shipment-quote.service.ts` | Runtime quote orchestration over injected parcel and rate providers; sends pricing channel + rate purpose for rate-book selection and rejects external-policy channels such as eBay checkout |
| domain | `domain/rate-book.ts` | Deterministic warehouse-specific then channel-wide assignment selection; ambiguity fails closed |
| infrastructure | `infrastructure/rate-book.repository.ts` | Loads active assignments and their active books for one pricing context |
| application | `application/shipment-weight.service.ts` | Resolves canonical Echelon weight, warned channel fallback, or missing-weight undercharge |
| infrastructure | `infrastructure/catalog-weight.repository.ts` | One-query exact-SKU lookup of `catalog.product_variants.weight_grams` |
| application | `application/weight-only-parcel.provider.ts` | One shipment from resolved weights, no boxes or dimensions |
| application | `application/shipping-rate-provider.ts` | Rate-provider port plus local deterministic table adapter |
| application | `application/rate-quote.service.ts` | `quoteShipmentRates`: active rate book → service-level rows → total-weight or pallet-count quote; optional snapshot |
| application | `application/shadow-quote.service.ts` | `runShadow`: replays recent real wms.orders through the full pipeline, persists 'shadow' snapshots, returns readiness report |
| application | `cartonization/application/wms-pack-plan.service.ts`, `shipping-engine/application/packing.service.ts` | Channel-neutral WMS pack plans + pack-station actuals |
| infrastructure | `cartonization/infrastructure/packing-input.repository.ts` | Variant dims/weights/shipping-group/own-container loaders; active box loader |
| application | `application/rate-calibration.service.ts` | Quoted-vs-actual calibration (needs ShipStation v2 key for live-rate comparison) |
| infrastructure | `infrastructure/shipstation-v2-rating.adapter.ts` | ShipStation v2 live-rate adapter (offline calibration + HIPRAK) |
| interfaces | `interfaces/http/*` | `carrier-callback` (unauthenticated, token-gated, registered before auth middleware), `shadow-admin`, `rate-table-admin`, `calibration-admin`, `packing`; plus `shipping-admin.routes.ts`, `outbound-shipments.routes.ts` |
| client | `ShippingSettings.tsx`, `components/shipping/RateTableBuilder.tsx` | Service-level promises plus visual destination, weight-band, pallet-band, CSV-assisted draft creation/review/activation |
| client | `Packing.tsx`, `OutboundShipments.tsx` | Pack-station + outbound shipment views |

## 4 · Data model & current prod state

Schema: `shipping.*` in the shared Postgres (Echelon owns it; the club app owns `membership`). Created in migration 117, extended through 135. Verified state as of Jul 14, 2026:

| Table | Purpose | Prod state |
|---|---|---|
| `zone_rules` | country + postal-prefix → zone | 48 active US rules → `US-48` / `US-HIPRAK`; region labels NULLed by mig 124 (they made resolveZone skip HIPRAK rules) |
| `rate_tables` + `rate_table_rows` | internal service level, pricing basis, status, effective dating; state/ZIP × shipment-measure cents | clean service-level shape is being introduced before activation; existing unused shared drafts can be discarded rather than migrated |
| `zone_sets` + `rate_books` + `rate_book_assignments` | reusable geography, independently priced books, deterministic channel/warehouse selection | migration 137 backfills all current shipping zones/tables to `shopify-retail-default`; dropship is not imported or activated |
| `box_catalog` | boxes: inner dims, tare, optional lower max weight, cost, fill factor | **14 seeded Jul 9** from 4,259 real ShipStation shipments (top 14 dim combos ≈ 85% of volume, incl. 2 storage-box flats); dimensions/tare/cost still require review in admin. NULL max weight uses the automatic 22,679 g handling ceiling. |
| `service_levels` | sellable checkout options | Standard is the only initial option and remains the checkout kill-switch; priority, overnight, and pallet freight are inactive future options |
| `service_level_methods` | reserved future fulfillment mappings | dormant until connected provider accounts supply a canonical method catalog; it is not used by checkout quoting or activation today |
| `transit_matrix` | historical carrier/method transit windows | 24 rows seeded (mig 120); retained for later fulfillment validation, not checkout-price identity |
| `quote_snapshots` | every quote (checkout/shadow/manual) — calibration dataset | accumulating; first shadow run persisted Jul 9 |
| pack plans + actuals | fulfillment plane | schema live (migrations 122 + 135); plans are test/shadow artifacts and are not required for any WMS status transition |

Variant fulfillment data lives on the catalog (`ProductDetail → Fulfillment characteristics`): weight, dims, shipping group, ships-in-own-container.

## 5 · Build board — status & readiness

| Metric | State |
|---|---|
| Shipping engine | Core deployed and dormant; channel-neutral runtime quote contracts are the current slice |
| Active variant weights | **251/305**; missing weights reduce quote accuracy but do not block checkout |
| Active variant dimensions | **1/305**; required for later cartonization, not shipping-engine launch |
| Boxes | 14 seeded from shipment history |
| Rate tables | 2 draft tables / 11 rows; inactive and awaiting weight-only comparison testing |
| Service levels | standard / expedited / express all inactive |
| Runtime configuration | callback token, origin override, ShipStation v2 key, and cartonization flags all unset |
| `SHIPSTATION_V2_API_KEY` | not set (blocks calibration + HIPRAK live rates; v1 key does NOT work on v2 API) |

**Cartonization shadow run (Jul 9, 100 real orders / 7 days):** pipeline ran end-to-end cleanly on all 100 orders. `packingFallback: 100/100` and `ratesEmpty: 100/100` were expected. This remains useful cartonization diagnostics, but it is not the acceptance test for the weight-only Shopify launch path.

**Later cartonization measurement program:** measuring only the top-volume SKUs unlocks most orders for true cartonization: **top 20 SKUs → 38%** of orders fully packable · **top 50 → 64%** · **top 100 → 90%**. This work can proceed independently after shipping rates launch.

## 6 · Activation runbook — path to cutover

Each step is independently reversible; only allowlisted test carts can receive Echelon rates in step 6, and normal customer traffic remains untouched until step 7.

1. **DONE — Separate shipping from packing and prices:** shared shipment, Echelon-weight resolver, parcel/rate providers, pricing context, zone sets, and independently assigned rate books are in place. eBay shopper checkout remains policy-owned.
2. **NEXT — Improve Echelon weight coverage:** resolve active variants with no `catalog.product_variants.weight_grams` and verify representative carts. Shopify weight is a warned fallback during transition; missing both sources is recorded and underquoted by policy, not blocked.
3. **NEXT — Finish base-rate configuration:** create internal service-level tables for Standard, Priority, Overnight, and any Pallet Freight programs needed by assigned rate books. Keep tables and service levels inactive.
4. **NEXT — Verify active US rates:** activate one reviewed rate-table revision, open its Pricing Program detail, and use `Test live US rates` with representative warehouses, states, ZIPs, and weights. This calls the production assignment selector and active tables, persists a `manual` quote snapshot, and reports if a different program owns the route. Drafts are never included.
5. **NEXT — Weight-only shadow comparison:** replay representative Shopify carts through the same runtime quote service, compare offers against Parcelify, and review missing-weight/zone/band failures. Do not use cartonization readiness as the pass criterion.
6. **Controlled Shopify checkout validation:**
   - Set Heroku config `SHIPPING_CALLBACK_TOKEN` (random secret), `SHOPIFY_CHECKOUT_RATE_MODE=off`, and, if origin ≠ warehouse 1, `SHIPPING_CALLBACK_ORIGIN_WAREHOUSE_ID`.
   - Deploy the callback, then register the CarrierService in Shopify pointing at `POST /api/shipping/rates-callback/<token>`. Re-audit delivery-zone assignments immediately; `off` must return no Echelon rates even if Shopify attaches the service unexpectedly.
   - Create an isolated Shopify test shipping profile with hidden test variants and US-only zones. Attach Echelon only to that profile; leave Parcelify and the two production profiles unchanged.
   - Set exact test variant SKUs in `SHOPIFY_CHECKOUT_RATE_TEST_SKUS`, then change `SHOPIFY_CHECKOUT_RATE_MODE=test`. Every cart line must be allowlisted or Echelon returns no rates.
   - Use the unpublished theme to exercise representative Lower-48 and HIPRAK addresses. Verify callback snapshots and quoted prices before proceeding; the theme is a test entry point, not the isolation boundary.
7. **Go live (Standard only):**
   - Activate the `standard` service level and its reviewed rate table.
   - Return `SHOPIFY_CHECKOUT_RATE_MODE` to `off`, attach Echelon alongside Parcelify to the four audited US zones in General profile and Storage Boxes, and verify that Echelon remains silent.
   - During a controlled window, set `SHOPIFY_CHECKOUT_RATE_MODE=live`, verify real checkout parity, then remove Parcelify from those US zones. Do not alter Shopify-managed international zones.
   - **Open item before uninstalling Parcelify entirely:** confirm how CarrierService (third-party calculated rates) is enabled on the current Shopify plan — Parcelify being installed may be what grants it today.
8. **Decommission Parcelify** once the engine has served checkout cleanly for an agreed soak period.
9. **After checkout is stable:** expose the runtime service to first-party websites, import dropship's distinct vendor rates into its own book, dual-run old/new dropship quotes before switching providers, keep eBay fulfillment-policy selection in its adapter, and advance cartonization through its separate test/shadow program.

> **Rollback at any point:** set `SHOPIFY_CHECKOUT_RATE_MODE=off` first, confirm Echelon returns no rates, and keep or re-attach Parcelify to the US zones. Deactivating service levels is a secondary rate-level stop; unsetting `SHIPPING_CALLBACK_TOKEN` makes the endpoint return 404 and is the final credential revocation step.

## 7 · Key mechanics & invariants (do not break)

- **Fail-empty, never fail-wrong:** the callback returns `{rates: []}` on any parse/zone/band/timeout failure. An empty response blocks checkout for that address rather than mispricing it. Keep that property.
- **Fail-closed rollout:** `SHOPIFY_CHECKOUT_RATE_MODE` accepts only `off`, `test`, or `live` and defaults to `off`; an invalid value also resolves to `off`. Test mode quotes only when every cart line has an exact SKU in `SHOPIFY_CHECKOUT_RATE_TEST_SKUS`. Bypassed requests never run weight lookup or rating and record their rollout reason in the checkout snapshot.
- **One destination owner:** Echelon owns `US` Shopify checkout rates. Every valid non-US country is delegated to Shopify/Global-e by wildcard; it does not need an Echelon country row. The Echelon CarrierService must be attached only to US delivery zones. A non-US callback is defense-in-depth: it bypasses all Echelon weight/rating work, returns no competing rate, and snapshots disposition `shopify_managed_destination`.
- **Completed Shopify orders are authoritative:** order intake preserves Shopify's destination country, currency, and shipping charge. It must not reject or re-rate an international order because Echelon lacks a local country configuration.
- **Sale over perfect weight data:** every positive physical-line weight contributes `unitWeight × quantity`; SKU-less lines are retained. Missing weights contribute zero, produce snapshot warnings, and never block checkout by themselves. An all-missing cart uses a 1g rate-band floor.
- **One rating engine, separate books:** Shopify checkout, first-party websites, and dropship vendor fulfillment use the shared runtime service but may resolve different prices. eBay shopper checkout remains external-policy managed. Dropship retains vendor-rate configuration plus post-quote insurance/handling/wallet behavior.
- **Canonical weight order:** Echelon `catalog.product_variants.weight_grams` wins. Shopify request weight is a warned transition fallback. Missing both contributes zero and never blocks checkout by itself.
- **Cartonization is replaceable and optional:** no Shopify callback or WMS status transition may require dimensions, a box, or a verified carton plan during the shipping-first rollout.
- **When cartonization is invoked, fit means placement:** every non-SIOC packed unit must have an in-bounds, non-overlapping placement. It still uses no arbitrary unit cap, and the ordinary-carton handling ceiling remains 22,679 g.
- **Plan reuse includes engine version:** an active pack plan is idempotently reused only when both its input hash and cartonizer version match. Deploying a new cartonizer automatically supersedes older plans on their next evaluation.
- **WMS rollout safety:** `POST /api/shipping/packing/orders/:wmsOrderId/generate-plan` is the explicit per-order test path. Automatic observation is off by default and requires `SHIPPING_WMS_CARTONIZATION_SHADOW_ENABLED=true`; failures are logged only, never block a handoff, and never route an order to `exception`. Held and already-fulfilled units are excluded from generated plans. There is deliberately no runtime enforcement flag.
- **Draft = inert:** `quoteShipmentRates` reads `status='active'` tables with effective dating only. Rate review happens in draft safely.
- **Inactive levels = silent engine:** quotes map to Shopify rates only through active `service_levels`. Both switches (levels + token) must be on for checkout to see anything.
- **Zone resolution:** longest postal-prefix wins, then priority, then lowest id; region-scoped rules (`destination_region` set) are skipped by design in v1 — *never seed region labels on prefix rules* (that was the HIPRAK bug, fixed in mig 124).
- **One table, one customer-facing option:** carrier and service codes cannot identify a checkout price. Parcel tables rate total shipment weight once; freight tables require pallet count and may enforce a total-weight ceiling.
- **US-only free shipping:** the engine has no international rates (US-only zone rules, no $0 rows). The member free-shipping Shopify Function (repo `shellz-club-functions`, extension `cardshellz-shipping-discount`) is gated to explicit `US` delivery addresses (PR #15, deployed Jul 9) after two international leaks (#59782 CA, #60039 DE). Keep both invariants when touching either system.
- **Every quote is snapshotted** (`quote_snapshots`, sources: checkout / shadow / manual) — that dataset drives calibration; don't turn it off.

## 8 · Ops, guardrails & gotchas

- **Deploys:** Heroku `cardshellz-echelon`; migrations run in the release phase (`scripts/release.sh` → `migrations/run-migrations.ts`), numbered `NNN_*.sql`, tracked in `_migrations`.
- **Migration numbering:** duplicate numeric prefixes abort the deploy. CI fails PRs on collisions (`server/__tests__/unit/migration-prefix-collision.test.ts`, #851) and the *main protection* ruleset requires the check + up-to-date branches. Still: pick your number against latest main *and* open PRs.
- **Writer-ratchet:** `scripts/writer-ratchet/baseline.json` freezes which modules may write which tables. New shipping-engine writers must be hand-added to the baseline in the same PR (alphabetical; never wholesale-regenerate on Windows).
- **Shared DB:** the club app shares this Postgres (owns `membership`). Dry-run migrations (`BEGIN … ROLLBACK`) against it before shipping.
- **ShipStation keys:** the v1 key/secret does NOT work on the v2 API — `SHIPSTATION_V2_API_KEY` is a separate credential, still unset.
- **wms data quirks:** `wms.orders.shipping_cents = 0` is unreliable for `globale`-tagged (international) orders — always verify against Shopify admin. `wms.order_items` has no variant-id column; resolve by `sku` (quantity column is `quantity`).
- **Shopify Functions:** metafields >10KB read as NULL inside Functions (this silently killed the shipping Function once — the plan-thresholds metafield is deliberately compact at 523B). Function changes need `npx @shopify/cli@latest app deploy` — merging alone changes nothing in checkout.

## 9 · Backlog after cutover

1. **Priority/Overnight/Pallet Freight service levels** — configure and validate rate tables, then activate per level. Add fulfillment-method mappings only when the fulfillment engine can enforce them.
2. **Calibration loop** — with the v2 key: scheduled quoted-vs-actual + live-rate comparison; adjust bands from `quote_snapshots`.
3. **First-party quote API and benefit policy** — reuse the runtime service with authenticated Shellz Club benefit context.
4. **Dropship shared-engine migration** — import the existing vendor rates as a separate `shipping.*` book, compare the shared engine against `DropshipShippingRateProvider`, switch only at parity, then retire duplicate tables while retaining dropship insurance, handling, snapshot, and wallet policy.
5. **Pack-station/cartonization rollout** — run explicit plans first, then opt-in shadow observation; capture actual box, weight, and cost before proposing enforcement.
6. **Multi-origin routing** — schema supports per-warehouse zone rules and rate rows; the callback currently prices from one origin (env-selected).
7. **Member Overnight benefit** — overnight for all, discounted per plan via the Function (member-exclusive rates are impossible: CarrierService sees no customer; Functions can only reduce existing rates).
8. **ShipStation replacement** — carrier adapters behind the provider seam (mig 115 varchar), FedEx-first.

---

*Sources: [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md) (full design), Echelon PRs #800–#851, shellz-club-functions #15. Every number in this doc was verified against production on Jul 8–9, 2026.*
