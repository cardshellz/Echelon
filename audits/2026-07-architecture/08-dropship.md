# Audit 08 — DROPSHIP Subsystem (Echelon)

Scope: `server/modules/dropship/**` (~50k LOC: 49,809 in module per `wc -l`, +1,460 in `shared/schema/dropship.schema.ts`), design docs, cross-module references.
Method: static trace with file:line evidence. Claims not directly grounded are labeled **HYPOTHESIS** or **INSUFFICIENT EVIDENCE**. No files were modified; no tests or servers were run.

---

## 1. SUBSYSTEM MAP

Layering follows the CLAUDE.md contract cleanly — `domain/` (9 files, pure rules), `application/` (~45 service/DTO files), `infrastructure/` (~70 repos/providers/factories), `interfaces/http/` (23 route files), `__tests__/` (69 test files).

**Functional clusters:**

| Cluster | Key files | Owns (dropship.* tables) |
|---|---|---|
| Auth/identity | `application/dropship-auth-service.ts`, `infrastructure/dropship-auth.repository.ts`, `simple-webauthn-passkey.provider.ts`, `dropship-password-hasher.ts` | `dropship_auth_identities`, `dropship_passkey_credentials`, `dropship_sensitive_action_challenges` |
| Entitlement | `infrastructure/shellz-club-entitlement.adapter.ts` | reads `membership.members/plans/member_subscriptions` (adapter.ts:41-46, 96) |
| Store connections / OAuth | `application/dropship-store-connection-service.ts`, `infrastructure/dropship-oauth-state-signer.ts`, `dropship-token-cipher.ts`, `dropship-marketplace-oauth.providers.ts`, `dropship-store-webhook-repair.*` | `dropship_store_connections`, `dropship_store_connection_tokens`, `dropship_store_setup_checks`, `dropship_setup_blockers` |
| Catalog exposure & selection | `application/dropship-catalog-exposure-service.ts`, `dropship-selection-atp-service.ts`, `infrastructure/dropship-atp.provider.ts` | `dropship_catalog_rules(+revisions)`, `dropship_vendor_selection_rules(+revisions)`, `dropship_vendor_variant_overrides`, `dropship_pricing_policies` |
| Listings & push jobs | `application/dropship-listing-preview-service.ts`, `dropship-listing-push-worker-service.ts`, `infrastructure/dropship-listing-push-job-runner.ts`, `dropship-ebay-listing-push.provider.ts`, `dropship-shopify-listing-push.provider.ts` | `dropship_vendor_listings`, `dropship_listing_push_jobs(+items)`, `dropship_listing_sync_events` |
| Wallet & funding | `application/dropship-wallet-service.ts` (1,289 LOC), `infrastructure/dropship-wallet.repository.ts` (1,794 LOC), `dropship-stripe-funding.provider.ts` | `dropship_wallet_accounts`, `dropship_wallet_ledger`, `dropship_funding_methods`, `dropship_auto_reload_settings`, `dropship_usdc_ledger_entries` |
| Shipping quotes | `application/dropship-shipping-quote-service.ts`, `dropship-cartonization-provider.ts`, `infrastructure/dropship-basic-cartonization.provider.ts`, `dropship-cached-rate-table.provider.ts` | `dropship_package_profiles`, `dropship_box_catalog`, `dropship_rate_tables(+rows)`, `dropship_zone_rules`, `dropship_shipping_quote_snapshots`, `dropship_insurance_pool_config`, `dropship_shipping_markup_config` |
| **Order intake → acceptance** | `dropship-marketplace-order-intake.routes.ts` (Shopify webhooks), `dropship-ebay-order-intake-poll-service.ts` + runner (eBay polling), `dropship-order-intake-service.ts`, `dropship-order-processing-service.ts` + runner, `dropship-order-acceptance-service.ts`, `infrastructure/dropship-order-acceptance.repository.ts` (1,345 LOC — the financial core) | `dropship_order_intake`, `dropship_order_economics_snapshots` — **plus direct writes to `oms.*` and `inventory.*` (see §4)** |
| Rejection / cancellation / payment holds | `dropship-order-rejection-service.ts`, `dropship-order-cancellation-service.ts` + repo, `dropship-payment-hold-expiration-service.ts` + repo, `dropship-*-order-cancellation.provider.ts` (eBay/Shopify) | `dropship_order_intake.cancellation_status` |
| Tracking write-back | `application/dropship-marketplace-tracking-service.ts`, `infrastructure/dropship-marketplace-tracking.repository.ts`, `dropship-ebay-tracking.provider.ts`, `dropship-shopify-tracking.provider.ts` | `dropship_marketplace_tracking_pushes` |
| Returns/RMA | `application/dropship-return-service.ts`, `infrastructure/dropship-return.repository.ts` (1,574 LOC) | `dropship_rmas(+items,+inspections,+status_updates)`, `dropship_return_policy_config`, `dropship_carrier_claims` |
| Notifications | `dropship-notification-service.ts`, `dropship-notification-dispatch.ts`, `dropship-notification-email.sender.ts` | `dropship_notification_events`, `dropship_notification_preferences` |
| Admin/ops surfaces | 9 `dropship-admin-*.routes.ts`, `dropship-ops-surface-service.ts` (1,564 LOC) + repo (1,890 LOC), `dropship-worker-ops-*` | `dropship_audit_events`, `dropship_admin_config_commands` |
| OMS channel config | `dropship-oms-channel-config.repository.ts` | **writes `channels.channels` + `channels.channel_connections` directly** (see §4) |

**Background workers** (started in `server/index.ts:805-807`, behind `schedulersDisabled()`): listing push worker, order processing worker (10s interval, `dropship-order-processing-runner.ts:59`), eBay order intake poller (5min, `dropship-ebay-order-intake-runner.ts:5`).

**Wiring into shared rails:** `server/index.ts:499` — `setDropshipFulfillmentSync(services.wmsSync)` injects the standard OMS→WMS sync into a dropship registry (`infrastructure/dropship-fulfillment-sync.registry.ts`). Reverse direction: `server/modules/oms/fulfillment-push.service.ts:398-400` dynamically imports the dropship tracking factory.

**Factory pattern:** 27 `*.factory.ts` files, all identical shape — a `createXFromEnv()` that news up a Pg repository + dependent services (e.g. `dropship-order-processing.factory.ts:14-26`). There is no shared composition root; each factory recursively re-instantiates its dependencies (`createDropshipOrderProcessingServiceFromEnv` builds fresh quote/wallet/notification services each call). This is *consistent* but heavy boilerplate, not accidental complexity per se — see §7.

**Dead scaffolding:** `application/dropship-use-cases.ts` (600 LOC, `DROPSHIP_REQUIRED_USE_CASE_NAMES` registry of 17 use-cases) is exported only via `application/index.ts` and referenced by nothing in routes/workers (grep over `server/` excluding tests returned zero call-sites). Production paths use the per-concern services instead. This is the abandoned "clean use-case layer skeleton" from the V2 build sequence step 2.

---

## 2. ORDER-PATH TRACE (end-to-end, one partner order)

### Stage A — Marketplace event → intake row
- **Shopify (webhook):** `POST /api/dropship/webhooks/shopify/orders/{paid,create}` (`dropship-marketplace-order-intake.routes.ts:44-62`). HMAC verified against secrets before anything else (routes:97-105 → `dropship-shopify-webhook-security.ts`); 503 if no secret configured, 401 on bad signature, 202 "ignored" for unpaid/test/unmatched-store, 200 only after the intake row is persisted (routes:134-148). Store resolved by shop domain (`dropship-order-intake-source.repository.ts` via routes:124).
- **eBay (polling):** worker (`dropship-ebay-order-intake-runner.ts`, 5-min default) → `dropship-ebay-order-intake-poll-service.ts` → `EbayDropshipOrderIntakeProvider.fetchOrders` (`dropship-ebay-order-intake.provider.ts:55-80`) using per-vendor OAuth tokens from `dropship_store_connection_tokens` (AES-GCM via `dropship-token-cipher.ts`), mapped by `dropship-ebay-order-intake.mapper.ts`.
- Both funnel into `DropshipOrderIntakeService.recordMarketplaceOrder` (`dropship-order-intake-service.ts:153-191`): Zod-validates the normalized payload (strict schemas, integer cents — lines 22-71), checks store context/platform match, computes payload hash, then `recordMarketplaceIntake`.
- **Persistence:** `dropship.dropship_order_intake` (`dropship-order-intake.repository.ts:230-257`). Idempotency = unique index `(store_connection_id, external_order_id)` (`shared/schema/dropship.schema.ts:975`) + `SELECT ... FOR UPDATE` pre-check (repo:198-220) + 23505 race fallback that replays (repo:120-140, 525). Same payload hash → `replayed`; changed payload on an immutable status (accepted/cancelled) → `DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE` (repo:150-170). Channel id resolved by config/env, not hardcoded (repo:313-319, `resolveDropshipOmsChannelIdWithClient`).

### Stage B — Processing worker → quote → acceptance
- Order processing worker sweeps `status IN ('received','retrying')` (`dropship-order-processing-runner.ts:122`) and reclaims stale `processing` rows via `FOR UPDATE SKIP LOCKED` (runner:79-83). Claim = guarded `UPDATE ... SET status='processing'` (`dropship-order-processing.repository.ts:77`).
- `DropshipOrderProcessingService.processIntake` (`dropship-order-processing-service.ts:137-`) resolves quote items, calls `shippingQuote.quote(...)` (snapshot into `dropship_shipping_quote_snapshots`), optionally `walletAutoReload.handleAutoReload`, then `orderAcceptance.acceptOrder` (processing-service:178).
- A vendor can also accept manually: `POST` route → `dropship-order.routes.ts:69` → `DropshipOrderAcceptanceWorkflowService.acceptOrderForMember` (`dropship-order-acceptance-workflow-service.ts:65-95`) → the same acceptance service. Routes are thin (validate + delegate) — compliant with CLAUDE.md §2.

### Stage C — Atomic acceptance (the financial transaction)
`PgDropshipOrderAcceptanceRepository.acceptOrder` — one `BEGIN...COMMIT` (`dropship-order-acceptance.repository.ts:153-166`), all steps on one `PoolClient`:
1. Lock intake `FOR UPDATE` (repo:319-337). If already `accepted` → idempotent replay with quote-snapshot + request-hash conflict detection (repo:339-388).
2. Lock vendor + store `FOR UPDATE OF v, sc`, joining `membership.plans` and `channels.partner_profiles` for the wholesale discount (repo:398-423).
3. Load quote snapshot (repo:447-487); resolve order lines to vendor-owned listings joined to `catalog.product_variants/products/product_line_products` (repo:510-553).
4. **Lock raw inventory**: `SELECT ... FROM inventory.inventory_levels ... FOR UPDATE` filtered to the quote's warehouse (repo:610-632); availability re-derived as `variant_qty - reserved_qty - picked_qty - packed_qty` (repo:1275-1277).
5. Pure planning in the application layer: `buildDropshipOrderAcceptancePlan` (`dropship-order-acceptance-service.ts:255-349`) — status/entitlement/store gates, ship-to completeness, quote↔order destination & item match, pricing-policy gate, inventory sufficiency, wallet currency; wholesale = catalog retail − integer-percent discount (service:351-364); `totalDebit = wholesale + shipping (+ fees=0)`. Insufficient funds → `payment_hold` outcome with expiry (service:288-292), persisted on the intake (repo:686-720).
6. On accepted: **direct `INSERT INTO oms.oms_orders`** with `status='confirmed', financial_status='paid'`, external key `dropship:{storeConnectionId}:{externalOrderId}`, `ON CONFLICT (channel_id, external_order_id) DO NOTHING` (conflict → structured error) (repo:722-804); **`INSERT INTO oms.oms_order_lines`** priced at wholesale cents (repo:806-843); **raw `UPDATE inventory.inventory_levels SET reserved_qty = reserved_qty + $1`** per bin + **`INSERT INTO inventory.inventory_transactions`** (`transaction_type='reserve'`, `reference_type='dropship_order_intake'`) (repo:845-918); wallet debit with balance guard + ledger row (`type='order_debit'`, unique `(reference_type='order_intake', reference_id=intakeId)` per schema:780-782, idempotency key `order:{intakeId}:{sha256(submittedKey)}` repo:1301-1304) (repo:921-1003); economics snapshot (repo:1006-1048); intake → `accepted` with `oms_order_id` (repo:1050-1069); audit event (repo:1071-1104).

**Tables written in Stage C:** `oms.oms_orders`, `oms.oms_order_lines`, `oms.oms_order_events` (×2), `inventory.inventory_levels`, `inventory.inventory_transactions`, `dropship.dropship_wallet_accounts`, `dropship.dropship_wallet_ledger`, `dropship.dropship_order_economics_snapshots`, `dropship.dropship_order_intake`, `dropship.dropship_audit_events`.

### Stage D — OMS → WMS (shared rails)
- After commit, `syncDropshipAcceptedOrderToWmsSafely` (`dropship-fulfillment-sync-dispatch.ts:16-101`) calls `fulfillmentSync.syncOmsOrderToWms(omsOrderId)` — which is the **standard** `services.wmsSync` (`server/index.ts:499`). Failures enqueue into the shared OMS webhook-retry queue (`dropship-fulfillment-sync-retry-queue.ts`; ops-surface reads `oms.webhook_retry_queue` at `dropship-ops-surface.repository.ts:517`).
- `wms-sync.service.ts:123-` creates `wms.orders` + `wms.order_items` (financial snapshot validated, wms-sync:224-331), creates `wms.outbound_shipments(+items)` (wms-sync:539-546), **reserves inventory via `reservation.reserveOrder(wmsOrderId)`** because the order is `financial_status='paid'` → `warehouseStatus='ready'` (wms-sync:678-684, reserve at wms-sync:568-580), and pushes to the shipping engine (wms-sync:616-629).

### Stage E — Shipment → tracking back to the partner store
- Shipment/tracking truth lands on `wms.outbound_shipments` via the engine (out of dropship scope). `oms/fulfillment-push.service.ts` detects a dropship order by sniffing `oms_orders.raw_payload.dropship` or the `"dropship"` tag (fulfillment-push:272-278) and routes to `DropshipMarketplaceTrackingService.pushForOmsOrder` (fulfillment-push:403-438; wired via dynamic import at 398-400 or `setDropshipMarketplaceTrackingService`).
- The tracking service claims/creates a `dropship_marketplace_tracking_pushes` row (unique `idempotency_key`, schema:1008; `ON CONFLICT DO NOTHING` at `dropship-marketplace-tracking.repository.ts:377`), correlates OMS order → intake via `dropship_order_intake.oms_order_id` (tracking repo:275-287), builds line items by joining `wms.outbound_shipment_items → wms.order_items → oms.oms_order_lines` (tracking repo:301-319), then pushes via the platform provider (`dropship-shopify-tracking.provider.ts` fulfillment API / `dropship-ebay-tracking.provider.ts`), recording attempts/failures with retryable classification (tracking repo:230-270). Admin retry surface: `dropship-tracking-push-ops-*`.

**Full table list on the happy path:** `dropship_order_intake` → `dropship_shipping_quote_snapshots` → (`dropship_wallet_accounts`, `dropship_wallet_ledger`) → `oms.oms_orders`, `oms.oms_order_lines`, `oms.oms_order_events` → `inventory.inventory_levels`, `inventory.inventory_transactions` → `dropship_order_economics_snapshots` → `dropship_audit_events` → `wms.orders`, `wms.order_items`, `wms.outbound_shipments`, `wms.outbound_shipment_items` (+ second `inventory.*` write via reserveForOrder) → `dropship_marketplace_tracking_pushes` → partner store.

### Answer to the central question
**It is neither a clean channel adapter nor a fully parallel pipeline — it is a hybrid that forks exactly at the two financially critical writes.** The pre-OMS staging (intake, quoting, wallet, payment-hold) is legitimately dropship-owned and matches the V2 design. Downstream of OMS-order creation, dropship rides the standard rails (`syncOmsOrderToWms`, engine push, fulfillment-push write-back). But at the convergence point, dropship does **not** enter OMS through its published ingest interface (`createOmsService().ingestOrder`, `oms.service.ts:157-173`, used by the internal eBay channel via `ebay-order-ingestion.ts:53`) and does **not** reserve through `reserveForOrder()` — it re-implements both as raw cross-schema SQL inside `PgDropshipOrderAcceptanceRepository`. The evident motive is the single-transaction atomicity requirement (V2 §9 step 6; PHASE0 spec line 1448), but note `reserveOrder`/`reserveForOrder` already accept a `dbOverride` transaction handle (`channels/reservation.service.ts:90-98, 239-240`) — composability existed on the drizzle side; the dropship repo chose raw `pg` instead.

---

## 3. STATE & WRITERS

| State | Design owner (BOUNDARIES.md) | Actual writer(s) | Verdict |
|---|---|---|---|
| `dropship.*` (34 tables) | Dropship | Dropship only (grep: no other module writes `dropship.*`) | OK |
| `oms.oms_orders`, `oms_order_lines`, `oms_order_events` | **OMS sole writer** (BOUNDARIES.md:153) | OMS **and** dropship acceptance repo (repo:728, 791, 816, 903) | **VIOLATION** |
| `inventory.inventory_levels`, `inventory_transactions` | **WMS `inventoryCore` only** (BOUNDARIES.md:156) | inventoryCore **and** dropship acceptance repo (repo:866, 873) | **VIOLATION** |
| `channels.channels`, `channel_connections` | **Channel Sync** (BOUNDARIES.md:157) | Channel Sync **and** dropship OMS-channel config repo (`dropship-oms-channel-config.repository.ts:248, 260, 303, 321, 350`) | **VIOLATION** (admin-config writes, incl. dropship markers embedded in channels-owned jsonb) |
| `wms.*` | WMS | dropship reads only (`dropship-order-ops.repository.ts:301-303`, `dropship-ops-surface.repository.ts:893`, tracking repo:301-319) | OK as sole-writer; joins breach the "no cross-boundary inner joins" principle (BOUNDARIES.md:14) |
| `membership.*`, `catalog.*` | Membership/Catalog | dropship reads only (entitlement adapter:41-46; acceptance repo:531-534) | OK (reads permitted) |
| Vendor store (eBay/Shopify) listing/fulfillment state | external — port+adapter | dropship providers only | OK pattern |
| `oms.webhook_retry_queue` | OMS internal | dropship enqueues (retry queue) and ops-surface reads (ops-surface repo:517) | grey zone — shared queue used as an interface |

State ownership of partner-facing surfaces: OAuth state is stateless HMAC (no DB row — signer.ts:15-41); tokens in `dropship_store_connection_tokens` (dropship-owned, encrypted); entitlement truth stays in `membership.*` with cached snapshot fields on `dropship_vendors` (`entitlement_status`, `entitlement_checked_at`, schema:198-200) and re-checked at acceptance (acceptance-service:424-429); listings/quantities in `dropship_vendor_listings` (unique `(store_connection_id, product_variant_id)`, schema:639); notifications and returns fully dropship-owned; wallet ledger authoritative for spendable balance (schema constraints:712-714, 780-795).

---

## 4. BOUNDARY VIOLATIONS (each with evidence)

1. **Reservation bypass — the single worst violation.** `dropship-order-acceptance.repository.ts:866-870` raw `UPDATE inventory.inventory_levels SET reserved_qty = reserved_qty + $1` + hand-rolled `inventory_transactions` insert (873-891). BOUNDARIES.md:235: "Every reservation goes through `reserveForOrder()` — no raw SQL, no reimplementation." Also re-derives availability from raw bins (repo:619-632, 1275-1277) against V2 §8 ("no dropship code should use raw inventory as vendor-facing ATP") and bypasses the post-reserve channel-sync trigger that the canonical path fires (`reservation.service.ts:311-315`).
2. **OMS order-creation bypass.** Direct `INSERT INTO oms.oms_orders/lines/events` (repo:728, 816, 791/903) instead of the published `omsService.ingestOrder` (oms.service.ts:157). BOUNDARIES.md:153 makes OMS sole writer.
3. **Double-reservation consequence** of (1)+(2) interacting with shared rails — detailed as Risk #1 in §5.
4. **`channels.*` writes** from `dropship-oms-channel-config.repository.ts:248-350`, including rewriting `channels.channels.shipping_config` and `channel_connections.metadata` jsonb to plant/clear dropship markers (301-343). Channel Sync is the sole writer of `channels.*` (BOUNDARIES.md:157).
5. **Cross-boundary inner joins** (read-only, lesser): acceptance repo joins `membership.plans` + `channels.partner_profiles` inside a `FOR UPDATE` query (repo:414-422 — note `FOR UPDATE OF v, sc` correctly excludes the foreign tables from locking); order-ops and tracking repos join `wms.* × oms.*` (order-ops repo:301-303, 329; tracking repo:301-319); ops-surface reads `oms.webhook_retry_queue` (517) and `wms.outbound_shipments` (893). BOUNDARIES.md:14 prohibits cross-owner inner joins; pragmatically these are reporting/correlation reads.
6. **OMS → dropship coupling via payload sniffing.** `fulfillment-push.service.ts:272-278` identifies dropship orders by `raw_payload.dropship` / a `"dropship"` string in `tags`, then dynamically imports a dropship factory (398-400). Works, but the contract is implicit (a jsonb blob + tag convention written by dropship at repo:762-772) rather than a declared channel-adapter interface.
7. **eBay logic duplication (partial).** `dropship-ebay-order-intake.provider.ts` re-implements OAuth token refresh, retry, and Fulfillment-API paging (provider:30-47, 96+) that exist for the internal eBay channel in `channels/adapters/ebay/ebay-auth.service.ts` (:89-256) and `ebay-api.client.ts` (:287 `getOrders`). It *does* reuse the canonical `EbayOrder` types (provider:11). The duplication is partially justified — per-vendor multi-tenant credentials vs. Echelon's single account, tokens stored/encrypted differently — but the HTTP/token/paging machinery (~360 LOC) could sit behind one shared eBay transport. Same story for tracking/cancellation/listing-push providers vs. `channels/adapters/ebay`.

**Compliance positives (for balance):** routes contain no business logic or DB writes (checked `dropship-marketplace-order-intake.routes.ts`, `dropship-order.routes.ts:69`); every financial mutation is inside an explicit transaction with rollback (acceptance repo:153-166; return repo, wallet repo, cancellation repo all `BEGIN/COMMIT/rollbackQuietly`); clocks are injected everywhere (`DropshipClock`, e.g. acceptance-service:170-183); errors are structured `DropshipError{code,message,context}` with retryable classification on workers (processing repo `markIntakeFailure(retryable)`, tracking repo failure rows record `retryable`); webhooks persist-then-200 with 5xx/401 semantics (routes:88-148); `allowNegative` appears nowhere in the module.

---

## 5. CORRECTNESS RISKS (ranked)

**R1 — HIGH: Double reservation / permanent reserved_qty leak on every accepted dropship order.**
Facts: (a) acceptance raw-reserves N units (`acceptance.repository.ts:866`); (b) the OMS order is inserted with `financial_status='paid'` (repo:735-740); (c) `syncOmsOrderToWms` maps paid → `warehouseStatus='ready'` (`wms-sync.service.ts:682`) and then calls `reservation.reserveOrder(wmsOrderId)` (wms-sync:568-580); (d) `reserveForOrder` is gated only on ATP and has no knowledge of the acceptance-time reservation (`reservation.service.ts:90-219`); (e) nothing in the dropship module ever releases the acceptance-time reservation (grep for release/unreserve across `dropship/**` matches only `client.release()`).
Consequence (**HYPOTHESIS**, statically traced, not executed): if other stock exists, the same order is reserved twice; the WMS-side reservation is the one consumed by pick/ship, so the acceptance-time raw reservation never unwinds → `reserved_qty` inflates permanently → ATP shrinks → listings under-report quantity and future acceptances fail with `DROPSHIP_ORDER_INVENTORY_SHORTFALL`. If no extra stock exists, `reserveOrder` logs shortfall warnings and the WMS order proceeds pick-able against unlinked reservations. Either branch corrupts inventory truth. This alone justifies the refactor.
Corroborating design intent: PHASE0 spec explicitly says "Reserve inventory via reserveForOrder()" *inside* the acceptance transaction (DROPSHIP-PHASE0-SPEC.md:1324, 1444, 1448).

**R2 — HIGH: Acceptance-time reservation is invisible to the reservation system.** The raw `inventory_transactions` row logs `variant_qty_delta=0`, before=after, and does not record the reserved quantity at all (repo:873-891 — only the notes string mentions the OMS order). Reserved history cannot be reconstructed from the ledger; reconcilers keyed on `reference_type='order'`/order-item linkage will not see `reference_type='dropship_order_intake'`. Cancellation after acceptance (OMS-side) would release only reservations made via `reserveForOrder` (**HYPOTHESIS** for the release path; the dropship module itself only cancels pre-acceptance intakes — `dropship-order-cancellation.repository.ts:54` filters `oi.oms_order_id IS NULL`).

**R3 — MEDIUM: Quote/reservation/fulfillment warehouse divergence.** Acceptance locks and reserves in the *quote's* warehouse (repo:624-628) and stamps `oms_orders.warehouse_id = plan.warehouseId` (repo:761), but `syncOmsOrderToWms` re-routes via `fulfillmentRouter.routeOrder(channelId, country, skus)` without reading the OMS order's warehouse (wms-sync:259-269), and the second reservation lands on the variant's *assigned primary bin* wherever it is (reservation.service.ts:138-157). V2 §11 requires quote, debit, and reservation to agree on the warehouse. **INSUFFICIENT EVIDENCE** whether router config currently makes these coincide in production.

**R4 — MEDIUM: No ATP-change→listing quantity sync.** V2 §8: "Quantity sync should happen on every ATP change." Grep: `channels/` has zero dropship references; dropship has no `notifyChange`/`queueSyncAfterInventoryChange` subscription. Marketplace quantities update only via listing push jobs, so vendor listings go stale between pushes → oversell window on partner stores (mitigated only by intake-time ATP checks + rejection/cancellation flow, V2 §9 accepts this as exception handling).

**R5 — MEDIUM: OAuth state replay.** `dropship-oauth-state-signer.ts:20-41` verifies HMAC + expiry but has no nonce/one-time-use store; a captured `state` can be replayed within its TTL. DROPSHIP-IMPLEMENTATION-DELTA.md:313 requires "nonce/expiry/one-time use."

**R6 — LOW-MEDIUM: Vendor availability uses global base ATP, not Dropship channel allocation.** `dropship-atp.provider.ts` wraps `inventoryAtpService.getBulkAtp` (global fungible ATP), with admin caps applied in `dropship-selection-atp-service.ts:194-215`. V2 §8 and DELTA §4 required allocation-engine output (`channels/allocation-engine.service.ts` — unused by dropship, grep). Caps approximate the intent; there is no shared-pool carve-out, so dropship listings compete with Echelon's own channels for the same units until acceptance.

**R7 — LOW: dual gating semantics.** Acceptance's raw availability math (repo:1276, per-warehouse, bin-level) differs from canonical ATP (`atpService.getAtpPerVariant`, fungible pool, UOM-aware). Edge divergence (e.g., stock reserved elsewhere but physically in another warehouse) means dropship may accept what reserveForOrder later can't reserve, or reject what ATP would allow.

**R8 — LOW: logging/observability.** Each service defines its own console-JSON logger (29 `makeDropship*Logger` variants; 127 `console.*` occurrences in the module) rather than the single structured logger required by CLAUDE.md §10; correlation ids exist ad hoc (intakeId/omsOrderId in contexts) but there is no unified correlation-context threading.

**Idempotency review (mostly strong):** intake dedupe (unique idx + FOR UPDATE + 23505 replay, §2A); acceptance replay with conflict detection (repo:339-388); wallet ledger double protection (unique `(reference_type,reference_id)` schema:780-782 + idempotency key); OMS insert `ON CONFLICT DO NOTHING` (repo:741); tracking pushes unique idempotency key (schema:1008); notifications unique `(idempotency_key, channel)` (schema:1188); RMA + inspections unique keys and one-inspection-per-RMA (schema:1079, 1141); workers claim via `FOR UPDATE SKIP LOCKED` (processing runner:83; cancellation repo:72; payment-hold repo:61). A partner double-submitting the same marketplace order cannot double-debit or double-create. Residual gap: the acceptance replay path returns success for a *different submitted idempotency key* as long as intake/vendor/store/quote ids match (requestHash covers only those four fields — acceptance-service:366-373); acceptable, but worth documenting.

**Money:** integer cents everywhere (`bigint mode:number` columns with `>= 0` CHECKs throughout `dropship.schema.ts`; `CentsSchema` boundary validation at acceptance-service:746-768; marketplace decimal strings parsed digit-wise, `whole*100+fraction`, mapper:71/77 — no floats); USDC as `numeric(78,0)` atomic units (schema:1253); wholesale discount is integer floor math (acceptance-service:351-364). No floating-point money found (grep for `parseFloat|toFixed` matched only the integer-cent parsers).

---

## 6. DESIGN-VS-CODE DELTA (vs DROPSHIP-V2-CONSOLIDATED-DESIGN.md)

Implemented as designed: single Dropship OMS channel, config-resolved (no hardcoded ids); store connections with one-active-per-vendor partial unique index (schema:298-300); intake uniqueness `(store_connection_id, external_order_id)`; atomic acceptance bundle (economics snapshot, debit, OMS order, reservation, intake status, audit) in one tx; payment_hold living in intake with configurable timeout (schema:27, acceptance-service:288-292, 697-728); wallet available/pending with non-negative constraints; rate-table shipping behind provider abstractions; returns/RMA with single inspection and fault categories; critical notifications unmutable (schema:1205); listing states matching the design enum (schema:73-85); prototype files (`vendor-portal.routes.ts`, `vendor-ebay.routes.ts`, `vendor-order-polling.ts`, old `wallet.service.ts`) retired — they no longer exist.

Divergences:
1. **"Fulfillment proceeds through normal Echelon/WMS flow" + "reserve via existing reservation path" (V2 §9.6-7; DELTA §4; PHASE0:1444)** — reservation and OMS creation re-implemented raw (§4.1-2), producing R1/R2.
2. **"Vendor-facing availability comes from Dropship channel allocation output" (V2 §8)** — uses global ATP + caps, allocation engine unused (R6).
3. **"Quantity sync on every ATP change" (V2 §8)** — absent (R4).
4. **"Quote, wallet debit, and inventory reservation must agree on the same fulfillment warehouse" (V2 §11)** — not enforced through WMS routing (R3).
5. **OAuth one-time state (DELTA §10)** — expiry only (R5).
6. **Clean use-case layer (V2 §17)** — built (`dropship-use-cases.ts`) then orphaned; production uses per-concern services (a *fine* architecture, but the dead 600-LOC registry contradicts "removed dead code").
7. Membership-lapse grace automation (V2 §3: listing zero-push on lapse, 72h grace reactivation) — entitlement gates exist at acceptance and intake eligibility, and `membership_grace_ends_at` exists (schema:200); **INSUFFICIENT EVIDENCE** that automated listing zero-out on lapse is implemented (no worker found named for it; not exhaustively traced).
8. TikTok/Instagram/BigCommerce appear in enums (schema:42-48) beyond the launch scope — harmless forward-compat, but adds CHECK-constraint surface.

---

## 7. VERDICT + REFACTOR RECOMMENDATIONS

**Verdict: (a) keep the architecture, with one surgical re-platform of the acceptance transaction's OMS/inventory writes onto the published interfaces. Do not rewrite the module.**

Rationale: the module is *not* a parallel order pipeline — order lifecycle, picking, shipping, engine push, and tracking write-back all already ride OMS/WMS shared rails. The dropship-owned staging layer (intake/wallet/quotes/listings/returns) is exactly what the V2 design prescribes and is well-built: strict Zod boundaries, integer cents, pervasive idempotency keys + DB constraints, transactions with row locks, injected clocks, structured errors, 69 test files. A full re-platform onto a generic "channel adapter" seam would discard sound work; the OMS ingest interface (`ingestOrder`) is not transaction-composable today and dropship's funding/reservation coupling genuinely requires a composed transaction. The defects are concentrated in ~200 lines of `dropship-order-acceptance.repository.ts` plus wiring.

Priority order:
1. **Fix R1 now (correctness, testing phase):** pick one reservation owner. Cleanest: delete the raw reserve (repo:845-918) and the raw inventory lock/gate, gate acceptance on `atpService` (read-only, per BOUNDARIES), and let `syncOmsOrderToWms → reserveOrder` remain the sole reserver — accepting a small window where a funded order can fail reservation (already handled as partial-failure + `requires_review`). Stricter alternative: make acceptance call `reserveForOrder(..., dbOverride)` with a drizzle transaction (the signature already supports it — reservation.service.ts:97) and teach `syncOmsOrderToWms` to skip reservation when the order already has reservations. Either way, add an integration test that accepts an order and asserts `reserved_qty` rises by exactly N end-to-end.
2. **Route OMS-order creation through an OMS-published, tx-composable API:** extract `ingestOrder`'s insert path to accept an external transaction handle, or add `omsService.createOrderInTx(tx, orderData, lines)`; replace repo:722-843. This also replaces raw_payload sniffing with a first-class `source='dropship'` marker OMS understands (fixes §4.6).
3. **Move Dropship-channel provisioning behind a Channel Sync interface** (fixes §4.4); stop writing dropship markers into `channels.*` jsonb — keep the mapping in a dropship-owned table or channel config API.
4. **Subscribe listing quantity sync to ATP change notifications** (reuse `queueSyncAfterInventoryChange` fan-out or the channel-sync orchestrator) + keep the push-job path as the bulk/manual mechanism (fixes R4).
5. **Adopt allocation-engine output for vendor ATP** behind the existing `DropshipAtpProvider` port — one provider swap, no service changes (fixes R6).
6. **Add nonce persistence to OAuth state** (one small table or reuse `dropship_sensitive_action_challenges` pattern) (fixes R5).
7. **Deduplicate eBay transport:** parameterize `channels/adapters/ebay` auth/client over a credential source so dropship providers pass vendor-scoped credentials instead of re-implementing token refresh/paging (§4.7).
8. **Hygiene:** delete `dropship-use-cases.ts` dead scaffold; collapse the 27 `*FromEnv` factories into one composition root (or a `dropship/composition.ts`) — the pattern is consistent but each factory re-instantiates its dependency graph per call; unify the 29 per-file console loggers into one module logger with correlation context `{intake_id, vendor_id, store_connection_id, oms_order_id, wms_shipment_id}` per CLAUDE.md §10.

**Reusable either way:** the entire intake/idempotency layer, wallet + ledger, shipping quote engine + snapshots, economics snapshots, listing push job machinery, tracking push state machine, returns/RMA, notifications, admin ops surfaces, the schema (constraints are exemplary), and the test suite. The only code that should not survive as-is are the raw `oms.*`/`inventory.*` writes in the acceptance repository and the `channels.*` writes in the OMS-channel config repository.

---

## 8. UNKNOWNS

- **Runtime confirmation of R1:** the double-reservation is statically traced; not executed (audit is read-only, dev DB empty per CLAUDE.md). Next check: integration test or prod query `SELECT * FROM inventory.inventory_transactions WHERE reference_type='dropship_order_intake'` cross-checked against reservations for the same OMS orders.
- **Post-acceptance cancellation flow:** how an accepted dropship order that the marketplace later cancels unwinds wallet debit + both reservations — no dropship code path found for accepted intakes (`cancellation repo:54` excludes them); presumably manual/admin via order-ops + OMS cancel. INSUFFICIENT EVIDENCE.
- **Membership-lapse listing zero-out automation** (V2 §3) — not located; may be pending work.
- **`fulfillmentRouter` warehouse behavior for the dropship channel** (R3) — depends on runtime routing rules, not verifiable from code alone.
- **Wallet funding webhook ACK semantics** (Stripe/USDC settlement callbacks): repository-level idempotency verified (unique ledger refs, `stripe-funding:{paymentIntentId}` keys, wallet-service:850); route-level 2xx/5xx discipline for funding webhooks not exhaustively traced.
- **Test depth on acceptance rollback:** 69 test files exist including `dropship-order-acceptance-service.test.ts` and a schema integration test; whether "atomic acceptance rollback when wallet debit fails / reservation fails" (V2 §18) is covered end-to-end against a real DB was not verified.
- `dropship.repository.ts` and `catalog.repository.ts` (small infra files) were not read in full; no cross-schema writes surfaced in the module-wide write grep.
