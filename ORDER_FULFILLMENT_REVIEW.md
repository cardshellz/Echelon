# Order & Fulfillment Flow Review — Echelon WMS/OMS

**Date:** 2026-05-22
**Scope:** End-to-end order lifecycle across Shopify, eBay, OMS, WMS, ShipStation
**Out of scope:** Returns/RMA workflow (acknowledged gap, deferred), ShipStation replacement (current engine, but architecture should be engine-agnostic)

---

## Severity Key

| Level | Meaning |
|-------|---------|
| **P0 — Critical** | Will cause order loss, double-ships, wrong quantities, or customer-facing failures. Fix immediately. |
| **P1 — High** | Creates significant operational risk, frequent manual intervention, or silent data drift. Fix soon. |
| **P2 — Medium** | Creates occasional issues, operational overhead, or scaling blockers. Plan for next cycle. |
| **P3 — Low** | Future-proofing, observability, architectural cleanliness. Track for later. |

---

## Executive Summary

The system has a solid core architecture: idempotent OMS ingestion, a clear WMS state machine with audit trails, and well-built Shopify cancel/refund cascades with unit tests. The ShipStation V2 SHIP_NOTIFY flow handles split and combined shipments properly.

However, there is one dominant structural problem: **the WMS is decoupled from the OMS after initial sync and does not receive lifecycle updates.** Order edits, quantity changes, and item additions in Shopify/eBay update the OMS but never propagate to the WMS. This means the warehouse works from stale data whenever an order changes after sync. This single architectural gap is the root cause of a large class of potential operational failures.

Beyond that, eBay's non-happy-path handling is significantly weaker than Shopify's, inventory shortfalls don't block fulfillment, and there is no operator-facing queue for shipments flagged for review.

**Finding count:** 7 P0, 8 P1, 9 P2, 5 P3

---

## STAGE 1: Order Intake (Channel → OMS)

### F-01 | P2 | eBay webhook only handles ORDER topics
**File:** `server/modules/oms/ebay-order-ingestion.ts:425`
**Problem:** The eBay webhook handler filters on `topic?.includes("ORDER")` only. Refund, return, and cancellation-specific eBay notifications are silently dropped. All non-happy-path detection relies on the 5-minute polling cycle.
**Impact:** Up to 5-minute delay detecting eBay cancellations/refunds. In a rapid cancel→reship scenario, the warehouse may ship a cancelled order.
**Fix:** Register and handle eBay marketplace notification topics for CANCELLATION and REFUND events. As a safety net, reduce poll interval to 60 seconds for status-change detection.

### F-02 | P3 | Missing Shopify webhook topics
**File:** `server/modules/oms/oms-webhooks.ts:8-13`
**Problem:** Not subscribed to `fulfillment_orders/in_progress` or `fulfillment_orders/cancelled`. These Shopify topics provide line-item-level fulfillment state changes that the current `orders/fulfilled` handler doesn't capture.
**Impact:** Minimal today (single warehouse, no 3PL fulfillment splitting), but blocks multi-location fulfillment visibility.
**Fix:** Subscribe when multi-warehouse goes live.

---

## STAGE 2: OMS → WMS Sync

### F-03 | P1 | OMS → WMS sync is not event-driven
**File:** `server/routes/shopify.routes.ts:746-858`
**Problem:** The `POST /api/orders/sync-from-oms` endpoint that creates WMS orders from OMS orders is a manually/periodically triggered batch operation, not an automatic event fired when an OMS order is created. This creates a window where orders sit in the OMS without entering the pick queue.
**Impact:** Orders can be delayed entering the warehouse. The earlier fix to `orderSyncListener.ts` addressed Shopify→OMS reliability, but OMS→WMS is a separate seam. At 60-100 orders/day, even short delays compound.
**Fix:** After `OmsService.ingestOrder()` succeeds, automatically trigger `syncOmsOrderToWms()` for that specific order. Keep the batch endpoint as a reconciliation backstop, not the primary path.

### F-04 | P0 | Inventory shortfall does not block order progression
**Files:** `server/modules/channels/reservation.service.ts:89-200`, `server/modules/oms/wms-sync.service.ts:461-462`
**Problem:** When `reserveForOrder()` encounters insufficient ATP, it logs a warning and creates the WMS order anyway. The picker sees the order in the queue with no indication that inventory is short. The `backorderQty` field in `inventory_levels` exists but is never written.
**Impact:** Picker walks to a bin, finds insufficient stock, manually shorts the item. Order goes to exception. No proactive customer communication. For high-velocity SKUs, this creates a steady stream of avoidable exceptions.
**Fix:**
- When shortfall detected during reservation, set WMS order to `on_hold` with a hold reason of `inventory_shortfall`.
- Create a backorder record linking order, SKU, and shortfall qty.
- Surface held orders in the operations dashboard with reason.
- When inventory is received (PO, cycle count adjustment), auto-check backorder queue and release holds.

### F-05 | P2 | No default warehouse fallback in fulfillment routing
**File:** `server/modules/orders/fulfillment-router.service.ts:59-91`
**Problem:** Fulfillment routing rules are evaluated by priority. If no rule matches and no `default` rule is configured, the order has no warehouse assignment. This silently prevents it from entering any pick queue.
**Impact:** Today with one warehouse this is likely covered by a default rule, but the architecture doesn't enforce that a default must exist. Adding a second warehouse without configuring routing could silently drop orders.
**Fix:** If no routing rule matches, either (a) require a default rule at startup and fail loudly if missing, or (b) assign to the primary warehouse and log a warning.

---

## STAGE 3: Order Lifecycle Management (Post-Sync Changes)

### F-06 | P0 | Order edits do NOT propagate from OMS to WMS
**File:** `server/modules/oms/oms-webhooks.ts:1220-1301`
**Problem:** The `orders/updated` webhook updates OMS line items (quantity changes, new line items) and WMS shipping address, but **does not update `wms.order_items`**. Specifically:
- **Quantity reductions:** OMS qty updated, WMS still shows original qty. Warehouse picks too many units.
- **Quantity increases:** OMS qty updated, WMS picks too few units.
- **Item additions:** New OMS line created, no corresponding WMS order_item. Item never picked.
- **Item removals:** Not handled in either OMS or WMS.
- **Reservations:** Not released or adjusted for qty changes.

**Impact:** Every order edit after sync results in the warehouse working from wrong data. The user confirmed this happens regularly (wrong item ordered, qty changes). At 60-100 orders/day, even a 5% edit rate means 3-5 wrong shipments daily.
**Fix:** When `orders/updated` fires:
1. Diff OMS line items against WMS order_items.
2. For qty reductions: update WMS item qty, release excess reservation, adjust inventory if already picked.
3. For qty increases: update WMS item qty, attempt reservation for additional units, flag if shortfall.
4. For new items: create WMS order_item, attempt reservation, assign bin location.
5. For removed items: if not picked, cancel the WMS item and release reservation. If picked, flag for review.
6. If the order is currently being picked (`picking` status), alert the picker or flag the order.

### F-07 | P0 | Cancellation does not auto-pull from pick queue
**File:** `server/modules/oms/oms-webhooks.ts:1333-1475`
**Problem:** The Shopify cancel cascade updates shipment statuses and OMS/WMS order status, but does not handle the case where a picker has already claimed the order (status = `picking`). The cancel sets the WMS order to `cancelled`, but the picker's UI may still show the order as active. There is no mechanism to interrupt a picker mid-pick.
**Impact:** Picker picks a cancelled order. Inventory is deducted. The order sits in a contradictory state (cancelled but with picked inventory). Manual cleanup required.
**Fix:**
- When cancellation fires on an order in `picking` status: set order to `cancelled`, reverse any picks already made (add inventory back to on-hand), and if the picker's session is active, push a real-time notification (WebSocket/SSE) that the order was cancelled.
- For `ready` status: straightforward cancel + reservation release (may already work, but verify inventory reversal).
- Add a guard in `pickItem()`: before processing a pick, check that the order is not `cancelled`.

### F-08 | P0 | eBay cancellations force-cancel post-label shipments
**File:** `server/modules/oms/ebay-order-ingestion.ts:225-254`
**Problem:** Unlike Shopify's cancel cascade (which flags post-label shipments as `requires_review` + `on_hold`), eBay cancellations force-cancel the WMS order regardless of shipment state. If a label has already been printed or the package is in transit, the system marks it cancelled without any review gate.
**Impact:** A shipped/labeled eBay order gets cancelled in the system while the physical package is in transit. Inventory counts are wrong. No one is alerted to intercept the package.
**Fix:** Apply the same pre-label/post-label cascade logic used for Shopify cancellations. Post-label shipments should be flagged `requires_review` + `on_hold`, not force-cancelled.

### F-09 | P0 | eBay refunds have no WMS cascade
**File:** `server/modules/oms/ebay-order-ingestion.ts:255-262`
**Problem:** When eBay polling detects a refund (`FULLY_REFUNDED` or `PARTIALLY_REFUNDED`), only the OMS `financialStatus` is updated. There is no cascade to WMS: no shipment hold, no inventory adjustment, no reservation release. Compare to Shopify where `applyShopifyRefundCascade()` handles all of this.
**Impact:** eBay refund on an unshipped order → warehouse still ships it. eBay partial refund → warehouse ships full quantity. Direct financial loss.
**Fix:** Build an eBay refund cascade mirroring `applyShopifyRefundCascade()`. Since eBay doesn't provide line-item refund detail in the same way, at minimum: if fully refunded and order is pre-ship, cancel the order. If partially refunded, flag for review.

### F-10 | P1 | Shopify refund "restock" is reservation release, not physical restock
**File:** `server/modules/oms/oms-webhooks.ts:1717-1759`
**Problem:** When a Shopify refund includes `restock=true`, the cascade calls `reservation.releaseOrderReservation()`, which releases the reserved qty. But if inventory was already picked (in `picked_qty`), it is not returned to `variant_qty` (on-hand). Physical restock is deferred to a future commit per code comments.
**Impact:** After a refund on a picked-but-unshipped order, inventory is stuck in `picked_qty` permanently. ATP slowly drifts from physical reality. Requires manual cycle count to correct.
**Fix:** When refund fires on an order with picked inventory:
1. Reverse pick transactions: decrement `picked_qty`, increment `variant_qty` for affected items.
2. Create `inventory_transactions` with type=`refund_restock` for audit trail.
3. Cancel or adjust the associated shipment items.

### F-11 | P1 | Pre-shipment refunds with no shipment are silently lost
**File:** `server/modules/oms/oms-webhooks.ts` (refund cascade logic)
**Problem:** If a refund fires on an order that has no `outbound_shipments` row yet (e.g., order is still in `ready` or `picking` status), the cascade has nothing to hold/cancel. The refund event is recorded in OMS but the WMS order continues through the pick queue.
**Impact:** Refunded order gets picked and shipped. Direct financial loss + customer confusion.
**Fix:** Refund cascade should check WMS order status. If pre-shipment (ready, picking, picked), cancel the WMS order directly (same as cancellation flow). If specific line items are refunded, reduce WMS item quantities or mark items cancelled.

---

## STAGE 4: Picking Flow

### F-12 | P1 | No guard against picking cancelled/edited orders
**File:** `server/modules/orders/picking.use-cases.ts` (pickItem function)
**Problem:** `pickItem()` validates item status but does not re-check the parent order's `warehouseStatus`. If a cancellation or edit arrives while a picker is mid-pick, subsequent picks proceed against stale order data.
**Impact:** Picker picks items for a cancelled order. Inventory deducted incorrectly. Manual reversal needed.
**Fix:** At the start of `pickItem()`, verify `order.warehouseStatus` is not in [`cancelled`, `on_hold`]. If it is, reject the pick and return a clear error message the picker can act on.

### F-13 | P2 | Pick failure mid-transaction can leave inventory inconsistent
**File:** `server/modules/orders/picking.use-cases.ts` (pickItem function)
**Problem:** `pickItem()` decrements `variant_qty` and increments `picked_qty`, then updates `order_items.picked_quantity` and status. If the item status update fails after the inventory transaction succeeds, inventory is decremented but the order item still shows `pending`.
**Impact:** Rare (requires a DB failure between two operations in the same request), but results in phantom inventory loss that only surfaces during cycle counts.
**Fix:** Wrap the inventory deduction + item status update in a single database transaction. If either fails, both roll back.

### F-14 | P2 | No real-time picker notification for order changes
**Problem:** There is no WebSocket/SSE channel to push order state changes to an active picker's session. If an order is cancelled, edited, or put on hold while a picker has it claimed, they continue working with stale data until they complete or refresh.
**Impact:** Wasted pick labor + inventory corrections. Low frequency today but grows with volume.
**Fix:** Implement a lightweight WebSocket channel per active picker session. Push events for: order cancelled, order edited, order held. Picker UI shows a banner/modal interrupting the current pick.

---

## STAGE 5: Inventory Management

### F-15 | P0 | picked_qty can orphan if SHIP_NOTIFY is delayed or lost
**Files:** `server/modules/orders/fulfillment.service.ts:180-260`, `server/modules/oms/shipstation.service.ts:878-1026`
**Problem:** Inventory transitions from `picked_qty` → shipped only when `SHIP_NOTIFY` webhook arrives from ShipStation. If the webhook is delayed, fails, or ShipStation has an outage, `picked_qty` remains elevated indefinitely. The hourly fulfillment sweeper checks Shopify/eBay fulfillment status but does not reconcile `picked_qty` against ShipStation shipment status.
**Impact:** ATP shows falsely low inventory (picked qty excluded from available). At scale, a ShipStation webhook outage could freeze ATP for all in-transit orders until manual intervention.
**Fix:**
- Add a scheduled job that queries ShipStation for shipments in `labeled`/`shipped` state that the WMS hasn't received SHIP_NOTIFY for (compare `shipstation_order_id` against shipments still in `queued` status older than X hours).
- Auto-process any confirmed shipments found.
- Alert on shipments stuck in `queued` status > 2 hours.

### F-16 | P1 | No inventory reconciliation between WMS and channels
**Problem:** There is no periodic check that WMS on-hand inventory matches what Shopify/eBay show as available. Channel sync pushes ATP updates after inventory changes, but there is no reverse reconciliation to detect drift (e.g., manual Shopify inventory edits, channel sync failures, rounding errors).
**Impact:** Silent overselling or underselling over time. Only caught by cycle counts.
**Fix:** Daily scheduled job: for each active SKU, compare WMS ATP against Shopify/eBay available qty. Flag discrepancies above threshold. Auto-correct if the WMS is the source of truth (configurable).

---

## STAGE 6: Shipping (ShipStation Integration)

### F-17 | P1 | Shipping engine is tightly coupled to ShipStation
**Files:** `server/modules/oms/shipstation.service.ts` (2900+ lines)
**Problem:** ShipStation-specific logic (order key format, payload structure, API calls, webhook parsing) is embedded directly in the service layer with no abstraction. The `pushShipment()`, `SHIP_NOTIFY` handler, hold/unhold, void, and rate logic all reference SS-specific data structures.
**Impact:** Switching to a different shipping engine (direct carrier APIs, EasyPost, Pirate Ship, etc.) requires rewriting the entire service, not just swapping an adapter. Risk of introducing bugs in the transition.
**Fix:** Extract a `ShippingEngine` interface with methods: `pushShipment()`, `voidLabel()`, `holdOrder()`, `unholdOrder()`, `parseShipNotification()`, `getTrackingUrl()`. Current ShipStation code becomes `ShipStationEngine implements ShippingEngine`. New engines implement the same interface.

### F-18 | P1 | Order hold to ShipStation is fire-and-forget
**File:** `server/modules/oms/shipstation.service.ts` (hold/unhold logic)
**Problem:** When a WMS order is put on hold, the hold is sent to ShipStation asynchronously. If the SS API call fails, WMS shows on-hold but ShipStation does not. A packer using the ShipStation UI directly could process and ship the held order.
**Impact:** Hold bypass. Frequency depends on how often the SS UI is used directly vs. through Echelon.
**Fix:** Make the SS hold call synchronous (or retry with confirmation). If SS hold fails, surface an alert to the operator: "Order held in Echelon but ShipStation hold failed — do not ship from SS UI."

### F-19 | P2 | Re-label (void → re-push) relies on hourly sweeper
**Problem:** When a label is voided in ShipStation, the WMS shipment status moves to `voided`. Re-pushing a new label requires the hourly fulfillment sweeper to detect the void and re-trigger, or manual intervention.
**Impact:** Up to 1-hour delay before a voided label is re-created. During peak, this delays shipments.
**Fix:** When a void is detected (either via webhook or polling), immediately re-queue the shipment for a new push instead of waiting for the sweeper.

### F-20 | P2 | Financial validation in pushShipment can silently block
**File:** `server/modules/oms/shipstation.service.ts:2805-2806`
**Problem:** `validateShipmentForPush()` checks unit prices, amounts, and financial totals. If validation fails, the shipment stays in `planned` status with no operator-visible error. The only trace is a server log.
**Impact:** Shipments that fail financial validation sit in `planned` indefinitely with no alert. Particularly risky for orders with complex discounts, free items, or manual price overrides.
**Fix:** When validation fails, set shipment status to `on_hold` with `review_reason` populated. Surface in operations dashboard.

---

## STAGE 7: Fulfillment Write-Back (WMS → Channel)

### F-21 | P1 | Combined order fulfillment push has no transactional guarantee
**File:** `server/modules/oms/fulfillment-push.service.ts:157-177`
**Problem:** When a combined-order group ships, each child order gets a separate Shopify fulfillment push. These are independent API calls. If push #1 succeeds and push #2 fails, one customer sees "fulfilled" and the other does not, even though they shipped in the same box.
**Impact:** Customer confusion, support tickets, and the failed push relies on the hourly sweeper to retry (up to 1-hour delay).
**Fix:** Process all child pushes, collect failures, and immediately retry failed pushes (up to 3 attempts with backoff). If still failing after retries, flag the order for operator attention rather than silently waiting for the sweeper.

### F-22 | P2 | Tracking number changes only update Shopify if fulfillment already pushed
**File:** `server/modules/orders/shipment-rollup.ts:274-296`
**Problem:** When a tracking number changes (re-label), `updateShopifyFulfillmentTracking()` is called only if `shopify_fulfillment_id` already exists on the shipment. If the original fulfillment push hasn't happened yet (queued/failed), the new tracking sits in WMS only. The fulfillment push will eventually use the latest tracking, but there's a window where tracking data is inconsistent.
**Impact:** Low — the eventual push picks up the latest tracking. But if the original tracking was already pushed and then voided, the Shopify fulfillment shows stale tracking until the update fires.
**Fix:** On tracking change, check if fulfillment was already pushed. If yes, immediately update. If no, no action needed (eventual push will use current tracking).

---

## STAGE 8: Multi-Warehouse & Routing

### F-23 | P2 | No order splitting for multi-warehouse fulfillment
**Problem:** When an order has items in different warehouses, there is no mechanism to split the order into multiple fulfillment units routed to different warehouses. The fulfillment router assigns the entire order to one warehouse.
**Impact:** Not an issue today (single warehouse), but this is a blocker for multi-warehouse scaling. The user explicitly requires this capability.
**Fix:** Design a split-order flow:
1. After OMS sync, evaluate each line item's optimal warehouse (based on inventory, proximity, cost).
2. If items span warehouses, create child fulfillment orders per warehouse, each with a subset of items.
3. Each child routes independently through the pick→ship flow.
4. Parent order status = aggregate of children (all shipped → shipped, any pending → partially_shipped).
5. Channel write-back consolidates: multiple fulfillments per Shopify/eBay order, each with its own tracking.

### F-24 | P2 | 3PL awaiting_3pl has no timeout or fallback
**Problem:** Orders assigned to a 3PL warehouse enter `awaiting_3pl` status with no timeout. If the 3PL never updates, the order sits forever.
**Impact:** Not active today, but when 3PL is enabled, a silent failure at the 3PL creates invisible stuck orders.
**Fix:** Add a configurable timeout (e.g., 48 hours). After timeout, alert operator with options: re-route to internal warehouse, contact 3PL, or cancel.

---

## STAGE 9: Observability & Operations

### F-25 | P0 | No operator queue for requires_review shipments
**Problem:** Both Shopify cancel and refund cascades flag post-label shipments as `requires_review = true` + `on_hold`. But there is no dashboard, queue, or alert that surfaces these to an operator. The flags are written to the database and never read by any UI or notification system.
**Impact:** Post-label cancellations/refunds are flagged but no one sees the flags. The operator doesn't know they need to void a label or intercept a package. The entire review system is write-only.
**Fix:** Add a "Shipments Requiring Review" panel to the operations dashboard. Query: `outbound_shipments WHERE requires_review = true AND status = 'on_hold'`. Show order number, reason, shipment status, tracking number, and action buttons (void, ship anyway, cancel).

### F-26 | P1 | No alerting for stuck orders
**Problem:** There is no monitoring for orders stuck in intermediate states. An order in `ready` for 24 hours, `picking` for 4 hours (picker abandoned), `queued` shipment for 6 hours, or `exception` with no resolution — none of these trigger alerts.
**Impact:** Orders silently age out of SLA. Only discovered when a customer complains.
**Fix:** Scheduled job (every 15 minutes) checking:
- Orders in `ready` > configurable threshold (e.g., 4 hours during business hours)
- Orders in `picking` with no pick activity > 1 hour
- Shipments in `queued` > 2 hours
- Orders in `exception` > 4 hours with no resolution
- Orders in `on_hold` > 24 hours
Surface counts on operations dashboard. Optional: email/Slack alert for P0 thresholds.

### F-27 | P1 | Exception resolution allows invalid status
**File:** `server/modules/orders/picking.routes.ts:769-770`
**Problem:** Exception resolution endpoint accepts "resolved" as a valid resolution, but "resolved" is not a valid `warehouseStatus` enum value. If the database enforces enum constraints, this would fail silently. If it doesn't, the order enters an undefined state.
**Impact:** Orders resolved as "resolved" may not appear in any queue or dashboard filter.
**Fix:** Map "resolved" to a valid warehouse status (e.g., `ready_to_ship` if all items are picked, or `ready` if items need re-picking). Remove "resolved" as a terminal state.

### F-28 | P3 | No dead-letter queue for failed webhook processing
**Problem:** If a webhook handler throws an unrecoverable error, the webhook payload is lost. The webhook-inbox service has a replay mechanism for known topics, but there's no persistent dead-letter queue for payloads that fail processing.
**Impact:** Rare, but a bug in webhook handling could silently drop events with no way to replay them.
**Fix:** On webhook processing failure, persist the raw payload + error to a `webhook_dead_letters` table. Surface in diagnostics dashboard. Allow manual replay.

---

## STAGE 10: Architectural / Structural

### F-29 | P0 | The WMS is a one-time snapshot, not a live mirror of OMS
**Problem:** This is the root cause behind F-06, F-07, F-11, and F-12. The OMS→WMS sync creates WMS orders as a point-in-time copy. After creation, the WMS order lives independently. Channel-side changes (edits, partial cancels, refunds) update the OMS but the WMS continues with stale data.
**Impact:** Every order that changes after sync results in the warehouse working from wrong data. This is the single highest-impact structural issue in the system.
**Fix:** Implement an OMS→WMS change propagation layer:
1. When any `orders/updated`, `orders/cancelled`, or `refunds/create` webhook modifies OMS data, check if a corresponding WMS order exists.
2. If yes, compute the delta (what changed) and apply it to WMS: update quantities, add/remove items, cancel order, adjust reservations, reverse picks if needed.
3. Respect the WMS state machine: changes to an order in `shipped` status are handled differently than changes to an order in `ready` status.
4. Log all propagated changes to `oms_order_events` for audit.

### F-30 | P3 | No idempotency keys on channel write-backs
**Problem:** Fulfillment pushes to Shopify/eBay rely on application-level duplicate detection (checking if `shopify_fulfillment_id` already exists). There are no external idempotency keys sent with the API calls themselves.
**Impact:** In a retry scenario (network timeout where the push actually succeeded), the same fulfillment could be created twice on Shopify. The hourly sweeper would then see "already fulfilled" and skip, but the duplicate fulfillment exists.
**Fix:** Use Shopify's `idempotency_key` header on fulfillment creation mutations. For eBay, use the existing dedup key pattern consistently.

### F-31 | P3 | ShipStation order key format has two generations
**File:** `server/modules/oms/shipstation.service.ts`
**Problem:** V2 shipments use `echelon-wms-shp-{shipmentId}` as the order key, while legacy shipments use `echelon-oms-{omsId}`. Both formats coexist in production. The SHIP_NOTIFY handler must check both patterns when resolving incoming webhooks.
**Impact:** Maintenance complexity. Risk of mismatched resolution if a legacy shipment is re-pushed with V2 key format.
**Fix:** Document the key format generations. Add a migration to backfill legacy shipments with the V2 key format (write to a `legacy_order_key` column for historical lookup).

---

## Prioritized Action Plan

### Phase 1 — Stop the Bleeding (P0s)
These should be fixed before anything else. Each one can cause direct operational failures.

| # | Finding | Summary | Effort |
|---|---------|---------|--------|
| 1 | F-29 + F-06 | Build OMS→WMS change propagation for order edits | Large |
| 2 | F-07 | Auto-pull cancelled orders from pick queue + reverse picks | Medium |
| 3 | F-04 | Block orders with inventory shortfall (hold + backorder queue) | Medium |
| 4 | F-25 | Build operator queue for requires_review shipments | Small |
| 5 | F-08 | Apply Shopify-style cancel cascade to eBay | Medium |
| 6 | F-09 | Build eBay refund cascade mirroring Shopify | Medium |
| 7 | F-15 | Reconcile picked_qty against ShipStation shipment status | Medium |

### Phase 2 — Harden the Flow (P1s)
Reduce risk and manual intervention.

| # | Finding | Summary | Effort |
|---|---------|---------|--------|
| 8 | F-03 | Make OMS→WMS sync event-driven (auto on ingest) | Small |
| 9 | F-10 | Fix refund restock to reverse picks, not just reservations | Medium |
| 10 | F-11 | Handle pre-shipment refunds (cancel WMS order) | Small |
| 11 | F-12 | Add cancelled/hold guard to pickItem() | Small |
| 12 | F-16 | Daily inventory reconciliation WMS ↔ channels | Medium |
| 13 | F-17 | Extract ShippingEngine interface for engine-agnostic design | Large |
| 14 | F-18 | Make SS hold synchronous with failure alerting | Small |
| 15 | F-21 | Retry combined-order fulfillment pushes immediately | Small |
| 16 | F-26 | Build stuck-order monitoring + alerting | Medium |
| 17 | F-27 | Fix exception resolution to use valid statuses | Small |

### Phase 3 — Scale & Polish (P2/P3)
Prepare for multi-warehouse, improve resilience.

| # | Finding | Summary | Effort |
|---|---------|---------|--------|
| 18 | F-23 | Design order splitting for multi-warehouse | Large |
| 19 | F-24 | 3PL timeout + fallback routing | Small |
| 20 | F-05 | Enforce default warehouse rule exists | Small |
| 21 | F-13 | Wrap pick + inventory update in DB transaction | Small |
| 22 | F-14 | Real-time picker notifications via WebSocket | Medium |
| 23 | F-19 | Immediate re-push on void detection | Small |
| 24 | F-20 | Surface failed financial validation as shipment hold | Small |
| 25 | F-22 | Tracking change update timing | Small |
| 26 | F-01 | eBay refund/cancel webhook topics | Medium |
| 27 | F-02 | Shopify fulfillment_orders webhook topics | Small |
| 28 | F-28 | Webhook dead-letter queue | Medium |
| 29 | F-30 | Idempotency keys on channel write-backs | Small |
| 30 | F-31 | ShipStation order key format cleanup | Small |

---

## Architecture Diagram (Current State)

```
SHOPIFY ──webhook──→ OMS (oms_orders) ──manual sync──→ WMS (orders) ──pick──→ SHIPSTATION ──SHIP_NOTIFY──→ WMS
  ↑                       ↑                               ↓                                                │
  │                       │                          inventory_levels                                       │
  │                       │                               ↓                                                │
  │                  eBay polling                   outbound_shipments                                     │
  │                       ↑                               │                                                │
EBAY ──webhook(ORDER)──→ OMS                              └──fulfillment push──→ SHOPIFY/EBAY ←────────────┘
                                                                                   (tracking)

PROBLEM: The ──manual sync──→ arrow is one-way, one-time.
         Changes flow LEFT (channel→OMS) but NOT RIGHT (OMS→WMS) after initial sync.
```

## Architecture Diagram (Target State)

```
SHOPIFY ──webhook──→ OMS (oms_orders) ══auto sync══→ WMS (orders) ──pick──→ SHIPPING ENGINE ──notify──→ WMS
  ↑                    │  ↑                ↑             ↓              (interface)                       │
  │                    │  │           change propagation  │                                               │
  │                    │  │           (edits/cancels/     inventory_levels                                │
  │                    │  │            refunds)           ↓                                               │
  │                    │  eBay webhook                outbound_shipments                                  │
  │                    │  (ORDER+CANCEL+REFUND)          │                                               │
EBAY ──webhook──────→ OMS                               └──fulfillment push──→ SHOPIFY/EBAY ←────────────┘
                                                              (w/ retry)          (tracking)
                                                                    │
                                                              ┌─────┘
                                                              ↓
                                                     OPERATOR DASHBOARD
                                                     - requires_review queue
                                                     - stuck order alerts
                                                     - inventory discrepancies
                                                     - backorder holds
```

---

*End of review. All findings are based on code analysis as of 2026-05-22. Line numbers reference current HEAD.*
