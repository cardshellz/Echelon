# Dependency Entanglement Audit — Echelon WMS

> **Audited:** 2026-03-20 | **Auditor:** Systems Architect (read-only)
> **Scope:** All service files in `server/modules/`

---

## Executive Summary

The codebase has **8 P0 findings**, **7 P1 findings**, and **6 P2 findings**. The most critical pattern is the OMS `reserveInventory()` function, which bypasses both ATP and the reservation service entirely, doing raw SQL `UPDATE` on `inventory_levels`. Several inventory mutation paths also lack downstream sync triggers, meaning channel quantities can drift silently.

---

## Prioritized Fix List

### 🔴 P0 — Causing data issues NOW

| # | Finding | File | Fix |
|---|---------|------|-----|
| 1 | OMS `reserveInventory()` bypasses ATP + reservation service | `oms/oms.service.ts:173` | Delegate to `ReservationService.reserveForOrder()` |
| 2 | `reserveForOrder()` in core doesn't trigger `notifyChange` | `inventory/core.service.ts:609` | Add `this.notifyChange()` after reserve |
| 3 | `releaseReservation()` in core doesn't trigger `notifyChange` | `inventory/core.service.ts:657` | Add `this.notifyChange()` after release |
| 4 | `transfer()` in core doesn't trigger `notifyChange` | `inventory/core.service.ts:703` | Add `this.notifyChange()` for both variants |
| 5 | `skuCorrectionTransfer()` doesn't trigger `notifyChange` | `inventory/core.service.ts:803` | Add `this.notifyChange()` for both variants |
| 6 | `BreakAssemblyService` bypasses `notifyChange` entirely | `inventory/break-assembly.service.ts` | Call `inventoryCore.notifyChange()` or fire channelSync |
| 7 | `InventorySourceService.setInventoryLevel()` bypasses core and sync | `inventory/source.service.ts:206` | Use `inventoryCore` + fire channelSync |
| 8 | OMS orders written as "confirmed" but never updated when Shopify fulfills | `oms/shopify-bridge.ts` | Add fulfillment webhook → OMS status update |

### 🟡 P1 — Will cause issues at scale

| # | Finding | File | Fix |
|---|---------|------|-----|
| 9 | Legacy `ChannelSyncService.syncProduct()` has full allocation engine reimplemented inline | `channels/sync.service.ts:142-300` | Remove legacy path, fail if orchestrator missing |
| 10 | Orchestrator fallback path re-derives ATP inline instead of using atpService | `channels/echelon-sync-orchestrator.service.ts:~330` | Remove inline SQL fallback |
| 11 | Orchestrator uses `product_locations` to gate variant existence at warehouse | `channels/echelon-sync-orchestrator.service.ts:~282` | Use `inventory_levels` instead |
| 12 | `ReservationService.reserveForOrder()` requires `product_locations` assignment | `channels/reservation.service.ts:131` | Fall back to any location with stock |
| 13 | `channel_feeds.last_synced_qty` can drift from actual Shopify inventory | Multiple files | Add periodic reconciliation job |
| 14 | Dual sync trigger paths (core `notifyChange` + explicit `channelSync.queueSync`) | Multiple files | Consolidate to single trigger path |
| 15 | Picking service inline `adjustLevel` for bin counts bypasses core service | `orders/picking.service.ts:~confirmCaseBreak` | Use `inventoryCore.adjustInventory()` |

### 🟢 P2 — Tech debt

| # | Finding | File | Fix |
|---|---------|------|-----|
| 16 | `inventory.routes.ts` computes `available = variantQty - reservedQty` inline | `inventory/inventory.routes.ts:2189,2268,2311` | Use ATP service for availability |
| 17 | Operations dashboard queries `inventory_levels` directly for reserved totals | `orders/operations-dashboard.service.ts:163` | Use ATP service |
| 18 | Alerts service queries `inventory_levels` directly | `inventory/alerts.service.ts` | Acceptable for anomaly detection |
| 19 | `break-assembly.service.ts` uses `productLocations` join for target location | `inventory/break-assembly.service.ts:130` | Acceptable for slotting hint |
| 20 | Order status in 3 tables: WMS `orders`, OMS `oms_orders`, Shopify | All order modules | Add reconciliation cron |
| 21 | `product_locations` bin assignments can drift from `inventory_levels` reality | warehouse module | Already mitigated by cycle count reconciliation |

---

## Detailed Findings

---

### Finding 1 — OMS `reserveInventory()` Bypasses ATP + Reservation Service (P0)

**File:** `server/modules/oms/oms.service.ts`, lines 173-211

**What it does wrong:**
```typescript
// Find inventory level with stock and increment reserved_qty
const result = await db.execute(sql`
  UPDATE inventory_levels
  SET reserved_qty = reserved_qty + ${line.quantity},
      updated_at = NOW()
  WHERE product_variant_id = ${line.productVariantId}
    AND variant_qty >= ${line.quantity}
  RETURNING id
`);
```

This is a textbook dependency entanglement violation:
1. **Bypasses ATP entirely** — checks `variant_qty >= quantity` instead of calling ATP, which means it ignores the fungible pool (cases+packs share base units).
2. **Picks a random location** — the `UPDATE` hits whichever `inventory_levels` row the DB finds first with stock. No location prioritization, no bin assignment awareness.
3. **No audit trail** — doesn't write to `inventory_transactions`.
4. **No channel sync** — doesn't fire `queueSyncAfterInventoryChange()`.
5. **No lot tracking** — doesn't call `lotService.reserveFromLots()`.

**Used by:** eBay order ingestion (`ebay-order-ingestion.ts:196,288`) calls `omsService.reserveInventory()`.

**What it should do:** Delegate to `ReservationService.reserveForOrder()` which already:
- Gates on fungible ATP
- Finds the assigned bin via `product_locations`
- Delegates to `inventoryCore.reserveForOrder()`
- Fires channel sync afterward

**Severity:** P0 — eBay orders are being reserved without ATP gating. For fungible products (cases/packs), this will reserve at the wrong granularity and won't properly account for the shared pool.

---

### Finding 2 — `reserveForOrder()` Doesn't Trigger `notifyChange` (P0)

**File:** `server/modules/inventory/core.service.ts`, line 609-670

The `InventoryCoreService` calls `this.notifyChange()` for:
- ✅ `receiveInventory()` (line 274)
- ✅ `pickItem()` (line 370)
- ✅ `recordShipment()` (line 479)
- ✅ `adjustInventory()` (line 593)
- ❌ `reserveForOrder()` — **MISSING**
- ❌ `releaseReservation()` — **MISSING**
- ❌ `transfer()` — **MISSING**
- ❌ `skuCorrectionTransfer()` — **MISSING**

**Impact:** Any service that registered via `inventoryCore.onInventoryChange()` (which includes the sync orchestrator) won't be notified when reservations change. The `ReservationService` explicitly calls `channelSync.queueSyncAfterInventoryChange()` as a workaround, but this creates a dual-trigger system — some mutations go through `notifyChange`, others bypass it.

**What it should do:** Add `this.notifyChange(params.productVariantId, "reserve")` at the end of `reserveForOrder()`.

**Severity:** P0 — Reserving reduces available ATP. If the `onInventoryChange` callback is the primary sync trigger, reservations won't push updated quantities to channels.

---

### Finding 3 — `releaseReservation()` Doesn't Trigger `notifyChange` (P0)

**File:** `server/modules/inventory/core.service.ts`, line 657-715

Same as Finding 2. Releasing a reservation increases available ATP, but `notifyChange` is not called. The `ReservationService` has its own explicit sync call, but this is an inconsistent pattern.

**Severity:** P0 — Same reasoning as Finding 2.

---

### Finding 4 — `transfer()` Doesn't Trigger `notifyChange` (P0)

**File:** `server/modules/inventory/core.service.ts`, line 703-801

Bin-to-bin transfers don't call `notifyChange`. While transfers typically don't change total ATP (stock moves within the same warehouse), they DO matter for:
- Warehouse-aware sync (the orchestrator pushes per-warehouse ATP)
- The sync orchestrator checks which variants exist at which warehouse

**Mitigation note:** `inventory.routes.ts` lines 164 and 313 fire `channelSync.queueSyncAfterInventoryChange()` explicitly for transfer endpoints. But any code calling `inventoryCore.transfer()` directly (like `cycleCountService.resolveWithTransfer`) relies on the `notifyChange` mechanism which is missing.

**Severity:** P0 — Transfers via cycle count resolution and replen won't trigger sync.

---

### Finding 5 — `skuCorrectionTransfer()` Doesn't Trigger `notifyChange` (P0)

**File:** `server/modules/inventory/core.service.ts`, line 803-905

Cross-variant SKU correction transfers move stock between variants. This definitely changes ATP for both the source and target variant, but `notifyChange` is never called.

**Severity:** P0 — Both source and target variant ATP are wrong until next scheduled sync.

---

### Finding 6 — `BreakAssemblyService` Bypasses `notifyChange` Entirely (P0)

**File:** `server/modules/inventory/break-assembly.service.ts`

The `breakVariant()` and `assembleVariant()` methods:
- Directly call `this.adjustWithinTx()` which does raw SQL `UPDATE` on `inventoryLevels`
- Log to `inventory_transactions` correctly
- **Never call `notifyChange` or `channelSync.queueSyncAfterInventoryChange()`**

Breaking a case into packs changes the ATP for ALL variants of the product (the shared base-unit pool stays the same, but the variant composition changes). If the case variant was listed on Shopify, its ATP just went to zero. If the pack variant wasn't listed, packs are now sellable.

**The routes might compensate:** Need to check if `inventory.routes.ts` fires sync after break/assembly.

Checking routes line 313: `channelSync.queueSyncAfterInventoryChange(fromVarId)` and `toVarId` — this IS for break/assembly. **So the route compensates**, but:
- The service is called directly by `replen.service.ts executeTask()` during case-break replen, which does NOT go through the route.
- The replen service's `executeTask()` doesn't fire channel sync itself.

**Severity:** P0 — Case breaks via replen (which is the primary use case!) don't trigger channel sync.

---

### Finding 7 — `InventorySourceService.setInventoryLevel()` Bypasses Core (P0)

**File:** `server/modules/inventory/source.service.ts`, lines 206-255

```typescript
private async setInventoryLevel(locationId, variantId, newQty, warehouseId) {
  // Direct UPDATE on inventory_levels
  await this.db.update(inventoryLevels)
    .set({ variantQty: newQty, updatedAt: new Date() })
    .where(eq(inventoryLevels.id, existing.id));
  // ...logs to inventory_transactions with non-standard fields
}
```

This service syncs external warehouse inventory (3PL/Shopify locations) and:
1. Sets `variantQty` directly (not through `inventoryCore`)
2. Uses non-standard transaction schema (e.g., `qty` field instead of `variantQtyDelta`)
3. **Never fires channel sync** — external warehouse stock changes should propagate to all channels
4. No lot tracking

**Severity:** P0 — 3PL inventory changes are invisible to channel sync.

---

### Finding 8 — OMS Orders Written Once, Never Updated (P0)

**File:** `server/modules/oms/shopify-bridge.ts`

The Shopify bridge writes orders to `oms_orders` with a status based on the Shopify data at ingestion time. But there's **no mechanism to update `oms_orders` when Shopify fulfills the order later**. The bridge:

```typescript
// Line 84-87: Status set at ingestion, never updated
if (raw.cancelled_at) {
  status = "cancelled";
} else if (fulfillmentStatus === "fulfilled") {
  status = "shipped";
} else if (financialStatus === "paid") {
  status = "confirmed";
}
```

Most orders are ingested when they're created (status = "confirmed"). When ShipStation ships them and Shopify fires a fulfillment webhook, the `fulfillment.service.ts` processes the shipment on the WMS `orders` table — but **never touches `oms_orders`**.

**The `markShipped()` function in `oms.service.ts` exists** but is never called by the fulfillment webhook flow.

**Severity:** P0 — The OMS orders table shows ~2774 orders, most stuck in "confirmed" even after shipping. This makes the unified order view unreliable.

---

### Finding 9 — Legacy `ChannelSyncService` Has Full Allocation Engine Reimplemented (P1)

**File:** `server/modules/channels/sync.service.ts`, lines 142-300

The `syncProduct()` method has a full legacy allocation path that:
1. Loads allocation rules from `channel_product_allocation` (different table than the allocation engine's `channel_allocation_rules`)
2. Implements its own `allocationPct` / `allocationFixedQty` logic on the `channels` table
3. Has a 6-step priority chain (variant override → product block → channel allocation → product floor → product cap → variant floor/cap)

This is a **complete reimplementation** of what `allocation-engine.service.ts` does, using different tables and different logic. The service has orchestrator delegation (`this.orchestrator?.syncInventoryForProduct()`) that short-circuits the legacy path, but:

- If the orchestrator throws, it **falls back to the legacy path** (line ~135: `catch → "Fall through to legacy path"`)
- The legacy path uses different allocation tables (`channel_product_allocation` vs `channel_allocation_rules`)

**Impact:** If the orchestrator ever errors, inventory gets pushed with different allocation logic. The two systems could produce different quantities for the same product.

**Severity:** P1 — Currently mitigated by orchestrator being set, but the fallback creates a hidden inconsistency.

---

### Finding 10 — Orchestrator Fallback ATP Calculation (P1)

**File:** `server/modules/channels/echelon-sync-orchestrator.service.ts`, lines ~320-345

When `atpService.getAtpPerVariantByWarehouse` is unavailable, the orchestrator has an inline fallback:

```typescript
// Fallback: direct per-variant ATP (no fungible conversion)
const atpRows = await this.db
  .select({ productVariantId: ..., atp: sql`SUM(GREATEST(variant_qty - reserved_qty - picked_qty - packed_qty, 0))` })
  .from(inventoryLevels)
  .innerJoin(warehouseLocations, ...)
  .where(...)
  .groupBy(inventoryLevels.productVariantId);
```

This is the **exact anti-pattern** that caused the original bug — per-variant ATP without fungible conversion. A case of 800 would show ATP=1 (1 case) instead of ATP=800 (800 base units convertible to 32 packs of 25).

**Severity:** P1 — The primary path uses fungible ATP correctly, but if `atpService` is ever undefined (e.g., construction order bug), the fallback silently reverts to the broken model.

---

### Finding 11 — Orchestrator Uses `product_locations` to Gate Variant Existence (P1)

**File:** `server/modules/channels/echelon-sync-orchestrator.service.ts`, lines ~275-295

```typescript
// Query which variant IDs from this product exist at this warehouse
const variantIdsAtWarehouse = await this.db
  .select({ variantId: sql`DISTINCT ${productLocations.productVariantId}` })
  .from(productLocations)
  .innerJoin(warehouseLocations, eq(warehouseLocations.id, productLocations.warehouseLocationId))
  .where(and(
    eq(warehouseLocations.warehouseId, wh.warehouseId),
    eq(productLocations.status, "active"),
  ));
```

This uses `product_locations` (bin assignments) to determine which variants exist at a warehouse. But stock can exist at locations without a `product_locations` assignment — via transfers, receives to unassigned bins, etc.

If a variant has `inventory_levels` rows at a warehouse but no `product_locations` assignment, it will be **skipped during sync**. The stock exists but won't be pushed to Shopify.

**What it should do:** Query `inventory_levels` joined with `warehouse_locations` to find which variants have stock at the warehouse. `product_locations` is for slotting, not for existence.

**Severity:** P1 — Won't cause issues until stock ends up at unassigned locations (which happens via transfers and 3PL syncs).

---

### Finding 12 — Reservation Requires `product_locations` Assignment (P1)

**File:** `server/modules/channels/reservation.service.ts`, lines 131-147

```typescript
// Step 3: Find the variant's assigned bin from product_locations
const [assignment] = await this.db
  .select({ warehouseLocationId: productLocations.warehouseLocationId })
  .from(productLocations)
  .where(and(
    eq(productLocations.productVariantId, variantId),
    eq(productLocations.status, "active"),
  ))
  .limit(1);

if (!assignment?.warehouseLocationId) {
  console.warn(`[RESERVATION] No assigned bin for variant ${variantId}`);
  return { reserved: 0, shortfall: orderQty };
}
```

The reservation service correctly gates on ATP (fixed today), but still requires a `product_locations` assignment to determine WHERE to place the reservation. If a variant has stock but no bin assignment, it **cannot be reserved**.

This is partially acceptable (you need to know where to put the reservation), but the fallback should be to check `inventory_levels` for ANY location with stock.

**Severity:** P1 — New variants that have been received but not yet assigned to a pick bin can't be reserved.

---

### Finding 13 — `channel_feeds.last_synced_qty` Drift (P1)

**Multiple files**

`channel_feeds.last_synced_qty` is written after successful Shopify API pushes. But:
1. If Shopify adjusts inventory externally (marketplace fulfillment, manual edit), `last_synced_qty` diverges from actual Shopify inventory
2. The `getDivergence()` method in `sync.service.ts` detects this by comparing ATP to `last_synced_qty`, but it only catches internal drift (ATP changed, sync didn't fire), not external drift (Shopify changed independently)

There's no periodic reconciliation that reads FROM Shopify and compares.

**Severity:** P1 — External Shopify edits create ghost inventory.

---

### Finding 14 — Dual Sync Trigger Paths (P1)

**Multiple files**

There are TWO mechanisms for triggering channel sync after inventory changes:

1. **`inventoryCore.onInventoryChange()` callback** — fires `notifyChange` from core service for receive/pick/ship/adjust
2. **Explicit `channelSync.queueSyncAfterInventoryChange()`** — called directly by services and routes

These overlap for some operations (both fire for picks via routes) and miss others (only explicit for reservations, neither for transfers via core). This creates:
- Double-syncs for some paths
- Missing syncs for others
- Confusion about which mechanism is canonical

**Severity:** P1 — Should consolidate to a single mechanism. Either ALL mutations go through `notifyChange`, or remove it and always use explicit calls.

---

### Finding 15 — Picking Service Inline Inventory Adjustments (P1)

**File:** `server/modules/orders/picking.service.ts`, `confirmCaseBreak()` and `skipReplen()`

The picking service directly calls `inventoryCore.adjustLevel()` for bin count corrections instead of using `inventoryCore.adjustInventory()`:

```typescript
// confirmCaseBreak, line ~confirmCaseBreak
await this.inventoryCore.adjustLevel(level.id, { variantQty: adjustment });
```

`adjustLevel()` is a low-level atomic bucket change that:
- ❌ Doesn't check for negative inventory
- ❌ Doesn't fire `notifyChange` (only `adjustInventory` does)
- ❌ Doesn't clean up zombie records
- ❌ Doesn't adjust lots

The method also manually logs transactions instead of letting `adjustInventory()` handle it.

**Note:** The `handleBinCount()` method has the same pattern but is more comprehensive. The `confirmCaseBreak` and `skipReplen` methods should use `adjustInventory()`.

**Severity:** P1 — Bin count corrections in the picking flow don't trigger channel sync or lot adjustments.

---

### Finding 16 — Inline `available = variantQty - reservedQty` in Routes (P2)

**File:** `server/modules/inventory/inventory.routes.ts`, lines 2189, 2268, 2311

Multiple API endpoints compute availability inline:
```typescript
lv.available = lv.variantQty - lv.reservedQty;
// and
available: row.variant_qty - row.reserved_qty - row.picked_qty,
```

This ignores the fungible ATP model. For display purposes on inventory management screens, this is acceptable (showing per-location stock). But if any consumer of these APIs uses `available` for decision-making, they'll get variant-level numbers instead of fungible ATP.

**Severity:** P2 — These are read-only display endpoints, not decision gates. Acceptable but confusing.

---

### Finding 17 — Operations Dashboard Direct `inventory_levels` Queries (P2)

**File:** `server/modules/orders/operations-dashboard.service.ts`, line 163

```sql
COALESCE(SUM(CASE WHEN il.variant_qty > 0 THEN il.reserved_qty ELSE 0 END), 0)::int as total_reserved_qty
```

The ops dashboard queries `inventory_levels` directly for aggregate stats. This is acceptable for dashboard display but creates coupling to the raw table structure.

**Severity:** P2 — Display-only, no decision-making impact.

---

### Finding 18 — Alerts Service Direct Queries (P2)

**File:** `server/modules/inventory/alerts.service.ts`

The alerts service queries `inventory_levels` directly to detect anomalies (negative inventory, over-reserved, stale picks, orphaned picks). This is **appropriate** — anomaly detection should query raw data, not go through ATP which masks issues.

**Severity:** P2 — Acceptable pattern for anomaly detection. No fix needed.

---

### Finding 19 — Break/Assembly `product_locations` Join for Target Location (P2)

**File:** `server/modules/inventory/break-assembly.service.ts`, line 130

```typescript
const assignment = await this.db
  .select({ warehouseLocationId: productLocations.warehouseLocationId })
  .from(productLocations)
  .innerJoin(warehouseLocations, eq(productLocations.warehouseLocationId, warehouseLocations.id))
  .where(and(
    eq(sql`UPPER(${productLocations.sku})`, targetVariant.sku?.toUpperCase() ?? ""),
    eq(warehouseLocations.isPickable, 1)
  ))
  .limit(1);
```

This uses `product_locations` to find the target pick bin for a break operation. This is a **slotting lookup** (where SHOULD this SKU go), not an availability check (where IS stock), so the join is appropriate.

**Severity:** P2 — Acceptable use of `product_locations` for slotting.

---

### Finding 20 — Order Status in Three Tables (P2)

Order status is tracked in three places:
1. WMS `orders` table: `warehouseStatus` (pending → ready → in_progress → packed → shipped)
2. OMS `oms_orders` table: `status` + `fulfillmentStatus` (pending → confirmed → shipped)
3. Shopify: `fulfillment_status` (unfulfilled → fulfilled)

The WMS→Shopify path works (fulfillment webhook updates `orders`). The Shopify→OMS path is broken (Finding 8). The OMS→WMS path doesn't exist (OMS orders don't auto-create WMS pick queue entries yet).

**Severity:** P2 — Currently the WMS `orders` table is the operational source of truth. OMS is supplementary. But as eBay grows, OMS becomes the primary intake and needs to drive WMS.

---

### Finding 21 — `product_locations` Drift (P2)

`product_locations` represents where a SKU SHOULD live (bin assignment). `inventory_levels` shows where stock actually IS. These can diverge:
- Stock received to unassigned location → `inventory_levels` has row, `product_locations` doesn't
- Bin assignment removed but stock remains → `product_locations` deleted, `inventory_levels` still has stock
- Cycle count finds unexpected SKU → `reconcileBinAssignment()` creates new `product_locations`

The cycle count service's `reconcileBinAssignment()` method already handles this reconciliation after variance approval. The core service also cleans up empty `inventory_levels` rows when stock goes to zero at unassigned locations.

**Severity:** P2 — Mitigated by existing reconciliation in cycle counts.

---

## Inventory Mutation → Sync Trigger Coverage Matrix

| Mutation | `notifyChange` | Explicit `channelSync` | Covered? |
|----------|:--------------:|:----------------------:|:--------:|
| `receiveInventory()` | ✅ | ✅ (receiving.service) | ✅ |
| `pickItem()` | ✅ | — | ✅ |
| `recordShipment()` | ✅ | ✅ (fulfillment.service) | ✅ |
| `adjustInventory()` | ✅ | ✅ (routes, cycle count) | ✅ |
| `reserveForOrder()` | ❌ | ✅ (reservation.service) | ⚠️ Partial |
| `releaseReservation()` | ❌ | ✅ (reservation.service) | ⚠️ Partial |
| `transfer()` | ❌ | ✅ (routes only) | ⚠️ Route-only |
| `skuCorrectionTransfer()` | ❌ | ✅ (routes only) | ⚠️ Route-only |
| `breakVariant()` | ❌ | ✅ (routes only) | ❌ Via replen |
| `assembleVariant()` | ❌ | ✅ (routes only) | ❌ Via replen |
| `setInventoryLevel()` (3PL) | ❌ | ❌ | ❌ |
| OMS `reserveInventory()` | ❌ | ❌ | ❌ |
| Picking `adjustLevel()` bin counts | ❌ | ❌ | ❌ |

**Key insight:** The "Covered?" column shows that many paths only work when called through HTTP routes (which add explicit sync calls). When called service-to-service (replen → break, cycle count → transfer, picking → adjustLevel), the sync triggers are missing.

---

## Recommended Fix Order

1. **Add `notifyChange` to ALL core mutations** (Findings 2-5) — 30 min, eliminates 4 P0s
2. **Wire OMS `reserveInventory` to `ReservationService`** (Finding 1) — 1 hour, eliminates P0 + fixes eBay
3. **Add channelSync to `BreakAssemblyService`** (Finding 6) — 30 min, eliminates replen sync gap
4. **Add channelSync to `InventorySourceService`** (Finding 7) — 30 min, eliminates 3PL sync gap
5. **Add OMS status update from fulfillment webhook** (Finding 8) — 1 hour, fixes unified order view
6. **Remove legacy allocation fallback in sync.service.ts** (Finding 9) — 30 min, eliminates hidden inconsistency
7. **Replace `product_locations` gate in orchestrator** (Finding 11) — 30 min, prevents sync gaps
8. **Add fallback in reservation for unassigned variants** (Finding 12) — 30 min, prevents reservation failures
9. **Replace `adjustLevel` with `adjustInventory` in picking** (Finding 15) — 30 min, adds safety + sync
10. **Consolidate to single sync trigger mechanism** (Finding 14) — 2 hours, architectural cleanup

Total estimated effort: ~8 hours for all P0+P1 fixes.
