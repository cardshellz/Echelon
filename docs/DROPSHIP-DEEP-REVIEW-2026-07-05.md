# Dropship Deep Review — 2026-07-05

Scope: `DROPSHIP-V2-CONSOLIDATED-DESIGN.md` vs the implemented dropship module (~74k LOC under `server/modules/dropship`, `shared/schema/dropship.schema.ts`, plus the OMS/WMS/inventory/channels seams it calls), the dogfood test plan, and live production state on Heroku (`cardshellz-echelon`).

Method: seven parallel subsystem reviews (money core; ATP/inventory/OMS channel; listing pipeline; shipping; auth/entitlement/security; fulfillment/tracking/returns/notifications; wiring/workers/migrations/tests), followed by direct verification of every P0/P1 mechanism cited below.

Evidence tags: **[V]** = verified directly in code/config during this review. **[R]** = reported by a subsystem review pass with file:line citations, pattern spot-checked but not fully re-read.

---

## 1. Live production state (checked 2026-07-05)

- **[V] Production deploys are failing.** Releases v2286–v2289 all failed the release phase: `Migration prefix collision: 119_outbound_shipment_tracking_dedup.sql and 119_shipping_zone_seed.sql`. Production is pinned at v2285 = `5d748a4f`, 12+ commits behind main. Fix: **PR #837** renames the never-applied `119_outbound_shipment_tracking_dedup.sql` (PR #831) to `120_` (the `119_shipping_zone_seed.sql` from the PR #825 stack already ran in prod). Until merged, no hotfix can ship.
- **[V] The running release v2285 already contains every dropship change the test plan cares about**: PR #796 package editor (`214c10ac`), shared eBay builder (`f1b2dbee`), retail-cache pricing (`f7b2f741`), connector refactor (`5b058adb`), P0.1 single-writer reservations (`20066ad1`). What prod is missing is the shipping-engine stack (#825/#826) and P0.4 SHIP_NOTIFY dedup (#831) — the latter matters for Phase 10's duplicate-shipment checks.
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

### 3.6 [V] P0 (money class) — Cartonizer approves boxes on single-unit dimensions; quantity only bounded by weight
`boxFitsPackage` checks sorted single-unit dims vs box dims and weight-with-tare vs `max_weight_grams` (`domain/shipping-quote.ts:257-268`); `findCartonForUnits` multiplies **weight** by quantity but never re-checks volume/dims for quantity > 1 (`:194-215`). With `max_units_per_package` NULL and box `max_weight_grams` NULL, 50 units quote as one small box → systematic undercharge (vendor is charged the quote per §11; Card Shellz eats the label delta). The current unit test bakes this in (asserts 2 units in a 1-unit dim check).

Not a blocker for a 1-unit dogfood order. Operational guard available today: set `max_weight_grams` on every box and `max_units_per_package` on every profile. Real fix lands with cartonizer v2 (shipping-engine, EX-009).

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

## 5. Decisions needed (design doc vs code — pick a side, update the loser)

1. **Auth model**: keep standalone credentials (then update design §3 and accept password-reset/MFA/lockout hardening as roadmap) or build Shellz Club SSO before external vendors?
2. **Allocation pool**: is raw-global-ATP + per-variant vendor caps acceptable through early launch (accepting structural oversell vs your own channels), or is the §8 Dropship allocation pool + **admin** caps a pre-vendor-launch requirement?
3. **P3.2 synchronous reservation**: schedule before real vendors? (Design §9's "accepted means reserved" is currently false; §18's two rollback tests are unwritable until then.)
4. **eBay listing mode**: design says live-after-approval; code defaults `draft_first` everywhere. Which is intended? (If live: flip the eBay default; if draft-first: update design §6 and the LIST phase evidence expectations.)
5. **Shipping stack convergence**: `SHIPPING-ENGINE-DESIGN.md` (2026-07-02) already decided "dropship keeps its stack short-term; converges on shared tables later" — EX-009/EX-010/EX-012 are really that decision. Set the convergence milestone, and decide the package-data source *now* (§3.1): sync `dropship_package_profiles` from catalog variants, or point dropship reads at catalog variant fields.
6. **USDC on Base**: design §10 says launch-blocking; the readiness check is a stub. Confirm actual scope for launch (schema/tables exist; end-to-end state unproven).
7. **Split shipments**: in dogfood scope or not (Phase 12 "if in scope")? The readiness stub always says ready, so this is a real scope decision, not a checklist artifact.
8. **First real (non-dogfood) vendor timing**: §4 items (stale quantity, no lapse/disconnect cleanup, no drift) are tolerable for an internal dogfood store and clearly not for external vendors — the answer sequences the §4 backlog.

---

## 6. Test-plan and handoff corrections

- **Handoff step 3 is wrong as written** (§3.1): package data for the test SKU must exist in `dropship.dropship_package_profiles` (Dropship admin > Shipping config), not (only) Catalog > Variants. Update EX-011/EX-014 from "Fixed / verify" to open decision.
- **EX-013 cites PR #737 as landed — it is still OPEN** (verified via GitHub). Re-verify the vendor-catalog filter behavior against what actually merged (#735 only), or merge #737 first.
- Add pre-flight rows to "Hard Stop Rules": deploy pipeline green (no migration collision — PR #837); `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` present; `TRUST_PROXY=true` set; test store `listing_mode='live'` (or staged-offer expectation documented); all six eBay marketplace-config keys present; box `max_weight_grams` and profile `max_units_per_package` set (cartonizer guard, §3.6); dogfood vendor has a **passkey** registered (§3.10).
- Phase 7 addition: after acceptance, mutate the order on eBay (e.g., buyer note) and confirm the poll does **not** wedge (poison pill §3.5) — or at least document the failure signature (`DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE` + `storesFailed` in worker logs, watermark stuck).
- Phase 8 additions: confirm `payment_hold_expires_at` is **not** being re-armed each sweep (§3.4); fund by card for the first pass (§3.8); WALLET-06 idempotency check should include a worker+manual double-accept race (expect idempotent replay, but also expect a false "processing failed" vendor email — known [R] quirk).
- Phase 11 correction: tracking evidence lives in `dropship_audit_events` (+ the marketplace itself), **not** `oms_order_events`; the flow-reconciliation sweep will not catch missed dropship pushes (§3.9). TRACK-07's "retry path" = webhook_retry_queue backoff (5 attempts → DLQ) + admin tracking-push ops retry; Shopify GraphQL THROTTLED marks pushes failed/non-retryable [R] — retry via admin ops if hit.
- Phase 14: lost-package/carrier-fault credit without inspection (RETURN-07) is **unimplementable today** (§4 insurance) — mark it expected-fail or descope.
- §18 tests to write first (currently missing): behavioral atomic-rollback tests for wallet-debit failure; worker-path payment-hold expiry (would have caught §3.4); concurrent last-unit acceptance; pg-level quote provider tests (zone/rate SQL is untested); return repository tests (credit/fee math, insufficient funds); eBay-400 handling (would have caught §3.2); poison-pill isolation in the poll loop.
- CI: `dropship-schema.integration.test.ts` (where all §16 constraint proofs live) does not run in CI — add a PG service job, or at minimum run it locally before each dogfood session.
- Process guard: add a CI check for duplicate migration prefixes (today's collision was detectable at PR time).

## 7. Suggested sequence to resume dogfood

1. Merge **PR #837**, deploy, confirm release phase green and prod == main.
2. `heroku config:set TRUST_PROXY=true`; keep `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true`.
3. Land the two small pre-push fixes: eBay-400 ≠ auth failure (both providers, §3.2) and payment-hold expiry preservation (§3.4). Optionally the poll poison-pill isolation (§3.5) — small and de-risks Phase 7.
4. Update handoff/test plan per §6 (especially step 3 → dropship package profiles).
5. Resume at Phase 3/4 exactly as the handoff prescribes: readiness gate evidence → package profile for the test SKU → narrow variant exposure → portal shows only that SKU → set `listing_mode='live'` → one-SKU push (EX-015) → verify external listing ID + Echelon mapping on eBay itself → one small order.
