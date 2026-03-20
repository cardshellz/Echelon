# Echelon WMS — Full QA Audit Report

**Auditor:** Archon (QA Subagent)  
**Date:** 2026-03-20  
**Scope:** All modules — PO through shipping  
**Method:** Code review + live database queries (READ-ONLY)

---

## 🔥 Tomorrow's Fix List (Priority Order)

| # | Severity | Module | Issue | Est. Effort |
|---|----------|--------|-------|-------------|
| 1 | **P0** | Inventory | 3 inventory_levels rows with negative variant_qty (ARM-ENV-DBL-C300: -2, ARM-ENV-SGL-NM-C500: -9, ARM-ENV-SGL-C700: -2). Fix the data + add guard to `recordShipment()`. | 30 min |
| 2 | **P0** | PO State Machine | DB has status `"partial"` but code expects `"partially_received"`. PO-68 is stuck in a status the state machine doesn't recognize. | 15 min |
| 3 | **P1** | Channel Sync | 60,357 Shopify 404 errors in last 7 days (~51% error rate). Stale `channel_feeds` inventory item IDs pointing to deleted Shopify inventory items. | 1-2 hrs |
| 4 | **P1** | OMS | 269 Shopify orders stuck in `"confirmed"` since Jan 17. OMS bridge ingests them but nothing pushes them to shipped when Shopify fulfills them. | 1 hr |
| 5 | **P1** | OMS | `reserveInventory()` reserves on ANY matching inventory_levels row — ignores warehouse location context. Could reserve at a reserve bin instead of a pick bin. | 30 min |
| 6 | **P2** | Receiving | 3 abandoned draft receiving orders (RCV-20260304, RCV-20260316, RCV-20260317). Clean up or provide "delete draft" in UI. | 15 min |
| 7 | **P2** | Receiving | 26 pending receiving lines on RCV-20260317 have no putaway location assigned. Must be resolved before close. | Manual |
| 8 | **P2** | Channel Sync | 1,878 Shopify 422 errors ("Inventory item does not have inventory tracking"). Variants not set up for tracking in Shopify. | 1 hr |
| 9 | **P3** | Warehouse | `warehouse_zones` table is empty. Zones are referenced in UI but not populated. | 15 min |

---

## 1. Purchase Orders (Full Lifecycle)

### Current State: ✅ Mostly Working

**Status:** The PO module is well-architected with a clean state machine, multi-level approval tiers, and comprehensive audit trail.

#### UI Flow
1. Navigate to Purchase Orders → Click "New PO"
2. Select vendor, set expected delivery date, shipping method, notes
3. Auto-generates PO number (format: `PO-YYYYMMDD-NNN`)
4. Add line items: select product/variant, set qty, unit cost
5. Submit → auto-checks approval tiers → approved or pending_approval
6. Send to vendor → acknowledged → receive

#### State Machine
```
draft → pending_approval → approved → sent → acknowledged → partially_received → received → closed
                                                          ↘ cancelled/void
```

#### Findings

**🔴 P0 — Status Mismatch: `"partial"` vs `"partially_received"`**
- PO-68 (PO-20260319-001) has status `"partial"` in the database
- The code's `VALID_TRANSITIONS` map uses `"partially_received"` as the key
- This means PO-68 is in a dead-end state — no transition function will match `"partial"`
- **Root cause:** The `onReceivingOrderClosed()` method or the DB migration uses a different status string than the state machine expects
- **Fix:** Either rename the DB value to `"partially_received"` or add `"partial"` to the state machine. Check if the column has an enum constraint.

**🟡 P2 — Line Amendment Breadth**
- `LINE_AMENDABLE_STATUSES` allows editing lines in `partially_received` status, which is good
- But `EDITABLE_STATUSES` only allows `draft` — can't add NEW lines once submitted
- This is arguably correct but could frustrate users who need to add a forgotten line to an already-sent PO

**🟡 P2 — Approval Tiers**
- The system supports approval tiers, but with only 11 POs created over ~3 weeks, the overhead may not be justified
- If the only user is Overlord (the owner), approval workflows are bureaucratic self-approval
- **Recommendation:** Consider auto-approving everything below a high threshold, or disabling tiers entirely until there's a team

**✅ Good Design**
- PO number auto-generation works cleanly
- Total recalculation is thorough (includes line-level discount/tax)
- Status history creates a complete audit trail
- `createReceiptFromPO()` bridges PO → receiving cleanly
- Cascade variant changes to shipment lines, landed costs, and invoice lines — very thorough

#### Data Snapshot
- 11 POs total: 4 cancelled, 3 acknowledged, 2 received, 1 sent, 1 partial (stuck)
- 50 PO lines: 33 open, 8 received, 8 cancelled, 1 partial
- 10 vendors configured

---

## 2. Receiving (PO → Inventory)

### Current State: ✅ Working

**Status:** The receiving module handles PO-linked and standalone receipts, CSV bulk import with fuzzy location matching, and inventory updates on close.

#### UI Flow
1. Create receipt from PO (auto-generates receiving lines from open PO lines)
2. OR create standalone receipt → upload CSV or add lines manually
3. For each line: enter received qty, assign putaway location
4. "Complete All Lines" sets qty to expected (or user-entered if already filled)
5. Close receipt → inventory updated atomically → channel sync triggered → PO status updated

#### Findings

**✅ `completeAllLines()` Fix Verified**
```typescript
const effectiveQty = (line.receivedQty != null && line.receivedQty > 0)
  ? line.receivedQty
  : (line.expectedQty || 0);
```
This is sound. If the user has already entered a qty, it's preserved. Only defaults to expected qty for untouched lines (0 or null).

**🟡 P2 — Draft Receiving Orders Never Cleaned Up**
- 3 draft receiving orders exist:
  - RCV-20260304-001 (linked to PO-20260303-001, created Mar 4 — 16 days old)
  - RCV-20260316-001 (standalone, 4 days old)
  - RCV-20260317-001 (linked to PO-20260317-001, 3 days old)
- There's no automatic cleanup or "stale draft" warning
- **Recommendation:** Add a visual indicator for stale drafts (>7 days) and a bulk cleanup option

**🟡 P2 — 26 Pending Lines Without Putaway Location**
- All 26 are on RCV-20260317-001 (linked to PO-20260317-001)
- The close function correctly blocks if any received lines lack putaway location
- These lines have `received_qty = 0` so they'd be skipped — but they clutter the UI

**✅ Good Design**
- CSV import with fuzzy location matching (handles variations like "H6" → "H-06") is excellent
- Idempotent imports (update existing lines by SKU+location key)
- SKU auto-resolution from `product_variants` table
- Variant creation from SKU patterns (P=Pack, B=Box, C=Case)
- Landed cost integration: checks `shipmentTracking.getLandedCostForPoLine()` before falling back to PO cost
- Channel sync fires for each received variant (fire-and-forget)

#### Data Snapshot
- 11 receiving orders: 8 closed, 3 draft
- 263 receiving lines: 237 complete, 26 pending

---

## 3. Inventory Management

### Current State: ⚠️ Partially Working (Negative Inventory Bug)

**Status:** Core inventory operations are well-designed with atomic transactions, optimistic locking, and full audit trails. However, there are negative inventory records in production.

#### Architecture
- Inventory tracked per variant + warehouse location in `inventory_levels`
- State buckets: `variantQty`, `reservedQty`, `pickedQty`, `packedQty`, `backorderQty`
- All writes use `db.transaction()` with atomic `SET col = col + delta`
- Optimistic locking via `WHERE variant_qty >= qty` on picks/transfers

#### ATP Calculation
- ATP = onHand - reserved - picked - packed (in base units)
- Fungible model: all variants of a product share a single ATP pool
- Conversion: ATP base units ÷ variant's `unitsPerVariant` = sellable units
- Warehouse-scoped ATP available for channel sync
- **Design is excellent** — handles multi-UOM (case/box/pack) elegantly

#### Findings

**🔴 P0 — 3 Negative Inventory Records**

| SKU | variant_qty | Location |
|-----|------------|----------|
| ARM-ENV-DBL-C300 | -2 | 1264 |
| ARM-ENV-SGL-NM-C500 | -9 | 1262 |
| ARM-ENV-SGL-C700 | -2 | 1272 |

**Root cause analysis:** The `recordShipment()` method in `core.service.ts` has a "shipped without picking" path:
```typescript
if (fromOnHand > 0) {
  await svc.adjustLevel(level.id, {
    variantQty: -fromOnHand,
    ...(reservedToRelease > 0 ? { reservedQty: -reservedToRelease } : {}),
  });
}
```
This `adjustLevel()` call does NOT have a `WHERE variant_qty >= qty` guard like `pickItem()` does. When ShipStation sends a ship_notify for an order that was never picked through Echelon, the shipment path can drive inventory negative.

**Fix:**
1. Add a guard to the `fromOnHand` path in `recordShipment()` or handle insufficient stock gracefully
2. Run a one-time fix to zero out the 3 negative records (with adjustment transactions for audit trail)

**✅ Break/Assembly Service**
- Case → eaches conversion works cleanly
- Enforces direct parent-child relationship (no skip-level breaks)
- Validates fractional conversion prevention
- Auto-resolves target location from bin assignment
- Audit trail with shared batchId links both sides

**✅ Cycle Count Service**
- Full workflow: draft → initialize (snapshot bins) → count → approve → complete
- SKU mismatch detection with paired items (expected_missing + unexpected_found)
- Configurable auto-approve tolerance
- Bin reconciliation after approval
- Location freeze during active counts
- Transfer resolution for misplaced inventory
- Table exists: `cycle_counts`, `cycle_count_items`

**✅ Manual Adjustments**
- Guards against negative inventory (unless `allowNegative` flag is set)
- Zombie cleanup: removes zero-qty records when variant isn't assigned to bin
- Full audit trail with reason codes

**✅ Transfers**
- Atomic guarded decrement (same optimistic lock pattern as picks)
- Cross-variant SKU correction transfers with shared batchId
- Zombie cleanup on empty source levels

#### Data Snapshot
- 319 inventory_levels, 11,108 total variant_qty, 467 reserved, 13 picked
- 11,000+ inventory_transactions (full audit trail)
- 54 inventory_lots (FIFO cost tracking)

---

## 4. Order Management

### Current State: ⚠️ Partially Working

**Status:** OMS ingestion works for both Shopify and eBay. The core issue is that 269 Shopify orders are stuck in "confirmed" — they were shipped through Shopify's native fulfillment but OMS was never updated.

#### Shopify Bridge
- Uses pg LISTEN/NOTIFY to bridge Shopify orders into OMS
- Backfill function available for historical orders
- Determines channel (US vs CA) from shop_domain
- Maps financial/fulfillment status correctly
- **Idempotent** via (channel_id, external_order_id) dedup

#### eBay Ingestion
- Polls every 5 minutes with 30-minute lookback window
- Webhook handler for real-time ORDER_CONFIRMATION
- Auto-reserves inventory + assigns warehouse + pushes to ShipStation on new order
- Dollar → cents conversion handled correctly
- Tax excluded from totals (eBay collects/remits)

#### Findings

**🟡 P1 — 269 Shopify Orders Stuck in "confirmed"**
- Oldest: Jan 17, 2026 (over 2 months old)
- All are channel_id=36 (Shopify US)
- These orders were fulfilled through Shopify's native flow (ShipStation → Shopify fulfillment)
- The OMS never received a status update when they shipped
- **Root cause:** The Shopify bridge creates OMS orders when they come in, but there's no mechanism to update OMS status when Shopify orders get fulfilled outside of Echelon
- **Fix options:**
  1. Add a periodic reconciliation job that checks Shopify order fulfillment status and updates OMS
  2. Listen for Shopify fulfillment webhooks and update OMS accordingly
  3. Accept that OMS is additive-only for Shopify and filter the confirmed orders in the UI

**🟡 P1 — `reserveInventory()` Location Agnostic**
```sql
UPDATE inventory_levels
SET reserved_qty = reserved_qty + $qty
WHERE product_variant_id = $variantId
  AND variant_qty >= $qty
RETURNING id
```
This hits the FIRST matching row regardless of warehouse/location. It could:
- Reserve at a reserve bin instead of a pick bin
- Reserve at a different warehouse entirely
- **Fix:** Add `warehouseId` filter or pick-location preference

**🟢 P3 — eBay Order Count Low**
- Only 5 eBay orders in OMS (all "confirmed")
- eBay channel was recently launched — this is expected
- ShipStation push is functional

#### Data Snapshot
- 2,838 OMS orders: 2,538 shipped, 269 confirmed, 31 cancelled
- 7,035 OMS order lines
- 2,786 order events
- Channel split: 2,833 Shopify US, 5 eBay

---

## 5. Picking Flow

### Current State: ✅ Working

**Status:** The picking module is the most mature part of the system. Sophisticated inventory deduction with optimistic locking, replenishment guidance, bin count integration, and comprehensive audit logging.

#### Pick Flow
1. Orders appear in pick queue (filtered to shippable items)
2. Picker claims an order (locks it)
3. For each item: scan/confirm pick → inventory deducted → replen check
4. If bin low: replen guidance shown (source location, SKU, qty)
5. Bin count after replen to reconcile
6. Order completed → marked ready_to_ship

#### Findings

**✅ Pick-Queue-Sync is Lightweight**
- The `syncPickQueueForSku()` function only updates pending order items when their location has actually changed
- Only logs when changes occur — not flooding logs every 15s as SYSTEM.md warns
- The original concern may have been addressed already or referred to a different component

**✅ Sophisticated Inventory Deduction**
- Tries assigned bin first, then any pickable bin with full qty, then partial pick
- Optimistic lock prevents concurrent picks from driving negative
- When deduction fails: item stays completed, but inventory discrepancy logged + bin count triggered
- Inferred replen: if picker's bin count shows surplus, system infers an unrecorded case break

**✅ Replen Integration**
- Guidance-only approach: no task auto-created during pick, just display info
- Picker can confirm or skip replen via `handleBinCount()`
- `initiateCaseBreak()` for picker-initiated replen
- Max bin count guard (0–10,000) prevents barcode-in-number-field errors

**🟡 P2 — Single Order Pick Mode Only**
- `pick_mode: "single_order"` in warehouse settings
- No batch picking implementation visible
- For higher volume, batch picking would significantly improve efficiency
- **This is a future feature, not a bug**

#### Data Snapshot
- 11,000+ picking_logs (comprehensive audit trail)
- WMS orders: 53,295 shipped, 612 cancelled, 145 ready, 39 completed, 2 ready_to_ship

---

## 6. Fulfillment & Shipping

### Current State: ✅ Working

**Status:** ShipStation integration is fully functional. Ship notify webhook → OMS update → fulfillment push to eBay.

#### Flow
1. eBay order ingested → auto-pushed to ShipStation
2. ShipStation SHIP_NOTIFY webhook → `processShipNotify()`
3. OMS order marked shipped → line items fulfilled
4. `pushTracking()` sends tracking to originating channel
5. For eBay: creates shipping fulfillment via Fulfillment API
6. For Shopify: skipped (handled natively)

#### Findings

**✅ Carrier Mapping**
- ShipStation carrier codes → eBay-compatible codes (USPS, FedEx, UPS, DHL)
- Dual mapping: `shipstation.service.ts` for inbound, `fulfillment-push.service.ts` for outbound

**✅ Idempotent**
- Checks existing tracking before updating
- Skips voided shipments
- Records events for success and failure

**🟡 P2 — No Retry on Push Failure**
- If `pushTracking()` fails for eBay, it logs an error event but doesn't retry
- Consider adding a retry queue for failed fulfillment pushes

---

## 7. Accounts Payable

### Current State: ✅ Working

**Status:** Full AP lifecycle is implemented: invoice creation, PO linking, 3-way matching, payments with allocations, and aging reports.

#### Flow
1. Create invoice → link to PO(s) → auto-import lines from PO
2. Run 3-way match (invoice vs PO vs received qty)
3. Approve invoice → record payment with allocation
4. Balance auto-recalculates after payments

#### Findings

**✅ 3-Way Matching**
- Checks price discrepancy, over-billing, qty discrepancy
- Match status per line: pending → matched/price_discrepancy/over_billed/qty_discrepancy

**✅ Payment Lifecycle**
- Payment number auto-generation (PAY-YYYYMMDD-NNN)
- Multi-invoice allocation supported
- Void payment → balances recalculate on affected invoices
- Invoice status auto-transitions: received → approved → partially_paid → paid

**✅ Shipment Cost Bridge**
- Create invoices from shipment costs
- Link individual costs to existing invoices
- Payment status tracking per shipment cost

**✅ AP Summary/Aging**
- Aging buckets: current, 1-30, 31-60, 61-90, 90+
- Per-vendor aging breakdown
- Overdue detection

#### Data Snapshot
- 15 vendor invoices: 4 paid, 3 approved, 3 partially_paid, 1 received, 4 voided
- 8 AP payments (all completed)
- 13 invoice lines

---

## 8. Warehouse Management

### Current State: ⚠️ Partially Configured

**Status:** Location management is functional. Zones and replenishment rules exist but need more configuration.

#### Findings

**✅ Locations Well-Organized**
- 235 warehouse locations: 192 pick, 39 reserve, 3 storage, 1 receiving
- Two warehouse settings configs: LEON (primary) and DEFAULT (fallback)

**🟡 P3 — Warehouse Zones Empty**
- `warehouse_zones` table has 0 rows
- Zones are referenced in location data (zone column exists on locations)
- No formal zone definitions means no zone-based filtering in cycle counts or pick paths

**🟡 P3 — Warehouse Settings Dual Config**
- Two warehouse_settings rows: LEON (warehouse_id=1) and DEFAULT (warehouse_id=NULL)
- Settings include replen mode, pick mode, channel sync interval
- Both set to `inline` replen, `single_order` pick mode, channel sync enabled at 15-min intervals
- Scheduled replen is disabled on both

**✅ Replenishment Infrastructure**
- Tables exist: `replen_rules`, `replen_tasks`, `replen_tier_defaults`
- Inline replen from picking flow is functional
- Max 2 cases per inline replen
- Stockout priority: 1 (highest)

---

## 9. Channel Sync

### Current State: ⚠️ Major Error Rate

**Status:** The sync orchestrator pushes inventory to Shopify, but over half the syncs are failing.

#### Findings

**🟡 P1 — 60,357 Shopify 404 Errors in 7 Days**
```
Shopify API POST /inventory_levels/set.json failed (404): {"errors":"Not Found"}
```
- This is the #1 error by far
- Likely cause: `channel_feeds` table contains stale `channel_inventory_item_id` values pointing to Shopify inventory items that have been deleted or recreated
- **Fix:** Run a reconciliation to validate all channel_feed inventory item IDs against Shopify's actual inventory items. Invalidate stale feeds.

**🟡 P1 — 1,878 Shopify 422 Errors**
```
Shopify API POST /inventory_levels/set.json failed (422): {"errors":["Inventory item does not have inventory tracking"]}
```
- Some Shopify variants don't have inventory tracking enabled
- **Fix:** Either enable tracking in Shopify or exclude these variants from sync

**Other Errors (Lower Priority)**
- 762 location 404s (stale Shopify location ID)
- 289 "No SHOPIFY_LOCATION_ID configured" errors
- 14 network failures
- 6 rate limit (429) hits — acceptable

**Volume:** ~46,000 sync operations per 24 hours. At 50% success rate, that's a LOT of wasted API calls.

#### Data Snapshot
- 304k channel_sync_log rows
- 106k allocation_audit_log rows
- 589 channel_feeds, 294 channel_listings
- Last 7 days: 63,316 errors vs 60,379 successes

---

## 10. Data Integrity Summary

### Negative Inventory (P0)
| SKU | Variant ID | Location | Qty |
|-----|-----------|----------|-----|
| ARM-ENV-DBL-C300 | 63 | 1264 | -2 |
| ARM-ENV-SGL-NM-C500 | 69 | 1262 | -9 |
| ARM-ENV-SGL-C700 | 67 | 1272 | -2 |

**Root cause:** `recordShipment()` lacks a guard on the `fromOnHand` path. When ShipStation ships an order that was never picked through Echelon, the direct variantQty decrement can go negative.

### Orphaned Records
- ✅ No orphaned OMS order lines (all have parent orders)
- ✅ No orders stuck in "processing" state
- ⚠️ 269 orders stuck in "confirmed" (see §4)
- ⚠️ 3 draft receiving orders potentially abandoned (see §2)

### PO Status Inconsistency (P0)
- PO-68 has DB status `"partial"` which doesn't match the code's state machine (`"partially_received"`)
- The `onReceivingOrderClosed()` writes `"partially_received"` but something else wrote `"partial"`

### WMS Legacy Orders
- 54k WMS `orders` rows (legacy system)
- 1,439 `order_items` — this is the current active flow
- Migration to OMS is ongoing but legacy system is still primary for Shopify

---

## 11. Architecture Assessment

### Strengths
1. **Atomic operations** — All inventory writes use transactions with optimistic locking
2. **Full audit trail** — 11k+ inventory transactions, status history on POs, OMS events
3. **Fungible ATP** — Multi-UOM inventory model is elegant and correct
4. **Idempotent ingestion** — OMS dedup by (channel_id, external_order_id) prevents duplicates
5. **FIFO lot tracking** — Cost tracking through picks and shipments
6. **Comprehensive picking** — Replen guidance, bin counts, case break integration

### Weaknesses
1. **Channel sync reliability** — 50% error rate is unacceptable for a production system
2. **OMS ↔ Shopify gap** — No mechanism to update OMS when Shopify orders are fulfilled externally
3. **Ship-without-pick guard** — `recordShipment()` can drive negative inventory
4. **State machine string inconsistency** — `"partial"` vs `"partially_received"` in POs
5. **No batch picking** — Single-order only limits throughput

### Missing Features (Not Bugs)
- Batch/wave picking
- Automatic replenishment scheduling (infrastructure exists, disabled)
- eBay listing push (marked as "building" in SYSTEM.md)
- Returns processing (page exists but unclear if fully functional)
- Notification system (tables exist with 0 rows)

---

## Appendix: Database Table Counts

| Table | Rows | Notes |
|-------|------|-------|
| products | 188 | |
| product_variants | 313 | |
| inventory_levels | 319 | 3 negative |
| inventory_transactions | 11k+ | Full audit |
| purchase_orders | 11 | |
| purchase_order_lines | 50 | |
| receiving_orders | 11 | |
| receiving_lines | 263 | |
| oms_orders | 2,838 | |
| oms_order_lines | 7,035 | |
| orders (WMS) | 54k | Legacy |
| channel_sync_log | 304k | High error rate |
| warehouse_locations | 235 | |
| vendors | 10 | |
| vendor_invoices | 15 | |
| ap_payments | 8 | |
| picking_logs | 11k+ | |
| channel_feeds | 589 | |

---

*End of audit. All findings are observation-only — no code was modified, no data was changed.*
