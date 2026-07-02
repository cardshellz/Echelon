# Echelon Audit — 01 CHANNEL INTAKE

Auditor: Claude (read-only). Date: 2026-07-02. Scope: `server/modules/channels/**`, `server/modules/shopify/**`, OMS webhook intake (`server/modules/oms/oms-webhooks.ts`, `webhook-inbox.service.ts`, `ebay-order-ingestion.ts`, `webhook-retry.worker.ts`, `shopify-bridge.ts`, `oms.service.ts` ingest path), `server/routes/ebay/**`, `server/routes/ebay-listing-rules.routes.ts`, `server/routes/shopify.routes.ts` (webhook endpoints), `server/index.ts` webhook wiring. Contract: `BOUNDARIES.md`.

All paths relative to `/home/user/Echelon/`. Claims are cited `file:line`; anything not directly verified is labeled **HYPOTHESIS** or **INSUFFICIENT EVIDENCE**.

---

## 1. SUBSYSTEM MAP

Channel intake is split across **four** places, not one:

### 1a. OMS webhook intake (the real order-ingest path)
| File | LOC | Responsibility |
|---|---|---|
| `server/modules/oms/oms-webhooks.ts` | 2,371 | Shopify order webhooks: `orders/paid`, `orders/updated`, `orders/cancelled`, `orders/fulfilled`, `refunds/create` (registered at oms-webhooks.ts:1508, 1632, 1974, 2045, 2170). HMAC verify (106–119), inbox persist (1440–1473), map payload → `OrderData` (1068–1160), cancel/refund cascades that reach into WMS (263–1025). |
| `server/modules/oms/webhook-inbox.service.ts` | 339 | Durable `oms.webhook_inbox` — build idempotency key (89–101), `recordWebhookReceived` with `ON CONFLICT (idempotency_key) DO NOTHING` (142–172), status transitions (187–218), manual replay (220–309). |
| `server/modules/oms/webhook-retry.worker.ts` | 2,075 | Single retry queue `oms.webhook_retry_queue` for failed webhooks + internal ops (WMS sync, shipment push, tracking push). Backoff 2^attempts min, MAX_ATTEMPTS=5 (line 11), dead-letter + inbox mirroring (1710–1738). |
| `server/modules/oms/ebay-order-ingestion.ts` | 495 | eBay: 5-min poll (192–214, window = 4h creationdate lookback, line 37), webhook handler (386–495), manual reingest (351–384). Maps eBay order → `OrderData` (74–165). |
| `server/modules/oms/oms.service.ts` | 1,004 | `ingestOrder(channelId, externalOrderId, OrderData)` — the single idempotent ingest chokepoint (162–382). |
| `server/modules/oms/shopify-bridge.ts` | 314 | Backfill bridge: legacy `shopify_orders` rows → `ingestOrder` (32–219); LISTEN/NOTIFY on `shopify_order_ingested` (263–314). |
| `server/modules/oms/shopify-line-item-normalizer.ts` | 221 | Pure line-item + discount-split normalization (dollars→cents at 44–47). |

### 1b. Channels module (`server/modules/channels/**`, ~11,600 LOC non-test)
Outbound sync (listings/inventory/pricing push), allocation engine, source-lock, catalog backfill, **plus** an order-reservation service and WMS/OMS order routes that do not belong here:
- `channels.routes.ts` (2,561) — channel CRUD **and** `/api/wms/orders` order creation/listing (247–367, 129–211).
- `channel-adapter.interface.ts` (376) — canonical `IChannelAdapter` port incl. `ChannelOrder` DTO + `receiveOrder`/`pullOrders` (102–150, 280–298) and `ChannelAdapterRegistry` (342–376).
- `adapters/shopify.adapter.ts` (736), `adapters/ebay.adapter.ts` (875) — implement the full port incl. order mapping (shopify.adapter.ts:372–435; ebay.adapter.ts:478–570). **Order methods are dead code** (see §5).
- `echelon-sync-orchestrator.service.ts` (1,595), `allocation-engine.service.ts` (784), `sync.service.ts` (874), `catalog-backfill.service.ts` (1,273), `reservation.service.ts` (822), `source-lock.service.ts` (295), `sync-settings.service.ts` (331), `channels.storage.ts` (918), `channel-catalog.storage.ts` (308).

### 1c. Legacy/secondary Shopify webhooks (`server/routes/shopify.routes.ts`, 1,762)
- `products/create|update|delete` (1421, 1445, 1480) — inline, no inbox.
- `fulfillments/create|update` (1587, 1656) — inline processing of ~700 LOC of fulfillment-cascade logic living in this routes file (57–560); failure → `webhookRetryQueue` insert + 500 (1624–1635, 1690–1701).
- `orders/create|fulfilled|cancelled` — disabled stubs returning 200 (1710–1759).

### 1d. eBay operational routes (`server/routes/ebay/**` + `ebay-listing-rules.routes.ts`, ~5,400 LOC)
Listing push/reconcile, pricing, policies, taxonomy, config — mounted at routes.ts:104. Not order intake, but part of the channel surface (details §3/§4; per-file findings in the eBay routes subsection below).

### 1e. Wiring (`server/index.ts`, 1,593)
- Global `express.json({verify})` captures `rawBody` for HMAC (index.ts:72–74).
- ShipStation SHIP_NOTIFY registered pre-auth at index.ts:433–473 — **processed inline, no inbox** (451), failure → `enqueueShipStationRetry` + 500 (464–471).
- `registerOmsWebhooks(...)` pre-auth (476–480).
- eBay order webhook registered **behind `requireAuth`** (526–527) — see CRITICAL finding §4.
- eBay polling started (518–522); eBay listing reconciliation calls its own HTTP endpoint via localhost loopback with `INTERNAL_API_KEY` (575–639).
- Service handles smuggled through the db object: `(db as any).__fulfillmentPush/__shipStationService/__shippingEngine/__wmsSyncService/__ebayWebhookReplay` (483–516) — hidden global state.

### `server/modules/shopify/`
Contains only `admin-gql-client.ts` (88 LOC) — a thin DI seam over the subscriptions module's GraphQL adapter (admin-gql-client.ts:73–88). Not an intake path.

### 1f. Webhook intake-path matrix (inbox-persisted vs inline)

| Event | Endpoint | Durable-persist BEFORE ACK? | On processing failure | Auth |
|---|---|---|---|---|
| Shopify `orders/paid`, `orders/updated`, `orders/cancelled`, `orders/fulfilled`, `refunds/create` | oms-webhooks.ts:1508–2368 | **Yes** — inbox row, then 200; inbox-write failure → 500 (oms-webhooks.ts:1447–1471) | mark inbox `failed` + insert `webhook_retry_queue` w/ `source_inbox_id` (1383–1389) | HMAC (106–119) |
| eBay order notification | ebay-order-ingestion.ts:390–495 (route index.ts:526–527) | **Yes** — inbox then process (424–440) | mark inbox `failed`, **return 200, NO retry enqueue** (472–480) | **`requireAuth` session — blocks eBay itself (R1); no signature check** |
| ShipStation SHIP_NOTIFY | index.ts:433–473 | **No inbox** — processed inline (451) | enqueue `webhook_retry_queue` + **500** (464–471) | shared-secret (435) |
| Shopify `fulfillments/create` / `fulfillments/update` | shopify.routes.ts:1587, 1656 | **No inbox** — inline cascade | insert `webhook_retry_queue` + **500** (1624–1635, 1690–1701) → Shopify ALSO retries; dedupe relies on handler idempotency | HMAC per-channel (1378–1418) |
| Shopify `products/create` / `delete` | shopify.routes.ts:1421, 1480 | No — inline | 500, no queue | HMAC |
| Shopify `products/update` | shopify.routes.ts:1445 | **No — 200 ACK first, then `setImmediate` background work** (1454–1471); crash = silent loss | logged only (1468–1470) | HMAC |
| Shopify `orders/create|fulfilled|cancelled` (legacy) | shopify.routes.ts:1710–1759 | Disabled stubs, always 200 | n/a | none observed in stub |

Three different durability contracts coexist for financially-relevant events (inbox+early-ACK / inline+500+queue / inline+200) — the flagged intake-path inconsistency is real and broader than just SHIP_NOTIFY.

### Ingestion idempotency (direct answer)
- **Inbox dedupe key:** `provider:topic:sourceDomain:eventId` (webhook-inbox.service.ts:89–101), `eventId` = `x-shopify-webhook-id` → payload id → payload-hash fallback (103–132); eBay: notificationId → `topic:orderId` → hash (311–339). Enforced by `UNIQUE INDEX webhook_inbox_idempotency_key_uidx` (migrations/071_oms_webhook_inbox.sql:20–21) + `INSERT ... ON CONFLICT DO NOTHING` (webhook-inbox.service.ts:142–172).
- **Order dedupe key:** unique `(channel_id, external_order_id)` (oms.schema.ts:121) with GID→numeric normalization at the chokepoint (oms.service.ts:145–151, 169) + `onConflictDoNothing` insert (220) + SELECT fallback (281–293). Replayed order webhooks are safe.
- **Refund idempotency:** financial update guarded by a `refunded` event marker keyed on Shopify refund id, committed in the SAME transaction as the money update (oms-webhooks.ts:2247–2291); WMS return row keyed by `refund_external_id` (880–899); line adjustments `ON CONFLICT DO NOTHING` (574–576).
- **Gaps:** `oms_order_lines` has no unique key (R15); `markWebhookProcessing` is unconditional so the processing-dup guard is advisory (R9); SHIP_NOTIFY has no intake-level dedupe at all (R4); retry queue dedupes pending rows via a scoped unique index, unique-violation swallowed by design (webhook-retry.worker.ts:634–658).

---

## 2. STATE & WRITERS

Writers observed in **channel-intake code** (schema.table ← writing function):

### oms.* (OMS-owned — legitimate owner is OMS, but note *which* code writes)
| Table | Writers |
|---|---|
| `oms.oms_orders` | `ingestOrder` insert w/ `onConflictDoNothing(channelId, externalOrderId)` (oms.service.ts:174–221); direct `db.update` from webhook handlers: orders/updated (oms-webhooks.ts:1664–1694), orders/cancelled (2004–2012), orders/fulfilled (2099–2109), refunds/create tx (2266–2291); **raw unqualified SQL** from eBay poller `UPDATE oms_orders ...` (ebay-order-ingestion.ts:259–262, 285–292). |
| `oms.oms_order_lines` | ingest tx insert (oms.service.ts:241–265); non-tx backfill (332–376); orders/updated per-line update/insert/zero-out (oms-webhooks.ts:1813–1879); orders/fulfilled bulk update (2111–2114). |
| `oms.oms_order_events` | ingest tx (oms.service.ts:268–272); cascades + webhooks (oms-webhooks.ts:398–407, 434–443, 995–1004, 1941–1949, 2121–2130, 2277–2290). Append-only in practice; no UPDATE/DELETE observed on it in intake code. |
| `oms.webhook_inbox` | `recordWebhookReceived` / `markWebhook{Processing,Succeeded,Failed}` (webhook-inbox.service.ts:142–218); replay reset (283–289); retry-worker mirror (webhook-retry.worker.ts:1720–1738). |
| `oms.webhook_retry_queue` | `handleProcessingFailure` (oms-webhooks.ts:1383–1389); shopify.routes.ts:1624, 1690; index.ts:464; worker state transitions (webhook-retry.worker.ts:629–641, 1575–1584, 1619–1626, 1686–1705). |
| `oms.order_line_adjustments` | `persistRefundLineAdjustments` w/ `ON CONFLICT ... DO NOTHING` (oms-webhooks.ts:552–577). |

### wms.* — WRITTEN DIRECTLY BY NON-WMS CODE (violations, see §3)
| Table | Writers in intake code |
|---|---|
| `wms.orders` | **oms-webhooks.ts orders/updated raw UPDATE** of address, `financial_status` (defaulting to `'paid'` when payload omits it), and `warehouse_status` pending→ready promotion (oms-webhooks.ts:1725–1744). |
| `wms.order_items` | refund cascade UPDATE status→cancelled (oms-webhooks.ts:631–641). |
| `wms.outbound_shipment_items` | refund cascade UPDATE qty (oms-webhooks.ts:617–630). |
| `wms.outbound_shipments` | refund flag `requires_review` (oms-webhooks.ts:688–694); retry worker `markShipmentPushPermanentlyFailed` (webhook-retry.worker.ts:1659–1671). |
| `wms.returns` / `wms.return_items` | refund cascade inserts (oms-webhooks.ts:937–948, 965–972), idempotent by `refund_external_id` SELECT-then-INSERT (880–899). |
| `inventory.inventory_levels` | **channels/catalog-backfill.service.ts:867 direct insert** (bypasses `inventoryCore`). |
| `inventory.inventory_transactions` | catalog-backfill.service.ts:878; channels/reservation.service.ts:509 (direct ledger insert bypassing `inventoryCore`). |
| `warehouse.warehouse_locations` | catalog-backfill.service.ts:1019 (creates `BACKFILL-DEFAULT` bin). |
| `warehouses` | channels/sync-settings.service.ts:173 (`feedEnabled`); channels.routes.ts:867, 874 via `storage.updateWarehouse`. |

### catalog (Catalog-owned) — written by channels module AND eBay routes
| Table | Writers |
|---|---|
| `products` | catalog-backfill.service.ts:364 (update), :387 (insert); echelon-sync-orchestrator.service.ts:1163 (listing pull-back); routes: ebay-policies.routes.ts:90–96 (policy overrides), ebay-config.routes.ts:366–369 (raw `UPDATE catalog.products`), ebay-listing-rules.routes.ts:153–156 & 196–199 (product_type), ebay-listing-state.ts:52–54 (`ebayListingExcluded`). |
| `product_variants` | catalog-backfill.service.ts:514, 541; ebay-policies.routes.ts:122–128; ebay-listing-state.ts:86–88. |
| `product_assets` | catalog-backfill.service.ts:725; ebay-policies.routes.ts:288 (import-images bulk insert). |

### ebay.* + channels.* written from `server/routes/ebay/**` (route-layer writers)
`channels.channel_listings` — ebay-listings.routes.ts upserts at :528–:1693 (~20 sites via `upsertChannelListing`/`upsertPushError`), raw `UPDATE channel_listings` in reconcile (:1843–1846, :1880–1883); ebay-sync-helpers.ts:34–62, 108–115, 610; ebay-listing-state.ts:111–194 (raw `pool.query`); ebay-policies.routes.ts:378–385 (hardcoded cleanup delete). `ebay.ebay_category_mappings` — ebay-config.routes.ts:213–244, 445–451. `ebay.ebay_category_aspects` — **written inside a GET** (ebay-taxonomy.routes.ts:310–325). `ebay.ebay_type_aspect_defaults` / `ebay_product_aspect_overrides` — ebay-taxonomy.routes.ts:392–409, 469–486. `ebay.ebay_listing_rules` — ebay-listing-rules.routes.ts:252–363. `channels.channel_pricing_rules` — ebay-pricing.routes.ts:92–142. `channels.channels` — auto-created in unauthenticated OAuth GET callback (ebay-oauth.routes.ts:108–116). `channels.channel_connections` — ebay-settings.routes.ts:77–85, 318–336, 359–370.

**No `oms.*`, `wms.*`, or inventory writes were found anywhere under `server/routes/ebay/**`** (verified by the delegated file-by-file audit).

### channels.* (rightful owner: Channel Sync) — compliant
`channels`, `channel_connections`, `channel_feeds`, `channel_listings`, `channel_pricing`, `channel_*_overrides`, `channel_product_allocation`, `channel_warehouse_assignments`, `channel_allocation_rules`, `sync_settings`, `sync_log`, `channel_sync_log`, `source_lock_config`, `allocation_audit_log`, `ebay_oauth_tokens` — full write inventory with lines: channels.storage.ts:160–910, channel-catalog.storage.ts:75–296, sync-settings.service.ts:70–184, source-lock.service.ts:179–234, allocation-engine.service.ts:768, echelon-sync-orchestrator.service.ts:664–1548, catalog-backfill.service.ts:584–674, adapters/ebay/ebay-auth.service.ts:292–301, channels.routes.ts:2237–2511.

**Sole-writer verdict:** `oms.oms_orders` has at least four distinct writer sites across two modules (oms.service, oms-webhooks handlers, eBay poller raw SQL, plus reconcilers out of scope); `wms.orders.warehouse_status` is written by OMS webhook code despite BOUNDARIES.md:154 naming WMS sole writer. No table in the order path has exactly one owning writer except `oms.webhook_inbox`.

---

## 3. BOUNDARY VIOLATIONS

Ranked, against BOUNDARIES.md (sole-writer matrix at BOUNDARIES.md:144–173).

**V1 — OMS webhook code writes `wms.orders.warehouse_status` (pending→ready) + `financial_status` directly.** oms-webhooks.ts:1725–1744. BOUNDARIES.md:154: "`wms.orders.warehouse_status` ... Sole writer **WMS** — others request via WMS interface." Worse: `financial_status = ${shopifyOrder.financial_status || "paid"}` (1735) silently promotes a payload with a *missing* field to `'paid'` in WMS. This is the single worst writer-control violation in the subsystem: a channel payload field flows, unvalidated, straight into the WMS work-release gate.

**V2 — Channels module writes WMS inventory + Catalog master directly.** `catalog-backfill.service.ts` inserts `inventory_levels` (:867), `inventory_transactions` (:878), `warehouse_locations` (:1019), and upserts `products`/`product_variants`/`product_assets` (:364/387/514/541/725). BOUNDARIES.md:117: Channel Sync "Does NOT: Modify `inventory_levels` — ever." Bypasses `inventoryCore`, so ledger and level can diverge (no transaction either — see §4 R6).

**V3 — A reservation service lives inside `server/modules/channels/`.** `channels/reservation.service.ts` (822 LOC) implements ATP-gated reserve/release/reallocate (:90, :239, :720). BOUNDARIES.md:89–99 places reservation *inside WMS* with `reserveForOrder()` as the single entry point. It mostly delegates mutations to `inventoryCore.reserveForOrder` (:202) / `releaseReservation` (:387), so it is a *location/ownership* violation more than a raw-SQL one — **except** the direct `inventoryTransactions` insert at :509.

**V4 — OMS refund/cancel cascades mutate `wms.order_items`, `wms.outbound_shipment_items`, `wms.outbound_shipments`, `wms.returns` via raw SQL from `oms-webhooks.ts`** (617–694, 937–972). Direction contract (BOUNDARIES.md:167–169: "OMS never writes `wms.*`") violated in the same file whose header cascade helpers partially *do* go through WMS helpers (`../orders/shipment-rollup`, `order-status-core` at 371–372, 2117). Two idioms coexist in one file.

**V5 — Channels routes create OMS + WMS orders.** channels.routes.ts:273 (`omsService.ingestOrder`) and :352 (`storage.createOrderWithItems`) inside POST `/api/wms/orders`; order state mutations at :488–506. BOUNDARIES.md:117–119: Channel Sync does not create orders or know warehouse ops. (Mitigating: goes through interfaces, not raw SQL.)

**V6 — Orchestrator writes Catalog master on listing pull** (echelon-sync-orchestrator.service.ts:1163) and sync-settings writes `warehouses` (:173).

**V7 — Vendor identifiers leak past adapters.** Channel intake carries `shipstation_order_id`/`shipstation_order_key` in shipment queries (oms-webhooks.ts:656–657) — acknowledged back-compat shadow columns (CLAUDE.md project note), but the refund cascade still branches on them. eBay `channelId = 67` is hard-coded (ebay-order-ingestion.ts:35; index.ts:505, 568) — a channel row id baked into code contradicts the "adapter per provider, no vendor leak" rule.

**V8 — Cross-schema raw reads in channels code** (reads, not writes, but bypass published interfaces): allocation velocity joins over `wms.order_items`/`wms.orders`/`catalog.product_variants` (allocation-engine.service.ts:61–71; duplicated in channels.routes.ts:2530–2540); orchestrator joins `inventory.inventory_levels` + `warehouse.*` (echelon-sync-orchestrator.service.ts:523–540); `channels.storage.ts` reads `oms.oms_orders` (:840–858) and `membership.*` (:872–878).

**V9 — eBay operational routes live outside the channels module and write Catalog + channels tables from the route layer.** Why `server/routes/ebay/` exists apart from `channels/adapters/ebay/`: it is the UI-facing listing-management surface (push/sync/reconcile/pricing/policies/taxonomy/config) built directly against eBay's APIs, predating/bypassing the adapter port. Boundaries it crosses: (a) writes `catalog.products`/`product_variants`/`product_assets` directly (see §2 table); (b) writes `channels.channel_listings`/`channel_pricing_rules` — Channel-Sync-owned tables — from route handlers instead of the channels module; (c) imports adapter *internals* (`EbayAuthService`, `EbayApiClient`, `EbayListingBuilder`) from five files under `modules/channels/adapters/ebay/*` rather than a published channels interface (ebay-settings.routes.ts:28–40, ebay-listing-rules.routes.ts:32–35); (d) maintains a **second hand-rolled eBay HTTP client** (`ebay-utils.ts:84, :153`) parallel to the adapter's `EbayApiClient` (adapters/ebay/ebay-api.client.ts:64), so retry/rate-limit/dry-run behavior forks; (e) mutating writes inside GET handlers — taxonomy aspect cache refresh (ebay-taxonomy.routes.ts:310–325) and OAuth channel auto-create (ebay-oauth.routes.ts:108) — violating CLAUDE.md §8; (f) `EBAY_CHANNEL_ID = 67` re-hardcoded three more times (ebay-utils.ts:13, ebay-listing-rules.routes.ts:41, ebay-settings.routes.ts:46).

---

## 4. CORRECTNESS RISKS (ranked by financial risk)

### CRITICAL
**R1 — eBay real-time order intake is dead: webhook registered behind session auth.** index.ts:526–527 registers `/api/ebay/webhooks/order` with `requireAuth`, which 401s any request without `req.session.user` (server/routes/middleware.ts:22–27). eBay platform notifications carry no session cookie; even the GET challenge handshake (ebay-order-ingestion.ts:392–409) cannot succeed. Consequence: order intake relies entirely on the 5-minute poller whose filter is `creationdate:[now-4h..now]` (ebay-order-ingestion.ts:235, 37). **An eBay cancellation or refund occurring >4h after order creation has no intake path**: webhook dead, poll window misses it (poll only sees recently-created orders), and the eBay reconciler only handles fulfillment/tracking, not cancellations (reconcilers/ebay.reconciler.ts:12–30, 93–170). Financial exposure: shipping cancelled/refunded eBay orders. *What is not proven:* whether some proxy injects a session, or another sweep covers late eBay cancels — I found none (oms-flow-reconciliation.service.ts reconciles internal OMS↔WMS state only, e.g. :146–294). Verify webhook delivery logs in production.

**R2 — Unvalidated channel payload field gates WMS work release.** oms-webhooks.ts:1735–1739 (V1): missing `financial_status` → literal `'paid'` written to `wms.orders`; `warehouse_status` promoted pending→ready on `partially_paid`. A malformed/partial `orders/updated` payload can release unpaid work to the floor. No Zod validation exists anywhere on the webhook boundary (see §5).

### HIGH
**R3 — eBay webhook ACKs 200 on processing failure with no retry enqueue.** ebay-order-ingestion.ts:472–480: on failure it marks the inbox row `failed` and returns `200 {processing:"failed"}`. Unlike the Shopify path (oms-webhooks.ts:1383–1389) nothing inserts into `webhook_retry_queue`; inbox `failed` rows are only replayed manually (webhook-inbox.service.ts:220–309; oms.routes.ts:115). Violates CLAUDE.md §6 "never ACK 200 when work failed and should be retried." Mitigated only by the 4h-window poller — which does not cover the R1 late-event classes. (Currently moot while R1 keeps the endpoint dead, but it becomes live the moment R1 is fixed.)

**R4 — SHIP_NOTIFY bypasses the inbox pattern.** index.ts:433–473: processed inline; no `oms.webhook_inbox` row; failure → retry-queue + 500. There is no durable record of the received event (only the derived retry row on failure), no dedupe key (ShipStation resends → relies on downstream idempotency of `processWebhook`), and no ops visibility parity with Shopify/eBay events in the inbox dashboards (ops-health.service.ts:115–208 queries only `webhook_inbox`). Three intake paths = three different durability contracts (inbox+ack-early / inline+500 / inline+200).

**R5 — `orders/updated` multi-table write is not transactional.** One webhook writes `oms_orders` (oms-webhooks.ts:1664–1694), `wms.orders` (1725–1744), per-line `oms_order_lines` (1813–1879), triggers WMS propagation (1895), then the event log (1941). A crash mid-sequence leaves OMS and WMS divergent with the inbox row stuck `processing`; the retry replays the *whole* handler (safe-ish because upserts, but the line "zero-out removed lines" loop at 1866–1879 and address/cancel cascades re-run against changed state). CLAUDE.md §8 requires a transaction around multi-step financial writes.

**R6 — Channels backfill writes level then ledger with no transaction.** catalog-backfill.service.ts:867 (`inventory_levels`) then :878 (`inventory_transactions`) — partial failure = stock without audit trail. Agent-verified: **zero `db.transaction` calls in the entire channels module.** Also source-lock select-then-insert race (source-lock.service.ts:164–203) and delete-then-insert product-line replaces (channels.storage.ts:478–482).

### MEDIUM
**R7 — `verifyAndParse` ACKs 200 for empty/unparseable bodies before any persistence.** oms-webhooks.ts:1318–1322 (missing rawBody → 200 "ok"), 1343–1347 (JSON parse fail → 200). A body-parser/middleware misconfiguration (transient, config-class) would silently ACK and drop every Shopify order webhook with no inbox row and no dead-letter — only console.warn. Should be 5xx for missing-rawBody (permanent-vs-transient misclassification).
**R8 — HMAC bypass via `x-internal-retry: SESSION_SECRET`.** oms-webhooks.ts:1314, 1352; mirrored in shopify.routes.ts:1384. Reuses the session-cookie secret as a webhook-forgery bypass; if SESSION_SECRET leaks (it is used for cookies), attacker can inject orders/refunds. Should be a dedicated secret at minimum.
**R9 — Duplicate-processing guard is best-effort, not a lock.** `receiveShopifyWebhook` skips only when a duplicate row is already `processing` (oms-webhooks.ts:1458–1462); two *different* events for the same order (paid + updated arriving together) run concurrently with no per-order serialization; `markWebhookProcessing` is not conditional (`UPDATE ... SET status='processing'` without `WHERE status IN (...)`, webhook-inbox.service.ts:187–196). Guarded by ingest upsert but the post-ingest steps (reserve, WMS sync, address propagation) interleave — the code itself documents the race (oms-webhooks.ts:1556–1559).
**R10 — `isNew` = `createdAt` within 5s of `Date.now()`** (oms-webhooks.ts:1530; ebay-order-ingestion.ts:252, 363, 454). Hidden clock dependency (CLAUDE.md §3); a slow ingest tx or clock skew misclassifies new orders as existing, skipping member-tier enrichment / MC push (Shopify) and the totalIngested count (eBay).
**R11 — eBay poller refund handling invents amounts.** ebay-order-ingestion.ts:283–291: full refund → `refund_amount_cents = total_cents`, partial → `0`, with raw unqualified `UPDATE oms_orders` (search_path dependent). Best-effort is commented, but a partial refund records **zero** refunded cents — understates refunds in a financial table.
**R12 — products/update webhook: 200-ACK then `setImmediate` background work, no persistence** (shopify.routes.ts:1454–1471). Crash after ACK = lost update. Catalog-only (not money), hence MEDIUM-.
**R13 — `getChannelId` resolves the channel by `ILIKE %domain%` substring** (oms-webhooks.ts:1496–1500) — `shop.myshopify.com` matches `myshop.myshopify.com` patterns; wrong-channel attribution risk for multi-store.

### HIGH (eBay listing/pricing surface — from delegated audit, spot-verify lines before acting)
**R18 — eBay listing push persistence probably throws at runtime: Drizzle helpers fed a raw pg `PoolClient`.** `upsertChannelListing`/`upsertPushError`/`clearPushError` call `dbArg.insert(...)/.select()/.update()` (ebay-sync-helpers.ts:34–115) but ebay-listings.routes.ts passes `client = await pool.connect()` (a node-postgres client with only `.query()`) at ~22 call sites (:528, :541, :677, :759, :801 ... :1693). `db = drizzle(pool)` (server/db.ts:43) vs `pool.connect()` are different objects. Directly verified: `const client = await pool.connect()` at ebay-listings.routes.ts:329 is the `client` passed at :528/:541/:677/:759/:801/:819, and `upsertChannelListing` immediately calls `dbArg.insert(channelListings)` (ebay-sync-helpers.ts:34). A `PoolClient` has no `.insert` → `TypeError` at runtime on the listing-persistence step of every push; sync path passes real drizzle `db` and works (ebay-sync-helpers.ts:610). Whether the surrounding catch masks it (listing pushed to eBay but never recorded locally = orphaned live listings) needs runtime confirmation — either way the path is broken.
**R19 — Sync marks price `synced` in DB after the eBay write failed.** Offer-update failure swallowed as "Non-fatal" then `lastSyncedPrice: newPriceCents, syncStatus: 'synced'` written unconditionally (ebay-sync-helpers.ts:604–615; duplicated ebay-listings.routes.ts:1689–1698). DB claims a price is live on eBay that is not — direct financial-state corruption (mispriced live listings won't be re-pushed because `last_synced` matches).
**R20 — Connection leak per sync run:** `pool.connect()` at ebay-sync-helpers.ts:302 is never released (`finally` at :693–695 deliberately removed release while `client` is still used at :574). Repeated syncs exhaust the pool → takes down ALL intake paths sharing it.
**R21 — Pricing-rule math in floating point:** `applyPricingRule` computes `Math.round(basePriceCents * (1 + value/100))` with `value` from `parseFloat` (ebay-sync-helpers.ts:144–216) — percent markups on money via float (CLAUDE.md §4). Also pricing-rule change → eBay propagation is fire-and-forget `.catch(console.error)` (ebay-pricing.routes.ts:117–119): a failed repricing is never surfaced or retried.

### LOW
**R14 — `dollarsToCents` = `Math.round(parseFloat(x)*100)`** (oms-webhooks.ts:125–128; ebay-order-ingestion.ts:69–72; shopify-line-item-normalizer.ts:44–47; adapters shopify.adapter.ts:443ff, ebay.adapter.ts:835). Float intermediate on money at the boundary; safe for 2-dp vendor strings, but violates the letter of CLAUDE.md §4 — a string-decimal parse (or cents from vendor integer fields) would be exact. Adapter line-total drift: shopify.adapter.ts:456 computes `round(price*qty*100)` instead of vendor line total.
**R15 — `oms_order_lines` has no unique dedupe key**: `.onConflictDoNothing()` with no target (oms.service.ts:265, 373) and only non-unique indexes (oms.schema.ts:185–188) — concurrent duplicate line inserts are possible on the non-tx backfill path (oms.service.ts:332–376).
**R16 — refunds/create endpoint is the only OMS webhook without the rate limiter** (oms-webhooks.ts:2170 vs 1508/1632/1974/2045).
**R17 — Console logging throughout intake** (`console.log/warn/error` with emoji, e.g. oms-webhooks.ts:1607) — no structured logger, no correlation context object; violates CLAUDE.md §10 but consistently.

---

## 5. SEAM ASSESSMENT — how close to plug-and-play channel adapters?

**Verdict: the seam exists on paper, twice, and the production order path uses neither.**

1. **The designed seam is dead code for intake.** `channel-adapter.interface.ts` defines exactly the right contract — canonical `ChannelOrder` in integer cents (:102–142), `receiveOrder`/`pullOrders` (:280–298), a registry (:342–376) — and both adapters implement it (shopify.adapter.ts:372–435; ebay.adapter.ts:478–570). But no production code calls `receiveOrder` or `pullOrders`: references exist only in the adapters, the interface, `index.ts` re-exports, and tests (verified by grep across `server/`). The orchestrator invokes only `pushInventory`/`pushPricing`/`pushListings`.
2. **The de-facto seam is `OrderData` + `ingestOrder`.** The real convergence point is `omsService.ingestOrder(channelId, externalOrderId, OrderData)` (oms.service.ts:162) fed by two bespoke mappers: `mapShopifyOrderToOrderData` (oms-webhooks.ts:1068–1160) and `mapEbayOrderToOrderData` (ebay-order-ingestion.ts:74–165), plus the bridge (shopify-bridge.ts:150–186). `OrderData` is channel-agnostic and integer-cents — genuinely good — but it is a **TypeScript interface with zero runtime validation**: no Zod parse anywhere on the boundary (`insertOmsOrderSchema` exists at oms.schema.ts:128–134 but is never called; only compile-time `satisfies` at oms.service.ts:219, 265). CLAUDE.md §4/§5 require schema validation of channel payloads.
3. **What actually leaks past the "adapter":**
   - Post-ingest orchestration (reserve → assignWarehouse → WMS sync → FO-ID population → cancel/refund cascades) is copy-pasted per channel in each webhook/poller handler (oms-webhooks.ts:1521–1613 vs ebay-order-ingestion.ts:246–316 vs 446–469) rather than living behind one `ingestAndRoute()` use-case. The eBay copy already drifted: its cancel path skips reservation release + shipment cascade that the Shopify path has (ebay-order-ingestion.ts:264–277 vs oms-webhooks.ts:345–446).
   - Channel-specific lifecycle logic (Shopify refund restock semantics, fulfillment-order GIDs, eBay ship-by dates) reaches into `wms.*` tables directly (§3 V1/V4).
   - Hard-coded `EBAY_CHANNEL_ID = 67` (ebay-order-ingestion.ts:35) and channel resolution by domain-ILIKE (oms-webhooks.ts:1496–1500).
   - Two parallel eBay order mappers exist (adapter vs OMS module) that can drift independently (ebay.adapter.ts:574 vs ebay-order-ingestion.ts:74).
4. **Cost of adding a new channel today (e.g. Amazon):** write a mapper to `OrderData`, a webhook/poller with its own HMAC + inbox calls + retry wiring, replicate the ~90-line post-ingest choreography, add its cancel/refund cascade, and register endpoints in `index.ts`. Nothing in core forces consistency; the eBay/Shopify drift proves it. Estimated: **an adapter plus ~400–600 lines of copied orchestration** — not a thin adapter.
5. What is right and worth keeping: single idempotent ingest chokepoint with normalized external-id (oms.service.ts:145–151, 220), the durable inbox with deterministic idempotency keys (webhook-inbox.service.ts:89–172), unified retry queue with dead-lettering and inbox mirroring (webhook-retry.worker.ts:1562–1607, 1710–1738), integer-cents everywhere in `oms.*` (oms.schema.ts:80–86, 165–170).

---

## 6. REFACTOR RECOMMENDATIONS (incremental)

1. **(Do first, small) Fix R1**: remove `requireAuth` from `/api/ebay/webhooks/order` (index.ts:526–527) and add eBay signature verification (`x-ebay-signature` is already captured, webhook-inbox.service.ts:335–336, just never verified). Then fix R3: on processing failure, insert `webhook_retry_queue` with `source_inbox_id` (reuse `handleProcessingFailure` from oms-webhooks.ts:1367–1390).
2. **(Small) Fix R2**: in orders/updated, stop defaulting `financial_status || "paid"` (oms-webhooks.ts:1735); only write fields present in the payload, and route the pending→ready promotion through a WMS interface function (`wmsSyncService` already exists and is called two lines later — move the column writes into it).
3. **(Small) Route SHIP_NOTIFY through the inbox**: call `recordWebhookReceived` with provider `shipstation` before `processWebhook` (index.ts:449–454); gives dedupe, audit, and ops-dashboard parity for free.
4. **Extract one `ChannelIntakeService.ingestAndRoute(channelId, externalOrderId, OrderData)`** in OMS that owns the post-ingest choreography (reserve → assign → WMS sync → retry enqueue). Both webhook handlers and the eBay poller become ~20-line shells. This erases the Shopify/eBay drift and is a precondition for any new channel.
5. **Add Zod schemas** for `OrderData`/`LineItemData` (or wire the existing `insertOmsOrderSchema`, oms.schema.ts:128) and parse at the top of `ingestOrder`; validate raw Shopify/eBay payload shape in the mappers (reject → permanent error → inbox `dead`, not a crash mid-write).
6. **Unify on the adapter port**: make `mapShopifyOrderToOrderData`/`mapEbayOrderToOrderData` the *implementation* of `IChannelAdapter.receiveOrder` (converting `ChannelOrder` ↔ `OrderData`, or collapsing the two DTOs into one), register adapters in `ChannelAdapterRegistry`, and have one generic webhook controller: verify → inbox → adapter.receiveOrder → ingestAndRoute → mark inbox. Adding Amazon then = one adapter file + registry entry.
7. **Move the cancel/refund WMS mutations behind WMS interfaces**: `applyRefundLineAdjustmentsToWms` (oms-webhooks.ts:583–760) and the `wms.orders` UPDATE (1725–1744) become functions in `server/modules/orders/` (WMS) called by OMS — the `shipment-rollup` helpers already model this correctly.
8. **Relocate `channels/reservation.service.ts` into WMS** (it already delegates to `inventoryCore`); fix its direct `inventory_transactions` insert (:509). Rehome `catalog-backfill.service.ts` writes: products/variants via a Catalog interface, inventory via `inventoryCore.receiveInventory`/adjust — inside transactions.
9. **Transactions**: wrap orders/updated per-order writes (oms-webhooks.ts:1664–1949) and backfill level+ledger pairs; add a unique index on `oms_order_lines (order_id, external_line_item_id)` to give the line upserts a real conflict target (oms.service.ts:265).
10. **Replace `x-internal-retry: SESSION_SECRET`** with a dedicated `INTERNAL_RETRY_SECRET` (oms-webhooks.ts:1314, 1352; shopify.routes.ts:1384); exact-match channel domain lookup instead of ILIKE-substring (oms-webhooks.ts:1499); make `EBAY_CHANNEL_ID` a `channels` lookup by provider.
11. **eBay routes triage (before any refactor)**: (a) runtime-verify R18 (pg client vs drizzle handle) and fix by passing `db`; (b) fix R20 leak (`client.release()` in ebay-sync-helpers.ts:693–695); (c) fix R19 — only stamp `synced`/`lastSyncedPrice` when the eBay offer call succeeded; (d) make `applyPricingRule` integer/bigint math (basis points, not `value/100` float).
12. **Longer term**: collapse the three push implementations and two sync implementations into `channels/adapters/ebay/` behind the orchestrator; retire the hand-rolled `ebay-utils.ts` HTTP client in favor of `EbayApiClient`; expose a published channels-module interface so routes stop importing adapter internals; kill the localhost-HTTP self-call for reconciliation (index.ts:575–639) in favor of a direct service call; move GET-path mutations (taxonomy cache, OAuth channel auto-create) into POST/service paths.

---

## 7. UNKNOWNS

- **Production behavior of the eBay webhook endpoint** (R1): I cannot verify from code whether any infrastructure injects a session or whether eBay's subscription is even active. Needs prod log check. The unit test `ebay-webhook-inbox-regression.test.ts` exercises the handler directly, bypassing route middleware — so tests would not catch it.
- Whether `services.shippingEngine.processWebhook` (index.ts:451) is internally idempotent per shipment — SHIP_NOTIFY dedupe depends on it (ship-notify-v2 tests suggest yes: `__tests__/unit/ship-notify-v2.test.ts`, 1,493 LOC — not audited here; SHIP_NOTIFY is another subsystem's scope).
- Whether any *other* scheduled job covers late eBay cancellations (>4h after creation). `oms-flow-reconciliation.service.ts` reconciles internal state; `shipstation-sweeper.ts` and `fulfillment-sweeper.scheduler.ts` were not fully audited.
- `storage.createOrderWithItems` internals (channels.routes.ts:352) — whether it wraps WMS order+items in a transaction. INSUFFICIENT EVIDENCE here (WMS subsystem scope).
- Runtime dedupe behavior when Shopify omits `x-shopify-webhook-id`: the fallback event id is payload-hash or `admin_graphql_api_id` (webhook-inbox.service.ts:108–111) — two *distinct* deliveries of `orders/updated` for the same order with byte-identical payloads would dedupe (correct), but different `updated_at` payloads never dedupe (also correct). Behavior with GID-vs-numeric fallback ids across topics not exhaustively traced.
- The eBay routes appendix and the channels-module write inventory are based on delegated file-by-file reviews (line refs read from source by the delegates); spot-verify individual line numbers before acting.
- **R18 is static evidence only**: whether `upsertChannelListing(client, ...)` actually throws in production (vs some path passing `db`) requires a runtime check or the push-stream logs — I did not run the code (read-only audit).
- Whether the channels-module `catalog-backfill.service.ts` is still invoked in production (one-time import vs recurring job) — its callers were not traced; if dormant, V2 severity drops but the code remains a loaded gun.

---

## Appendix A — eBay routes per-file (delegated file-by-file audit; line refs verified against source by the delegate)

**ebay-listings.routes.ts (1,913)** — `/api/ebay/listings/push` (:303), SSE `push-stream` (:858), `sync-all` (:1387), SSE `sync-stream` (:1420), `reconcile` (:1781, `requireAuthOrInternalApiKey` — called by the index.ts localhost loop). The push handler is ~550 lines of inline business logic (policy cascade :422–447, category :426–452, aspects :454–469, pricing loop :476–480, ATP :485–490, full inventory-item→group→offer→publish sequence :492–838) and `push-stream` duplicates all of it; `sync-stream` (:1530–1755) duplicates `syncActiveListings`. Duplicate-offer recovery keys on `err.message.includes("25002"/"409")` (:653, :734) — string-matched, no transient/permanent classification. Multi-step eBay+DB writes per product, no transaction.

**ebay-sync-helpers.ts (732)** — shared upserts + `syncActiveListings` (:268) + `applyPricingRule` (:205–216, float — R21) + R19 swallowed-failure/`synced` stamp (:604–615) + R20 connection leak (:302). Second `escapeXml` copy (:251 vs ebay-utils.ts:67).

**ebay-listing-state.ts (385) / -core.ts (28)** — the GOOD pattern: pure predicates in core; transactional dual-writes `products`+`channel_product_overrides` (:50–72) and `product_variants`+`channel_variant_overrides` (:84–106) — properly wrapped in `tx`, but still catalog+channels dual-ownership writes from route-layer code. Withdraw/zero operations stamp `sync_status='error'` then rethrow (:275–279, :380–384) — best error handling in the directory.

**ebay-config.routes.ts (462)** — writes `ebay.ebay_category_mappings` in explicit BEGIN/COMMIT (:210–250), raw `UPDATE catalog.products` (:366–369). Empty `catch {}` swallows identity-fetch failure (:69). Trading-API calls embed the OAuth token in the XML body (:298).

**ebay-policies.routes.ts (397)** — writes catalog `products` (:90–96) / `product_variants` (:122–128) / `product_assets` (:288); permanent hardcoded one-off cleanup for productId 60 with literal SKUs (`cleanup-prod60`, :318–390) — dead one-off code in a live route. Good partial-failure signalling on product-exclusion (502 "local saved, remote failed", :58–66).

**ebay-pricing.routes.ts (213)** — `channel_pricing_rules` writes inside `db.transaction` (:92–114, one of only two transactions in the whole eBay routes tree); `GET /effective-prices` loops every active variant N+1 (:199–203); fire-and-forget repricing (:117–119, R21).

**ebay-taxonomy.routes.ts (503)** — GET `category-aspects` performs delete+insert cache refresh inside the GET (:310–325) — mutating read path (CLAUDE.md §8). PUT handlers are transactional delete+insert (:392–409, :469–486).

**ebay-listing-rules.routes.ts (571)** — writes `catalog.products.product_type` (:153–156, raw SQL :196–199) and `ebay.ebay_listing_rules` (:252–363); the SKU→rule-cascade resolution is inline in the handler (:409–442); unique-violation mapped to 409 via `err.code === "23505"` (:268–271). Re-declares its own `getAuthService` (:47).

**ebay-oauth.routes.ts (196)** — unauthenticated GET callback auto-creates a `channels.channels` row (:108–116); token persistence correctly delegated to `EbayAuthService.persistTokens` (adapters/ebay/ebay-auth.service.ts:291–305). Secrets from env only.

**ebay-settings.routes.ts (674)** — writes only `channel_connections` (:77–85, :318–336, :359–370) but has the deepest adapter reach-in (imports from five `adapters/ebay/*` files, :28–40); `POST /listings/test` publishes a REAL eBay listing with no local `channel_listings` record (:580–598); `merchantLocationKey` default `"CARDSHELLZ_HQ"` (:273) mismatches the push/sync default `"card-shellz-hq"` (ebay-listings.routes.ts:327, :903, :1457; ebay-sync-helpers.ts:300) — fresh-install pushes can reference a non-existent location key.

**Cross-cutting (eBay routes):** token refresh is NOT duplicated — all paths funnel through `EbayAuthService.getAccessToken` (adapters/ebay/ebay-auth.service.ts:89), the one clean seam. Everything else forks: two HTTP clients, three push implementations, two sync implementations, raw `console.*` logging throughout, no error classification anywhere.
