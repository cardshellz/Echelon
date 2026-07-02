# Audit 04 — Shipping Engine Seam (ShipStation → own engine swappability)

Scope: `server/modules/shipping/**`, `server/modules/oms/shipstation.service.ts` (3,868 lines), SHIP_NOTIFY V2 + legacy, pushShipment, markAsShipped, hold/release, void/cancel, engine_* columns, and every repo file mentioning "shipstation". Working tree audited post-commit 1fa0d30. All claims carry file:line evidence; statements not grounded in read code are labeled HYPOTHESIS.

---

## 1. SUBSYSTEM MAP

### 1.1 The intended seam (`server/modules/shipping/`)

| File | Contents |
|---|---|
| `shipping/engine.ts:26-106` | `ShippingEngine` port: `engineName`, `isConfigured`, `upsertShipment`, `cancel`, `hold`, `releaseHold`, `markShipped`, `updatePriority`, `getState`, `getShipments`, `normalizeWebhook`, `processWebhook`, `registerWebhook`, `sweepQueue?` |
| `shipping/types.ts` | Canonical vocabulary: `EngineRef` (L43-47), `CanonicalShipmentEvent` (L53-85), `ShipmentPushPayload` (L116-155), `EngineOrderState` (L167-174), `normalizeCarrier` (L30-37) |
| `shipping/adapters/shipstation.adapter.ts:108-235` | `createShipStationEngine(ss)` — thin delegation over the legacy service; `toEngineRef`/`fromEngineRef` (L33-53), `engineRefFromRow` (L59-77, engine-columns-first with legacy fallback) |
| `shipping/reconcile-derive.ts:31-78` | `deriveReconcileEvent` — engine-agnostic reconcile derivation (shipped/voided/cancelled/review) |
| `shipping/index.ts` | Barrel exports |

Wiring (`server/services/index.ts`): raw service built at L243 (`createShipStationService(db, inventoryCore)`), port wraps it at L246 (`createShipStationEngine(shipStation)`); **both** are exported in the registry (L291-292) and both injected into `WmsSyncService` (L253-254); raw-only into `SyncRecoveryService` (L260). `server/index.ts:488-489` stashes both on the db object (`__shipStationService`, `__shippingEngine`) for the retry worker; L483 stashes `__fulfillmentPush`.

### 1.2 The real engine implementation: `server/modules/oms/shipstation.service.ts` (3,868 lines — full map)

Module-level (outside factory):
- L25-28 constants: `EBAY_CHANNEL_ID = 67`, resource host, `shipstation_combined_child` source
- L30-39 `ShipStationWebhookProcessingError`; L65-78 `ShipStationPushError` `{code, shipmentId, field, value}`
- L45-49 `isShopifyFulfillmentPushEnabled()` (env flag, default ON)
- L103-136 `parseEchelonOrderKey` — parses `echelon-wms-shp-<id>` / `echelon-oms-<id>` orderKeys
- L144-207 row shapes (`WmsShipmentRow` includes `shipstation_order_id/key`, L152-153)
- L223-310 `resolveShipStationIds` — store/warehouse routing from `shipping_config` jsonb keyed `"shipstation"`, env defaults, hardcoded 319989/996884 fallback
- L312 `PUSHABLE_SHIPMENT_STATUSES = {planned, queued, voided}`
- L343-516 country normalization (`normalizeCountryToIso2`)
- L536-704 `validateShipmentForPush` (SS_PUSH_INVALID_SHIPMENT; integer-cents checks)
- L759-795 URL builders incl. `parseWmsShipmentItemLineKey` (`wms-item-<id>`, L780-786)
- L801-813 `mapShipStationCarrier` (SS→eBay carrier map)
- L815-827 `redactSensitiveUrl`

Inside `createShipStationService(db, inventoryCore)` (L833-3866):
- **HTTP client**: `apiRequest` L849-887 (Basic auth, 429-only retry w/ header-driven sleep)
- **Reads**: `getShipments` L907-950 (merges orderId+orderNumber queries for SS splits), `getOrderByKey` L956, `getOrderByNumber` L968, `getOrderById` L3117
- **Inbound SHIP_NOTIFY V2**: `deriveEventFromSSShipment` L1010-1047 (SS shipment → `ShipmentEvent`; void wins over ship), `resolveWmsShipmentForShipNotify` L1056-1083 (lookup by `shipstation_order_id`, fallback orderKey), `resolveShipmentByOrderKey` L1093-1186 (drift-adopt SS orderId, sibling resolution, `ship_notify_unresolved` dead-letter), `syncShipmentItemsFromShipStation` L1188-1413 (rewrites `outbound_shipment_items.qty`/`tracking_id` from SS payload; zeroes untouched rows L1385-1412), `resolveCombinedShipmentGroupsFromShipStationItems` L1415-1565 (**INSERTs synthetic `outbound_shipments` rows** for combined shipments, L1531-1544, advisory lock 918406), `processShipNotifyV2` L2170-2223, `applyShipNotifyV2EventToResolvedShipment` L2225-2358 (dispatch → rollup → OMS derive → inventory → channel pushes)
- **Inventory hookup**: `loadValidatedInventoryShipmentItems` L1567-1674 (incl. ship-before-pick bin fallback), `recordInventoryForShipment` L1676-1705 (calls `inventoryCore.recordShipment`), `applyShipmentQuantitiesToWmsOrderItems` L1707-1775 + fallback L1777-1798 (writes `wms.order_items.fulfilled_quantity/picked_quantity/status`)
- **OMS derivation (cross-boundary writes)**: `updateOmsLineFulfillmentFromWms` L2365-2400 (writes `oms.oms_order_lines`), `updateOmsDerivedFromEvent` L2402-2456 (writes `oms.oms_orders.status/fulfillment_status/tracking`), `recordShipmentEventV2` L2462-2505 (`shipped_via_shipstation` etc., 23505 dedup)
- **OMS finality guards**: L1812-1917; `markShipmentShippedAfterFinalOrderReview` L1919-1950
- **Channel push orchestration**: `pushShopifyFulfillmentFromShipNotify` L1957-2057 (via `(db as any).__fulfillmentPush`), delayed-tracking enqueues L2059-2159
- **Inbound legacy**: `processShipNotifyLegacy` L2517-2930 (orderKey-driven; direct WMS/OMS writes; **INSERTs shipped `outbound_shipments` row** L2745-2750; direct OMS-only inventory deduction L2787-2846)
- **Entry points**: `processShipmentNotification` L2934-2986 (V2→legacy fallback→`ship_notify_no_match` dead-letter), `processShipNotify` L2988-3030 (fetches resource_url, per-shipment try/catch, throws `ShipStationWebhookProcessingError` on any failure)
- **Webhook registration**: `registerWebhook` L3036-3071 (idempotent list+subscribe; **errors swallowed** L3068-3070)
- **Hold/priority/void-cancel**: `putOrderOnHold` L3082 (sentinel `holdUntilDate: "2099-12-31"`), `releaseOrderFromHold` L3099, `markAsShipped` L3132-3193 (getOrderById precheck; alreadyInState no-ops), `cancelOrder` L3201-3234 (createorder upsert w/ `orderStatus:'cancelled'`), sort-rank cluster L3241-3330 (`customField1`), `syncWmsOrderShipStationHoldState` L3332-3370
- **Outbound push**: `pushShipment` L3387-3846 — advisory lock 918407 (L3413-3414), status/held/requires_review guards (L3442-3486), cancelled-SS-order resurrect guard (L3491-3504), OMS finality blocker (L3567-3580), WMS-only data load, `orderKey = echelon-wms-shp-<id>` (L3644), eBay `EB-` prefix via `EBAY_CHANNEL_ID` (L3648-3651), self/sibling dedup query (L3740-3777), **orderKey pre-check against SS** (L3786-3803, the 1fa0d30 hardening), createorder POST, dual-write of legacy + engine columns + `status='queued'` (L3822-3834), `recomputeOrderStatusFromShipments` (L3836)

Returned surface (L3848-3865): 16 methods; the adapter consumes 13 of them.

### 1.3 WMS shipment state machine: `server/modules/orders/shipment-rollup.ts`
`markShipmentShipped` L199-329, `markShipmentCancelled` L357-435 (engine-cancel hook L404-423, port-first with `shipstation.removeFromList` fallback), `handleAddressChangeOnShipment` L465-516, `handleCustomerCancelOnShipment` L540-597, `markShipmentVoided` L624-732 (label-of-record guard L660-669), `recomputeOrderStatusFromShipments` L758-908, `dispatchShipmentEvent` L923-967, `cancelStaleShipmentsIfFullyCovered` L979-1024. Header claims (L4-8): mark-helpers are the ONLY writers of `outbound_shipments.status`; recompute the ONLY writer of `wms.orders.warehouse_status`. Imports `engineRefFromRow` **from the SS adapter file** (L42).

### 1.4 Entry points & schedulers
- SHIP_NOTIFY webhook: `server/index.ts:433-473` — shared-secret verify, host allowlist, `services.shippingEngine.processWebhook(resource_url)` (L451); on failure: enqueue retry (L464) **and** 500 (L471)
- Webhook registration: `server/index.ts:666-670` via port
- Reconcile (every 10 min, L1588-1589): V2 `runShipStationReconcileV2` L1174-1508 (port `getState`/`getShipments` + `deriveReconcileEvent` + `dispatchShipmentEvent`, but inline OMS writes L1371-1428 and a raw shipment-status write L1274-1279); V1 fallback L1511-1573 (reads `oms_orders.shipstation_order_id`, stamps `shipstation_reconciled_at` L1560)
- Engine queue sweeper: adapter `sweepQueue` (adapter.ts:225-233) → `server/modules/oms/shipstation-sweeper.ts` — **its own fetch client + Basic auth** (L150-167), its own orderKey regexes (L19-27), pages SS `awaiting_shipment`/`awaiting_payment` queues, writes review flags (L86-93) and `oms_order_events` (L63-79)
- Retry worker: `server/modules/oms/webhook-retry.worker.ts` — dispatchers for `shipstation_shipment_push` (L1004-1022, engine-first; permanent-classifies `SS_PUSH_INVALID_SHIPMENT` L1030-1040), `shipstation_hold_sync` (L1060-1166), `shipstation_sort_rank_sync` (L1168-1288), SHIP_NOTIFY (L1760-1789, `engine.processWebhook` first, raw fallback L1773)
- Hold/release/priority UI: `server/modules/orders/picking.routes.ts:25-103` — enqueue + immediate best-effort port calls (`hold`/`releaseHold` L50-52, `updatePriority` L92)
- Manual push routes: `server/routes/oms.routes.ts:300,353` — **raw** `ss.pushShipment`
- Recovery sweep: `server/modules/sync/sync-recovery.service.ts:199` — **raw** `shipStation.pushShipment`

### 1.5 Inbound event contract — two vocabularies (FACT)
There are **two parallel event types**: internal `ShipmentEvent` (`orders/shipment-rollup.ts:90-99`) produced by `deriveEventFromSSShipment` (shipstation.service.ts:1010-1047) and consumed by `dispatchShipmentEvent` — this is the **live SHIP_NOTIFY path**; and canonical `CanonicalShipmentEvent` (`shipping/types.ts:53-85`) produced only by `adapter.getShipments` (adapter.ts:176-205) and consumed only by the reconcile V2 job via `deriveReconcileEvent`. The port's `normalizeWebhook` is a **stub returning `[]`** (adapter.ts:211-219: "callers still use ss.processShipNotify directly. This will be implemented when C5 lands"). Normalization for the live webhook path happens *inside* the ShipStation service, not at the adapter boundary.

---

## 2. STATE & WRITERS

### 2.1 Columns
`wms.outbound_shipments` (shared/schema/orders.schema.ts:425-487): canonical triple `shipping_engine`/`engine_order_ref`/`engine_shipment_ref` (L447-449, migration 0573), legacy `shipstation_order_id`/`shipstation_order_key` (L454-455, migration 060), plus status/tracking/review/held/lifecycle columns.
`oms.oms_orders` (shared/schema/oms.schema.ts:100-106): legacy `shipstation_order_id`/`shipstation_order_key` + `shipping_engine`/`engine_order_ref` (migration 0574), `shipstation_reconciled_at` (migration 0560). **No `engine_shipment_ref`** on OMS.
Startup backfill dual-writes both generations: `server/db.ts:628-639`.
**No unique index exists on any engine_/shipstation_ column** — `idx_outbound_shipments_engine_ref` (0573:25-27) and `idx_oms_orders_engine_ref` (0574:17-19) are non-unique partial indexes. Idempotency relies on advisory locks + SS orderKey dedup, not schema constraints.

### 2.2 Writer matrix for `wms.outbound_shipments` (BOUNDARIES.md:155 says sole writer = WMS)

| Column(s) | Writers (file:line) | Verdict |
|---|---|---|
| `status` + tracking + lifecycle | `shipment-rollup.ts:278-287, 425-432, 699-708` (mark-helpers) | intended sole writer |
| `status='queued'`, `voided_at=NULL` | `shipstation.service.ts:3822-3834` (pushShipment) | **engine layer writes WMS lifecycle directly**, bypasses rollup helpers |
| `status='shipped'` raw | `shipstation.service.ts:2633-2641` (legacy SHIP_NOTIFY) | bypasses mark-helpers |
| `status='cancelled'` raw | `shipment-rollup.ts:1006-1015` (`cancelStaleShipmentsIfFullyCovered`) | bypasses `markShipmentCancelled` → **no engine-side cancel** for queued stale shipments |
| `status='shipped'` raw | `server/index.ts:1274-1279` (reconcile V2 "already terminal" branch) | bypasses `markShipmentShipped`; **no tracking/shipped_at set** |
| **Row INSERT** (shipped) | `shipstation.service.ts:2745-2750` (legacy SHIP_NOTIFY) | inbound engine data creates WMS shipment rows |
| **Row INSERT** (queued, w/ SS ids) | `shipstation.service.ts:1531-1544` (combined-child) | inbound engine data creates WMS shipment rows |
| Row INSERT (planned) | `wms/create-shipment.ts:355-358, 522-525`; `wms/line-item-hold.ts:64-70`; `orders/fulfillment.service.ts:107, 329` | WMS-side creators (legitimate) |
| `shipstation_order_id/key` + engine refs | pushShipment `3822-3834` (full dual-write); drift-adopt `1130-1136` (writes `shipstation_order_id` + `engine_order_ref`, **not** `shipping_engine`); combined-child `1531-1544` (full); `db.ts:639` backfill | engine layer |
| `shipstation_order_id/key` **only** (no engine refs) | `wms/create-shipment.ts:518-525` (`linkChildToParentShipment` — child inherits legacy columns; engine triple left NULL) | **dual-write gap: WMS ops code writes legacy columns** |
| `requires_review/review_reason` | shipstation.service.ts:1252-1258, 1323-1329, 1373-1380, 1646-1672, 1926-1932; shipstation-sweeper.ts:86-93; index.ts:1310-1318, 1488-1494 | many writers; index.ts:1492 writes raw error text into `review_reason` (others use stable codes) |
| `outbound_shipment_items.qty/tracking_id` | `shipstation.service.ts:1336-1412` (`syncShipmentItemsFromShipStation`) — **inbound SS payload rewrites WMS item quantities, zeroes untouched rows** | engine data mutates WMS "truth" (BOUNDARIES.md:160 says truth = wms.outbound_shipments) |
| `last_reconciled_at` | index.ts:1262-1266, 1285-1301, 1468-1472 | reconciler |

### 2.3 Cross-boundary writes to OMS from the engine/reconcile layer
BOUNDARIES.md:169-170: "WMS/reconcilers never write `oms_orders` directly." Violated in three duplicated implementations:
1. `shipstation.service.ts:2419-2429, 2442-2450` (`updateOmsDerivedFromEvent` writes `oms.oms_orders.status/fulfillment_status/tracking`), `2365-2400` (order lines), `2853-2869` (legacy path)
2. `server/index.ts:1371-1380, 1423-1428` (reconcile V2 inline "mirrors updateOmsDerivedFromEvent" per its own comment L1360-1361) + line-status CTE duplicate L1381-1411
3. `server/index.ts:1560` (V1 stamps `oms_orders.shipstation_reconciled_at`)

### 2.4 `wms.orders.warehouse_status` — two modules claim sole-writer
`orders/order-status-core.ts:2-6` ("the sole guarded writer... Direct UPDATEs forbidden outside this module") vs `shipment-rollup.ts:6-8` ("The only writer... is recomputeOrderStatusFromShipments in this file"). `recomputeOrderStatusFromShipments` UPDATEs `warehouse_status` raw (shipment-rollup.ts:841-905), not via `transitionOrderStatus`. Legacy SHIP_NOTIFY uses `markOrderShipped` (order-status-core) at shipstation.service.ts:2652-2653/2717-2718. Both claims cannot be true; the transition-matrix guard is not applied on the rollup path.

---

## 3. BOUNDARY VIOLATIONS

### 3.1 Direct calls bypassing the ShippingEngine port (non-test, outside adapter)

**Unconditional raw-service calls (no engine branch) — 10 sites:**
1. `server/routes/oms.routes.ts:300` — `ss.pushShipment(shipmentId)` (HTTP route, via `getShipStation` helper L25-26 pulling raw service from registry)
2. `server/routes/oms.routes.ts:353` — `ss.pushShipment(shipmentId)` (retired push-to-shipstation route delegating to shipment push)
3. `server/modules/sync/sync-recovery.service.ts:199` — `this.services.shipStation.pushShipment(id)` (scheduled recovery sweep; DI has no `shippingEngine` at all, L42)
4. `server/modules/oms/oms-webhooks.ts:1419` — `shipStationService.pushShipment(shipment.id)` (address-change re-push)
5. `server/modules/oms/oms-webhooks.ts:2136` — `shipStationService.markAsShipped(existing.shipstationOrderId, ...)` (orders/fulfilled mirror — also keyed on the **legacy OMS column**)
6. `server/modules/oms/oms-webhooks.ts:2323` — `shipStationService.cancelOrder(shipstationOrderId)` (refund cascade `shipstation` callback)
7. `server/modules/oms/oms-webhooks.ts:2332` — `shipStationService.pushShipment(shipmentId)` (refund cascade re-push helper)
8. `server/modules/oms/oms-webhooks.ts:374-385` — `cancelOrderCascade`'s `ssAdapter` wraps raw `opts.shipStationService.cancelOrder`; no engine parameter exists on the cascade
9. `server/modules/oms/wms-sync.service.ts:1711-1712` — `createShipStationService(db)` constructed inline for cancel-reconcile, fed to `cancelOrderCascade`
10. `server/modules/oms/wms-sync.service.ts:1796-1797` — same inline construction for GID-duplicate cleanup

**Engine-first with raw fallback (documented transitional) — 6 sites:** `wms-sync.service.ts:629, 1473` (pushShipment), `webhook-retry.worker.ts:1022` (pushShipment), `:1140` (syncWmsOrderShipStationHoldState — no port equivalent exists), `:1262` (updateSortRank), `:1773` (processShipNotify).

**Independent ShipStation API clients (bypass service AND adapter):** `oms/shipstation-sweeper.ts:150-167, 284-290` (own Basic auth + fetch; reached via the adapter's `sweepQueue`, which itself reads `SHIPSTATION_API_KEY/SECRET` env directly, adapter.ts:226-233); `scripts/test_mark_shipped.ts:2-7` (raw HTTPS).

### 3.2 Directional-contract violations (BOUNDARIES.md:167-172)
- Engine service writes `oms.oms_orders` / `oms_order_lines` directly (§2.3) — should go through an OMS interface.
- Inbound engine data creates/rewrites WMS shipment rows and item quantities (§2.2 rows 5-6, 12) — BOUNDARIES.md:171-172 says inbound events are "normalized and applied by WMS"; here the vendor service does the applying, including row creation.
- WMS module imports from the vendor adapter file: `orders/shipment-rollup.ts:42`, `orders/picking.routes.ts:15`, `webhook-retry.worker.ts:1124, 1246`, `server/index.ts` — `engineRefFromRow` is generic but lives in `shipping/adapters/shipstation.adapter.ts`, inverting the dependency direction (core → vendor adapter).
- The engine implementation itself lives in the **OMS module** (`server/modules/oms/shipstation.service.ts`), not in `shipping/` — the module layout contradicts the architecture (WMS ships; OMS shouldn't host the shipping engine).

### 3.3 Webhook ACK contract
`server/index.ts:449-472`: on processing failure the handler **both** enqueues a durable retry (L464) **and** returns 500 (L471), so ShipStation also retries. Double delivery is tolerated only because processing is idempotent (see §4). CLAUDE.md §6 prescribes inbox-then-2xx **or** 5xx; doing both is a deliberate belt-and-suspenders but multiplies replay traffic on persistent failures (SS retry × queue retry every 5 min, webhook-retry.worker.ts:169-197).

---

## 4. CORRECTNESS RISKS (ranked)

1. **Legacy SHIP_NOTIFY path can insert duplicate shipped shipment rows on replay.** `shipstation.service.ts:2745-2750` INSERTs into `wms.outbound_shipments` with `ON CONFLICT DO NOTHING`, but there is **no unique constraint** this can conflict on (Task-2 column inventory: all engine/SS indexes non-unique; no unique on (order_id, tracking_number)). The INSERT runs on every legacy-keyed notification including the "already shipped — running OMS repair cascade" replay branch (L2714-2715 does not skip it). Each replay can add another `status='shipped'` row, inflating `updateOmsLineFulfillmentFromWms` sums (L2370-2399) and `applyShipmentQuantitiesToWmsOrderItems*`. Scope-limited to pre-cutover `echelon-oms-*` orders, but those are exactly the ones SS re-delivers. (Inventory deduction itself is safe — see #7.)
2. **Reconcile V2 writes `status='shipped'` without tracking/shipped_at, bypassing the state machine.** `server/index.ts:1274-1279`: when WMS says cancelled but the engine order is terminal, the row is flipped to `shipped` raw — no `shipped_at`, no `tracking_number`, no `markShipmentShipped` idempotency/history, no order-level recompute in that branch. Violates the shipment-rollup sole-writer invariant (shipment-rollup.ts:4-8) and produces shipped rows that look unshipped to tracking consumers.
3. **`cancelStaleShipmentsIfFullyCovered` cancels queued shipments without engine cancel.** `shipment-rollup.ts:1006-1015` raw-UPDATEs planned/**queued** rows to cancelled; queued rows have live SS orders (engine ref) that are never cancelled — orphaned `awaiting_shipment` orders on the engine until the sweeper flags them for manual review (shipstation-sweeper.ts:224-234). Contrast `markShipmentCancelled` (L404-423) which calls the engine.
4. **SHIP_NOTIFY still creates WMS shipment rows from inbound data (combined-shipment path).** `shipstation.service.ts:1531-1544` inserts a synthetic `queued` child shipment (with SS ids) when an SS shipment spans multiple WMS orders — directly contradicting the same file's invariant comments ("We NEVER create new shipment rows", L1053-1054; "WMS is the sole creator", L1363-1366) and the intent of commit 1fa0d30. Advisory-locked and keyed by `external_fulfillment_id` (L1516-1529) so it is at least idempotent, but the engine remains a creator of WMS truth.
5. **Inbound SS item payload mutates WMS item quantities.** `syncShipmentItemsFromShipStation` (L1336-1412) sets `qty` from SS values and zeroes rows SS didn't mention (L1385-1396). A malformed/partial SS payload (items without `lineItemKey` matched by SKU/qty heuristic, L1222-1250) rewrites shipment composition. Guards exist (requires_review on unmapped items L1373-1380), but the write direction is engine→WMS on the very columns BOUNDARIES.md calls WMS-owned truth.
6. **`updateShipStationCustomField1` echoes a full SS order snapshot back via `createorder`** (`shipstation.service.ts:3279-3287`): GET → spread → POST. A stale read races a concurrent SS-side edit and clobbers it (cancelled-status is guarded, L3277, other fields are not). Same pattern in `cancelOrder` L3220-3223. HYPOTHESIS: low frequency, but it is a lost-update window on the engine.
7. Idempotency that **works** (for the record): `pushShipment` — advisory lock 918407 (L3413-3414) + self/sibling dedup (L3740-3777) + orderKey pre-check (L3786-3803); `markShipmentShipped/Voided/Cancelled` no-op replays (shipment-rollup.ts:243-249, 374-376, 646-648); `recordShipmentEventV2` 23505 dedup (L2497); inventory `recordShipment` pre-checks `inventory_transactions` on (ship, reference_id=shipmentId, order_item_id) inside a locked tx + `ship_dedup` constraint backstop (inventory.use-cases.ts:362-375, 448-450). V2 replays re-run the cascade deliberately and are inventory-safe.
8. **Error classification is thin at the API client.** `apiRequest` (L849-887) retries only 429; every other status becomes a generic `Error` string. Downstream, only `SS_PUSH_INVALID_SHIPMENT` is classified permanent (webhook-retry.worker.ts:1030-1040); an SS 400 on the API itself (not caught by local validation) retries to DLQ. Note stale comment at shipstation.service.ts:683-687 claiming the permanent class is "not yet wired" — it is wired (worker L1033).
9. **Hidden service handles on the db object.** `(db as any).__fulfillmentPush` (index.ts:483; read at shipstation.service.ts:1975, 2246, 2898), `__shipStationService`/`__shippingEngine` (index.ts:488-489; read at webhook-retry.worker.ts:753-763). Untyped, invisible dependency injection on the connection object — any code path with `db` can reach the raw engine.
10. **`registerWebhook` swallows failure** (shipstation.service.ts:3068-3070, catch → console.error, no rethrow/retry) — a failed registration silently disables inbound tracking until reconcile catches drift 10 min later per shipment.

---

## 5. SEAM ASSESSMENT (core)

**Verdict: the seam is real but one-directional and porous. Outbound commands are ~80% port-shaped; inbound eventing, identity, persistence, ops tooling, and vocabulary are still ShipStation-shaped. "C9 complete" describes the port's existence, not engine-agnosticism.** Swapping engines today means implementing the 13-method port **plus** re-implementing or emulating a set of SS-specific behaviors documented below.

### 5.1 Repo-wide census (grep -ril shipstation server/ — 44 non-test files)

- **Inside the seam (5):** `shipping/engine.ts`, `types.ts`, `index.ts`, `reconcile-derive.ts`, `adapters/shipstation.adapter.ts`
- **Engine implementation living outside the seam (3):** `oms/shipstation.service.ts` (the real engine), `oms/shipstation-sweeper.ts` (second API client), `oms/shipstation-date.util.ts` (SS date quirk)
- **Wiring exposing the raw service (3):** `services/index.ts` (243, 253-254, 260, 291, 342-343), `server/index.ts` (480, 488, 493), `server/db.ts` (628-639 column backfills — legitimate dual-write)
- **LEAK — raw calls or SS concepts in core logic (9):** `routes/oms.routes.ts` (300, 353), `sync/sync-recovery.service.ts` (199), `oms/oms-webhooks.ts` (374-385, 1419, 2134-2136, 2323, 2332), `oms/wms-sync.service.ts` (629, 1473 fallbacks; 1711-1712, 1796-1797 raw construction; 1771 legacy-column read), `oms/webhook-retry.worker.ts` (raw fallbacks 1022/1140/1262/1773; SS-named topics), `wms/create-shipment.ts` (488, 505-508, 518-525 legacy-only identity write), `wms/line-item-hold.ts` (47, 85-86 "pushed?" = `shipstation_order_id > 0`, no engine fallback), `dropship/infrastructure/dropship-ops-surface.repository.ts` (822, 890-892 legacy-only reads), `dropship/application/dropship-ops-surface-service.ts` (1202-1240 SS env readiness checks)
- **MIXED — port-compliant flow with legacy reads / SS event names (6):** `server/index.ts` (reconcile SQL 1184-1196, 1519-1531 + OMS writes), `orders/shipment-rollup.ts` (42, 131-132, 364-366, 410-413), `orders/picking.routes.ts` (15, 37-41, 80-85), `routes/shopify.routes.ts` (198), `oms/flow-trace.service.ts` (120-121, 262), `oms/flow-waterfall.service.ts` (111-138 DLQ bucketing by SS error strings)
- **PORT-COMPLIANT detection via canonical column (2):** `oms/oms-flow-reconciliation.service.ts` (386, 417, 928: `engine_order_ref IS NULL`), `oms/ops-health.service.ts` (374, 409)
- **COSMETIC — comments/log strings/dead plumbing (16):** `orders/fulfillment.service.ts`, `orders.storage.ts`, `picking.use-cases.ts`, `sort-rank.ts`, `wms/insert-order.ts`, `oms/ebay-order-ingestion.ts` (dead `setShipStationService`, 172-181 — injected at index.ts:493 but never read), `oms/fulfillment-push.service.ts`, `fulfillment-sweeper.scheduler.ts`, `channel-fulfillment.service.ts`, `shopify-line-item-normalizer.ts`, `shopify/admin-gql-client.ts`, `instrumentation/metrics.ts` (ss_* metric names), `routes/pick-priority.routes.ts` (enqueue only), `scripts/auth-audit.ts`, `fix_all_routes.ts`, `fix_orphaned_picks.ts`
- **LEAK (script):** `scripts/test_mark_shipped.ts` (raw API)

**Leakage count: 10 unconditional raw call sites + 6 engine-first fallbacks + 2 independent API clients + ~14 files reading legacy `shipstation_*` columns (2 of them writing legacy identity without engine refs).**

### 5.2 ShipStation concepts a new engine would be forced to emulate

1. **The orderKey scheme `echelon-wms-shp-<shipmentId>` / `echelon-oms-<id>`.** Generated at pushShipment L3644; parsed at `parseEchelonOrderKey` (L103-136), `resolveWmsShipmentForShipNotify` L1073-1082, the sweeper's own regexes (shipstation-sweeper.ts:19-27), and SHIP_NOTIFY's sibling-adopt logic (L3761-3768 preserves sibling keys because "SHIP_NOTIFY parses key → shipmentId"). The orderKey doubles as (a) the engine-side idempotency key (SS dedups on it), and (b) the fallback correlation identity inbound. A new engine must offer an equivalent client-supplied unique key with upsert semantics, or the duplicate-push protections (L3720-3803) and inbound fallback resolution collapse.
2. **Numeric engine order id.** `fromEngineRef` (adapter.ts:44-53) requires a positive integer — adapter-internal, fine. But `toEngineRef(Number(row.shipstation_order_id))` in V1 reconcile (index.ts:1542) and `Number(r.engineOrderRef)` in `markShipmentCancelled`'s legacy fallback (shipment-rollup.ts:412) bake numeric-ness outside the adapter.
3. **SS status vocabulary in "canonical" state.** `EngineOrderState.status` is a raw string (types.ts:170) filled with `ssOrder.orderStatus` verbatim (adapter.ts:168). `deriveReconcileEvent` compares `status === "cancelled"` (reconcile-derive.ts:69) and index.ts compares `!== "shipped"` / `!== "cancelled"` (L1250, 1269). A new engine must map its states onto ShipStation's `awaiting_shipment/shipped/cancelled/on_hold` words or reconcile misfires. The status enum was never canonicalized.
4. **Pull-based webhook model.** `processWebhook(resourceUrl)` (engine.ts:94) assumes "webhook = URL you fetch" — SS's resource_url pattern. The retry queue stores `resource_url` (webhook-retry.worker.ts:179-187, unique index on it per migration 073). A push-payload engine must synthesize fetchable resource URLs or the interface, the retry queue schema, and `flow-waterfall`'s `batchId` extraction (flow-waterfall.service.ts:422-425) all need rework. `normalizeWebhook` (the intended payload-based contract) is an unimplemented stub (adapter.ts:211-219).
5. **lineItemKey round-trip `wms-item-<shipment_item_id>`.** Emitted at push (L3690), parsed inbound (L780-786) to map SS shipment items back to WMS rows; the SKU/qty heuristic fallback (L1222-1250) exists precisely for payloads that drop it. A new engine must echo client line keys through its shipment objects, or every split/partial shipment lands in `requires_review`.
6. **Split/combine semantics.** `getShipments` merges orderId+orderNumber queries because SS splits spawn new internal order ids (L907-950); combined shipments spanning WMS orders spawn synthetic child rows (L1415-1565); the `EB-` orderNumber prefix (L3648-3651) and `customField1/2/3` metadata channel (L3701-3708: sort rank, `wms_order_id|shipment_id`, `oms_order_id`) are SS advanced-options concepts the pick-priority pipeline depends on (`updatePriority` port method exists, but the *meaning* — "engine displays sort key to packers" — is SS-workflow-specific).
7. **Hold semantics.** Indefinite hold is faked with `holdUntilDate: "2099-12-31"` (L3085-3088); release = `restorefromhold`. The port's `hold()/releaseHold()` is clean, but the ops model (hold syncs SS-side queue + sort-rank refresh before/after, L3341-3367) assumes an engine-side visible queue.
8. **`createorder` resurrect quirk as a design driver.** Multiple guards exist solely because SS's upsert reactivates cancelled orders (pushShipment L3487-3504, `updateShipStationCustomField1` L3275-3277, `deriveReconcileEvent`'s review-not-cancel rule referencing ENGINE-CANCEL-DIVERGENCE-DESIGN.md). These express as generic rules but their trigger conditions are SS-behavioral.
9. **Vendor-named durable state.** Audit event types `shipped_via_shipstation` / `cancelled_via_shipstation` / `voided_via_shipstation` (shipstation.service.ts:2469-2473; index.ts:1443-1447), event types `shipstation_queue_review_required`, `ship_notify_*`; retry topics `shipstation_shipment_push/_hold_sync/_sort_rank_sync` and provider `'shipstation'` (webhook-retry.worker.ts:1817); review reasons `shipstation_split_items_unmapped`, `shipstation_shipped_after_cancel`, etc.; metrics `ss_*` (metrics.ts:36-48); DLQ bucketing regexes over SS error strings (flow-waterfall.service.ts:111-138). A new engine either emits lies ("via_shipstation") or breaks every dashboard/DLQ classifier keyed to these strings.
10. **Config keyed by vendor name.** `shipping_config` jsonb keyed `"shipstation"` (resolveShipStationIds L262-299; channels.schema.ts:44, warehouse.schema.ts:116 — at least the jsonb is engine-keyed by design), env vars `SHIPSTATION_API_KEY/SECRET/WEBHOOK_SECRET/DEFAULT_STORE_ID/DEFAULT_WAREHOUSE_ID` checked in dropship readiness (dropship-ops-surface-service.ts:1202-1240) and read directly by the adapter's sweepQueue (adapter.ts:226-228).

### 5.3 Is shipstation.service.ts a monolith? Yes — quantified
One 3,033-line factory closure (L833-3866) mixes seven concerns: (1) vendor HTTP client; (2) outbound push + payload mapping + validation; (3) inbound webhook processing incl. **two** generations of handlers; (4) WMS shipment/item persistence and repair; (5) OMS status/line derivation (cross-boundary); (6) inventory deduction orchestration; (7) channel (Shopify/eBay) fulfillment push scheduling. Only (1), (2)-mapping, and the SS-quirk parts of (3) belong in an adapter. The adapter header admits this: "Phase 1 strategy: thin delegation... the adapter will stop loading from DB and become a pure API translator" (adapter.ts:5-11) — that phase never completed.

### 5.4 What building their own engine requires touching TODAY (real seam surface)

Minimum to make traffic flow (assuming the new engine mimics SS semantics):
1. New adapter implementing `ShippingEngine` (engine.ts:26-106) — but **`upsertShipment` cannot be implemented from the payload**: the SS adapter ignores `ShipmentPushPayload` and calls `ss.pushShipment(payload.shipmentId)` which re-reads everything from the DB (adapter.ts:118-124, service L3417-3639). A new engine must duplicate ~450 lines of pushShipment's DB loading, guards, dedup and dual-writes, or that logic must first be hoisted out of the SS service.
2. `processWebhook`: implement the entire inbound cascade — resolution (L1056-1186), item sync (L1188-1413), combined groups (L1415-1565), event application (L2225-2358), OMS derive (L2365-2456), inventory (L1567-1705), channel pushes (L1957-2159) — none of which is engine-generic today; or first extract it to a WMS-owned applier keyed on `CanonicalShipmentEvent` and implement only `normalizeWebhook` (currently a stub).
3. Rewire raw call sites (§3.1: 10 unconditional + 6 fallbacks) or keep a `shipStation`-shaped shim.
4. Reproduce/replace: orderKey scheme + lineItemKey echo (§5.2 #1, #5), status-word mapping (#3), resource_url webhook model (#4).
5. Data: rows where `shipping_engine IS NULL`/legacy-only (create-shipment.ts children; pre-0573 rows) resolve via `engineRefFromRow`'s legacy fallback **which hardcodes engine='shipstation'** (adapter.ts:73-75) — mixed-engine operation misroutes them unless backfilled first; `line-item-hold.ts:85-86` and dropship reads see engine-only rows as "not pushed".
6. Ops surface: sweeper equivalent, retry topics, metrics, DLQ classifiers, dashboards keyed to `*_via_shipstation` events.
7. Config: new key in `shipping_config` jsonb (already designed for this), new env vars, dropship readiness checks.

The **intended** surface was: "write one adapter file." The **actual** surface is: 1 adapter + extraction of ~2,000 lines of pipeline out of the SS service + 16 call-site rewires + vocabulary/dashboard migration.

---

## 6. REFACTOR RECOMMENDATIONS

Ordered to de-risk the engine swap; each step is independently shippable.

1. **Extract the inbound applier out of the vendor service (highest value).** Create `wms/shipment-event-applier.ts` owning: resolve-shipment, item sync, `dispatchShipmentEvent`, rollup, OMS-derive (via an OMS interface, fixing §2.3), inventory recording, channel-push scheduling — consuming only `CanonicalShipmentEvent`. Implement the adapter's `normalizeWebhook` for real (deriveEventFromSSShipment + item mapping is 90% of it); reduce `processWebhook` to fetch→normalize→apply. This is the "C5" the adapter comment promises (adapter.ts:211-219).
2. **Make `upsertShipment` consume `ShipmentPushPayload`.** Hoist pushShipment's DB loading/guards/dedup into an engine-neutral `preparePushPayload()` (WMS-side) + `persistEngineRefs()` (WMS-side); leave only payload→SS-JSON mapping and the API call in the adapter. The advisory lock, sibling dedup, and finality guards are engine-neutral and belong on the WMS side of the port.
3. **Canonicalize `EngineOrderState.status`** to an enum (`open|held|shipped|cancelled|unknown`) mapped in the adapter; fix `deriveReconcileEvent` and index.ts comparisons.
4. **Close the raw-service surface.** Delete `shipStation` from the service registry export (services/index.ts:291), route oms.routes.ts:300/353, sync-recovery:199, oms-webhooks (1419/2136/2323/2332, cancelOrderCascade), wms-sync inline constructions (1711/1796) through `shippingEngine`; add `syncHoldState`-equivalent via existing `hold/releaseHold` (the worker already shows how, webhook-retry.worker.ts:1123-1137); then drop the four fallback branches.
5. **Fix writer control:** route index.ts:1274-1279 through `markShipmentShipped` (or a `markShipmentShippedFromEngineTerminal` helper); make `cancelStaleShipmentsIfFullyCovered` call `markShipmentCancelled` per row (engine cancel included); remove the legacy SHIP_NOTIFY row-INSERT (2745-2750) or key it with a real unique constraint; decide one sole writer for `warehouse_status` (rollup vs order-status-core) and delete the other claim.
6. **Move the seam's files home:** `shipstation.service.ts` (post-extraction remnant), `shipstation-sweeper.ts`, `shipstation-date.util.ts` → `shipping/adapters/`; move `engineRefFromRow` to `shipping/types.ts` (it's engine-neutral) so WMS never imports from an adapter path.
7. **De-vendor durable vocabulary** before the swap, behind compatibility views if dashboards need them: event types → `shipped_via_engine` + `{engine}` in details; retry topics → `engine_shipment_push` etc.; metrics → `engine_push_*`. Migrate `review_reason` raw-error writes (index.ts:1488-1494) to stable codes.
8. **Dual-write hygiene:** add engine-ref inheritance to `create-shipment.ts:518-525`; add `COALESCE(engine_order_ref, ...)` to `line-item-hold.ts:47/85-86` and the dropship repository reads; backfill `shipping_engine IS NULL` rows, then execute the CLAUDE.md post-soak TODO (drop legacy columns, delete COALESCEs).
9. **Replace db-object stashing** (`__fulfillmentPush`, `__shipStationService`, `__shippingEngine`) with explicit constructor injection; the retry worker already has the resolution seam to swap (webhook-retry.worker.ts:753-763).
10. **Add unique indexes** to back idempotency at the schema: partial unique on `outbound_shipments(shipping_engine, engine_order_ref)` for active rows, and a dedup key for the legacy insert path if kept.

---

## 7. UNKNOWNS

- **`registerOmsWebhooks` internals beyond the grepped sites** — oms-webhooks.ts is 2,371 lines; I read the fulfilled/refund/address-change/cancel-cascade regions and grepped the rest; other SS touchpoints inside it beyond lines cited would need a full read. (Delegated sweep found none, but that is one pass, not a proof.)
- ~~`shipment_dedup` constraint~~ RESOLVED: it exists — `uq_oms_order_events_shipment_dedup` unique index created in `migrations/0571_oms_order_events_ship_dedup.sql:38`; the 23505 catch at shipstation.service.ts:2497 is backed by schema.
- **Runtime flag states in production** (`RECONCILE_V2`, `SHOPIFY_FULFILLMENT_PUSH_ENABLED`, scheduler-disable flags): which reconcile generation actually runs, and whether the V1 path (with its `oms_orders.shipstation_order_id` reads) is live, cannot be verified from code (env unavailable). CLAUDE.md notes dev DB is empty; production behavior unverifiable here.
- **`inventoryCore.recordShipment` dedup key collision across paths**: V2 passes WMS shipment id as `shipmentId` (L1693), legacy passes the SS shipment id (L2837). Both are strings into `reference_id`; a numeric collision between a WMS shipment id and an SS shipment id would false-positive the dedup check (inventory.use-cases.ts:364-371). HYPOTHESIS: plausible in principle (both are integer sequences); likelihood unquantified.
- **eBay tracking push correctness** (`mapShipStationCarrier` → eBay codes, L801-813) — the eBay side (fulfillment-push.service) was only skimmed; carrier-code fidelity for a new engine not assessed.
- **INSUFFICIENT EVIDENCE on frontend/client**: only `server/` was in scope; any client-side reads of `shipstation_order_id` (e.g. admin UI deep links) were not audited.
