# Cardshellz Shipping Engine — Dev Team Handoff

*Updated July 14, 2026 · rating core deployed and dormant; shipping-first channel convergence is in progress. Full design: [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md).*

> **July 14 shipping-first decision:** launch the shipping engine independently of cartonization. Shopify and future first-party websites consume runtime weight-based quotes. eBay continues to use eBay fulfillment policies selected through its channel adapter. Dropship exposes its own managed shipping-policy/rate configuration. Cartonization remains a standalone optional provider and a WMS test path until separately approved. This supersedes every statement below that treats variant dimensions, boxes, or verified carton placement as a checkout launch gate.

> **July 13 update (PR #909 + follow-up):** standalone cartonizer v3.1 replaces aggregate volume feasibility with real non-overlapping 3D unit placement, all six rotations, persisted placement coordinates, geometry-driven splitting, and an automatic under-50-lb handling ceiling. Dropship and WMS test adapters can delegate to the same core. WMS enforcement is not active: manual plan generation and opt-in shadow execution are the only rollout paths, and neither may block or change fulfillment status.

## 0 · TL;DR

The local zone/rate-table core, service levels, ETA data, callback shell, and snapshots are deployed but dormant. The engine is **not cutover-ready yet**: Shopify is being moved onto a channel-neutral runtime quote service, channel ownership is being made explicit, active rate/service configuration is still absent, and comparison testing against Parcelify remains. Variant dimensions are not a checkout requirement. The initial strategy uses Shopify item weights when present; missing weights are excluded with snapshot warnings so checkout can continue at a deliberately low estimate.

## 1 · Vision & model

Checkout sells **service levels** (Standard / Expedited / Express), not carriers. The shared engine owns zone resolution, base rates, service-level selection, and delivery promises. Channel adapters own how that capability is consumed. Parcel selection is an injected provider: initial checkout uses a single weight-based shipment; the standalone cartonizer can be substituted later without changing the rate or channel contracts.

- **Replaces Parcelify** (static zip/weight/value tiers) at checkout. Parcelify is still active today serving US zones only; its admin UI has stopped loading for us (unresolved, app-side), which raises the urgency of cutover.
- **Long-term replaces ShipStation** via the per-carrier provider seam (FedEx own account first ≈10% of volume, then USPS ≈54%, UPS ≈36%). Commercial gate: own-account rates vs ShipStation wallet rates.
- International checkout is **Global-e** (DHL/UPS carrier participants) and stays out of scope for v1. The engine's zone rules are deliberately US-only.

## 2 · Architecture — two planes

### Quote plane (checkout-facing, latency-critical)

```
Shopify checkout ──POST──▶ /api/shipping/rates-callback/:token   (CarrierService, token-gated)
   every item[sku?,qty,grams] ─▶ weight-only parcel provider ─▶ one shipment
   shipment ─▶ resolveZone (zone_rules) ─▶ local rate provider (ACTIVE tables) ─▶ quotes
   quotes ─▶ map through ACTIVE service_levels ─▶ Shopify rates (+ETA dates from transit_matrix)
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
| Dropship | Managed channel policy | Dropship portal surfaces and stores its shipping configuration |

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
| domain | `domain/rate-selection.ts` | Per-parcel rate band selection per (carrier, serviceCode) |
| domain | `domain/eta.ts` | Delivery window = warehouse cutoff/timezone + transit_matrix business days |
| domain | `domain/rate-table-import.ts` | CSV grid import parsing/validation |
| domain | `domain/shipping-channel.ts`, `domain/shipment.ts` | Channel ownership/modes plus canonical shipment-line and parcel contracts |
| application | `application/shipment-quote.service.ts` | Runtime quote orchestration over injected parcel and rate providers; rejects policy-managed channels |
| application | `application/weight-only-parcel.provider.ts` | Initial Shopify/internal strategy: one shipment from complete channel item weights, no boxes or dimensions |
| application | `application/shipping-rate-provider.ts` | Rate-provider port plus local deterministic table adapter |
| application | `application/rate-quote.service.ts` | `quoteParcels`: zone → candidate rows (ACTIVE + effective-dated tables only) → per-parcel intersect → summed quotes; optional snapshot |
| application | `application/shadow-quote.service.ts` | `runShadow`: replays recent real wms.orders through the full pipeline, persists 'shadow' snapshots, returns readiness report |
| application | `cartonization/application/wms-pack-plan.service.ts`, `shipping-engine/application/packing.service.ts` | Channel-neutral WMS pack plans + pack-station actuals |
| infrastructure | `cartonization/infrastructure/packing-input.repository.ts` | Variant dims/weights/shipping-group/own-container loaders; active box loader |
| application | `application/rate-calibration.service.ts` | Quoted-vs-actual calibration (needs ShipStation v2 key for live-rate comparison) |
| infrastructure | `infrastructure/shipstation-v2-rating.adapter.ts` | ShipStation v2 live-rate adapter (offline calibration + HIPRAK) |
| interfaces | `interfaces/http/*` | `carrier-callback` (unauthenticated, token-gated, registered before auth middleware), `shadow-admin`, `rate-table-admin`, `calibration-admin`, `packing`; plus `shipping-admin.routes.ts`, `outbound-shipments.routes.ts` |
| client | `ShippingSettings.tsx` | 5 tabs: Service levels · Box catalog · Zone rules · Rate tables (import/review/activate) · Shadow runs |
| client | `Packing.tsx`, `OutboundShipments.tsx` | Pack-station + outbound shipment views |

## 4 · Data model & current prod state

Schema: `shipping.*` in the shared Postgres (Echelon owns it; the club app owns `membership`). Created in migration 117, extended through 135. Verified state as of Jul 14, 2026:

| Table | Purpose | Prod state |
|---|---|---|
| `zone_rules` | country + postal-prefix → zone | 48 active US rules → `US-48` / `US-HIPRAK`; region labels NULLed by mig 124 (they made resolveZone skip HIPRAK rules) |
| `rate_tables` + `rate_table_rows` | carrier/service, status, effective dating; zone × weight-band cents | ids 1 (US-48, 6 bands $4.99–$10.99) & 2 (US-HIPRAK, 5 bands $7.99–$29.94), **status=draft** — derived from 2,183 real orders; **91.2% of a 924-order backtest within $1** (56.2% exact); provenance in metadata |
| `box_catalog` | boxes: inner dims, tare, optional lower max weight, cost, fill factor | **14 seeded Jul 9** from 4,259 real ShipStation shipments (top 14 dim combos ≈ 85% of volume, incl. 2 storage-box flats); dimensions/tare/cost still require review in admin. NULL max weight uses the automatic 22,679 g handling ceiling. |
| `service_levels` + `service_level_methods` | sellable levels → carrier/method attachments | standard / expedited / express seeded, **all inactive** — the checkout kill-switch |
| `transit_matrix` | zone × carrier/service business-day windows | 24 rows seeded (mig 120) — feeds ETA dates on rates |
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

Each step is independently reversible; nothing reaches customers until step 5.

1. **IN PROGRESS — Separate shipping from packing:** land the shared shipment, parcel-provider, rate-provider, and channel-mode contracts. Shopify uses complete channel weights. eBay and dropship remain in their policy-owned paths.
2. **NEXT — Improve Shopify weight coverage:** resolve the active variants with no Shopify weight and verify representative carts. Missing weight is recorded and underquoted by policy; it is not a launch blocker. Dimensions and box data are unrelated to this work.
3. **NEXT — Finish base-rate configuration:** validate the draft US-48/HIPRAK rows, service-method mappings, and the exact Parcelify rules that must be preserved. Keep tables and service levels inactive.
4. **NEXT — Weight-only shadow comparison:** replay representative Shopify carts through the same runtime quote service, compare offers against Parcelify, and review missing-weight/zone/band failures. Do not use cartonization readiness as the pass criterion.
5. **Go live (Standard only):**
   - Set Heroku config `SHIPPING_CALLBACK_TOKEN` (random secret) and, if origin ≠ warehouse 1, `SHIPPING_CALLBACK_ORIGIN_WAREHOUSE_ID`.
   - Register the CarrierService in Shopify pointing at `POST /api/shipping/rates-callback/<token>`.
   - Activate the `standard` service level (+ its method mapping to the blended/standard table).
   - Attach the new carrier service to the US zones in the delivery profiles alongside Parcelify; verify rate parity in a real checkout; then remove Parcelify from the zones.
   - **Open item before uninstalling Parcelify entirely:** confirm how CarrierService (third-party calculated rates) is enabled on the current Shopify plan — Parcelify being installed may be what grants it today.
6. **Decommission Parcelify** once the engine has served checkout cleanly for an agreed soak period.
7. **After checkout is stable:** expose the same runtime quote service to first-party websites, build the dropship managed-policy UI, keep eBay fulfillment-policy selection in its adapter, and advance cartonization through its separate test/shadow program.

> **Rollback at any point:** deactivate service levels (response becomes `{rates: []}`) or unset `SHIPPING_CALLBACK_TOKEN` (endpoint 404s) and re-attach Parcelify to the zones.

## 7 · Key mechanics & invariants (do not break)

- **Fail-empty, never fail-wrong:** the callback returns `{rates: []}` on any parse/zone/band/timeout failure. An empty response blocks checkout for that address rather than mispricing it. Keep that property.
- **Sale over perfect weight data:** every positive physical-line weight contributes `unitWeight × quantity`; SKU-less lines are retained. Missing weights contribute zero, produce snapshot warnings, and never block checkout by themselves. An all-missing cart uses a 1g rate-band floor.
- **Channel ownership is explicit:** only Shopify and first-party/internal sites use runtime quotes. eBay is external-policy managed; dropship is portal-policy managed until an approved adapter says otherwise.
- **Cartonization is replaceable and optional:** no Shopify callback or WMS status transition may require dimensions, a box, or a verified carton plan during the shipping-first rollout.
- **When cartonization is invoked, fit means placement:** every non-SIOC packed unit must have an in-bounds, non-overlapping placement. It still uses no arbitrary unit cap, and the ordinary-carton handling ceiling remains 22,679 g.
- **Plan reuse includes engine version:** an active pack plan is idempotently reused only when both its input hash and cartonizer version match. Deploying a new cartonizer automatically supersedes older plans on their next evaluation.
- **WMS rollout safety:** `POST /api/shipping/packing/orders/:wmsOrderId/generate-plan` is the explicit per-order test path. Automatic observation is off by default and requires `SHIPPING_WMS_CARTONIZATION_SHADOW_ENABLED=true`; failures are logged only, never block a handoff, and never route an order to `exception`. Held and already-fulfilled units are excluded from generated plans. There is deliberately no runtime enforcement flag.
- **Draft = inert:** `quoteParcels` reads `status='active'` tables with effective-dating only. Rate review happens in draft safely.
- **Inactive levels = silent engine:** quotes map to Shopify rates only through active `service_levels`. Both switches (levels + token) must be on for checkout to see anything.
- **Zone resolution:** longest postal-prefix wins, then priority, then lowest id; region-scoped rules (`destination_region` set) are skipped by design in v1 — *never seed region labels on prefix rules* (that was the HIPRAK bug, fixed in mig 124).
- **A (carrier, serviceCode) is offered only if EVERY parcel priced under it** — partial quotes are dropped with warnings, not summed optimistically.
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

1. **Expedited/Express service levels** — attach methods + rate tables, activate per level.
2. **Calibration loop** — with the v2 key: scheduled quoted-vs-actual + live-rate comparison; adjust bands from `quote_snapshots`.
3. **First-party quote API and benefit policy** — reuse the runtime service with authenticated Shellz Club benefit context.
4. **Dropship managed shipping policy** — surface channel-appropriate shipping configuration without pretending it is a Shopify-style callback.
5. **Pack-station/cartonization rollout** — run explicit plans first, then opt-in shadow observation; capture actual box, weight, and cost before proposing enforcement.
6. **Multi-origin routing** — schema supports per-warehouse zone rules and rate rows; the callback currently prices from one origin (env-selected).
7. **Member Express benefit** — express for all, discounted per plan via the Function (member-exclusive rates are impossible: CarrierService sees no customer; Functions can only reduce existing rates).
8. **ShipStation replacement** — carrier adapters behind the provider seam (mig 115 varchar), FedEx-first.

---

*Sources: [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md) (full design), Echelon PRs #800–#851, shellz-club-functions #15. Every number in this doc was verified against production on Jul 8–9, 2026.*
