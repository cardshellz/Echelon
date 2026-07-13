# Dropship Deep Review — 2026-07-05

Scope: `DROPSHIP-V2-CONSOLIDATED-DESIGN.md` vs the implemented dropship module (~74k LOC under `server/modules/dropship`, `shared/schema/dropship.schema.ts`, plus the OMS/WMS/inventory/channels seams it calls), the dogfood test plan, and live production state on Heroku (`cardshellz-echelon`).

Method: seven parallel subsystem reviews (money core; ATP/inventory/OMS channel; listing pipeline; shipping; auth/entitlement/security; fulfillment/tracking/returns/notifications; wiring/workers/migrations/tests), followed by direct verification of every P0/P1 mechanism cited below.

Evidence tags: **[V]** = verified directly in code/config during this review. **[R]** = reported by a subsystem review pass with file:line citations, pattern spot-checked but not fully re-read.

---

## 1. Live production state (checked 2026-07-05)

- **[V] Deploy outage, RESOLVED same day.** Releases v2286–v2289 failed the release phase on `Migration prefix collision: 119_outbound_shipment_tracking_dedup.sql and 119_shipping_zone_seed.sql`, pinning prod at v2285 for ~1h. Fixed on main by renaming the never-applied file to `121_` (`120_` was claimed by `120_shipping_transit_seed.sql` in the interim); deploys green from v2290, prod current at v2292 (`d2f92f60`). PR #837 (this review's earlier `120_` rename) was superseded and closed. Standing recommendation: **add a CI check for duplicate migration prefixes** — this was detectable at PR time and cost a deploy outage.
- **[V] Prod now contains every dropship change the test plan cares about** (PR #796 package editor, shared eBay builder `f1b2dbee`, retail-cache pricing `f7b2f741`, connector refactor `5b058adb`, P0.1 single-writer reservations `20066ad1`), plus P0.4 SHIP_NOTIFY dedup and the shipping-engine stack through #821.
- **[V] Worker flags are set correctly in prod**: `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` is present (this worker is opt-in and **silently no-ops** when the var is missing — `dropship-order-processing-runner.ts:249-256`; keep this var pinned). Listing-push and eBay-intake workers are on; `DISABLE_SCHEDULERS=false`.
- **[V] `TRUST_PROXY` is NOT set in prod.** `server/index.ts` sets the session cookie `secure` flag only when `TRUST_PROXY === "true"` (trust-proxy itself keys off `NODE_ENV`), so vendor-portal and admin session cookies are currently issued **without the Secure attribute**. One-line fix: `heroku config:set TRUST_PROXY=true -a cardshellz-echelon`, then verify login still works (it should — trust proxy is already on via NODE_ENV).

---

## 2. What is solid (credit where due)

- **[V] §16 critical constraints are all real, DB-enforced**: intake unique `(store_connection_id, external_order_id)` (schema:975); one-active-store-connection partial unique (schema:298-300); listing unique `(store_connection_id, product_variant_id)` (schema:639, unconditional — stronger than the design's "active" scope); wallet ledger unique `(reference_type, reference_id)` + idempotency key (schema:780-783); non-negative balance CHECKs; all money integer cents (only `numeric` anywhere is USDC `numeric(78,0)` atomic units). No startup DDL for dropship; migrations `0086–0106` match the schema 1:1, test-enforced. [R for migration/table 1:1 match]
- **[R] The acceptance money transaction is genuinely atomic for what it covers** (OMS order + lines + wallet debit + ledger + economics snapshot + intake flip + audit in one Postgres tx, no external calls inside), with FOR UPDATE locks and DB uniques as replay backstops. Double-debit is not possible.
- **[R] Webhook/OAuth/token security is done properly**: Shopify HMAC timing-safe over raw body (fail-closed 503/401); eBay intake is authenticated polling (no spoofable endpoint); AES-256-GCM token vault with required 32-byte key (throws if missing), AAD-bound, no plaintext token logging; OAuth state HMAC-signed; no vendor↔vendor IDOR found (all queries scope by session-derived vendorId); admin routes RBAC-gated on a separate session principal.
- **[V] §17 legacy retirement is complete**: `vendor-portal.routes.ts`, `vendor-ebay.routes.ts`, `vendor-order-polling.ts`, old `wallet.service.ts` are deleted, with a regression test guarding re-introduction. All 22 route files are mounted; no orphan pages.
- **[R] Notification coverage matches the design's critical-event list**, criticality is forced server-side, muting critical events is rejected (DB CHECK + service), email failure never fails the business op.
- **[V] The eBay payload builder is genuinely shared** between admin/internal and dropship paths (`EbayListingBuilder` + `EbayMarketplaceListingConnector`, single implementation, both call sites confirmed) — PR #785 delivered what it claimed.
- **[R] Shipping quote path fails closed everywhere** (missing package/box/zone/rate/policy data throws typed errors; no flat-fee or free-shipping fallback), quote snapshots are idempotent and the debit charges exactly the snapshot amount.

---

## 3. Findings that will bite the next dogfood phases (fix or work around first)

Ordered by where they hit in the test-plan sequence.

### 3.1 [V] P1 — Package-data split-brain: handoff step 3 writes a table the quote never reads
The Catalog > Variants package editor (PR #794/#796) writes `catalog.product_variants.weight_grams/length_mm/width_mm/height_mm` (`catalog.routes.ts:1362-1398`). Dropship cartonization/quoting reads **only** `dropship.dropship_package_profiles` (`dropship-basic-cartonization.provider.ts:72-79`); its sole writer is the dropship shipping-config admin UI (`dropship-shipping-config.repository.ts:262`). **No sync exists.** The listing-push "package profile" blocker also gates on the dropship table.

Consequence: `DROPSHIP-DOGFOOD-HANDOFF.md` step 3 ("enter weight/dims in Catalog > Variants Package Editor") has **zero effect** on dropship readiness, quoting, or listing push. EX-011's "confirm shipping/listing flows consume catalog variant package fields" — they don't. The design (§11 "Package data direction") says catalog variant fields are the operational source and forbids a competing source; the implementation is the opposite.

Near-term unblock: create/verify the `dropship_package_profiles` row for the test SKU via Dropship admin > Shipping config (per the 7/2 prod audit in `SHIPPING-ENGINE-DESIGN.md` there is exactly 1 row in prod — confirm it's the intended SKU). Real fix: read-through/sync to catalog variant fields, decided together with the shipping-engine convergence (see §5.5).

### 3.2 [V] P1 — Any eBay HTTP 400 tears down the store connection (listing push AND tracking push)
`isPermanentAuthFailureStatus(status)` returns true for **400**/401/403 in both `dropship-ebay-listing-push.provider.ts:428-430` and `dropship-ebay-tracking.provider.ts` [R for tracking instance]. On any such status, `recordAuthFailure` sets the connection `needs_reauth`, flips setup to `attention_required`, **NULLs the token refs and deletes the vault rows** (`dropship-marketplace-credentials.ts:237-262`).

eBay returns 400 for ordinary payload/validation problems — wrong category, missing item specifics, price format, publish preconditions, bad tracking format — which is exactly the most likely first-push failure class. One 400 = vendor must redo full eBay OAuth, remaining job items get blocked (`DROPSHIP_LISTING_STORE_BLOCKED`), a false "store needs reauthorization" critical notification fires, and intake/pushes pause. The Shopify providers correctly treat only 401/403 as auth failures.

Fix (small): remove 400 from the permanent-auth set in both eBay providers (400 stays auth-fatal only on the token-refresh endpoint where it means `invalid_grant`). Until fixed, expect that any first-push validation error will "disconnect" marzcards — have the reconnect flow ready and don't read it as an OAuth regression.

### 3.3 [V] P1 — eBay listings default to `draft_first`; a "successful" push may stage, not publish
`DROPSHIP_DEFAULT_LISTING_MODE = "draft_first"` applies to eBay too (`dropship-listing-config-service.ts:19`), and the provider maps anything non-`live` to `publishMode: "stage"` (`dropship-ebay-listing-push.provider.ts:105`). A staged push completes "successfully" with the listing row set `paused` and — important for LIST-05/06 evidence — `external_listing_id` holds the **offerId**, not an eBay listing ID (`:116-127`). Design §6 says eBay lists live after vendor approval.

Before the EX-015 push: set `listing_mode='live'` on the test store's `dropship_store_listing_configs` (or explicitly accept a staged offer as the test outcome and verify the offer in Seller Hub instead of a live listing). Also verify the six required eBay config keys (marketplaceId, categoryId, merchantLocationKey, payment/return/fulfillment policy IDs) — missing ones are preview blockers.

### 3.4 [V] P1 — Payment holds never expire while the worker runs (and ≥10 held intakes starve all new orders)
Chain, each link verified: the sweep's candidate query selects **unexpired `payment_hold`** intakes every cycle (`dropship-order-processing-runner.ts:115-132`); claiming flips status to `processing` (`dropship-order-processing.repository.ts:75-88`); the expiry-preservation guard only preserves `payment_hold_expires_at` when it still sees status `payment_hold` (`dropship-order-acceptance-service.ts:703-709`) — so the worker path recomputes a fresh now+48h expiry on every sweep (default 10s). Effects: the §10 hold-timeout → marketplace-cancellation path can never fire via the worker; the 2h expiring warning never sends; ~2 audit rows per held intake per sweep (audit bloat); and because candidates are `ORDER BY received_at ASC LIMIT 10`, ten simultaneous holds permanently starve newer `received` intakes. The vendor manual-accept path is unaffected (which is why unit tests missed it).

Fix (small): preserve the existing `payment_hold_expires_at` through the claim (pass it into the plan regardless of the post-claim status), and/or exclude unexpired holds from the sweep unless auto-reload state changed.

### 3.5 [V] P1 — eBay poll poison pill: one immutable-payload conflict wedges a store's entire intake
Replaying a **changed** payload against an accepted/cancelled/rejected intake throws `DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE` (`dropship-order-intake.repository.ts:158-170`). The eBay poll re-fetches accepted-but-unshipped orders whenever eBay bumps `lastmodifieddate`, and the per-store loop aborts on the first throw **without advancing the watermark** (`dropship-ebay-order-intake-poll-service.ts:91-112`) — so the same order is re-fetched and re-thrown every 5 minutes and every order behind it in the batch is never recorded. A buyer editing an address note mid-dogfood can freeze marzcards intake. Fix: catch per-order, record an exception/audit row, continue the loop, and advance the watermark.

### 3.6 [V] P0 (money class) — Cartonizer approves boxes on single-unit dimensions; quantity only bounded by weight [resolved in PR #909]
`boxFitsPackage` checks sorted single-unit dims vs box dims and weight-with-tare vs `max_weight_grams` (`domain/shipping-quote.ts:257-268`); `findCartonForUnits` multiplies **weight** by quantity but never re-checks volume/dims for quantity > 1 (`:194-215`). With `max_units_per_package` NULL and box `max_weight_grams` NULL, 50 units quote as one small box → systematic undercharge (vendor is charged the quote per §11; Card Shellz eats the label delta). The current unit test bakes this in (asserts 2 units in a 1-unit dim check).

Resolution, July 13: physical packing now uses standalone cartonizer v3.1 in `server/modules/cartonization`. It expands quantities into physical units, tests non-overlapping placement with all six rotations, records coordinates/orientation, and splits cartons on geometry or packed weight. Verified placements can persist on the WMS pack plan through explicit generation or opt-in shadow observation; WMS enforcement is intentionally deferred, so cartonization cannot block or change order status. Dropship is one adapter to the same core. A mandatory `max_units_per_package` guard is no longer used. NULL box `max_weight_grams` uses the automatic 22,679 g handling ceiling; a lower box-specific structural limit remains optional. Production verification still belongs in `SHIPCFG-03A`, `SHIPCFG-04`, and `SHIPCFG-08`, followed by measured shadow validation before a separate cutover review.

### 3.7 [V] P1 — "Accepted" ≠ reserved (known interim), and the safety nets have dropship blind spots
Acceptance **validates** availability but no longer reserves; the single reservation happens post-commit at WMS sync ("P0.1a" comment, `dropship-order-acceptance.repository.ts:266-277`; "P3.2 upgrades acceptance to await that reservation synchronously"). Consequences, verified/reported:
- Two orders can both be funded/debited for the last unit; the loser becomes a **debited vendor + `on_hold` WMS order** with no automatic credit path (rejection is blocked once `oms_order_id` exists) — manual recovery only. [R mechanics, V for the non-reserving acceptance]
- Crash between COMMIT and the WMS dispatch leaves an accepted+debited order with no WMS order; recovery relies on `backfillUnsynced`/reconciler sweeps whose dropship coverage is uncertain. [R]
- A reservation **error** (vs shortfall) is swallowed and the order proceeds unheld, relying on the ready-but-unreserved detector. [R]
- No dropship audit event or vendor notification exists for the post-acceptance shortfall path. [R]

Dogfood guidance: don't cross-list the same low-stock SKU on two stores during the test; script the manual recovery (admin `retry-wms-sync`, manual wallet credit) before Phase 8. Decide P3.2's priority before real vendors.

### 3.8 [R] P1 — Pending ACH that later fails is never voided
`payment_intent.processing` credits `pending_balance_cents`; `payment_intent.payment_failed` only logs/notifies — no code path sets a ledger row `failed`/`voided` (grep-confirmed absence of writers). Phantom pending balance persists forever; there is also no ledger-vs-aggregate reconciliation job despite §10 "ledger is authoritative". For dogfood Phase 8, fund with **card** (or accept the known issue if testing ACH).

### 3.9 [V] P1 — Tracking-push reconciliation is blind to dropship orders
The `WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED` sweep filters `c.provider IN ('ebay','shopify')` (`oms-flow-reconciliation.service.ts:377-404`) but the Dropship OMS channel's provider is `manual` (`dropship-oms-channel-config-service.ts:24-28`), and the sweep's success signal (`oms_order_events.tracking_pushed`) is never written by the dropship path (it writes `dropship_audit_events`). So if the ship-notify enqueue is ever missed, **no sweep or alert notices** the missing customer tracking. Related [R]: an `already_processing` race can close the retry row as success while the push row wedges in `processing` (manual admin retry is then the only recovery). For Phase 11: verify tracking in `dropship_audit_events` + the marketplace itself, not `oms_order_events`; add the dropship channel to the sweep (small fix: include `manual` provider for orders tagged dropship, and/or write `tracking_pushed` OMS events from the dropship path).

### 3.10 [R] P2 — Step-up challenge CHECK constraint omits `manage_catalog_selection`
The action exists in the domain list (`domain/auth.ts:18`) and the vendor catalog route requires proof for it (`dropship-vendor-catalog.routes.ts:34`), but the `dropship_sensitive_action_challenges.action` CHECK list omits it (**[V]** — schema:269 read directly). Email-MFA vendors (no passkey) get a check-constraint 500 when starting that challenge; passkey vendors are unaffected (session-stored challenges). The dogfood vendor should register a passkey, or fix the CHECK before catalog-selection testing.

---

## 4. Post-dogfood / pre-real-vendor gaps (design commitments not implemented)

- **[V] Vendor-facing ATP is raw global inventory, not Dropship-channel allocation.** `dropship-atp.provider.ts:14` → `InventoryAtpService.getBulkAtp` sums `inventory_levels` across **all warehouses** with no channel scoping (`atp.service.ts:536-562`). The §8 "shared Dropship allocation pool" doesn't exist; the channels allocation engine is never consulted; the only cap is the vendor's own per-variant override (with none set, marketplace quantity **is** full raw ATP — §8 explicitly forbids both). Note: a §18-named test ("rejects raw ATP leakage") exists but only validates DTO shapes on the unused use-case descriptor registry — it does not cover the wired provider. **[V]**
- **[V+R] No quantity sync on ATP change, no drift correction, no scheduled reconciliation.** Quantity leaves Echelon only inside a manually-created push job; post-reservation sync only notifies `channel_feeds` channels (dropship stores aren't channels). Every Echelon retail sale makes vendor listings staler; the resulting marketplace orders get rejected at acceptance → marketplace cancellations → vendor account defects. Drift columns/status exist in schema with **no writers**.
- **[V] No listing end/pause/zero operation exists at all.** The push provider interface has only `pushListing` (`dropship-marketplace-listing-push-provider.ts:25-27`). Membership lapse (§3) and disconnect-grace expiry (§4) never end or zero live listings; nothing even transitions `grace_period → disconnected` at `grace_ends_at`; `DROPSHIP_ENTITLEMENT_GRACE_HOURS = 72` is defined and never referenced; `membership_grace_ends_at` is hard-coded NULL on every write. [R for the lapse specifics] A lapsed vendor's live listings keep selling Card Shellz inventory indefinitely.
- **[R] Preview is not recomputed at push execution/retry** (§6 requires "computed fresh before every push job executes"). The worker re-checks eligibility + preview-hash only; admin retry re-pushes the frozen intent — a SKU hidden after job creation can still go live; stale price/qty on late retries.
- **[R] Multiwarehouse is not implemented** (§11 "required at launch"): quote/acceptance hard-require the store's single default warehouse; no fallback/selection. And the **fulfillment router ignores `oms_orders.warehouse_id`** — with a second warehouse, quote/debit/validation can use warehouse A while reservation/pick land in B (invisible today with one warehouse).
- **[R] Rate tables are append-only with cheapest-row-wins across all active tables** — a corrected (higher) rate table can never win against the old cheaper one, and there's no retire/archive operation. Region zone rules match by exact string vs inconsistent marketplace region formats ("NY" vs "NEW YORK") and fall through to broader rules on mismatch. Dunnage is hardcoded 0.
- **[R] Insurance pool: no credit path without an inspection** (design §12 explicitly wants lost/misdelivered/no-inspection carrier credits), no pool balance/accounting anywhere. RMA state transitions are unenforced (any status → any status; inspection runs regardless of current status). Return fees are free-typed per inspection — nothing hardcoded (good) but no fee schedule config either.
- **[R] Wallet `DebitWalletForOrder` use case is unwired** — production debit is a parallel inline implementation in the acceptance repo; the service+repo path exists only in tests. Two divergent implementations of the same money movement.
- **[R] Economics snapshot omits matched pricing-policy IDs/versions** (§16 "Pricing rule version used" — only a format version is stored).
- **[R] Session fixation** (no `req.session.regenerate()` on any login path) and a member/entitlement **enumeration oracle** (`/auth/email/status` returns eligible+credential types; rate-limited but precise). No account lockout (IP rate-limit only).
- **[R] Readiness gate has two always-green stubs**: `split_shipment_handoff` and `usdc_base_funding` return ready unconditionally. Env checks are presence-only (no live API connectivity probes).
- **[V] Design §3 vs reality: portal auth is standalone Echelon credentials** (bcrypt-12 passwords + WebAuthn passkeys + email MFA) keyed to Shellz Club member identity by email lookup — the design says "Echelon does not maintain standalone dropship vendor passwords." This is a decision point, not a bug (see Q1).

---

## 5. Decisions — recorded 2026-07-05 (owner)

1. **Auth model: keep standalone credentials.** Update design §3 to describe the built system (bcrypt passwords + passkeys + email MFA keyed to Shellz Club member identity by email). Hardening backlog stays open: session regeneration on login, account lockout, `manage_catalog_selection` CHECK fix, enumeration-oracle tightening.
2. **Allocation: plug dropship into the existing channel allocation engine.** Verified state: the `Dropship OMS` channel exists in `channels.channels` (id 103, active) but has **no warehouse assignments, no channel allocation rules**, and the dropship ATP provider calls raw `getBulkAtp` — it never consults the engine. Work: (a) dropship ATP provider consumes engine allocation for the Dropship channel (`getAllocatedQty` / `allocateProduct`); (b) assign warehouse 1 to channel 103; (c) create the channel-default allocation rule (mode/share/caps = admin lever §8 wanted); (d) hang dropship quantity re-sync off `allocateAndGetSyncTargets` — which also closes the "no quantity sync on ATP change" gap (§4). Target: **before first external vendor** (dogfood may proceed on raw ATP with narrow exposure).
3. **P3.2 synchronous reservation: before first external vendor.** Dogfood proceeds on the interim model with guardrails (no cross-listing last-unit SKUs; Phase-8 recovery runbook: admin retry-wms-sync + manual wallet credit).
4. **eBay listing mode: live at push.** Flip the marzcards store `listing_mode` to `live` before the EX-015 test (data change; prod value verified `draft_first` on 2026-07-05); change the code default for eBay stores to `live` (Shopify stays `draft_first`). Design §6 already says this — the code changes, not the doc.
5. **Package data: make dropship read the catalog now.** Small PR before listing/quote testing: the cartonization/quote path reads weight/dims from `catalog.product_variants` (the Catalog > Variants editor becomes the single entry point, matching design §11); `dropship_package_profiles` keeps only optional dropship-specific overrides such as ship-alone, default box, and carrier/service preferences. Cartonizer v3 derives capacity physically and ignores the legacy max-units field. Needs its own verification pass (unit tests + SHIPCFG-04/08 manual quote validation). Handoff step 3 becomes correct as originally written once this lands.
6. **USDC on Base: planned optional rail, not a launch or activation requirement.** Card + ACH are the required launch rails. Preserve the existing USDC funding-method and ledger foundations, update design §10, and replace the always-green `usdc_base_funding` readiness stub with an honest not-applicable status until provider-backed verification is configured.
7. **Lapse/disconnect cleanup: build during dogfood.** Implement the listing end/zero-quantity provider operation (eBay + Shopify), the grace-expiry worker (`grace_period → disconnected`), and lapse → zero-quantity push; add a lapse-simulation phase to the dogfood checklist (pause the `.ops` subscription → listings zero → restore → listings resume).
8. **Split shipments** (not explicitly decided this round): Phase 12 stays conditional; the always-green `split_shipment_handoff` readiness stub should be fixed regardless so the gate reflects reality.

---

## 6. Test-plan and handoff corrections

- **Handoff step 3 is wrong as written until Decision 5 ships** (§3.1): today, package data for the test SKU must exist in `dropship.dropship_package_profiles` (Dropship admin > Shipping config), not (only) Catalog > Variants. Decision 5 makes dropship read catalog variant fields, after which the handoff instruction becomes correct as written. Update EX-011/EX-014 to point at that PR.
- **EX-013 cites PR #737 as landed — it is still OPEN** (verified via GitHub). Re-verify the vendor-catalog filter behavior against what actually merged (#735 only), or merge #737 first.
- Add pre-flight rows to "Hard Stop Rules": deploy pipeline green (no migration collision — PR #837); `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` present; `TRUST_PROXY=true` set; test store `listing_mode='live'` (or staged-offer expectation documented); all six eBay marketplace-config keys present; canonical SKU weight/dimensions and box inner dimensions/tare verified (cartonizer v3, §3.6); dogfood vendor has a **passkey** registered (§3.10).
- Phase 7 addition: after acceptance, mutate the order on eBay (e.g., buyer note) and confirm the poll does **not** wedge (poison pill §3.5) — or at least document the failure signature (`DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE` + `storesFailed` in worker logs, watermark stuck).
- Phase 8 additions: confirm `payment_hold_expires_at` is **not** being re-armed each sweep (§3.4); fund by card for the first pass (§3.8); WALLET-06 idempotency check should include a worker+manual double-accept race (expect idempotent replay, but also expect a false "processing failed" vendor email — known [R] quirk).
- Phase 11 correction: tracking evidence lives in `dropship_audit_events` (+ the marketplace itself), **not** `oms_order_events`; the flow-reconciliation sweep will not catch missed dropship pushes (§3.9). TRACK-07's "retry path" = webhook_retry_queue backoff (5 attempts → DLQ) + admin tracking-push ops retry; Shopify GraphQL THROTTLED marks pushes failed/non-retryable [R] — retry via admin ops if hit.
- Phase 14: lost-package/carrier-fault credit without inspection (RETURN-07) is **unimplementable today** (§4 insurance) — mark it expected-fail or descope.
- §18 tests to write first (currently missing): behavioral atomic-rollback tests for wallet-debit failure; worker-path payment-hold expiry (would have caught §3.4); concurrent last-unit acceptance; pg-level quote provider tests (zone/rate SQL is untested); return repository tests (credit/fee math, insufficient funds); eBay-400 handling (would have caught §3.2); poison-pill isolation in the poll loop.
- CI: `dropship-schema.integration.test.ts` (where all §16 constraint proofs live) does not run in CI — add a PG service job, or at minimum run it locally before each dogfood session.
- Process guard: add a CI check for duplicate migration prefixes (today's collision was detectable at PR time).

## 7. Sequence to resume dogfood (updated for the recorded decisions)

1. ~~Merge PR #837~~ Deploys are green again (v2290+); confirm prod == main before each session.
2. `heroku config:set TRUST_PROXY=true`; keep `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true`.
3. Land the pre-push fix batch (small PRs):
   - eBay 400 ≠ permanent auth failure — listing-push AND tracking providers (§3.2).
   - Payment-hold expiry preserved through worker claim (§3.4).
   - eBay poll poison-pill isolation — per-order catch + watermark advance (§3.5).
   - eBay default listing mode → `live` (Decision 4) + flip marzcards store config to `live`.
   - Dropship quote/cartonization reads `catalog.product_variants` weight/dims (Decision 5), with its own test pass.
4. Update handoff/test plan per §6 (pre-flight rows; EX-011/EX-013/EX-014 statuses; Phase 7/8/11/14 amendments).
5. Resume at Phase 3/4: readiness gate evidence → package data for the test SKU via Catalog > Variants (post-Decision-5) → narrow variant exposure → portal shows only that SKU → one-SKU push (EX-015) → verify the LIVE eBay listing ID + Echelon mapping on eBay itself → one small order.
6. During dogfood (Decision 7): build listing end/zero + grace-expiry worker + lapse→zero push; add the lapse-simulation phase.
7. Before first external vendor (Decisions 2, 3): allocation-engine wiring for channel 103 (+ quantity re-sync via `allocateAndGetSyncTargets`) and P3.2 synchronous reservation; auth hardening batch (Decision 1 backlog); honest readiness checks for `usdc_base_funding` (per Decision 6) and `split_shipment_handoff`.

---

## 8. Product/UX review — the vendor experience (added 2026-07-05)

Method: all 10 portal pages (`client/src/pages/dropship/`) plus the vendor-facing DTO surface were read — Onboarding/Catalog/Dashboard directly, the rest via a full sweep — and every headline claim below was re-verified at the cited line. Same [V]/[R] tags.

### 8.1 Overall opinion

The plumbing is enterprise-grade; the portal is an **ops console wearing vendor clothes**. Visual quality is genuinely good (consistent shadcn, light/professional, `#C060E0` accents, skeletons/empty states everywhere), and the onboarding checklist + launch-gate pattern is the right shape. But the product never answers the only question a reseller has — **"am I making money?"** — and it routinely speaks Echelon ("intake", "OMS order", token Present/Missing, idempotency key + request hash in the Returns detail [V] Returns.tsx:819-824) instead of seller.

Important framing [V]: in normal operation orders **auto-accept via the 10s worker** — the vendor's money moves without a click. That is the right model for dropship (speed wins), but it raises the bar: economics must be visible *before* the sale (at pricing time) and legible *after* it (per-order P&L), because there is no confirm moment in between.

### 8.2 The structural gap: economics are invisible [V]

Verified end-to-end: the catalog row DTO carries no wholesale, no suggested retail, no default price, no image (dropship-ops-surface.ts:1413-1425); the catalog table shows name/SKU/category/qty and a price input whose placeholder is "Default" without showing the default (DropshipPortalCatalog.tsx:1136-1171); the preview shows qty/price/status but no cost or margin; "suggested retail" (design §7) has **zero implementation anywhere**; the first time a vendor ever sees their wholesale cost is the order detail **after the debit** (DropshipPortalOrders.tsx:499). The order list has no money column; profit is never computed even though retail totals and total debit sit on the same detail screen; `feesCents` is in the DTO but never rendered.

For a margin business, this is the #1 product gap — ahead of any bug in §3.

### 8.3 Ranked vendor-experience fixes

**Big rocks (make-or-break for external vendors):**

1. **Margin-first everywhere** — wholesale cost, suggested retail, and computed margin %/$ in the catalog table and listing preview; estimated shipping at pricing time (the internal quote API exists); per-order P&L line (retail − wholesale − shipping − fees = profit) on order detail and list; profit summary on the dashboard. Requires exposing wholesale to the vendor surface plus a suggested-retail source (design §7 already names the model).
2. **Close the payment-hold loop** [V]: holds show an expiry but no screen links a held order to funding — Wallet doesn't show open holds, order detail has no "Fund wallet" CTA, notifications carry no links, and the Stripe return params (`?wallet_funding=...`) are ignored by the Wallet page, so even a successful top-up gets no confirmation. Build: open-holds banner on Wallet + "Fund now" CTA on held orders + Stripe-return success/failure banner + auto-retry messaging.
3. **My Listings page** [V]: vendors cannot see what is live — the only vendor listing endpoints are preview/push (dropship-listing.routes.ts:15,29). A Listings page (status, price, qty, failures, end/pause actions) pairs naturally with Decision 7's listing end/zero work and the future drift/quantity-sync work; without it, drift and stale quantity are invisible to the person they hurt.
4. **Make the machine invisible** — a vendor-language pass over statuses/blockers/notifications (error-code → plain-language dictionary); remove idempotency key/request hash/token internals from vendor screens; notification deep links + an unread badge in the shell (today the chrome is silent even during a store outage [V] — Shell.tsx has no badge or attention surface); **passkey enrollment UI** (`registerPasskey` exists in the auth lib with zero callers [V] — vendors are stuck doing email-OTP step-up for every sensitive action, including single notification-preference toggles [V] dropship-notification.routes.ts:48).
5. **Marketplace-readiness hand-holding** [R]: zero in-portal guidance for eBay business policies/category prerequisites — the highest-friction step of reseller onboarding happens entirely off-portal, and push failures give no remediation. Build a guided eBay setup step that pulls the seller's policies via the Account API into dropdowns (the internal admin already has policy UI to borrow from), with listing-push failures mapping to "fix it here" links.

**Quick wins (days, not weeks):**

- Pre-accept confirm dialog with the quoted debit breakdown on the *manual* Accept path [V] (accept currently posts blind; the amount appears only in the post-hoc success message, Orders.tsx:136-164).
- Running-balance column in the wallet ledger — the data is already in the DTO and design §14 requires it [V] (only Type/Status/Amount/Created render today).
- Pagination on Orders/Returns/ledger/alerts (all hardcoded page 1 / limit 50 while displaying a larger total [V] Orders.tsx:113-118).
- Auto-generate RMA numbers; label RMA item rows with product title/SKU instead of "Variant 3021"; render inspection photos instead of a count [R].
- Order-list money column; carrier-linked tracking numbers; alerts badge; drop the permanently-disabled SMS/webhook toggles; fix the literal backticks on the login page [R].
- Relax step-up scope: money actions keep 10-minute proofs; catalog selection and notification preferences get session-long proofs (or none).
- **Remove the USDC activation gate** [V] (`walletReady` requires a USDC funding method — dropship-vendor-provisioning-service.ts:303-305) as part of Decision 6, or no vendor activates without a crypto wallet.

### 8.4 What the design doc itself should add (gaps in what was specced, not just what was built)

1. **Pricing intelligence**: suggested retail (source + admin control), margin display rules, bulk pricing tools (CSV price import, cost-plus-percent rules). §7 names the four-price model; nothing specs where suggested retail comes from or how vendors use it.
2. **Listings management** as a first-class portal page (§14 omits it) — including how drift, stale quantity, failures, and end/pause surface to the vendor.
3. **Operating dashboard**: §14 lists "top SKUs" but the built dashboard is launch-checklist-only [V]; spec the post-launch state (sales, profit, sell-through, attention feed) and when the portal switches modes. Minimal profit reporting should be launch scope, not Phase-2 "analytics" — it is the product's pitch.
4. **Notification contract**: every vendor notification should carry an entity deep link (the DTO has no entity/URL fields [R] dropship-ops-surface.ts:2092-2103); critical events should also drive a persistent "needs attention" surface in the chrome.
5. **Vendor-facing error dictionary**: one table mapping every vendor-visible blocker/rejection/failure code to plain language + next step; make it a build requirement alongside §18 tests.
6. **Account self-service**: Settings today is a status page — no business-name/contact/password/passkey management despite the backend actions existing [R]; the return/contact display section has no editor.
7. **Support surface**: no help link, docs, or contact anywhere in the portal chrome [V]. Even a mailto + FAQ changes the feel for a paying vendor.

### 8.5 Sequencing

Nothing here blocks the dogfood order test. Suggested batches — **Batch A (pre-external-vendor, pairs with §7):** USDC gate removal, hold→fund loop, manual-accept confirm, pagination, passkey enrollment, language pass, alerts badge. **Batch B (vendor beta gate):** margin-first surfaces, My Listings, guided eBay setup, operating dashboard v1, RMA usability. Batch B is what turns ".ops works" into ".ops sells itself."
