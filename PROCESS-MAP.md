# Echelon WMS — Complete Process Map

> **Generated:** 2026-03-20 | **Auditor:** Systems Architect (read-only)
> **Scope:** Every business process, function chain, system ownership, and boundary violation

---

## How to Read This Document

Each process section follows the same format:
- **Happy Path** — step-by-step function chain with `file:line` references
- **System Ownership** — which system (OMS, WMS, Channel Sync, Catalog, Procurement) owns each step
- **⚠️ Boundary Violations** — where functions reach into another system's tables
- **Atomicity** — does it use transactions? Can it leave partial state?
- **Sync Triggers** — does it fire `notifyChange` or `channelSync.queueSyncAfterInventoryChange`?

---

## 1. Order Ingestion

### 1A. Shopify Order Ingestion

**Trigger:** Shopify fires `orders/create` webhook → Shopify app writes to `shopify_orders` table → PostgreSQL `LISTEN/NOTIFY` fires trigger

**Happy Path:**

```
1. Shopify webhook → shopify_orders INSERT
2. PostgreSQL trigger notify_new_shopify_order()
   → order-sync-listener.ts:setupOrderSyncListener (LISTEN handler, line ~430)
3. pendingSyncQueue.add(shopifyOrderId)
   → processQueue() called after 1.5s delay
4. syncSingleOrder(shopifyOrderId)
   → order-sync-listener.ts:109
   a. Check dedup: SELECT id FROM orders WHERE source_table_id = ?
   b. Fetch from shopify_orders + shopify_order_items
   c. Retry item fetch up to 3x with 2s/4s delays (race condition guard)
   d. Resolve channel: resolveChannelId() → channel_connections.shopDomain
   e. Enrich items: getBinLocationFromInventoryBySku() for each SKU
   f. storage.createOrderWithItems() → writes to WMS `orders` + `order_items`
5. Route order: fulfillmentRouter.routeOrder() → assignWarehouseToOrder()
   → orders/fulfillment-router.service.ts
6. Set SLA: slaMonitor.setSLAForOrder()
   → orders/sla-monitor.service.ts
7. Reserve inventory: reservation.reserveOrder(orderId)
   → channels/reservation.service.ts:210 (for managed warehouses only)
   See Process 2 for reservation details.
8. Bridge to OMS: bridgeShopifyOrderToOms() (fire-and-forget)
   → oms/shopify-bridge.ts:26
   → omsService.ingestOrder() → writes to oms_orders + oms_order_lines
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1-2 | External (Shopify) | Raw webhook data |
| 3-4 | OMS (order-sync-listener) | Normalizes to WMS orders table |
| 5-6 | WMS | Routing and SLA |
| 7 | WMS (Reservation) | ATP-gated reservation |
| 8 | OMS | Unified order view |

**⚠️ Boundary Violations:**
- **order-sync-listener.ts:174** — Reads `inventory_levels` via `getBinLocationFromInventoryBySku()` to populate `order_items.location`. This is acceptable (read-only display data), but the location lookup crosses from OMS into WMS tables.
- **order-sync-listener.ts:180** — Reads `product_locations`, `product_variants`, `product_assets` for image lookup. Cross-system read into Catalog and WMS. Acceptable for enrichment.

**Atomicity:** `createOrderWithItems()` should be transactional (single storage call). Reservation is a separate step — if it fails, order exists but is unreserved. This is intentional (order still enters pick queue, reservation retries on next sync).

**Sync Triggers:** Reservation fires `channelSync.queueSyncAfterInventoryChange()` — ✅ Correct.

---

### 1B. Shopify Order Updates (Fulfillment/Cancellation)

**Trigger:** Shopify fires `orders/updated` webhook → `shopify_orders` UPDATE → PostgreSQL `shopify_order_update` NOTIFY

**Happy Path:**

```
1. PostgreSQL trigger notify_shopify_order_update()
   → order-sync-listener.ts (LISTEN handler)
2. syncOrderUpdate(shopifyOrderId) after 500ms delay
   → order-sync-listener.ts:346
   a. Fetch latest status from shopify_orders
   b. Update WMS orders table (financial_status, fulfillment_status, cancelled_at)
3. If cancelled:
   a. reservation.releaseOrderReservation(orderId) → channels/reservation.service.ts:288
   b. releasePickedInventoryOnCancellation(orderId) → order-sync-listener.ts:280
      → inventoryCore.adjustLevel() + logTransaction()
   c. Update warehouse_status = 'cancelled'
4. If fulfillment_status = 'fulfilled' (Shopify confirms shipped):
   a. Check for existing shipments (idempotency guard)
   b. If shipment exists: just update warehouse_status = 'shipped'
   c. If no shipment:
      - releasePickedInventoryOnShipment(orderId) → inventoryCore.recordShipment()
      - deductInventoryForExternalShipment(orderId) → inventoryCore.recordShipment()
   d. Update order_items.status = 'completed'
```

**⚠️ Boundary Violations:**
- **order-sync-listener.ts:306** — `releasePickedInventoryOnCancellation()` calls `inventoryCore.adjustLevel()` directly (low-level bucket change) instead of using `inventoryCore.adjustInventory()`. This **bypasses `notifyChange`**, meaning channel sync won't fire after cancellation-related inventory releases.
  - **Fix:** Replace `adjustLevel()` with a proper `adjustInventory()` call, or add explicit `channelSync.queueSyncAfterInventoryChange()` after.

**Atomicity:** Each operation is independent (not wrapped in a single transaction). If `releaseOrderReservation` succeeds but `releasePickedInventoryOnCancellation` fails, reserved qty is freed but picked qty remains stranded. This is acceptable — the audit trail captures partial state.

---

### 1C. eBay Order Ingestion

**Trigger:** eBay webhook (ORDER_CONFIRMATION) or 5-minute polling

**Happy Path:**

```
1. Webhook: createEbayOrderWebhookHandler() → oms/ebay-order-ingestion.ts:218
   OR
   Poll: pollEbayOrders() → oms/ebay-order-ingestion.ts:152
2. mapEbayOrderToOrderData(ebayOrder) → oms/ebay-order-ingestion.ts:39
   → Normalizes eBay order into OMS OrderData
3. omsService.ingestOrder(EBAY_CHANNEL_ID=67, orderId, orderData)
   → oms/oms.service.ts:74
   a. Dedup check: SELECT from oms_orders WHERE channel_id + external_order_id
   b. INSERT into oms_orders
   c. For each line: SKU → product_variants lookup, INSERT into oms_order_lines
   d. INSERT oms_order_events (type: 'created')
4. If new order (created <5s ago):
   a. omsService.reserveInventory(orderId) → oms/oms.service.ts:170
      → Delegates to reservationService.reserveForOrder() (✅ FIXED)
   b. omsService.assignWarehouse(orderId) → sets warehouse_id=1 (LEON)
   c. shipStationService.pushOrder(fullOrder) → oms/shipstation.service.ts:109
      → ShipStation API POST /orders/createorder
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1-2 | OMS | eBay ingestion |
| 3 | OMS | Unified order storage |
| 4a | WMS (via Reservation) | ATP-gated inventory hold |
| 4b | OMS | Warehouse assignment |
| 4c | External (ShipStation) | Fulfillment push |

**⚠️ Boundary Violations:**
- **oms.service.ts:170 — FIXED** — `reserveInventory()` now delegates to `ReservationService.reserveForOrder()` which gates on fungible ATP, writes audit trail, and triggers channel sync.

**Atomicity:** Order creation is transactional (single `ingestOrder` call). Post-ingest steps (reserve, assign, ShipStation push) are separate — if any fails, the order exists but isn't fully processed. Error logging is in place.

**⚠️ eBay orders do NOT enter the WMS `orders` table.** They only live in `oms_orders`. This means they don't appear in the pick queue (which reads from `orders`). The pick queue is still Shopify-only.
- **Fix needed:** Either bridge eBay orders to the WMS `orders` table (like the Shopify bridge does in reverse), or make the pick queue read from `oms_orders`.

---

### 1D. Batch Sync (Safety Net)

**Trigger:** 60-second interval (order-sync-listener.ts:414) or server startup

```
syncNewOrders() → order-sync-listener.ts:268
  → SELECT shopify_orders WHERE NOT EXISTS in orders
  → syncSingleOrder() for each (same flow as 1A, step 4+)
```

Also: `backfillShopifyOrders()` → oms/shopify-bridge.ts:125 — backfills `oms_orders` from `shopify_orders`.

---

## 2. Order Reservation (FIXED)

**Current state after today's fix:** One function, gates on ATP, writes to `inventory_levels`.

### 2A. WMS Order Reservation (Shopify flow)

**Trigger:** Called by `order-sync-listener.ts:235` after order creation

```
1. reservation.reserveOrder(orderId)
   → channels/reservation.service.ts:210
2. For each order_item:
   a. Resolve product_variant by SKU
   b. reserveForOrder(productId, variantId, qty, orderId, orderItemId)
      → channels/reservation.service.ts:101
      i.   atpService.getAtpPerVariant(productId) → inventory/atp.service.ts:200
           → Computes FUNGIBLE ATP: onHand - reserved - picked - packed (in base units)
           → Converts to sellable variant units: floor(atpBase / unitsPerVariant)
      ii.  Determine toReserve = min(orderQty, atpUnits)
      iii. Find assigned bin: SELECT from product_locations WHERE variant + status='active'
      iv.  inventoryCore.reserveForOrder({variantId, locationId, qty, orderId, orderItemId})
           → inventory/core.service.ts:609
           → Atomic: upserts level, increments reservedQty, logs to inventory_transactions
           → ✅ Fires notifyChange(variantId, "reserve") (line 669)
3. Post-reservation: channelSync.queueSyncAfterInventoryChange(variantId) for each reserved variant
   → channels/reservation.service.ts:255
```

**System Ownership:** WMS owns the entire reservation flow. ATP service is read-only WMS.

**⚠️ Boundary Violations:** None — properly delegated through ATP → inventoryCore → channelSync.

**⚠️ Known Issue (P1, from audit Finding 12):**
- **reservation.service.ts:131** — Requires `product_locations` assignment. If variant has stock but no bin assignment (newly received, not yet slotted), reservation fails with `{ reserved: 0, shortfall: orderQty }`.
- **Fix:** Fall back to any `inventory_levels` row with stock for the variant.

**Atomicity:** `inventoryCore.reserveForOrder()` runs inside `db.transaction()` — atomic. Each item is reserved independently — partial success is allowed and reported.

**Sync Triggers:**
- `inventoryCore.reserveForOrder()` fires `notifyChange` — ✅
- `reservation.service.ts` fires explicit `channelSync.queueSyncAfterInventoryChange()` — ✅ (dual trigger, harmless)

### 2B. OMS Order Reservation (eBay flow)

```
omsService.reserveInventory(orderId)
  → oms/oms.service.ts:170
  → For each oms_order_line:
    a. Look up product_variant by oms_order_lines.productVariantId
    b. reservationService.reserveForOrder(productId, variantId, qty, orderId, lineId)
       → Same flow as 2A step 2b
```

**✅ FIXED today** — was previously doing raw SQL UPDATE on inventory_levels.

---

## 3. Pick Queue / Order Assignment

### 3A. Orders Enter Pick Queue

**How orders get into the pick queue:** The pick queue reads directly from the `orders` table filtered by `warehouse_status`.

```
pickingService.getPickQueue()
  → orders/picking.service.ts:763
  → storage.getPickQueueOrders()
  → Filters: orders with items where requiresShipping = 1
  → Enriches with: fresh bin locations, replen predictions, picker names, channel info
```

The `orders` table is populated by `syncSingleOrder()` (Process 1A). Orders enter the queue when `warehouse_status = 'ready'`.

**⚠️ eBay orders are NOT in the pick queue** — they only exist in `oms_orders`, not `orders`. ShipStation handles their fulfillment externally.

### 3B. Order Assignment (Claiming)

```
pickingService.claimOrder(orderId, pickerId)
  → orders/picking.service.ts:507
  a. storage.claimOrder(orderId, pickerId)
     → Sets assignedPickerId, warehouse_status = 'in_progress'
  b. Logs to picking_logs (actionType: 'order_claimed')
  c. Returns order + items
```

**System Ownership:** WMS owns claiming entirely.

**⚠️ Boundary Violations:** None — reads only from `orders`, `order_items`, and `users`.

### 3C. Pick Queue Location Sync

```
syncPickQueueForSku(sku)
  → orders/pick-queue-sync.ts:10
  → Updates order_items.location from inventory_levels (fresh bin lookup)
  → Broadcasts via WebSocket
```

Called fire-and-forget when product_locations change. This is a WMS-internal operation — no boundary violations.

---

## 4. Picking

### 4A. Picker Scans Item (Core Pick)

**Trigger:** Picker marks item as completed

```
pickingService.pickItem(itemId, { status: 'completed', pickedQuantity, ... })
  → orders/picking.service.ts:180

1. Validate: status enum, item exists, not already completed, qty bounds
2. Atomic status update: storage.updateOrderItemStatus() with WHERE guard
3. Log to picking_logs (fire-and-forget)
4. IF status === 'completed' AND was not previously completed:
   a. _deductInventory(item, beforeItem, opts)
      → orders/picking.service.ts:330
      i.   Resolve product_variant by SKU
      ii.  Resolve pick location: explicit > assigned bin > any pickable bin
      iii. inventoryCore.pickItem({variantId, locationId, qty, orderId, orderItemId})
           → inventory/core.service.ts:310
           → Atomic guarded UPDATE: variantQty -= qty, pickedQty += qty
           → Releases matching reservedQty (min of reserved and picked)
           → Logs to inventory_transactions (type: 'pick')
           → Lot tracking: lotService.pickFromLots() (FIFO)
   b. Replen guidance check (read-only, no task created):
      replenishment.checkReplenNeeded(variantId, locationId)
      → inventory/replen.service.ts (evaluateReplenNeed)
   c. Set binCountNeeded flag if replen triggered or bin hit zero
5. Update order progress: storage.updateOrderProgress()
```

**System Ownership:** WMS owns picking entirely.

**Inventory Deduction:** Goes through `inventoryCore.pickItem()` — ✅ Correct.

**Sync Triggers:** `pickItem()` in core.service.ts does NOT call `notifyChange()` after the pick (line 370 comment says "pick does not change ATP — reserved_qty already accounted for it"). This is **correct** — ATP is calculated as `onHand - reserved - picked - packed`, and since reserved was already decremented during the pick, the net ATP doesn't change.

**Atomicity:** `inventoryCore.pickItem()` uses `db.transaction()` with optimistic locking (`WHERE variant_qty >= qty`). Concurrent picks are safely rejected.

### 4B. Bin Count After Pick

```
pickingService.handleBinCount({ sku, locationId, binCount, didReplen })
  → orders/picking.service.ts:679

1. Guard: binCount between 0 and 10,000
2. Resolve product_variant by SKU
3. IF didReplen=true:
   → replenishment.createAndExecuteReplen(variantId, locationId)
4. IF surplus detected AND !didReplen:
   → replenishment.inferUnrecordedReplen(variantId, locationId, surplus)
5. Re-read system qty
6. Compute adjustment = binCount - systemQty
7. IF adjustment != 0:
   → inventoryCore.adjustLevel(level.id, { variantQty: adjustment })
   → inventoryCore.logTransaction(type: 'cycle_count')
```

**⚠️ Boundary Violation (P1, from audit Finding 15):**
- **picking.service.ts:handleBinCount/confirmCaseBreak/skipReplen** — Uses `inventoryCore.adjustLevel()` instead of `inventoryCore.adjustInventory()`.
  - `adjustLevel()` does NOT fire `notifyChange()`
  - `adjustLevel()` does NOT check for negative inventory
  - `adjustLevel()` does NOT adjust lots
  - **Fix:** Replace with `inventoryCore.adjustInventory()` which does all three.

### 4C. Replen Check After Pick

```
replenishment.checkReplenNeeded(variantId, locationId)
  → inventory/replen.service.ts (read-only guidance)
  → Returns: { needed, stockout, sourceLocationCode, sourceVariantSku, qtyTargetUnits }
  → Used by picker UI to show replen guidance — NO task created
```

Actual replen task creation happens via `checkAndTriggerAfterPick()` or `createAndExecuteReplen()` (see Process 5).

---

## 5. Case Break / Replenishment

### 5A. Replen Detection

**Trigger:** `checkAndTriggerAfterPick()` called from picking flow or `checkReplenForLocation()` from cycle count

```
replenishment.checkAndTriggerAfterPick(variantId, locationId)
  → inventory/replen.service.ts:650

1. evaluateReplenNeed(variantId, locationId) → replen.service.ts:220
   a. Check inventory_levels.variantQty at location
   b. Verify location is pickable and has product_locations assignment
   c. Resolve replen params: variant rule → product rule → tier default
   d. Check threshold (qty-based or pallet_drop velocity-based)
   e. Dedup: check for existing pending/assigned/in_progress tasks
   f. findSourceLocation() → finds stock in reserve/pallet locations
   g. If no same-variant source, try higher-hierarchy siblings (case variants)
   h. Calculate qty needed: maxQty - currentQty (or triggerValue * 2)
2. If needed_with_source:
   → INSERT into replen_tasks (status: pending)
   → If autoReplen enabled: executeTask() immediately
3. If needed_stockout:
   → Try cascade replen (dependency chain)
   → If no cascade: INSERT replen_tasks (status: blocked)
   → Fire stockout notification
```

### 5B. Source Location Finding (FIXED today)

```
replenishment.findSourceLocation(variantId, warehouseId, sourceLocationType, parentLocationId, sourcePriority)
  → inventory/replen.service.ts

1. Query inventory_levels JOIN warehouse_locations
   WHERE locationType = sourceLocationType AND variantQty > 0
2. Filter out frozen locations (cycleCountFreezeId)
3. Sort by sourcePriority: 'fifo' (oldest first) or 'proximity' (parent location first)
4. Return first matching location
```

### 5C. Case Break Execution

```
replenishment.executeTask(taskId)
  → inventory/replen.service.ts:411

IF replenMethod === 'case_break':
  1. Load source variant (case) and pick variant (pack)
  2. Calculate conversion: sourceQty × sourceUnitsPerVariant / pickUnitsPerVariant
  3. db.transaction():
     a. Atomic guarded decrement: source variantQty -= sourceQty
        → Direct SQL UPDATE on inventory_levels (WHERE variantQty >= qty)
     b. Log 'break' transaction for source variant
     c. Upsert + increment dest level: pickVariant at toLocation
     d. Log 'replenish' transaction for pick variant
     e. Update replen_tasks status = 'completed'

IF replenMethod === 'full_case' (same-variant transfer):
  1. inventoryCore.transfer({fromLocationId, toLocationId, qty})
     → inventory/core.service.ts:703
  2. Update replen_tasks status = 'completed'
```

**⚠️ Boundary Violation (P0, from audit Finding 6):**
- **Case break via `executeTask()`** — The `case_break` path does direct SQL on `inventory_levels` (lines ~460-520 of replen.service.ts), bypassing `inventoryCore` and `breakAssemblyService`.
  - Does NOT fire `notifyChange()` or `channelSync.queueSyncAfterInventoryChange()`
  - Does NOT go through `breakAssemblyService.breakVariant()` (which also doesn't fire sync, but at least handles lot tracking)
  - **Fix:** Call `breakAssemblyService.breakVariant()` from `executeTask()`, and add `channelSync.queueSyncAfterInventoryChange()` for both source and target variant after execution.

- **Full case via `transfer()`** — `inventoryCore.transfer()` does NOT call `notifyChange()` (Finding 4).
  - **Fix:** Add `this.notifyChange(params.productVariantId, "transfer")` at end of `transfer()`.

**Atomicity:** Case break runs inside `db.transaction()` — atomic. Full case uses `inventoryCore.transfer()` which also uses `db.transaction()` — atomic.

### 5D. Picker-Initiated Case Break

```
pickingService.initiateCaseBreak(sku, locationId)
  → orders/picking.service.ts:527

1. Check for existing pending/blocked replen task at this location
2. If found: execute it → replenishment.executeTask(taskId)
3. If not found:
   → replenishment.checkAndTriggerAfterPick(variantId, locationId)
   → If task created + auto-execute: done
   → Otherwise: replenishment.executeTask(task.id)
```

### 5E. Break/Assembly via Direct API

```
breakAssemblyService.breakVariant({sourceVariantId, targetVariantId, locationId, qty})
  → inventory/break-assembly.service.ts:100

1. Validate: same product, source > target in hierarchy, direct parent→child
2. Resolve target location: explicit > bin assignment > same as source
3. db.transaction():
   a. Validate source stock
   b. adjustWithinTx(sourceLevel.id, { variantQty: -sourceQty })
      → Direct SQL on inventory_levels (NOT through inventoryCore)
   c. adjustWithinTx(targetLevel.id, { variantQty: +targetQty })
      → Direct SQL on inventory_levels
   d. Log two 'break' transactions (source decrement + target increment)
```

**⚠️ Boundary Violation (P0, from audit Finding 6):**
- `adjustWithinTx()` is a private helper that does raw `UPDATE inventory_levels` — bypasses `inventoryCore`
- Does NOT fire `notifyChange()` or `channelSync`
- Comment in code says "break does not change ATP — same fungible pool" — **this is correct for the total pool**, but channel sync still needs to know because per-variant quantities change on Shopify
- **When called via inventory.routes.ts** — the route DOES fire `channelSync.queueSyncAfterInventoryChange()` for both variants — ✅
- **When called via replen.service.ts `executeTask()`** — does NOT fire sync — ❌

---

## 6. Packing / Shipping

### 6A. Shopify Fulfillment Webhook (ShipStation → Shopify → Echelon)

**Trigger:** ShipStation marks order shipped → Shopify fires `fulfillments/create` webhook

```
1. shopify.routes.ts: POST /api/webhooks/shopify/fulfillment
   → routes/shopify.routes.ts
2. fulfillmentService.processShopifyFulfillment({shopifyOrderId, fulfillmentId, tracking, lineItems})
   → orders/fulfillment.service.ts:270

   db.transaction():
   a. Idempotency: check shipments by externalFulfillmentId
   b. Resolve internal order from `orders` by shopifyOrderId
   c. CREATE shipment (source: 'shopify_webhook', status: 'pending')
   d. For each line item:
      i.   Match by SKU to order_items
      ii.  Resolve product_variant by SKU
      iii. Resolve fromLocationId: pick transaction > pickedQty location > max on-hand location
      iv.  INSERT shipment_items
   e. confirmShipmentInternal(shipmentId):
      → For each shipment_item with productVariantId + fromLocationId:
        inventoryCore.recordShipment({variantId, locationId, qty, orderId, ...})
        → inventory/core.service.ts:410
        → Drains pickedQty first, then variantQty (with CLAMP to prevent negative)
        → Releases matching reservedQty
        → Logs 'ship' transaction
        → Lot tracking: lotService.shipFromLots()
   f. UPDATE shipments status = 'shipped'
   g. UPDATE order_items: picked_quantity, fulfilled_quantity, status = 'completed'

3. Post-commit: channelSync.queueSyncAfterInventoryChange(variantId)
   → For each affected variant
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1 | External (Shopify webhook) | |
| 2a-d | WMS (Fulfillment) | Shipment record creation |
| 2e | WMS (inventoryCore) | Inventory release |
| 2f-g | WMS (Fulfillment) | Status updates |
| 3 | Channel Sync | ATP push |

**Atomicity:** Entire flow runs inside a single `db.transaction()` — fully atomic. If any step fails, nothing is committed.

**Sync Triggers:** Explicit `channelSync.queueSyncAfterInventoryChange()` — ✅. `recordShipment()` does NOT call `notifyChange()` (comment: "shipment does not change ATP"), but the explicit call covers it.

### 6B. ShipStation SHIP_NOTIFY Webhook (eBay flow)

**Trigger:** ShipStation ships an eBay order → fires SHIP_NOTIFY webhook

```
1. POST /api/webhooks/shipstation/ship-notify
   → routes/oms.routes.ts
2. shipStationService.processShipNotify(resourceUrl)
   → oms/shipstation.service.ts:237
   a. Fetch shipment data from ShipStation API
   b. For each shipment with orderKey 'echelon-oms-{id}':
      i.   Parse OMS order ID
      ii.  UPDATE oms_orders: status='shipped', tracking info
      iii. UPDATE oms_order_lines: fulfillmentStatus='fulfilled'
      iv.  INSERT oms_order_events (type: 'shipped_via_shipstation')
      v.   fulfillmentPush.pushTracking(omsOrderId)
           → oms/fulfillment-push.service.ts:41
```

**⚠️ Boundary Violation:**
- **shipstation.service.ts:280** — Updates `oms_orders` status directly (raw UPDATE), not through `omsService.markShipped()`. This duplicates the status update logic.
  - **Fix:** Call `omsService.markShipped()` instead of inline UPDATE.
- **No inventory deduction happens here.** ShipStation/eBay orders don't go through `inventoryCore.recordShipment()`. The reservation was made via `reserveForOrder()`, but there's no ship confirmation that releases reserved → shipped.
  - **Fix needed:** After ShipStation confirms shipment, call `inventoryCore.recordShipment()` for each line item to properly deduct inventory.

### 6C. Tracking Push to Channel

```
fulfillmentPush.pushTracking(orderId)
  → oms/fulfillment-push.service.ts:41

1. Load oms_order from DB
2. Load channel info
3. If eBay: pushToEbay(order, orderId)
   → ebayApiClient.createShippingFulfillment(externalOrderId, fulfillmentPayload)
   → INSERT oms_order_events (type: 'tracking_pushed')
4. If Shopify: skip (handled natively by ShipStation)
```

**System Ownership:** OMS → External (eBay API). Clean boundary.

---

## 7. Receiving

### 7A. PO Creation

```
purchasingService.createPO(data)
  → procurement/purchasing.service.ts

1. Generate PO number: storage.generatePoNumber()
2. INSERT purchase_orders (status: 'draft')
3. For each line: INSERT purchase_order_lines
4. INSERT po_status_history
```

**System Ownership:** Procurement owns entirely.

### 7B. Receiving Order Creation

```
purchasingService.createReceivingOrderFromPo(purchaseOrderId)
  → procurement/purchasing.service.ts

1. Load PO + PO lines
2. Generate receipt number: storage.generateReceiptNumber()
3. INSERT receiving_orders (linked to PO)
4. For each PO line: INSERT receiving_lines (expectedQty from PO line)
```

### 7C. Lines Received (User Input)

```
receivingService.bulkImportLines(orderId, csvLines)
  → procurement/receiving.service.ts:350

1. For each CSV line:
   a. Resolve SKU → product_variants
   b. Resolve location code → warehouse_locations (fuzzy matching)
   c. Set receivedQty from CSV
2. Batch INSERT/UPDATE receiving_lines
3. Update receiving_order totals
```

**No inventory changes yet** — receiving lines just record intent.

### 7D. Receiving Order Close (Inventory Receipt)

```
receivingService.close(orderId)
  → procurement/receiving.service.ts:136

1. Validate: all received lines have productVariantId + putawayLocationId
2. For each received line (receivedQty > 0):
   a. Determine unit cost: landed cost > PO line cost > receiving line cost
   b. inventoryCore.receiveInventory({variantId, locationId, qty, referenceId, unitCostCents, ...})
      → inventory/core.service.ts:218
      → db.transaction():
        i.   Upsert inventory_levels row
        ii.  adjustLevel(level.id, { variantQty: qty })
        iii. Lot creation: lotService.createLot() + updateVariantCosts()
        iv.  Log 'receipt' transaction
      → notifyChange(variantId, "receive") ✅
   c. Mark receiving_line as putaway_complete
3. Fire channel sync for all received variants:
   channelSync.queueSyncAfterInventoryChange(variantId)
   → (fire-and-forget for each variant)
4. Close receiving_order (status: 'closed')
5. If linked to PO: purchasing.onReceivingOrderClosed()
   → Updates PO line received_qty, auto-transitions PO status
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1-2 | Procurement (ReceivingService) | |
| 2b | WMS (inventoryCore) | Inventory receipt — ✅ proper delegation |
| 3 | Channel Sync | ATP push |
| 5 | Procurement | PO status update |

**Atomicity:** Each `receiveInventory()` call is individually transactional. If one line fails, previously received lines are committed. The close operation itself is not wrapped in a single transaction across all lines.

**Sync Triggers:**
- `inventoryCore.receiveInventory()` fires `notifyChange(variantId, "receive")` — ✅
- `receiving.service.ts` fires explicit `channelSync.queueSyncAfterInventoryChange()` — ✅ (dual trigger, harmless)

### 7E. Complete All Lines

```
receivingService.completeAllLines(orderId)
  → procurement/receiving.service.ts:263

1. For each incomplete line:
   → Uses user-entered qty if > 0, else sets to 0
   → ✅ FIXED (was previously overriding with expectedQty)
2. Update receiving_order totals
```

**No inventory changes** — this just marks lines complete, doesn't close the order.

---

## 8. Inventory Adjustment

### 8A. Manual Adjustment

**Trigger:** Admin adjusts inventory via UI

```
POST /api/inventory/adjust
  → inventory/inventory.routes.ts

inventoryCore.adjustInventory({variantId, locationId, qtyDelta, reason, userId})
  → inventory/core.service.ts:545

db.transaction():
  1. Upsert inventory_levels row
  2. Guard against negative (unless allowNegative=true)
  3. adjustLevel(level.id, { variantQty: qtyDelta })
  4. Lot adjustment: lotService.adjustLots()
  5. Log 'adjustment' transaction
  6. Zombie cleanup: delete empty inventory_levels rows without bin assignment

Post-transaction:
  → notifyChange(variantId, "adjustment") ✅
```

**Route also fires:** `channelSync.queueSyncAfterInventoryChange(variantId)` — dual trigger, ✅.

### 8B. Cycle Count

```
cycleCountService.approveItemCore(item, reasonCode, notes, approvedBy)
  → inventory/cycle-count.service.ts:~380

1. Read REAL-TIME inventory qty (not stale snapshot)
2. Compute realTimeVariance = countedQty - currentQty
3. NEGATIVE GUARD: if adjustment would create negative, flag as 'investigate'
4. IF realTimeVariance != 0:
   inventoryCore.adjustInventory({variantId, locationId, qtyDelta: realTimeVariance, reason, cycleCountId})
   → Same flow as 8A
5. After negative adjustments: reservation.reallocateOrphaned(variantId, locationId)
6. Mark item as approved
7. reconcileBinAssignment(item) — sync product_locations with physical reality

Post-approval side effects (fire-and-forget):
  → channelSync.queueSyncAfterInventoryChange(variantId) ✅
  → replenishment.checkReplenForLocation(locationId) — for negative adjustments
```

**System Ownership:** WMS owns cycle counts. Goes through `inventoryCore.adjustInventory()` — ✅ correct delegation.

**Atomicity:** Each item approval is independent. The `adjustInventory()` call is transactional.

### 8C. Transfer (Bin-to-Bin)

```
inventoryCore.transfer({variantId, fromLocationId, toLocationId, qty})
  → inventory/core.service.ts:703

db.transaction():
  1. Validate source has stock
  2. Atomic guarded decrement: source variantQty -= qty (WHERE >= qty)
  3. Zombie cleanup on source
  4. Upsert + increment destination
  5. Lot transfer: lotService.transferLots()
  6. Log two 'transfer' transactions (source + dest)

Post-transaction:
  → Comment says "transfer does not change ATP — same fungible pool"
  → Does NOT call notifyChange() ❌
```

**⚠️ Boundary Violation (P0, Finding 4):**
- `transfer()` does NOT fire `notifyChange()`. While transfers typically don't change total ATP, the sync orchestrator checks per-warehouse ATP. Transfers between warehouses would change per-warehouse ATP.
- **When called via inventory.routes.ts** — the route fires `channelSync.queueSyncAfterInventoryChange()` — ✅
- **When called via replen.service.ts `executeTask()` (full_case)** — does NOT fire sync — ❌
- **When called via cycle-count.service.ts** — the cycle count fires `channelSync` in `firePostApprovalSideEffects()` — ✅
- **Fix:** Add `this.notifyChange(params.productVariantId, "transfer")` at end of `transfer()`.

### 8D. SKU Correction Transfer

```
inventoryCore.skuCorrectionTransfer({sourceVariantId, targetVariantId, locationId, qty, batchId})
  → inventory/core.service.ts:803

db.transaction():
  1. Validate: source has stock, no reserved qty at source
  2. Atomic guarded decrement on source variant
  3. Upsert + increment on target variant
  4. Log two 'sku_correction' transactions (source + dest)

Post-transaction:
  → Does NOT call notifyChange() ❌
```

**⚠️ Boundary Violation (P0, Finding 5):**
- Changes ATP for BOTH source and target variants, but neither gets sync notification.
- **When called via routes** — the route fires `channelSync` — ✅
- **When called service-to-service** — no sync — ❌
- **Fix:** Add `notifyChange()` for both `sourceVariantId` and `targetVariantId`.

---

## 9. Channel Sync

### 9A. ATP Computation

```
atpService.getAtpPerVariant(productId)
  → inventory/atp.service.ts:200

1. getAtpBase(productId) → atp.service.ts:150
   a. getTotalBaseUnits(productId) → atp.service.ts:91
      → SELECT SUM(variantQty * unitsPerVariant) as onHand,
               SUM(reservedQty * unitsPerVariant) as reserved, ...
        FROM inventory_levels JOIN product_variants
        WHERE productId = ?
   b. ATP = onHand - reserved - picked - packed
2. For each active variant: atpUnits = floor(atpBase / unitsPerVariant)
```

**Also available per-warehouse:**
```
atpService.getAtpPerVariantByWarehouse(productId, warehouseId)
  → Scopes to inventory_levels at specific warehouse
```

**System Ownership:** WMS (read-only service). No writes, no boundary issues.

### 9B. Allocation

```
allocationEngine.allocateProduct(productId, triggeredBy)
  → channels/allocation-engine.service.ts

1. For each active channel:
   a. Load channel_allocation_rules (variant > product > channel default)
   b. Load channel_feeds for this product's variants
   c. Get variant ATPs from atpService
   d. Apply allocation rules: mirror/share/fixed + floor/ceiling
   e. Check channel_variant_overrides.is_listed and channel_product_overrides.is_listed
   f. Log to allocation_audit_log
2. Return allocations: [{ channelId, variantId, allocatedUnits, method }]
```

**System Ownership:** Channel Sync owns allocation rules and computation.

### 9C. Push to Shopify

```
orchestrator.syncInventoryForProduct(productId, config)
  → channels/echelon-sync-orchestrator.service.ts:175

1. allocationEngine.allocateProduct(productId)
2. Group allocations by channel
3. For each channel:
   pushInventoryToChannelWarehouseAware(channelId, ...)
   → echelon-sync-orchestrator.service.ts:301

   For each assigned warehouse:
   a. Query variant existence at warehouse (inventory_levels + product_locations)
      → ✅ FIXED: now uses UNION of inventory_levels and product_locations (not just product_locations)
   b. Get per-warehouse ATP via atpService.getAtpPerVariantByWarehouse()
      OR fallback: direct per-variant SQL ⚠️ (Finding 10 — non-fungible fallback)
   c. Apply allocation rules to per-warehouse ATP
   d. Build push items with warehouseBreakdown
   e. Shopify adapter: set inventory level at Shopify location
   f. UPDATE channel_feeds.last_synced_qty
   g. Log to channel_sync_log
```

**Triggers:**
1. **Event-driven:** `inventoryCore.notifyChange()` → registered callback → `orchestrator.syncInventoryForProduct()`
2. **Explicit:** `channelSync.queueSyncAfterInventoryChange(variantId)` from services/routes
3. **Scheduled:** 15-minute sweep via `scheduled-sync.service.ts`

**⚠️ P1 Issues:**
- **Fallback ATP (Finding 10):** If `atpService` is undefined, falls back to per-variant SQL that ignores fungible conversion. Not currently triggered but dangerous.
- **Legacy sync.service.ts (Finding 9):** `ChannelSyncService.syncProduct()` has a full legacy allocation engine reimplemented. If orchestrator throws, falls back to legacy path with DIFFERENT allocation logic.

### 9D. What Triggers Sync (Complete Coverage Matrix)

| Mutation | notifyChange | Explicit channelSync | Covered? |
|----------|:---:|:---:|:---:|
| `receiveInventory()` | ✅ core:274 | ✅ receiving.service | ✅ |
| `pickItem()` | — (correct: ATP unchanged) | — | ✅ N/A |
| `recordShipment()` | — (correct: ATP unchanged) | ✅ fulfillment.service | ✅ |
| `adjustInventory()` | ✅ core:593 | ✅ routes + cycle-count | ✅ |
| `reserveForOrder()` | ✅ core:669 | ✅ reservation.service | ✅ |
| `releaseReservation()` | ✅ core:715 | ✅ reservation.service | ✅ |
| `transfer()` | ❌ | ✅ routes only | ⚠️ Route-only |
| `skuCorrectionTransfer()` | ❌ | ✅ routes only | ⚠️ Route-only |
| `breakVariant()` (break-assembly) | ❌ | ✅ routes only | ⚠️ Route-only |
| `assembleVariant()` (break-assembly) | ❌ | ✅ routes only | ⚠️ Route-only |
| `executeTask()` case_break (replen) | ❌ | ❌ | ❌ Missing! |
| `executeTask()` full_case (replen) | ❌ | ❌ | ❌ Missing! |
| `setInventoryLevel()` (3PL) | ✅ via adjustInventory | ✅ via adjustInventory | ✅ FIXED |
| Picking `adjustLevel()` bin counts | ❌ | ❌ | ❌ Missing! |
| Cancellation `adjustLevel()` releases | ❌ | ❌ | ❌ Missing! |

---

## 10. Returns

### 10A. Return Processing

```
returnsService.processReturn({orderId, items, warehouseLocationId, userId})
  → orders/returns.service.ts:100

For each returned item:
  IF condition === 'sellable':
    1. inventoryCore.receiveInventory({variantId, locationId, qty, ...})
       → Adds stock back to variantQty ✅
       → Fires notifyChange("receive") ✅ → channel sync triggers
    2. inventoryCore.logTransaction(type: 'return', targetState: 'on_hand')

  IF condition === 'damaged' or 'defective':
    1. inventoryCore.receiveInventory({variantId, locationId, qty, ...})
       → Temporarily adds stock ✅
    2. inventoryCore.adjustInventory({variantId, locationId, qtyDelta: -qty, reason: 'damaged'})
       → Immediately removes stock ✅
       → Fires notifyChange("adjustment") ✅
    3. inventoryCore.logTransaction(type: 'return', targetState: 'damaged')
```

**System Ownership:** WMS owns returns. Properly delegates through `inventoryCore` — ✅.

**Atomicity:** Each item is processed independently. Both `receiveInventory` and `adjustInventory` are individually transactional, but the pair (receive + adjust for damaged) is NOT in a single transaction. If `adjustInventory` fails after `receiveInventory` succeeds, damaged stock remains in available inventory.
- **Fix:** Wrap the receive + adjust pair in `db.transaction()` for damaged/defective returns.

**Sync Triggers:** `receiveInventory()` fires `notifyChange` and `adjustInventory()` fires `notifyChange` — ✅. Returns properly update channel quantities.

---

## Cross-Cutting Issues

### Issue A: Multiple Code Paths for Sync

There are two complete sync engines:
1. **`echelon-sync-orchestrator.service.ts`** — The current engine. Uses allocation engine, warehouse-aware ATP, adapter pattern.
2. **`sync.service.ts`** — Legacy engine. Has its own inline allocation logic using different tables (`channel_product_allocation` vs `channel_allocation_rules`).

The legacy engine is still wired up. If the orchestrator throws, `sync.service.ts:~135` catches the error and falls back to the legacy path. This means:
- Different allocation rules apply on error
- Different ATP calculation (non-fungible)
- No warehouse-aware push

**Fix:** Remove the fallback in `sync.service.ts`. If the orchestrator fails, it should log an error and retry, not fall back to a different engine.

### Issue B: Dead Code Paths

- **`InventorySourceService.setInventoryLevel()`** — Was a P0 finding for bypassing core. Now ✅ FIXED — routes through `inventoryCore.adjustInventory()` which fires `notifyChange` and writes proper audit trail.

### Issue C: Functions That Do Too Much

1. **`order-sync-listener.ts:syncSingleOrder()`** (~150 lines) — Handles order creation, item enrichment, routing, SLA, reservation, AND OMS bridging. Should be split into:
   - `createWmsOrder()` — creates orders + order_items
   - `routeAndReserve()` — routing + reservation
   - `bridgeToOms()` — OMS bridging

2. **`echelon-sync-orchestrator.service.ts:pushInventoryToChannelWarehouseAware()`** (~300 lines) — Handles warehouse resolution, ATP calculation, allocation rule application, push item building, adapter calling, and feed updates. Could be split but the monolithic transaction boundary is intentional.

### Issue D: OMS ↔ WMS Status Sync Gap

**Order status lives in three places:**
1. `orders.warehouse_status` — WMS operational truth (ready → in_progress → packed → shipped)
2. `oms_orders.status` — OMS unified view (pending → confirmed → shipped)
3. Shopify `fulfillment_status` — External

**Sync flows:**
- Shopify → `orders` (via `syncOrderUpdate`) — ✅
- Shopify → `oms_orders` — ❌ MISSING (Finding 8). `oms_orders.status` is set at ingestion and never updated.
- `orders` → `oms_orders` — ❌ No linkage. When a WMS order ships, `oms_orders` isn't updated.
- ShipStation → `oms_orders` — ✅ (via `processShipNotify`)

**Fix:** Add `omsService.markShippedByExternalId()` call to `fulfillmentService.processShopifyFulfillment()` and/or `syncOrderUpdate()` when orders transition to shipped.

### Issue E: eBay Orders Not in Pick Queue

eBay orders exist only in `oms_orders`. The pick queue reads from `orders`. This means eBay orders can only be fulfilled via ShipStation — they never appear in the Echelon picking flow.

**Current workaround:** ShipStation handles eBay fulfillment end-to-end.

**Future fix:** Bridge eBay orders from `oms_orders` into `orders` (similar to how Shopify bridge works, but in reverse direction).

---

## Summary of All Boundary Violations

### 🔴 P0 — Fix Immediately

| # | Finding | File | Impact | Fix |
|---|---------|------|--------|-----|
| 1 | `replen.executeTask()` case_break bypasses inventoryCore + channelSync | `replen.service.ts:460-520` | Case breaks via replen don't push to Shopify | Use `breakAssemblyService` + add channelSync |
| 2 | `replen.executeTask()` full_case → `transfer()` has no notifyChange | `core.service.ts:703` | Transfers via replen don't trigger sync | Add `notifyChange()` to `transfer()` |
| 3 | Picking `adjustLevel()` for bin counts bypasses notifyChange + negative guards | `picking.service.ts:confirmCaseBreak/skipReplen/handleBinCount` | Bin count corrections don't sync | Use `adjustInventory()` instead |
| 4 | Cancellation `adjustLevel()` bypasses notifyChange | `order-sync-listener.ts:306` | Released picked inventory doesn't sync | Use `adjustInventory()` or add explicit sync |
| 5 | `skuCorrectionTransfer()` has no notifyChange | `core.service.ts:803` | SKU corrections via service calls don't sync | Add `notifyChange()` for both variants |

### 🟡 P1 — Fix Before Scale

| # | Finding | File | Impact | Fix |
|---|---------|------|--------|-----|
| 6 | Reservation requires `product_locations` assignment | `reservation.service.ts:131` | Unslotted variants can't be reserved | Fall back to any location with stock |
| 7 | eBay ship confirmation doesn't deduct inventory via inventoryCore | `shipstation.service.ts:280` | eBay shipments don't release inventory | Add `recordShipment()` calls |
| 8 | OMS orders never updated after ingestion | `shopify-bridge.ts` | `oms_orders` stuck in 'confirmed' | Add fulfillment webhook → OMS update |
| 9 | Legacy sync.service.ts fallback uses different allocation | `sync.service.ts:135` | Error fallback produces wrong quantities | Remove legacy fallback |
| 10 | Orchestrator fallback ATP ignores fungible model | `echelon-sync-orchestrator.service.ts:~430` | Would push wrong quantities if triggered | Remove inline SQL fallback |
| 11 | Returns damage flow not atomic (receive + adjust separate txns) | `returns.service.ts:160-175` | Damaged stock could stay sellable on failure | Wrap in single transaction |

### 🟢 P2 — Tech Debt

| # | Finding | File | Impact |
|---|---------|------|--------|
| 12 | `syncSingleOrder()` does too many things (150+ lines) | `order-sync-listener.ts:109` | Hard to maintain |
| 13 | eBay orders not in pick queue | `oms/` vs `orders/` | eBay requires ShipStation for fulfillment |
| 14 | Inline `available = variantQty - reservedQty` in routes | `inventory.routes.ts:2189,2268,2311` | Display only, not used for decisions |
| 15 | `channel_feeds.last_synced_qty` can drift from Shopify | Multiple | No reconciliation from Shopify |

---

## Recommended Fix Order

1. **Add `notifyChange()` to `transfer()` and `skuCorrectionTransfer()`** — 30 min, fixes P0 #2, #5
2. **Replace `adjustLevel()` with `adjustInventory()` in picking service** — 30 min, fixes P0 #3
3. **Add channelSync to `replen.executeTask()`** — 30 min, fixes P0 #1
4. **Add explicit channelSync to cancellation release** — 15 min, fixes P0 #4
5. **Add `recordShipment()` to ShipStation SHIP_NOTIFY for eBay** — 1 hour, fixes P1 #7
6. **Add OMS status update from fulfillment webhook** — 1 hour, fixes P1 #8
7. **Remove legacy sync fallback** — 30 min, fixes P1 #9
8. **Add reservation fallback for unslotted variants** — 30 min, fixes P1 #6
9. **Wrap damage return in transaction** — 15 min, fixes P1 #11
10. **Remove orchestrator inline ATP fallback** — 15 min, fixes P1 #10

**Total: ~5 hours for all P0+P1 fixes.**

---

*Last updated: 2026-03-20*

---

## Additional Process Audits

> **Generated:** 2026-03-21 | **Auditor:** Systems Architect (read-only)
> **Scope:** All non-WMS-core business processes — Procurement, AP/Invoicing, Catalog, Notifications, Bin Assignment, Warehouse Settings, Fulfillment Routing, Order Combining

---

## 11. Procurement (PO Lifecycle)

### 11A. PO Creation, Lines, Status Transitions

**Trigger:** User creates a PO via UI → `POST /api/purchase-orders`

**Happy Path:**

```
1. purchasing.createPO(data)
   → procurement/purchasing.service.ts:createPO (~line 130)
   a. Validate vendor exists via storage.getVendorById()
   b. Generate PO number via storage.generatePoNumber()
   c. INSERT purchase_orders (status: 'draft')
   d. recordStatusChange() → INSERT po_status_history

2. purchasing.addLine(purchaseOrderId, data)
   → procurement/purchasing.service.ts:addLine (~line 175)
   a. Guard: PO must be in EDITABLE_STATUSES ('draft')
   b. Validate product + variant via storage
   c. Calculate line total
   d. INSERT purchase_order_lines
   e. recalculateTotals() → UPDATE purchase_orders header totals

3. purchasing.submit(id)
   → procurement/purchasing.service.ts:submit (~line 260)
   a. Validate at least 1 active line with qty > 0
   b. Recalculate totals
   c. Check approval tier: storage.getMatchingApprovalTier(totalCents)
   d. If tier matches → status = 'pending_approval'
   e. If no tier → auto-approve (status = 'approved')
   f. recordStatusChange()

4. Status transitions: approve → send → acknowledge → (receiving) → close
   → Each validates via assertTransition() against VALID_TRANSITIONS map
   → Each records to po_status_history
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| All steps | Procurement | PO lifecycle is 100% Procurement-owned |

**⚠️ Boundary Violations:** None.
- Does NOT touch `inventory_levels` — ✅
- Does NOT touch `orders` or `oms_orders` — ✅
- Only touches Procurement-owned tables: `purchase_orders`, `purchase_order_lines`, `po_status_history`, `vendors`, `vendor_products`

**Atomicity:** Individual storage calls are not wrapped in a single transaction across steps. `recalculateTotals()` iterates lines and updates each, then updates the header. If it fails mid-way, line totals could be inconsistent with header totals. Low risk — retry-safe.

### 11B. PO Line Update with Variant Cascade

**Trigger:** User changes the variant/SKU on an existing PO line → `PATCH /api/purchase-orders/lines/:lineId`

```
purchasing.updateLine(lineId, updates)
  → procurement/purchasing.service.ts:updateLine (~line 215)

1. Guard: PO must be in LINE_AMENDABLE_STATUSES (draft through partially_received)
2. storage.updatePurchaseOrderLine(lineId, updates)
3. IF updates.productVariantId or updates.sku changed:
   a. Cascade to inbound_shipment_lines (variant, SKU, recalc cartons)
      → Direct db.update(inboundShipmentLines) with drizzle ORM
   b. Cascade to landed_cost_snapshots (variant)
      → Direct db.update(landedCostSnapshots)
   c. Cascade to vendor_invoice_lines (variant)
      → Direct db.update(vendorInvoiceLines)
4. recalculateTotals()
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1-2 | Procurement | PO line update |
| 3a | Procurement | Inbound shipment lines are Procurement-owned ✅ |
| 3b | Procurement | Landed cost snapshots are Procurement-owned ✅ |
| 3c | Procurement | Vendor invoice lines are Procurement-owned ✅ |

**⚠️ Boundary Violations:** None. All cascaded tables (`inbound_shipment_lines`, `landed_cost_snapshots`, `vendor_invoice_lines`) are owned by Procurement per BOUNDARIES.md.

### 11C. Receiving → PO Status Update

**Trigger:** ReceivingService closes a receiving order linked to a PO

```
purchasing.onReceivingOrderClosed(receivingOrderId, receivingLines)
  → procurement/purchasing.service.ts:onReceivingOrderClosed (~line 345)

1. For each receiving line with purchaseOrderLineId:
   a. Update PO line received/damaged quantities
   b. Auto-transition line status (open → partially_received → received)
   c. Create po_receipt record (cost variance tracking)
2. recalculateTotals()
3. Auto-transition PO status:
   - All lines received → status = 'received'
   - Some lines received → status = 'partially_received'
```

**System Ownership:** Procurement owns all steps. This is called BY the WMS (receiving service) INTO Procurement — correct handoff direction per BOUNDARIES.md.

**⚠️ Boundary Violations:** None.

### 11D. Reorder → PO Generation

```
purchasing.createPOFromReorder(items)
  → procurement/purchasing.service.ts:createPOFromReorder (~line 410)

1. Group items by vendor (preferred vendor lookup)
2. For each vendor group: createPO() + addBulkLines()
```

**Reads:** `vendor_products` (Procurement-owned), `product_variants` (Catalog-owned, read-only lookup). Read-only cross-system access is acceptable.

**⚠️ Boundary Violations:** None.

### 11E. Reorder Analysis (Reports Route)

```
GET /api/purchasing/reorder-analysis
  → procurement/procurement.routes.ts (~line 688)

1. storage.getReorderAnalysisData(lookbackDays)
   → procurement/procurement.storage.ts:getReorderAnalysisData
   → Raw SQL query JOINing:
     - products
     - product_variants
     - inventory_levels (SUM of variantQty, reservedQty)
     - order_items + orders (velocity calculation)
     - purchase_order_lines + purchase_orders (on-order qty)
```

**⚠️ Boundary Violations:**
- **procurement.storage.ts:getReorderAnalysisData** — Reads `inventory_levels` directly for stock-on-hand and reserved quantities. This is a **read-only cross-system access** from Procurement into WMS tables.
- **procurement.storage.ts:getReorderAnalysisData** — Reads `order_items` + `orders` for velocity. Read-only cross-system access from Procurement into OMS/WMS tables.
- **Verdict:** These are read-only reporting queries used for reorder analysis. They don't write to any foreign tables. **Acceptable** for reporting, but ideally would go through `atpService` for the inventory portion.
- **P3 improvement:** Replace the direct `inventory_levels` SUM with `atpService.getAtpBase()` calls to keep the read path consistent.

### 11F. Financial Reports

```
GET /api/reports/order-profitability
GET /api/reports/product-profitability
GET /api/reports/vendor-spend
GET /api/reports/cost-variance
  → procurement/procurement.storage.ts (raw SQL)
```

**⚠️ Boundary Violations:**
- `getOrderProfitabilityReport()` — Reads `orders`, `order_items`, `order_item_costs`. Cross-reads OMS/WMS tables.
- `getProductProfitabilityReport()` — Reads `order_items`, `product_variants`. Cross-reads.
- **Verdict:** Read-only reporting. Acceptable. No writes.

---

## 12. AP/Invoicing

### 12A. Vendor Invoice Lifecycle

**Happy Path:**

```
1. apLedger.createInvoice(data)
   → procurement/ap-ledger.service.ts:createInvoice (~line 95)
   a. INSERT vendor_invoices (status: 'received')
   b. If poIds provided: link POs + auto-import lines
   c. Recalculate invoice total from lines

2. apLedger.approveInvoice(id)
   → Status: received → approved

3. apLedger.recordPayment(data)
   → INSERT ap_payments
   → INSERT ap_payment_allocations (per invoice)
   → recalculateInvoiceBalance() for each affected invoice
     → Updates paid_amount_cents, balance_cents, auto-transitions status

4. apLedger.voidInvoice(id) / apLedger.disputeInvoice(id)
   → Status transitions with validation
```

**System Ownership:** All Procurement-owned tables: `vendor_invoices`, `vendor_invoice_po_links`, `vendor_invoice_lines`, `ap_payments`, `ap_payment_allocations`, `vendor_invoice_attachments`.

**⚠️ Boundary Violations:** None.
- Does NOT touch `inventory_levels` — ✅
- Does NOT touch `orders` — ✅
- Reads `purchase_orders` and `purchase_order_lines` for PO linking and 3-way match — both Procurement-owned — ✅
- Reads `vendors` for display enrichment — Procurement-owned — ✅

### 12B. 3-Way Match

```
apLedger.runInvoiceMatch(invoiceId)
  → procurement/ap-ledger.service.ts:runInvoiceMatch (~line 335)

For each invoice line with purchaseOrderLineId:
  1. Fetch current PO line data
  2. Compare: unit cost, qty invoiced vs ordered vs received
  3. Set matchStatus: matched | price_discrepancy | over_billed | qty_discrepancy
```

**⚠️ Boundary Violations:** None. Only reads/writes `vendor_invoice_lines` and `purchase_order_lines` — both Procurement-owned.

### 12C. Shipment Cost → AP Bridge

```
apLedger.createInvoiceFromShipmentCosts(shipmentId, data)
  → procurement/ap-ledger.service.ts:createInvoiceFromShipmentCosts (~line 395)

1. Fetch unlinked costs from shipment_costs
2. Create a vendor_invoice with one line per cost
3. Link shipment_costs back to the invoice (vendorInvoiceId)
```

**System Ownership:** All Procurement tables. `shipment_costs`, `inbound_shipments`, `vendor_invoices` — all Procurement-owned.

**⚠️ Boundary Violations:** None.

**Atomicity:** Not wrapped in a single transaction. If the invoice is created but linking fails, costs remain unlinked. Low risk — manually recoverable.

---

## 13. Catalog Operations

### 13A. Shopify Content Sync

```
productImport.syncContentAndAssets()
  → catalog/product-import.service.ts:syncContentAndAssets (~line 60)

1. Fetch Shopify products via API
2. For each Shopify product:
   a. Match to Echelon product by shopifyProductId or SKU
   b. Update product fields: title, description, brand, category, tags, status
   c. Delete + recreate product_assets (images)
   d. Upsert product_locations by SKU (warehouse assignment sync)
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1 | External (Shopify API) | |
| 2a-c | Catalog | Product + asset updates |
| 2d | WMS | `product_locations` is WMS-owned |

**⚠️ Boundary Violations:**
- **product-import.service.ts:~line 118** — Calls `storage.upsertProductLocationBySku()` to sync `product_locations` from Shopify data. `product_locations` is owned by WMS per BOUNDARIES.md. The Catalog service is directly writing to a WMS table.
  - **Severity:** P2. This is a convenience sync (ensures warehouse bin assignments exist for Shopify products). It writes to `product_locations` (a WMS table) but only upserts display/assignment data, not inventory quantities.
  - **Fix:** Move this call to the bin assignment service or expose a `binAssignment.ensureAssignment()` method that Catalog calls.

**Does NOT touch:** `inventory_levels`, `orders`, `channel_feeds` — ✅

### 13B. Full Product/Variant Sync (Multi-UOM)

```
productImport.syncProductsWithMultiUOM()
  → catalog/product-import.service.ts:syncProductsWithMultiUOM (~line 145)

1. Fetch Shopify products
2. Parse SKU pattern: BASE-SKU-P50, -B200, -C700
3. Create/update products and product_variants
```

**System Ownership:** Catalog only.

**⚠️ Boundary Violations:** None. Only touches `products` and `product_variants` — Catalog-owned tables.

### 13C. Product Archive (Soft Delete)

```
POST /api/products/:id/archive
  → catalog/catalog.routes.ts:archive (~line 170)

1. Pre-flight dependency check:
   - Read inventory_levels (WMS) — read-only ✅
   - Read shipment_items (WMS) — read-only ✅
   - Read channel_feeds (Channel Sync) — read-only ✅
2. If transfer requested:
   - inventoryCore.skuCorrectionTransfer() for each level — ✅ proper delegation
   - channelSync.queueSyncAfterInventoryChange() — ✅
3. Cleanup:
   - storage.deleteInventoryLevelsByVariantId() → catalog.storage.ts
   - storage.deleteProductLocationsByVariantId()
   - storage.deactivateChannelFeedsByVariantId()
```

**⚠️ Boundary Violations:**
- **catalog.storage.ts:deleteInventoryLevelsByVariantId (~line 229)** — Direct `DELETE FROM inventory_levels`. This bypasses `inventoryCore` entirely. No `notifyChange()`, no audit trail, no channel sync.
  - **Called from:** Product archive (catalog.routes.ts ~line 305) and variant archive (~line 727)
  - **Impact:** Archived product's inventory disappears from WMS with no transaction log and no channel sync push. Shopify still shows old stock.
  - **Severity:** P1.
  - **Fix:** Call `inventoryCore.adjustInventory()` to zero each level (which logs transactions and fires `notifyChange`), then delete the empty rows. The current code logs manual `inventory_transactions` inserts (line ~302) but they don't go through `inventoryCore`, so `notifyChange` never fires.

- **catalog.storage.ts:deactivateChannelFeedsByVariantId (~line 239)** — Direct `UPDATE channel_feeds SET is_active = 0`. This modifies a Channel Sync-owned table.
  - **Severity:** P2. The intent is correct (deactivate feeds when archiving), but it should go through a Channel Sync interface.
  - **Fix:** Add `channelSync.deactivateVariant(variantId)` method.

- **catalog.storage.ts:reassignInventoryLevelsToVariant (~line 462)** — Direct `UPDATE inventory_levels SET product_variant_id = targetVariantId`. Bypasses `inventoryCore`. Used by variant merge.
  - **Severity:** P1. Reassigns inventory rows without logging transactions or firing sync. After merge, channel quantities for both source and target variants are stale.
  - **Fix:** Call `inventoryCore.skuCorrectionTransfer()` for each level (which the archive flow already does correctly), then delete empty source rows.

### 13D. SKU Rename Cascade

```
PUT /api/products/:id (with sku change)
PUT /api/product-variants/:id (with sku change)
  → catalog/catalog.routes.ts + catalog.storage.ts:cascadeSkuRename

Cascades SKU text changes to:
  - purchase_order_lines, inbound_shipment_lines, receiving_lines
  - product_locations, vendor_invoice_lines
  - order_items, picking_logs, order_item_financials
```

**⚠️ Boundary Violations:**
- **catalog.storage.ts:cascadeSkuRename (~line 440)** — Updates `order_items.sku` (OMS/WMS table), `picking_logs.sku` (WMS table), `order_item_financials.sku` (WMS table), `product_locations.sku` (WMS table). These are all cross-system writes.
  - **Severity:** P2. This is a data integrity cascade — if the SKU changes in Catalog, cached SKU columns elsewhere must match. The writes are text-only (no quantity changes), and SKU renames are rare admin operations.
  - **Mitigation:** Acceptable as-is given the rarity and text-only nature. Ideal fix: emit a `sku_renamed` event and let each system update its own tables.

---

## 14. Notifications

### 14A. Notification Dispatch

```
notificationService.notify(typeKey, payload)
  → notifications/notifications.service.ts:notify (~line 18)

1. Look up notification_types by key
2. Get all active users + their role assignments
3. Get all notification_preferences for this type
4. Determine recipients (user override > role default)
5. Batch INSERT into notifications
6. Push real-time via WebSocket (broadcastToUser)
```

**System Ownership:** Notifications owns: `notifications`, `notification_types`, `notification_preferences`.

**⚠️ Boundary Violations:** None.
- Reads `users` and `auth_user_roles` — these are Auth-owned but read-only access is standard.
- Does NOT reach into inventory, orders, or any other system's tables to build notification content. The content is passed in via the `payload` parameter by the calling service.
- **Clean design:** Notifications is a pure push service. Callers construct the payload, notifications just delivers it.

### 14B. Notification Preferences

```
getUserNotifications() — reads from notifications + notification_types
getPreferencesForUser() — merges user + role preferences
setUserPreference() — upserts notification_preferences
```

**⚠️ Boundary Violations:** None. All Notifications-owned tables.

---

## 15. Bin Assignment Service

### 15A. Assignment View

```
binAssignment.getAssignmentsView(filters)
  → warehouse/bin-assignment.service.ts:getAssignmentsView (~line 55)

Raw SQL:
  SELECT pv.*, p.*, pl.*, wl.*, il.variant_qty
  FROM product_variants pv
  JOIN products p ON pv.product_id = p.id
  LEFT JOIN product_locations pl ON pl.product_variant_id = pv.id
  LEFT JOIN warehouse_locations wl ON pl.warehouse_location_id = wl.id
  LEFT JOIN inventory_levels il ON il.product_variant_id = pv.id AND il.warehouse_location_id = wl.id
```

**⚠️ Boundary Violations:**
- **bin-assignment.service.ts:~line 55** — Reads `inventory_levels.variant_qty` directly (WMS table) for the `current_qty` display column. This is a **read-only** cross-system access from the Bin Assignment service (WMS) into the inventory subsystem (also WMS).
  - **Verdict:** Both are WMS-internal. No violation. The read is for display enrichment only.

### 15B. Assign Variant to Location

```
binAssignment.assignVariantToLocation(params)
  → warehouse/bin-assignment.service.ts:assignVariantToLocation (~line 105)

1. Validate variant exists
2. Validate location exists and is_pickable = 1
3. Check for existing assignment
4. Upsert product_locations row
```

**System Ownership:** WMS owns `product_locations`.

**⚠️ Boundary Violations:** None.
- Does NOT touch `inventory_levels` — ✅
- Does NOT create/modify inventory — ✅
- Only manages `product_locations` (bin assignments) — ✅

---

## 16. Warehouse Settings / Zones / Locations

### 16A. Settings CRUD

```
GET/PUT /api/settings → settings.storage.ts
  → echelon_settings table CRUD
```

**System Ownership:** Settings is its own domain. No cross-system concerns.

### 16B. Warehouse CRUD

```
GET/POST/PATCH/DELETE /api/warehouses → warehouse.storage.ts
  → warehouses table CRUD
```

**System Ownership:** WMS owns `warehouses`.

### 16C. Zone CRUD

```
GET/POST/PATCH/DELETE /api/warehouse/zones → warehouse.storage.ts
  → warehouse_zones table CRUD
```

**System Ownership:** WMS owns `warehouse_zones`.

### 16D. Location CRUD

```
GET/POST/PATCH/DELETE /api/warehouse/locations → warehouse.routes.ts
  → warehouse_locations table CRUD
```

**System Ownership:** WMS owns `warehouse_locations`.

### 16E. Location Inventory View

```
GET /api/warehouse/locations/:id/inventory
  → warehouse.storage.ts:getLocationInventoryDetail

Raw SQL: SELECT from inventory_levels JOIN product_variants
  WHERE warehouse_location_id = ?
```

**⚠️ Boundary Violations:** None. Both `inventory_levels` and `warehouse_locations` are WMS-owned. Read-only.

### 16F. Bulk Location Reassignment

```
POST /api/warehouse/locations/bulk-reassign
  → warehouse.routes.ts + storage.bulkReassignProducts()

Updates product_locations to point to new warehouse_location_id.
```

**⚠️ Boundary Violations:** None. `product_locations` is WMS-owned.

**Note:** This does NOT move inventory (no `inventory_levels` changes). It only moves the bin assignment. Inventory would need a separate transfer.

### 16G. Location Move (Product Location)

```
POST /api/locations/:id/move
  → warehouse/locations.routes.ts (~line 195)

1. Update product_locations.warehouseLocationId
2. Log an inventory_transaction (transfer type, variantQtyDelta: 0)
```

**⚠️ Boundary Violations:**
- **locations.routes.ts:~line 220** — Direct `storage.createInventoryTransaction()` for audit logging. This writes to `inventory_transactions` (WMS-owned) from the locations route. Since locations routes ARE part of WMS, this is acceptable.
- **Note:** The transaction has `variantQtyDelta: 0` — it's purely an audit note that the bin assignment moved, not an inventory mutation. No `notifyChange` needed.

---

## 17. Fulfillment Routing

### 17A. Route Order to Warehouse

```
fulfillmentRouter.routeOrder(ctx)
  → orders/fulfillment-router.service.ts:routeOrder (~line 55)

1. Fetch active fulfillment_routing_rules (ordered by priority DESC)
2. For each rule, check matchesRule():
   - location_id: match Shopify fulfillment location
   - sku_prefix: match any SKU prefix
   - country: match shipping country
   - tag: match order tag
   - default: always matches
3. First match wins → return warehouse info
4. Fallback: default warehouse (warehouses.is_default = 1)
```

**System Ownership:**
| Step | Owner | Notes |
|------|-------|-------|
| 1-3 | WMS (Fulfillment Router) | Reads `fulfillment_routing_rules`, `warehouses` |
| 4 | WMS | Default warehouse lookup |

**⚠️ Boundary Violations:** None.
- Does NOT query `inventory_levels` for routing decisions — ✅
- Does NOT use ATP for routing — routing is purely rule-based
- Only reads `fulfillment_routing_rules` and `warehouses` — both WMS-owned

### 17B. Assign Warehouse to Order

```
fulfillmentRouter.assignWarehouseToOrder(orderId, routing)
  → orders/fulfillment-router.service.ts:assignWarehouseToOrder (~line 120)

1. UPDATE orders SET warehouse_id = routing.warehouseId
2. If 3PL warehouse: SET warehouse_status = 'awaiting_3pl'
```

**⚠️ Boundary Violations:** None. `orders` table is WMS-owned. The fulfillment router writes to it as part of order processing.

---

## 18. Order Combining

### 18A. Get Combinable Groups

```
combining.getCombinableGroups()
  → orders/combining.service.ts:getCombinableGroups (~line 120)

Raw SQL:
  SELECT o.*, count(order_items), sum(quantity)
  FROM orders o
  LEFT JOIN combined_order_groups cog ON cog.id = o.combined_group_id
  LEFT JOIN shopify_orders s ON o.source_table_id = s.id
  WHERE o.warehouse_status = 'ready' AND o.on_hold = 0
```

**System Ownership:** WMS reads from `orders`, `order_items`, `combined_order_groups`, `shopify_orders`. All are WMS/OMS-owned.

**⚠️ Boundary Violations:** None. Read-only query of WMS + OMS tables.

### 18B. Combine Orders

```
combining.combineOrders(orderIds, createdBy)
  → orders/combining.service.ts:combineOrders (~line 175)

1. Validate: all orders in 'ready' status, not on hold
2. Handle add-to-group / merge existing groups / create new
3. INSERT combined_order_groups
4. UPDATE orders SET combined_group_id, combined_role
```

**System Ownership:** WMS owns `combined_order_groups` and `orders`.

**⚠️ Boundary Violations:** None.
- Does NOT touch `inventory_levels` — ✅
- Does NOT touch reservations — ✅
- Pure order grouping for shipping efficiency

### 18C. Mark Group Packed/Shipped

```
combining.markGroupPacked(groupId, packedBy)
combining.markGroupShipped(groupId, trackingNumber, carrier)
  → orders/combining.service.ts:~line 380-410

1. UPDATE combined_order_groups status
2. UPDATE orders warehouse_status for all group members
```

**⚠️ Boundary Violations:** None. WMS-owned tables.

**⚠️ Note:** `markGroupShipped()` updates `orders.warehouse_status` to 'shipped' but does NOT:
- Call `inventoryCore.recordShipment()` to deduct inventory
- Push tracking to channels
- This is likely intentional — the actual shipment deduction happens when ShipStation fires the Shopify fulfillment webhook (Process 6A). The combining service just groups orders for physical packing; it doesn't own the shipment confirmation flow.

---

## Additional Boundary Violations Summary

### 🔴 P0 — No new P0 findings in these systems

All P0 violations were in the core WMS processes (already documented in the first audit).

### 🟡 P1 — Fix Before Scale

| # | Finding | File | Impact | Fix |
|---|---------|------|--------|-----|
| 16 | Product archive deletes `inventory_levels` directly, bypassing `inventoryCore` | `catalog.storage.ts:229` via `catalog.routes.ts:305` | Archived product inventory disappears with no sync push; Shopify shows stale stock | Use `inventoryCore.adjustInventory()` to zero, then delete empty rows |
| 17 | Variant merge reassigns `inventory_levels` directly, bypassing `inventoryCore` | `catalog.storage.ts:462` via `catalog.routes.ts:592` | Merged inventory doesn't fire `notifyChange`; channel quantities go stale | Use `inventoryCore.skuCorrectionTransfer()` per level (like archive already does) |

### 🟢 P2 — Tech Debt

| # | Finding | File | Impact | Fix |
|---|---------|------|--------|-----|
| 18 | Catalog product import writes `product_locations` (WMS table) directly | `product-import.service.ts:118` | Cross-system write during Shopify sync | Move to `binAssignment.ensureAssignment()` |
| 19 | Catalog archive deactivates `channel_feeds` directly | `catalog.storage.ts:239` | Cross-system write to Channel Sync table | Add `channelSync.deactivateVariant()` method |
| 20 | SKU rename cascade writes to `order_items`, `picking_logs`, `order_item_financials` | `catalog.storage.ts:440-458` | Cross-system writes (text-only, rare operation) | Emit `sku_renamed` event; let each system handle |
| 21 | Reorder analysis reads `inventory_levels` directly instead of through `atpService` | `procurement.storage.ts:getReorderAnalysisData` | Read-only, but inconsistent with ATP model | Replace with `atpService` calls |
| 22 | Financial reports read across OMS/WMS tables | `procurement.storage.ts` (multiple report queries) | Read-only reporting, acceptable | No change needed |

### ✅ Clean Systems (No Violations)

| System | Status | Notes |
|--------|--------|-------|
| **AP/Invoicing** | ✅ Clean | Only touches Procurement-owned tables |
| **Notifications** | ✅ Clean | Pure push service, no cross-system reads for content |
| **Bin Assignment** | ✅ Clean | WMS-internal, proper table ownership |
| **Warehouse Settings/Zones** | ✅ Clean | WMS config tables only |
| **Fulfillment Routing** | ✅ Clean | Rule-based, no inventory queries |
| **Order Combining** | ✅ Clean | WMS order grouping, no inventory mutations |

---

## Recommended Fix Order (Additional Findings)

1. **Archive: replace direct inventory_levels DELETE with inventoryCore.adjustInventory()** — 30 min, fixes P1 #16
2. **Merge: replace direct inventory_levels UPDATE with skuCorrectionTransfer()** — 30 min, fixes P1 #17
3. **Product import: route product_locations write through binAssignment** — 15 min, fixes P2 #18
4. **Archive: route channel_feeds deactivation through channelSync** — 15 min, fixes P2 #19
5. **SKU rename: consider event-based cascade** — 1 hour, fixes P2 #20 (lower priority)

**Total: ~2.5 hours for P1+P2 fixes.**

---

*Last updated: 2026-03-21*
