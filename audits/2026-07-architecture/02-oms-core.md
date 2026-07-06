# AUDIT — OMS CORE (server/modules/oms/**, excluding shipstation.service.ts / wms-sync.service.ts)

Audit date: 2026-07-02. Read-only. All claims cite file:line from /home/user/Echelon.
Interfaces to excluded files (shipstation.service.ts, wms-sync.service.ts) are described as call surfaces only.

---

## 1. SUBSYSTEM MAP

| Component | File | Role |
|---|---|---|
| Order ingestion service | `server/modules/oms/oms.service.ts` | `ingestOrder` (dedup upsert), `reserveInventory`, `assignWarehouse`, `markShipped(ByExternalId)`, `populateShopifyFulfillmentOrderIds`, reads |
| Shopify webhook handlers | `server/modules/oms/oms-webhooks.ts` (2,371 lines) | 5 endpoints: orders/paid, orders/updated, orders/cancelled, orders/fulfilled, refunds/create. Also owns `cancelOrderCascade`, `applyShopifyRefundCascade`, `applyRefundLineAdjustmentsToWms` |
| eBay ingestion | `server/modules/oms/ebay-order-ingestion.ts` | Poll + webhook ingest, cancel/refund reconciliation against OMS |
| Channel write-back | `server/modules/oms/fulfillment-push.service.ts` (2,658 lines) | `pushTracking`, `pushTrackingForShipment`, `pushShopifyFulfillment` (+combined-group fan-out), `cancelShopifyFulfillment`, `updateShopifyFulfillmentTracking`, `reconcileShopifyFulfillment`, dropship marketplace tracking |
| Channel-origin fulfillment | `server/modules/oms/channel-fulfillment.service.ts` | `applyChannelFulfillment` — flows Shopify/eBay-bought labels through WMS shipment rollup, derives OMS status |
| Fulfillment sweeper | `server/modules/oms/fulfillment-sweeper.scheduler.ts` | Hourly outbound sweep (OMS shipped but channel unfulfilled → repush) + inbound sweep (channel fulfilled but WMS open → pull tracking). Advisory-locked (ids 8484/8485, :156-157) |
| Reconcilers | `server/modules/oms/reconcilers/{shopify,ebay}.reconciler.ts` | Channel-status check + repush; no direct DB writes (shopify.reconciler.ts delegates to fulfillmentPush + `enqueueShopifyFulfillmentRetry`:126) |
| Flow reconciliation | `server/modules/oms/oms-flow-reconciliation.service.ts` | 15-min scheduler (:1210-1212) detecting OMS/WMS divergence; `remediateOmsFlowIssue` performs guarded corrective writes |
| Webhook inbox | `server/modules/oms/webhook-inbox.service.ts` | Durable inbox, unique `idempotency_key` (schema: `shared/schema/oms.schema.ts:392`), persist-before-ACK |
| Retry worker / DLQ | `server/modules/oms/webhook-retry.worker.ts` (2,075 lines) | `MAX_ATTEMPTS = 5` (:11), exponential backoff 2^attempts min (:1571), `markRowDead`, DLQ CRITICAL alerts, inbox mirroring (:1710-1735) |
| HTTP routes | `server/routes/oms.routes.ts` | Read endpoints + manual ops: assign-warehouse, mark-shipped, reserve, shipment push, inbox replay, retry requeue, remediation |
| Financial snapshot helpers | `server/modules/oms/wms-sync-financials.ts` | Pure validation (`ensureCents`, `ensureCurrencyCode`) + snapshot builders for OMS→WMS sync |
| Schema | `shared/schema/oms.schema.ts` | `oms_orders`, `oms_order_lines`, `order_line_adjustments`, `oms_order_events`, `webhook_retry_queue`, `webhook_inbox` |

**Call interfaces to excluded files (described only):**
- `wmsSyncService.syncOmsOrderToWms(omsOrderId) → wmsOrderId|null` — called via `ensureOmsOrderQueuedForWmsSync` (oms-webhooks.ts:47-70); failure enqueues `enqueueOmsWmsSyncRetry`.
- `wmsSyncService.propagateOmsEditsToWms(omsOrderId, newLineItems) → {updated, added, removed, flaggedForReview}` — called from orders/updated (oms-webhooks.ts:1895-1898). Defined at wms-sync.service.ts:1185 (not audited here).
- `shipStationService.{isConfigured, pushShipment(shipmentId), markAsShipped(ssOrderId, opts), cancelOrder(ssOrderId)}` — interface declared at oms-webhooks.ts:90-100.
- `shippingEngine.cancel({engine, engineOrderRef, engineShipmentRef?})` — injected into cancel/refund cascades (oms-webhooks.ts:1286, 2327).
- WMS published functions imported by OMS core: `../orders/shipment-rollup` (`handleCustomerCancelOnShipment`, `recomputeOrderStatusFromShipments`, `markShipmentCancelled`, `dispatchShipmentEvent`, `handleAddressChangeOnShipment`) and `../orders/order-status-core` (`cancelOrder`, `markOrderShipped`).

---

## 2. STATE & WRITERS

### 2.1 `oms.oms_orders.status` / `financial_status` — the answer to "who owns transitions"

**There is NO single guarded state-machine function.** Transitions are scattered across at least 11 distinct writer locations in 3+ modules plus the composition root. BOUNDARIES.md itself flags the reverse-leak as a violation to eliminate (BOUNDARIES.md:163-165, 170-171: "WMS/reconcilers never write `oms_orders` directly").

| # | Location | Transition | Guarded? |
|---|---|---|---|
| 1 | `oms.service.ts:484-486` `assignWarehouse` | → `confirmed` | **UNGUARDED** (`WHERE id =` only; can resurrect a cancelled order) |
| 2 | `oms.service.ts:505-516` `markShipped` | → `shipped` + fulfillment_status | **UNGUARDED**; `markShippedByExternalId` (:827) does a non-atomic pre-read check (TOCTOU) |
| 3 | `oms-webhooks.ts:1664-1694` orders/updated | → `cancelled` (if payload.cancelled_at) + unconditional `financialStatus` overwrite (:1675) | **UNGUARDED**, last-writer-wins, no out-of-order protection |
| 4 | `oms-webhooks.ts:2004-2012` orders/cancelled | → `cancelled` + financial_status | **UNGUARDED**; pre-read check at :1994 (TOCTOU) |
| 5 | `oms-webhooks.ts:2099-2109` orders/fulfilled (no-WMS fallback) | → `shipped` | **UNGUARDED**; pre-read check at :2065 |
| 6 | `oms-webhooks.ts:2266-2291` refunds/create | financial_status → (partially_)refunded, `refund_amount_cents` increment | Transactional with idempotency marker, but increment computed from a stale JS read (see §4 C2) |
| 7 | `channel-fulfillment.service.ts:149-159` `updateOmsFromRollup` | → derived shipped/partially_shipped | **UNGUARDED** |
| 8 | `oms-flow-reconciliation.service.ts:1069-1099` (WMS_FINAL_OMS_OPEN) | → shipped/cancelled from WMS | **GUARDED** (`AND oo.status NOT IN ('cancelled','shipped','partially_shipped','refunded')` :1098) |
| 9 | `oms-flow-reconciliation.service.ts:1131-1148` (SHIPMENT_SHIPPED_OMS_OPEN) | → shipped | **GUARDED** (`AND oo.status NOT IN ('shipped','partially_shipped')` :1147) |
| 10 | `ebay-order-ingestion.ts:259-262` poll cancel | → cancelled | **GUARDED** (`AND status != 'cancelled'`) — one of only three guarded writers |
| 11 | `ebay-order-ingestion.ts:285-292` poll refund | financial_status + `refund_amount_cents` **overwrite** (not increment) | **UNGUARDED** |
| 12 | `server/index.ts:856-863` eBay reconcile sweep (composition root!) | → shipped, raw SQL | **UNGUARDED** (SELECT filtered on status='confirmed' :834, but UPDATE itself unguarded — TOCTOU) |
| 13 | `server/index.ts:1371-1380` ShipStation Reconcile V2 | → shipped/partially_shipped, raw SQL | **UNGUARDED** |
| 14 | `server/index.ts:1423-1428` ShipStation Reconcile V2 | → cancelled, raw SQL | **UNGUARDED** — engine event can overwrite any OMS state incl. shipped |
| 15 | `server/modules/orders/fulfillment.service.ts:522-532` (WMS module) | → shipped | **UNGUARDED** — the exact "reverse leak" BOUNDARIES.md:163-165 prohibits |
| 16 | `server/modules/oms/wms-sync.service.ts:1722` | (excluded file — listed for completeness) | not audited here |
| 17 | `server/modules/oms/shipstation.service.ts:2420, 2444, 2854` | (excluded file — listed for completeness) | not audited here |

Non-status column writers (for completeness): `oms.service.ts:302-309` (channelShipByDate), `member-tier-enrichment.ts:63-66` (memberTier), `orders.storage.ts:1496-1508` (customer/ship-to backfill), `server/index.ts:1560` (`shipstation_reconciled_at`), `server/db.ts:632` (one-time engine-ref backfill).

### 2.2 `oms.oms_order_lines`
Writers: `oms.service.ts:241-265, 349-373` (insert at ingest, `onConflictDoNothing`), `oms.service.ts:970-978` (FO-id populate, guarded WHERE), `oms-webhooks.ts:1813-1832` (edit update), :1839-1861 (edit insert), :1870-1873 (zero removed lines), `channel-fulfillment.service.ts:161-188` (fulfillment_status recompute), `fulfillment-push.service.ts:1208-1219` (Path-B self-healing FO-id back-write, guarded), `server/index.ts:1381-1411` (line fulfillment_status recompute from composition root), `oms.service.ts:519-522` + `oms-webhooks.ts:2111-2114` + `orders/fulfillment.service.ts:534-537` (blanket `fulfillmentStatus='fulfilled'`).

### 2.3 `oms.oms_order_events` (audit trail)
- **Append-only confirmed:** grep for `update(omsOrderEvents)`, `delete(omsOrderEvents)`, `UPDATE/DELETE ... oms_order_events` across `server/` returns zero matches. Only INSERTs exist.
- Schema (`shared/schema/oms.schema.ts:233-241`): no updatedAt column; FK `onDelete: "cascade"` (:235) means deleting an order would purge its financial history — theoretical loophole; no order-delete code was found, but the schema does not protect the trail.
- Correlation threading is **ad hoc**: many events carry `wmsShipmentId`/`wmsOrderId`/`refundExternalId` in `details` JSON (e.g. fulfillment-push.service.ts:1380-1390, oms-webhooks.ts:995-1004, channel-fulfillment.service.ts:108-119), but there are no first-class correlation columns, and some transitions write **no event at all** (eBay poll cancel/refund, ebay-order-ingestion.ts:259-292; `server/index.ts:1371-1428` writes events only per shipment event kind at :1439-1457).

### 2.4 `oms.webhook_inbox` / `oms.webhook_retry_queue`
Writers confined to `webhook-inbox.service.ts` (:142-217, :255-289) and `webhook-retry.worker.ts` (enqueue*/markRow*/recordRetryFailure) plus `oms-webhooks.ts:1383-1389` (`handleProcessingFailure` insert). Unique `idempotency_key` (oms.schema.ts:392) gives constraint-backed dedup. Sound design.

### 2.5 WMS tables written FROM OMS core (see §3 violations)
- `wms.orders`: oms-webhooks.ts:1725-1744 (ship-to, financial_status, `warehouse_status pending→ready` promotion).
- `wms.outbound_shipment_items.qty` + `wms.order_items.status`: oms-webhooks.ts:602-643 (`applyRefundLineAdjustmentsToWms` raw SQL).
- `wms.outbound_shipments.requires_review/review_reason`: oms-webhooks.ts:688-694.
- `wms.returns` / `wms.return_items`: oms-webhooks.ts:937-972.
- `wms.outbound_shipments`: shipstation-sweeper.ts:87.
- `wms.orders.assigned_picker_id`: oms-flow-reconciliation.service.ts:1031.
- `wms.outbound_shipments.shopify_fulfillment_id`: fulfillment-push.service.ts:1358-1364 (guarded, correct owner would be WMS but this is the write-back of the engine ref the push itself created).

---

## 3. BOUNDARY VIOLATIONS

1. **Reverse leak (worst): non-OMS code writes `oms_orders.status`.**
   - `server/index.ts:856-863, 1371-1380, 1423-1428` — two reconciler sweeps inlined in the composition root write status via raw SQL. Explicitly named as the violation to eliminate in BOUNDARIES.md:163-165.
   - `server/modules/orders/fulfillment.service.ts:522-532` — WMS fulfillment service marks OMS orders shipped directly instead of calling an OMS interface (BOUNDARIES.md:170-171: "WMS calls an OMS interface so OMS transitions `oms_orders.status`").

2. **Forward leak: OMS webhook code writes `wms.*` directly.**
   - oms-webhooks.ts:1725-1744 — orders/updated rewrites `wms.orders` shipping/financial columns and promotes `warehouse_status` pending→ready with raw SQL, bypassing the WMS interface (BOUNDARIES.md:154: WMS is sole writer of `wms.orders.warehouse_status`).
   - oms-webhooks.ts:602-694, 937-972 — refund cascade mutates `wms.outbound_shipment_items.qty`, `wms.order_items.status`, `wms.returns`, `wms.return_items` via raw SQL inside the OMS module. It *does* route shipment cancels through `markShipmentCancelled`/`recomputeOrderStatusFromShipments` (:696-757), but the qty/return writes are direct.
   - shipstation-sweeper.ts:87 — direct `UPDATE wms.outbound_shipments`.

3. **Business logic in routes (minor but real).**
   - `server/routes/oms.routes.ts:244-271` `/orders/:id/mark-shipped` — orchestrates markShipped + channel push; the logic lives in services, but the endpoint mutates OMS state with **no WMS involvement**, manufacturing OMS-shipped/WMS-active divergence by design; push failure is console-only (:261).
   - `server/routes/oms.routes.ts:331-343` — raw `wms.*` SQL lookup inside a route (read-only, but the route reaches across two schemas).

4. **Cross-schema joins from OMS core into `wms.*`** throughout (e.g. fulfillment-push.service.ts:533-556, 620-648; fulfillment-sweeper.scheduler.ts:91-103). BOUNDARIES.md:14 prohibits cross-owned-table inner joins; reads are tolerated by the sole-writer matrix ("others may read") so these are gray-zone, but they hard-couple OMS code to WMS schema shape.

5. **Composition-root schedulers** (`server/index.ts` eBay reconcile, ShipStation Reconcile V2) implement OMS/WMS reconciliation logic outside any module — no owner, no tests adjacent, duplicated OMS-derive logic ("mirrors updateOmsDerivedFromEvent", index.ts:1360-1361).

---

## 4. CORRECTNESS RISKS (ranked)

### CRITICAL
- **C1 — No single writer/state machine for `oms_orders.status`/`financial_status`** (§2.1). 11+ writers, 3 guarded. Concrete failure modes: (a) `assignWarehouse` (oms.service.ts:484-486) can flip a `cancelled` order to `confirmed` (callable from the route at oms.routes.ts:226-239 and from the orders/paid race path at oms-webhooks.ts:1560-1566); (b) ShipStation reconcile cancel (index.ts:1423-1428) can overwrite `shipped`; (c) WMS fulfillment.service.ts:522-532 can overwrite `cancelled` with `shipped`. Every writer that pre-checks status does it read-then-write (TOCTOU), not `UPDATE ... WHERE status = ?`.

- **C2 — Refund amount lost-update race** (oms-webhooks.ts:2260-2275). `newRefundAmountCents = priorRefundCents + thisRefundCents` is computed in JS from `existing` fetched at :2189-2213, then written inside the transaction. Two *different* refunds for the same order processed concurrently (webhook + retry worker, or two dynos) both read the same prior value → one refund amount silently lost on a financial column. The per-refund marker (:2247-2255) only prevents same-refund replay, not cross-refund races. No `SET refund_amount_cents = refund_amount_cents + X`, no row lock.

### HIGH
- **H1 — orders/cancelled retry is defeated by its own TOCTOU check.** Handler sets `status='cancelled'` (:2004-2012) *before* running `cancelOrderCascade` (:2014-2020). If the cascade throws, the catch enqueues a retry (:2032-2038) — but the replay re-enters the handler, sees `existing.status === "cancelled"` (:1994) and early-returns success. The cascade (reservation release, shipment cancel, WMS cancel) never completes via retry; recovery depends entirely on the 15-min flow reconciler (`OMS_FINAL_WMS_ACTIVE`, oms-flow-reconciliation.service.ts:1005-1054). Inventory stays reserved in the gap.

- **H2 — No transaction around multi-step webhook writes.** orders/updated performs: oms_orders update (:1664) → wms.orders update (:1725) → cancel cascade (:1747) → per-line updates/inserts/zeroing (:1813-1879) → WMS propagation (:1895) → event insert (:1941) — all as separate statements. A crash mid-way leaves OMS/WMS lines diverged with only whole-handler replay as recovery. `cancelOrderCascade` (oms-webhooks.ts:345-446) is likewise non-atomic across reservation release → shipment cancels → WMS cancel → event.

- **H3 — Order edits never refresh header money totals.** The orders/updated `.set()` (:1666-1693) carries no `subtotalCents/totalCents/discountCents/taxCents`; `ingestOrder` is insert-only for existing orders. After a Shopify order edit (upsell/qty change), `oms_orders.total_cents` is stale while lines are updated — finance analytics (finance-analytics.service.ts reads header cents) and the WMS financial snapshot (`buildWmsOrderFinancialSnapshot`, wms-sync-financials.ts:117-135, reads header cents) both propagate stale money.

- **H4 — Edit-propagation failure to WMS is swallowed.** oms-webhooks.ts:1911-1915: `propagateOmsEditsToWms` failure is `console.error` only — no `enqueueOmsWmsSyncRetry`, no event, no requires_review. OMS lines and WMS pick lines diverge silently; a picker can pick quantities the customer already removed. (Contrast: sync failures do enqueue, :1917-1922.) Whether WMS-side guards block edit-vs-pick races lives in `propagateOmsEditsToWms` (wms-sync.service.ts:1185) — **not verifiable from OMS core; owned by the wms-sync auditor.**

- **H5 — refunds/create financial_status derivation is per-payload, not cumulative** (oms-webhooks.ts:2232-2234). `refundedQty >= totalOrderQty` compares only *this* refund's line quantities to the whole order: two partial refunds that cumulatively refund everything leave `partially_refunded`; a money-only refund (no line items, e.g. shipping refund) with full monetary value also yields `partially_refunded`. `financial_status='refunded'` gates the cancel semantics in `deriveOmsUpdateFinality` (:1048-1051) and reconciler queries, so misclassification changes downstream cancellation behavior.

### MEDIUM
- **M1 — `wms.returns` idempotency has no constraint backstop.** SELECT-then-INSERT keyed on `(refund_external_id, order_id)` (oms-webhooks.ts:880-899, 937-948); migrations/062_returns.sql:53-55 creates a plain (non-UNIQUE) index. Concurrent duplicate deliveries can double-insert return rows. Same event-marker-only pattern for eBay order-level tracking push (`pushToEbay`, fulfillment-push.service.ts:558-618) which has **no** prior-push check at all (the shipment-scoped path does, :703-716).
- **M2 — Shopify push retry has no permanent-error classification.** `dispatchShopifyFulfillmentRetry` (webhook-retry.worker.ts:1296-1379) retries ALL errors — including deterministic `SHOPIFY_PUSH_USER_ERRORS` / `SHOPIFY_PUSH_INVALID_INPUT` — up to 5 attempts before DLQ. Violates CLAUDE.md §6 ("never retry a permanent error"); bounded, but contrast the ShipStation branch which classifies (`markShipmentPushPermanentlyFailed`, :1030-1039, 1644-1673).
- **M3 — Unguarded status overwrites from stale/out-of-order webhooks.** orders/updated overwrites `financial_status`/ship-to from payload with no Shopify `updated_at` comparison (:1675-1694); Shopify does not guarantee delivery order. A delayed older webhook regresses newer state.
- **M4 — orders/updated repush loop protection is behavioral, not structural.** `deriveOmsUpdateFinality` (:1044-1055) fixed the #57977 re-cancel loop, but `cancelOrderCascade` remains re-runnable on every `cancelled_at`-bearing update (:1746-1754); idempotency rests on downstream shipment handlers being no-op-safe, not on a cascade-level marker.
- **M5 — refund cascade side effects run before the idempotency check.** `persistRefundLineAdjustments` + `applyRefundLineAdjustmentsToWms` (:862-875) execute before the returns dedup check (:880); adjustments are ON-CONFLICT-safe (oms.schema.ts:216) and qty recompute is derived-idempotent, but a replay re-triggers `pushShipment` re-pushes to the engine (:716-724) — repeated external side effect.
- **M6 — `orders/paid` "isNew" heuristic is wall-clock based** (`createdAt` within 5s, oms-webhooks.ts:1530; also ebay-order-ingestion.ts:252): violates determinism (CLAUDE.md §3); a slow transaction misclassifies new orders as existing, skipping member-tier enrichment and MC push.
- **M7 — Sweepers/reconcilers log-and-continue on every error** (fulfillment-sweeper.scheduler.ts:66-77, 136-145; index.ts:878-886): no metric, no event, no requires_review. A channel-side permanent rejection loops hourly forever (repush failures enqueue retry only inside shopify.reconciler.ts:126-130).

### LOW
- **L1 — `dollarsToCents` float parse at boundary** (oms-webhooks.ts:125-128): `Math.round(parseFloat(v) * 100)` — acceptable for Shopify 2-dp strings, but `parseFloat` on money violates the letter of CLAUDE.md §4; event `details.totalRefundAmount` is a raw `parseFloat` sum in dollars (oms-webhooks.ts:2286-2288) — display-only, but a float dollar value is being persisted into the audit trail alongside integer cents.
- **L2 — eBay refund amounts are guesses** (ebay-order-ingestion.ts:283-292): full refund = totalCents, partial = 0, overwrite semantics — documented best-effort, but `refund_amount_cents` on eBay orders is unreliable and a later full-refund poll can clobber a prior value.
- **L3 — refunds/create endpoint lacks the rate limiter** applied to the other four webhooks (oms-webhooks.ts:2170 vs :1508, :1632, :1974, :2045).
- **L4 — `verifyAndParse` ACKs 200 on empty/unparseable body** (oms-webhooks.ts:1318-1322, 1343-1347) — deliberate to stop Shopify retries, but the payload is dropped without an inbox row (contradicts CLAUDE.md §6 "persist to the inbox first, then 2xx").
- **L5 — Logging is raw `console.*` with prefixes**, not the structured JSON logger with correlation context required by CLAUDE.md §10; a single-order life story requires the flow-trace service's heuristic payload matching (oms.service.ts:576-618) rather than threaded IDs.
- **L6 — `oms_order_events` FK `onDelete: cascade`** (oms.schema.ts:235) — audit history dies with the order row if a delete path is ever added.

### What works well (evidence)
- Ingest dedup is constraint-backed and atomic: `onConflictDoNothing` on `(channel_id, external_order_id)` (oms.service.ts:220, schema :121) inside one transaction with lines + created event (oms.service.ts:173-276), with GID/numeric normalization at the chokepoint (:145-151). (Gap: line backfill for partial ingestion runs outside a transaction, :332-376.)
- Webhook inbox: persist-before-ACK (oms-webhooks.ts:1512-1516), constraint dedup, replay + requeue ops endpoints (oms.routes.ts:108-152).
- Refund same-refund idempotency: event-marker + financial update in one transaction (oms-webhooks.ts:2243-2291).
- `pushShopifyFulfillment` is the strongest write-back path: idempotent pre-check (fulfillment-push.service.ts:853-877), guarded conditional persist for concurrent winners (:1358-1374), audit event (:1376-1396), structured error codes (:84-97), metrics (`incr`).
- All money columns are `bigint` integer cents (oms.schema.ts:80-98, 165-181); OMS→WMS snapshots are validated with `ensureCents` (wms-sync-financials.ts:53-105).
- Schedulers are dyno-safe via advisory locks (fulfillment-sweeper.scheduler.ts:156-187, oms-flow-reconciliation.service.ts:1193-1212).
- Retry worker: backoff, MAX 5, DLQ with CRITICAL alerts, dead-status mirrored to inbox (webhook-retry.worker.ts:1553-1735).
- Reconciler remediation writes are guarded UPDATEs with terminal-state predicates and audit events (oms-flow-reconciliation.service.ts:1069-1113, 1131-1163).

---

## 5. SEAM ASSESSMENT

- **Ingest seam (channel → OMS): GOOD.** `ingestOrder` is a true chokepoint (Shopify webhooks, eBay poll/webhook, bridge all converge); dedup key normalized; per-channel mapping stays in adapters (`mapShopifyOrderToOrderData` oms-webhooks.ts:1068-1160, `mapEbayOrderToOrderData`).
- **Status-transition seam: MISSING.** This is the defining gap. There is no `transitionOmsOrder(id, from → to, evidence)` function; every caller re-implements "update status + maybe insert event". The two flow-reconciliation remediations (§2.1 #8-9) are the only writes shaped like the target pattern.
- **OMS → WMS seam: LEAKY.** Correct calls exist (`reserveForOrder` via reservationService, oms.service.ts:449-455; `syncOmsOrderToWms`; shipment-rollup published functions) but raw `wms.*` writes from oms-webhooks.ts (§3.2) bypass them.
- **WMS → OMS seam: MISSING.** Nothing like `omsInterface.applyShipmentOutcome()` exists, which is *why* index.ts, fulfillment.service.ts, channel-fulfillment.service.ts and shipstation.service.ts each hand-roll the OMS derive (four near-identical copies of the status+line-fulfillment SQL: channel-fulfillment.service.ts:138-188, index.ts:1362-1411, and per its own comment shipstation.service.ts `updateOmsDerivedFromEvent`).
- **Write-back seam (OMS → channel): GOOD SHAPE.** `fulfillment-push.service.ts` is a proper port with per-provider branches, structured error codes, and DLQ integration; blemishes are the legacy order-level eBay path without idempotency (M1) and Shopify-retry classification (M2).
- **Ops/observability seam: PRESENT** (ops-health, flow-waterfall, flow-trace, remediation endpoints) — read-only except guarded remediation; well-factored.

---

## 6. REFACTOR RECOMMENDATIONS

1. **Create ONE OMS state-machine module** (e.g. `oms-order-status.core.ts`): `transitionStatus(tx, orderId, {to, expectedFrom[], evidence})` implemented as `UPDATE oms.oms_orders SET status=$to WHERE id=$id AND status = ANY($expectedFrom) RETURNING`, inserting the `oms_order_events` row in the same transaction, rejecting (and logging `requires_review`) invalid transitions. Port writers in order of blast radius: index.ts sweeps → orders/fulfillment.service.ts → webhook handlers → channel-fulfillment → oms.service.
2. **Give WMS a published `notifyOmsOfShipmentOutcome(omsOrderId, event)` on the OMS interface** and delete the four duplicated OMS-derive SQL blocks (index.ts:1362-1411, channel-fulfillment.service.ts:138-188, fulfillment.service.ts:512-548, shipstation.service.ts equivalent). This closes BOUNDARIES.md's named reverse leak in one move.
3. **Make refund totals atomic and cumulative:** `SET refund_amount_cents = refund_amount_cents + ${thisRefundCents}` inside the existing transaction; derive `refunded` vs `partially_refunded` from `refund_amount_cents + this >= total_cents` (or cumulative adjusted qty), not per-payload qty.
4. **Fix the cancel-retry dead end (H1):** either move the status write *after* a successful cascade, or split the early-return so a replay with status=cancelled still re-runs the cascade idempotently (cascade steps already tolerate re-runs), or record a `cancel_cascade_completed` event and gate the short-circuit on it.
5. **Wrap orders/updated in a transaction** for the OMS-side writes (header + lines + event) and enqueue `enqueueOmsWmsSyncRetry` when `propagateOmsEditsToWms` fails (one-line fix for H4); recompute header cents from Shopify payload totals in the same update (H3).
6. **Move the two `server/index.ts` reconciliation sweeps into modules** (oms/reconcilers or the flow-reconciliation service) so they inherit guarded-update discipline, tests, and advisory locks.
7. **Add UNIQUE indexes** where idempotency is currently marker-based: `wms.returns(order_id, refund_external_id)` (partial, WHERE refund_external_id IS NOT NULL); consider an idempotency ledger for eBay `createShippingFulfillment` order-level pushes or delete the legacy order-level path.
8. **Classify Shopify push errors in the retry worker** mirroring the ShipStation branch: `SHOPIFY_PUSH_USER_ERRORS` on deterministic messages (already fulfilled, FO closed) → dead-letter + requires_review immediately.
9. **Replace `wms.orders` raw writes in orders/updated** (oms-webhooks.ts:1725-1744) with a wms-sync interface call (`updateShippingAndFinancials(omsOrderId, snapshot)`), which the pending→ready promotion already logically belongs to.
10. Longer term: adopt the structured logger with `{oms_order_id, wms_order_id, shipment_id, channel_event_id}` on every line (CLAUDE.md §10) so flow-trace stops payload-grepping the inbox.

---

## 7. UNKNOWNS

- **Whether an order edit can race a pick/ship inside WMS** depends on `propagateOmsEditsToWms` (wms-sync.service.ts:1185) — outside this audit's scope; from OMS core I can only verify the call and that its failure is swallowed (oms-webhooks.ts:1911-1915). INSUFFICIENT EVIDENCE here; the wms-sync auditor must confirm guarded updates on picked/fulfilled quantities.
- **Whether eBay `createShippingFulfillment` is idempotent server-side** (would mitigate M1's order-level path). Not determinable from this repo.
- **Production duplicate-webhook concurrency:** the inbox dedups by `x-shopify-webhook-id` (webhook-inbox.service.ts:109-111); distinct deliveries of the *same logical change* (orders/updated + orders/cancelled) still process concurrently on separate dynos — I cannot verify dyno count / connection isolation from the repo (Heroku per CLAUDE.md), so real-world likelihood of C2/H2 races is unquantified.
- **Whether any code path deletes `oms_orders`** (which would cascade-delete events, L6) — none found in `server/`, but admin SQL/console access is outside repo evidence.
- **`markShippedByExternalId` lacks a channel filter** (oms.service.ts:817-820 matches on `external_order_id` alone, not `(channel_id, external_order_id)`): whether numeric-id collisions across channels are possible in production data cannot be verified from code — flagged as HYPOTHESIS: cross-channel id collision would mark the wrong order shipped.
- `db.__fulfillmentPush` service-locator pattern (channel-fulfillment.service.ts:86, webhook-retry.worker.ts:770-778, shopify.reconciler.ts:102) — wiring happens in server/index.ts; whether it is set before first scheduler tick in all boot orders was not traced.
