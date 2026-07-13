# Dropship Dev Handoff — 2026-07-09

Audience: developers picking up dropship work. This is the **work order**: every recorded decision, every verified defect with its fix approach, sequenced into batches. State below was re-verified against prod and main on 2026-07-09 (prod = v2318 = `a32af11d`, current with main; zero dropship-module commits since the 07-05 review, so every item stands).

## Doc map (what's authoritative for what)

| Doc | Role |
| --- | --- |
| `DROPSHIP-V2-CONSOLIDATED-DESIGN.md` | Platform design of record (amendments needed — §6 below) |
| `docs/DROPSHIP-DEEP-REVIEW-2026-07-05.md` | Verified findings (§3 bugs, §4 gaps), owner strategic decisions (§5), UX review (§8). **Evidence with file:line lives there — this handoff doesn't repeat it.** |
| `docs/DROPSHIP-MARGIN-FIRST-CATALOG-DESIGN.md` | Margin-first catalog build spec (merged, decisions recorded, ready to build) |
| `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md` + `docs/DROPSHIP-DOGFOOD-HANDOFF.md` | Test checklist + operator handoff. **Known correction:** its step 3 (package data via Catalog > Variants) only becomes true after item 0.5 below ships. |

## Current state (verified 2026-07-09)

- Dogfood is paused before the first listing push (test plan Phase 3/4). Vendor `bseager6@gmail.com` / eBay store `marzcards` / warehouse 1.
- Prod is current with main; deploys green (the 07-05 migration-collision outage was fixed on main via the `121_` rename).
- Prod data: 1 package profile, 1 box, 1 zone rule, 1 rate row, 1 listing config (**`listing_mode='draft_first'`** — must be flipped for the eBay test). Dropship channel id **103** exists with **no** warehouse assignments and **no** allocation rules. `TRUST_PROXY` is **unset** on Heroku. `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` is set — keep it pinned (the worker silently no-ops without it).

## 1. Recorded decisions (owner, 2026-07-05 / 07-09)

Strategic (deep review §5):

| # | Decision | Consequence for dev |
| --- | --- | --- |
| D1 | **Keep standalone portal auth** (passwords + passkeys + email MFA keyed to Shellz Club identity); update design §3 | Auth hardening backlog is real work (Batch 3); no SSO build |
| D2 | **Wire dropship ATP into the existing channel allocation engine** (channel 103) | Batch 3 item 3.1 — replaces raw `getBulkAtp` reads |
| D3 | **P3.2 synchronous reservation before first external vendor** | Batch 3 item 3.2 |
| D4 | **eBay lists LIVE at push** | Batch 0 item 0.4 (code default + data flip) |
| D5 | **Dropship reads package weight/dims from `catalog.product_variants`** | Batch 0 item 0.5 (before quote testing) |
| D6 | **USDC is a planned optional rail, not a launch or activation requirement** | Batch 0 item 0.6 removes the gate and makes readiness honest; provider-backed verification remains a separate wallet milestone |
| D7 | **Lapse/disconnect listing cleanup built during dogfood** + lapse-simulation test phase | Batch 1 |

Margin-first catalog (design doc §5):

| # | Decision |
| --- | --- |
| M1 | **Never estimate marketplace fees.** Margin = product margin (price − Card Shellz cost), prominently labeled as excluding shipping + marketplace fees |
| M2 | **One marketplace-agnostic shipping rate stack** (already built that way — platform is not a rate dimension). v1 margin excludes shipping; v1.1 adds a read-only quote `estimate` mode showing Card Shellz's own charge |
| M3 | **No vendor P&L anywhere.** Show Card Shellz costs authoritatively (debit breakdown incl. `feesCents`); marketplace totals stay informational; no computed profit |
| M4 | **Show the .ops discount percent** (tooltip; doubles as membership marketing) |

House pricing philosophy behind M1-M3: *show our numbers authoritatively; never guess theirs.* Apply it to any future vendor-facing money surface.

## 2. Batch 0 — before resuming dogfood (small PRs, each independently shippable)

Implementation status (2026-07-13):

| Item | Status |
| --- | --- |
| 0.1 | Implemented and covered across listing, tracking, intake, and cancellation resource APIs. Production verification remains. |
| 0.2 | Implemented: active holds are reconsidered only after a vendor wallet mutation and retain their original expiration across worker claims. Production verification remains. |
| 0.3 | Implemented with strict error-shape matching, a deduplicated audit event, and cursor advancement after the remaining orders complete. Production verification remains. |
| 0.4 | Code default implemented: new eBay configs use `live`; Shopify remains `draft_first`. The existing `marzcards` production config still requires an explicit post-deploy flip. |
| 0.5 | Implemented: quote cartonization, listing/eBay push, and dogfood readiness use canonical Catalog Variant package data; dropship profiles are override-only. Production quote verification remains. |
| 0.6 | Implemented: USDC is no longer an activation, settings, or dogfood-readiness requirement. The optional funding-method/ledger foundation remains, and provider-backed USDC is reported as not applicable to launch until configured. Production portal verification remains. |

**0.1 eBay HTTP 400 must not tear down the store connection.** `isPermanentAuthFailureStatus` treats 400 as a permanent auth failure in BOTH `dropship-ebay-listing-push.provider.ts:428-430` and `dropship-ebay-tracking.provider.ts` (~:298); any eBay validation 400 then nulls token refs and deletes vault rows via `recordAuthFailure` (`dropship-marketplace-credentials.ts:237-262`), forcing full OAuth reconnect and blocking remaining job items. Fix: 401/403 only in both API-call paths (400 stays fatal only on the token-refresh endpoint = `invalid_grant`). Acceptance: unit test — eBay 400 on push/tracking fails the item without touching connection status/tokens. (Deep review §3.2.)

**0.2 Payment-hold expiry must survive the worker sweep.** The 10s sweep re-claims every unexpired hold (`dropship-order-processing-runner.ts:115-132` selects unexpired `payment_hold` rows), the claim flips status to `processing` (`dropship-order-processing.repository.ts:75-88`), so `normalizeActivePaymentHoldExpiresAt` (`dropship-order-acceptance-service.ts:703-709`) no longer sees `payment_hold` and re-arms the expiry to now+48h every cycle. Holds never expire; ≥10 holds starve newer intakes (`ORDER BY received_at ASC LIMIT 10`); 2 audit rows per held intake per sweep. Fix: carry the pre-claim status/expiry into the plan (preserve expiry through the claim), and/or exclude unexpired holds from the sweep unless funding state changed. Acceptance: worker-path test — claim an underfunded intake twice; `payment_hold_expires_at` unchanged; `expirePaymentHolds` fires at the original deadline. (§3.4.)

**0.3 eBay poll poison-pill isolation.** One `DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE` throw (changed payload replayed against an accepted intake, `dropship-order-intake.repository.ts:158-170`) aborts the whole store's poll loop before `markStorePollSucceeded` (`dropship-ebay-order-intake-poll-service.ts:91-112`) — watermark stuck, same order re-fetched every 5 min, all later orders never ingested. Fix: per-order try/catch → record an exception/audit row, continue the loop, advance the watermark. Acceptance: test — batch of 3 orders where #2 throws immutable-conflict → #1/#3 recorded, watermark advances, conflict surfaced once. (§3.5.)

**0.4 eBay live-at-push (D4).** Code: eBay default listing mode → `live` (`DROPSHIP_DEFAULT_LISTING_MODE` currently `draft_first` for all platforms, `dropship-listing-config-service.ts:19`, applied to eBay in `buildDefaultDropshipStoreListingConfig` :247-265); Shopify keeps `draft_first`. Data: flip marzcards `dropship_store_listing_configs.listing_mode` to `live` (admin PUT `/api/dropship/admin/store-connections/:id/listing-config` exists). Note: staged pushes store the **offerId** in `external_listing_id` (`dropship-ebay-listing-push.provider.ts:116-127`) — after this change, live pushes must assert a real listing id (the provider already errors when live && !listingId). Acceptance: provider test default-mode eBay push publishes; config test builds eBay default as live.

**0.5 Dropship package data reads `catalog.product_variants` (D5).** Today the quote/cartonization path reads only `dropship.dropship_package_profiles` (`dropship-basic-cartonization.provider.ts:72-79`) while the PR #796 Catalog > Variants editor writes `catalog.product_variants` weight/dims (`catalog.routes.ts:1362-1398`) — no sync, so the dogfood handoff's step 3 currently does nothing. Fix: cartonization provider sources weight_grams/length_mm/width_mm/height_mm from `catalog.product_variants`; `dropship_package_profiles` keeps only dropship-specific fields (ship_alone, default_box_id, max_units_per_package) — treat profile dims as deprecated (read-through preference: catalog first). Listing-preview's `package_profile_required` blocker must gate on catalog dims presence instead. Needs its own test pass (this touches quote correctness right before the first quote validation): unit tests + one manual SHIPCFG-04/08 quote check. (§3.1.)

**0.6 Remove the USDC activation gate (D6).** `walletReady` hard-requires a USDC funding method (`dropship-vendor-provisioning-service.ts:303-305`) and onboarding copy demands it (`DropshipPortalOnboarding.tsx:731,913-915`) — every vendor would need a crypto wallet to activate. Fix: drop `hasUsdcBaseFundingMethod` from the gate (keep spendable-or-stripe + auto-reload), remove USDC from vendor/admin launch blockers, update portal copy, keep the USDC panel as optional, and report provider-backed USDC as not applicable to launch until configured. Preserve all USDC funding-method and ledger foundations. Acceptance: provisioning unit test — walletReady true with Stripe+auto-reload and no USDC; settings and dogfood readiness do not block on USDC.

**0.7 Config one-liners.** `heroku config:set TRUST_PROXY=true -a cardshellz-echelon` (session cookies currently issued without `Secure` — cookie flag keys off TRUST_PROXY, `server/index.ts:127`, while trust-proxy itself keys off NODE_ENV). Verify login after. Keep `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` pinned.

**0.8 Cartonizer guardrail (operational until cartonizer v2).** `boxFitsPackage` dimension-checks a single unit regardless of quantity; only weight caps bound a package (`domain/shipping-quote.ts:194-268`) → multi-unit orders can underquote. Until the shipping-engine cartonizer replaces this: every box row gets `max_weight_grams`, every profile gets `max_units_per_package`; add a config-service validation warning when either is null. The existing unit test asserting 2-units-in-a-1-unit-box (`dropship-shipping-quote-service.test.ts:40-57`) should be re-pinned to the guarded behavior. (§3.6.)

Then resume the dogfood test plan at Phase 3/4 per `docs/DROPSHIP-DOGFOOD-HANDOFF.md`, whose step 3 is now correct thanks to 0.5.

## 3. Batch 1 — during dogfood (D7 + small correctness)

**1.1 Listing end/zero-quantity capability.** The push-provider interface has only `pushListing` (`dropship-marketplace-listing-push-provider.ts:25-27`); nothing can end/pause/zero a live listing. Add `endListing`/`setQuantity` (or a zero-quantity push mode) to the eBay + Shopify providers and worker plumbing. This is the dependency for everything below and for future drift/quantity sync.

**1.2 Grace-expiry worker + lapse zeroing.** `DROPSHIP_ENTITLEMENT_GRACE_HOURS = 72` (`domain/auth.ts:3`) is never referenced; `membership_grace_ends_at` is hardcoded NULL on every write (`dropship-vendor-provisioning.repository.ts:400,435`); nothing transitions `grace_period → disconnected` at `grace_ends_at`; lapsed vendors' live listings keep selling. Build: populate grace timestamps; a sweep that (a) on lapse → zero-quantity push all active listings + notify, (b) at disconnect-grace expiry → end listings, flip status, ops exception on API failure (design §3/§4 behavior). Add the **lapse-simulation phase** to the dogfood test plan: pause the `.ops` subscription → listings zero → restore → resume.

**1.3 Step-up CHECK constraint fix.** `dropship_sensitive_action_challenges.action` CHECK omits `manage_catalog_selection` (`shared/schema/dropship.schema.ts:269`) while the route requires it (`dropship-vendor-catalog.routes.ts:34`) → email-MFA vendors 500 on catalog selection. Migration to extend the CHECK + a test that runs the email-MFA challenge for every action in `domain/auth.ts`.

**1.4 Session regeneration on login** (all four login handlers set `req.session.dropship` without `regenerate()`, `dropship-auth.routes.ts:120-192`) — session-fixation hygiene while auth is standalone (D1).

## 4. Batch 2 — margin-first catalog (spec: `docs/DROPSHIP-MARGIN-FIRST-CATALOG-DESIGN.md`)

Three PRs, spec'd in detail there; the invariant to protect: **displayed cost = debited cost**, enforced by reusing `calculateDiscountedWholesaleUnitCostCents` + one shared retail-price SQL fragment, with formula/retail parity unit tests.

- PR 1 (server): shared retail-SQL fragment; `DropshipCatalogRow` += suggestedRetailCents / wholesaleUnitCents / imageUrl / vendorRetailPriceCents (+ top-level discount %); preview rows += cost/margin; orders list += totalDebitCents.
- PR 2 (UI): catalog thumbnail/Cost/Suggested/Your-price/live-Margin columns with the M1 exclusion label; preview Cost+Margin; real suggested price as the input placeholder; "Pricing unavailable" badge.
- PR 3 (UI, small): orders Total-debit column; render `feesCents` in the economics block. No P&L (M3).

## 5. Batch 3 — before first external vendor

**3.1 Allocation-engine wiring (D2).** Channel 103 exists but has no warehouse assignments/rules and the dropship ATP provider bypasses the engine (`dropship-atp.provider.ts:14` → raw `InventoryAtpService.getBulkAtp`, global/unscoped). Work: (a) provider consumes the engine for channel 103 (`AllocationEngine.getAllocatedQty(productId, variantId, channelId)`; note the current provider interface is per-product — per-variant allocation likely simplifies `vendor-selection.ts:132-142` which divides by unitsPerVariant); (b) assign warehouse 1 to channel 103 (`channel_warehouse_assignments`); (c) create the channel-default allocation rule — this is the admin quantity-cap lever design §8 requires; (d) dropship quantity re-sync consuming `allocateAndGetSyncTargets` (fires on allocation change; today nothing ever re-pushes quantity after the first push). Also fixes the "no raw inventory ATP" design rule and the stale-listing-quantity failure mode in one motion. (Deep review §4 first two bullets.)

**3.2 P3.2 synchronous reservation (D3).** Acceptance currently validates availability but reserves post-commit at WMS sync (in-code P0.1a comment, `dropship-order-acceptance.repository.ts:266-277`); the last-unit race leaves a debited vendor + on-hold WMS order with manual-only recovery. Implement the in-code plan: acceptance awaits the reservation before confirming. Unblocks the two §18 rollback tests (write them with it). Until it ships, ops runbook: admin `retry-wms-sync` + manual wallet credit.

**3.3 Money/tracking safety nets.** (a) Tracking-push reconciliation is blind to dropship: sweep filters `c.provider IN ('ebay','shopify')` but the dropship channel is `manual`, and the dropship path never writes the `tracking_pushed` OMS event the sweep looks for (`oms-flow-reconciliation.service.ts:377-404`) — include the dropship channel and/or emit the event. (b) Pending ACH that fails after `processing` is never voided — phantom pending balance forever; add the void transition on `payment_intent.payment_failed` + a ledger-vs-aggregate reconciliation check. (c) Replace the always-green `split_shipment_handoff` readiness stub. The USDC readiness stub moves to an honest not-applicable launch status in item 0.6.

**3.4 UX Batch A** (deep review §8.3 quick wins): hold→fund loop (open-holds banner on Wallet, "Fund now" CTA on held orders, handle the Stripe return query params that are currently ignored); pre-accept confirm with the quoted debit on the manual Accept path; pagination on Orders/Returns/ledger/alerts (all hardcoded page 1/limit 50); **passkey enrollment UI** (`registerPasskey` exists with zero callers — this is what makes step-up bearable); vendor-language pass + strip internals (idempotency key/request hash off the Returns detail, token internals off Settings); alerts unread badge in the shell; step-up scope relaxation (money actions keep 10-min proofs; selection/preferences get session-long).

**3.5 Auth hardening (D1 backlog).** Account lockout (schema `locked` status exists, nothing writes it); enumeration tightening on `/auth/email/status`; account self-service UI (change password/email — backend actions exist with no UI).

## 6. Batch 4 — vendor beta gate (UX Batch B, deep review §8.3-8.4)

My Listings page (needs a vendor GET-listings endpoint — none exists; pairs with 1.1 end/pause actions and 3.1 quantity sync); guided eBay policy setup (pull seller's business policies via eBay Account API into dropdowns; internal admin has policy UI to borrow); operating dashboard v1 (Card Shellz spend tile per M3 — no profit; top SKUs per design §14); RMA usability (auto-generate RMA numbers, product names instead of "Variant 3021", render inspection photos); margin-design v1.1 (read-only quote `estimate` mode — no snapshot/idempotency — per M2); support surface (help/contact in the portal chrome).

## 7. Tests & CI (cross-batch)

- CI: add a duplicate-migration-prefix check (the 07-05 deploy outage was detectable at PR time). Integration tests (`dropship-schema.integration.test.ts` — where the §16 constraint proofs live) don't run in CI; add a PG service job or run locally before each dogfood session.
- §18 tests to write, in priority order: acceptance rollback on wallet-debit failure (behavioral, not source-grep); worker-path hold expiry (0.2); concurrent last-unit acceptance (pins 3.2); eBay-400 handling (0.1); poison-pill isolation (0.3); pg-level quote provider tests (zone/rate SQL currently untested); return repository tests (credit/fee math, insufficient funds); margin parity tests (Batch 2).

## 8. Design-doc amendments (update `DROPSHIP-V2-CONSOLIDATED-DESIGN.md`)

§3 auth → standalone credentials model (D1). §10 → USDC is a planned optional rail and not launch-blocking (D6). §8 → allocation implemented via the channel allocation engine + channel rules as admin caps (D2). §14 → add My Listings page; specify the operating dashboard; add the notification deep-link contract and a vendor-facing error dictionary as build requirements (deep review §8.4). §7 → suggested retail = Card Shellz live retail (retail cache), margin display per M1/M4.

## 9. Working agreement

One operator drives the dogfood checklist, one engineer traces failures (per the existing dogfood handoff); capture evidence IDs back into the test plan as you go; deliver work as PRs — owner merges and deploys; before any prod-state assertion, re-verify (releases, config, DB counts) — several "facts" in earlier docs went stale within days.
