# Cardshellz Shipping Engine — Dev Team Handoff

*July 9, 2026 · engine code-complete in production, dormant until activated. Full design: [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md).*

> **July 13 update (PR #909 + follow-up):** standalone cartonizer v3.1 replaces aggregate volume feasibility with real non-overlapping 3D unit placement, all six rotations, persisted placement coordinates, geometry-driven splitting, and an automatic under-50-lb handling ceiling. Dropship, checkout, and WMS test adapters delegate to the same core. WMS enforcement is not active: manual plan generation and opt-in shadow execution are the only rollout paths, and neither may block or change fulfillment status.

## 0 · TL;DR

A greenfield, Amazon-style shipping engine is **fully built and deployed inside Echelon** (13 PRs, all merged; Heroku deploys green). It replaces Parcelify for checkout rates and, long-term, ShipStation for fulfillment. Nothing is customer-visible yet — activation is a deliberate, reversible sequence of data + config steps (§6). The remaining work is mostly **data entry (variant dimensions)** and **staged activation**, not code.

## 1 · Vision & model

Checkout sells **service levels** (Standard / Expedited / Express), not carriers. The engine owns every downstream decision: which zone, which rate, which carrier+method satisfies the level cheapest, which box(es) the order packs into, and the delivery-date promise. The WMS pack station receives an optimized box selection and split plan instead of packer guesswork.

- **Replaces Parcelify** (static zip/weight/value tiers) at checkout. Parcelify is still active today serving US zones only; its admin UI has stopped loading for us (unresolved, app-side), which raises the urgency of cutover.
- **Long-term replaces ShipStation** via the per-carrier provider seam (FedEx own account first ≈10% of volume, then USPS ≈54%, UPS ≈36%). Commercial gate: own-account rates vs ShipStation wallet rates.
- International checkout is **Global-e** (DHL/UPS carrier participants) and stays out of scope for v1. The engine's zone rules are deliberately US-only.

## 2 · Architecture — two planes

### Quote plane (checkout-facing, latency-critical)

```
Shopify checkout ──POST──▶ /api/shipping/rates-callback/:token   (CarrierService, token-gated)
   items[sku,qty,grams] ─▶ resolve variants ─▶ cartonize (box catalog) ─▶ parcels
   parcels ─▶ resolveZone (zone_rules) ─▶ quoteParcels (ACTIVE rate tables) ─▶ quotes
   quotes ─▶ map through ACTIVE service_levels ─▶ Shopify rates (+ETA dates from transit_matrix)
   every request ─▶ shipping.quote_snapshots (source 'checkout')  ← calibration dataset
```

- No external calls in the hot path — DB reads only; hard 2s response deadline; every failure degrades to `{ rates: [] }` (never a wrong/free rate, never a 5xx).
- Member free shipping stays in the club app's Shopify Function (separate repo, §8) — engine quotes are member-agnostic because Shopify's CarrierService payload carries no customer identity.
- HI/AK/PR: local `US-HIPRAK` zone with conservative table rates now; live ShipStation v2 rating as a later enhancement (blocked on the v2 API key).

### Fulfillment plane (warehouse-facing)

```
order ─▶ pack-plan service (cartonize with full dims) ─▶ persisted ship plan
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

Schema: `shipping.*` in the shared Postgres (Echelon owns it; the club app owns `membership`). Created in migration 117, extended through 124. Verified state as of Jul 9, 2026:

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
| Engine PRs | 13/13 merged & deployed |
| Variant weights | 253/326 (backfilled from Shopify; 73 need manual entry) |
| Variant dims | **0/326 — THE gating item** for cartonization |
| Boxes | 14 seeded from shipment history |
| Rate tables | draft (validated, awaiting activation) |
| `SHIPSTATION_V2_API_KEY` | not set (blocks calibration + HIPRAK live rates; v1 key does NOT work on v2 API) |

**First shadow run (Jul 9, 100 real orders / 7 days):** pipeline ran end-to-end cleanly on all 100 orders. `packingFallback: 100/100` (no variant has dims yet) and `ratesEmpty: 100/100` (expected — quotes read `status='active'` tables only and both tables are draft).

**Dims hit-list (60-day order coverage — do these first):** measuring only the top-volume SKUs unlocks most orders for true cartonization: **top 20 SKUs → 38%** of orders fully packable · **top 50 → 64%** · **top 100 → 90%**. #1 is `EG-SLV-STD-5PCK-B500` (15.5% of all orders). The ranked list comes from `wms.order_items` grouped by SKU over 60 days.

## 6 · Activation runbook — path to cutover

Each step is independently reversible; nothing reaches customers until step 5.

1. **DONE** — Engine built, deployed, dormant. Draft rate grid loaded + backtested. Boxes seeded. HIPRAK zone fix live.
2. **NEXT — Enter dims** for top-20/50 SKUs (ProductDetail → Fulfillment characteristics). Also finish the 73 missing weights.
3. **NEXT — Activate the two rate tables** (Settings → Shipping → Rate tables). Checkout-invisible while service levels are inactive and no callback is registered. This makes shadow runs produce real quotes.
4. **Shadow-run to accuracy** (Settings → Shipping → Shadow runs): compare engine quotes vs `wms.orders.shipping_cents` until the match rate holds. Note: most historical "misses" were multi-group carts where Parcelify summed two group rates — the engine models per-parcel natively and is usually cheaper; only 12/924 backtested orders would quote higher than what was paid.
5. **Go live (Standard only):**
   - Set Heroku config `SHIPPING_CALLBACK_TOKEN` (random secret) and, if origin ≠ warehouse 1, `SHIPPING_CALLBACK_ORIGIN_WAREHOUSE_ID`.
   - Register the CarrierService in Shopify pointing at `POST /api/shipping/rates-callback/<token>`.
   - Activate the `standard` service level (+ its method mapping to the blended/standard table).
   - Attach the new carrier service to the US zones in the delivery profiles alongside Parcelify; verify rate parity in a real checkout; then remove Parcelify from the zones.
   - **Open item before uninstalling Parcelify entirely:** confirm how CarrierService (third-party calculated rates) is enabled on the current Shopify plan — Parcelify being installed may be what grants it today.
6. **Decommission Parcelify** once the engine has served checkout cleanly for an agreed soak period.

> **Rollback at any point:** deactivate service levels (response becomes `{rates: []}`) or unset `SHIPPING_CALLBACK_TOKEN` (endpoint 404s) and re-attach Parcelify to the zones.

## 7 · Key mechanics & invariants (do not break)

- **Fail-empty, never fail-wrong:** the callback returns `{rates: []}` on any parse/zone/band/timeout failure. An empty response blocks checkout for that address rather than mispricing it. Keep that property.
- **Fit means placement, not volume:** every non-SIOC packed unit must have an in-bounds, non-overlapping placement in the selected carton's inner dimensions. Aggregate cube and sorted single-item dimensions are only quick rejection checks.
- **No arbitrary unit cap:** carton count is derived from physical dimensions, rotation, fill clearance, and packed weight. `max_units_per_package` is deprecated compatibility data and must not affect quotes.
- **Handling ceiling:** ordinary packed cartons may not exceed 22,679 g including tare. A box-specific maximum may lower that limit but never raise it.
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
3. **Pack-station rollout** — run explicit plans first, then opt-in shadow observation; expose predicted plans in the Packing UI and capture actual box, weight, and cost. A separate cutover PR may propose enforcement only after SKU-dimension coverage, stocked-box coverage, verified-plan rate, no-fit rate, and predicted-vs-actual accuracy meet approved thresholds and operators have a usable exception workflow.
4. **Multi-origin routing** — schema supports per-warehouse zone rules and rate rows; the callback currently prices from one origin (env-selected).
5. **Member Express benefit** — express for all, discounted per plan via the Function (member-exclusive rates are impossible: CarrierService sees no customer; Functions can only reduce existing rates).
6. **ShipStation replacement** — carrier adapters behind the provider seam (mig 115 varchar), FedEx-first.
7. **Dims long tail** — remaining variants past the top 100; per-box tare/max-weight/cost tuning in the catalog.

---

*Sources: [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md) (full design), Echelon PRs #800–#851, shellz-club-functions #15. Every number in this doc was verified against production on Jul 8–9, 2026.*
