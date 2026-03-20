# Ghost Investigation #2 — Dual Issue Report
**Date:** 2026-03-20  
**Investigator:** Archon (subagent)  
**Status:** READ-ONLY investigation — no code or data modified

---

## Issue 1: EG-SLV-STD-P100 "Out of Stock" on Scanner at E-07

### Summary
**This was NOT a system bug.** The picker was at bin E-07 (which is the first stop for order #54887), scanning `SHLZ-MAG-180PT-P1` (which lives at E-07). The "Out of Stock" message was likely a **misunderstanding of the scanner UI**, not an actual "out of stock" for EG-SLV-STD-P100.

### Evidence

#### 1. Order #54887 (order_id 89846) Items & Locations
| SKU | Location | Qty | Status |
|-----|----------|-----|--------|
| SHLZ-MAG-180PT-P1 | **E-07** | 1 | completed |
| SHLZ-MAG-55PT-SLV-P1 | E-03 | 3 | completed |
| SHLZ-MAG-35PT-SLV-P1 | E-02 | 13 | completed |
| GLV-MAG-35PT-P50 | D-09 | 1 | completed |
| SHLZ-SLV-TM-P100 | D-13 | 2 | completed |
| **EG-SLV-STD-P100** | **C-09** | 3 | completed |

**The EG-SLV-STD-P100 order item was correctly assigned to C-09, NOT E-07.**

#### 2. No Misassigned Locations
- Zero order items for EG-SLV-STD-P100 with location = E-07 exist in the database
- `product_locations` correctly maps EG-SLV-STD-P100 → C-09 (warehouse_location_id 1190)
- All 20 most recent order items for this SKU show location = C-09

#### 3. What's Actually at E-07
- E-07 contains `SHLZ-MAG-180PT-P1` (180PT Magnetic Holder) — 110 units in stock
- This is the FIRST item in order #54887's picking sequence

#### 4. The Pick SUCCEEDED
Picking logs show order #54887 was:
- **Claimed** at 16:10:21 UTC
- **SHLZ-MAG-180PT-P1** picked from E-07 at 16:10:31 (scan method)
- **EG-SLV-STD-P100** picked from C-09 at 16:12:55-16:12:56 (manual method, 3 units scanned one-by-one)

All items picked, no errors, no discrepancies, no shorts.

#### 5. C-09 Inventory
At time of investigation: **94 units** of EG-SLV-STD-P100 at C-09, reserved=0, picked=0, packed=0. Fully available.

#### 6. No Error Logs
- No `inventory_discrepancy` logs for EG-SLV-STD-P100 on March 20
- No failed picks, no "out of stock" entries in picking_logs
- The gap between 16:12:56 and 16:25 has zero picking_logs entries for any SKU

### Root Cause Analysis

The screenshot showing "E-07 1/1" at the top is the **order's picking sequence** — the scanner navigates the picker through bins in order. E-07 is stop #1 (for the 180PT mag holder), not the bin for EG-SLV-STD-P100.

**Most likely scenario:** The picker misinterpreted the scanner UI. They were at E-07 picking the first item (SHLZ-MAG-180PT-P1) and may have confused the bin indicator "E-07 1/1" as being the location for EG-SLV-STD-P100. The actual pick for EG-SLV-STD-P100 happened ~2 minutes later at C-09, successfully.

### Verdict: NO BUG
The `_deductInventory` logic correctly:
1. Uses `item.location` (C-09) as the assigned bin
2. Falls back through pickable locations if needed
3. Never tried to pick from E-07 for this SKU

---

## Issue 2: EG-SLV-PF-P100 Shows Out of Stock on Shopify

### Summary
**This IS a real issue.** The sync system is correctly pushing `pushed_qty=0` because the **per-variant direct ATP** is 0, despite the **fungible ATP pool** being 1000 packs (100,000 base units). The warehouse-aware sync uses `getDirectVariantAtpByWarehouse` which calculates ATP **per variant row** instead of using the fungible pool.

### The Full Math

#### Inventory On Hand
| Variant | SKU | Location | variant_qty | units_per_variant | Base Units |
|---------|-----|----------|-------------|-------------------|------------|
| 72 | EG-SLV-PF-P100 | C-13 (pick) | **1** | 100 | 100 |
| 73 | EG-SLV-PF-C10000 | G-04-A (pick) | **10** | 10,000 | 100,000 |
| **TOTAL** | | | | | **100,100** |

#### Reservations
| Variant | reserved_qty | picked_qty | packed_qty | Base Units Committed |
|---------|-------------|------------|------------|---------------------|
| 72 (P100) | **1** | 0 | 0 | 100 |
| 73 (C10000) | 0 | 0 | 0 | 0 |
| **TOTAL** | | | | **100** |

#### Fungible ATP (what SHOULD be pushed)
```
Total On-Hand Base:    100,100
- Total Reserved Base:    -100
- Total Picked Base:         0
- Total Packed Base:         0
= Fungible ATP Base:   100,000
÷ 100 (units per pack) = 1,000 packs available
```

#### Direct Variant ATP (what IS being pushed)
```
EG-SLV-PF-P100 at C-13:
  variant_qty(1) - reserved_qty(1) - picked_qty(0) - packed_qty(0) = 0
  
  Per-variant ATP = 0  ← THIS IS WHAT GETS PUSHED TO SHOPIFY
```

### The Bug: Sync Uses Direct ATP, Not Fungible ATP

The sync orchestrator (`echelon-sync-orchestrator.service.ts`, line ~290) calls:
```typescript
warehouseAtpMap = await this.atpService.getDirectVariantAtpByWarehouse(variantIds, wh.warehouseId);
```

`getDirectVariantAtpByWarehouse` computes:
```sql
SUM(GREATEST(variant_qty - reserved_qty - picked_qty - packed_qty, 0))
```
**per variant**, grouped by `product_variant_id`.

This means variant 72 (P100) only sees its own 1 pack at C-13 (which is fully reserved), giving ATP = 0.

The **10 cases** of variant 73 (C10000) at G-04-A represent **100,000 base units** — enough for 1,000 packs — but they're invisible to variant 72's direct ATP calculation because they're a different variant.

### Timeline of the Bug

| Time (UTC) | Event |
|------------|-------|
| Mar 19 14:40 | pushed_qty = 0 (before case inventory was loaded) |
| Mar 19 15:09 | pushed_qty = 2000, atp_base = 200,000 (allocation engine ran) |
| Mar 19 15:18 | pushed_qty = 1000, atp_base = 100,000 (10 cases loaded) |
| Mar 19 15:18+ | All subsequent syncs: pushed_qty = 1000, **atp_base = 0** |
| Mar 20 13:51 | Last sync with pushed_qty = 1000 |
| Mar 20 14:12 | **pushed_qty drops to 0** — and stays 0 ever since |

**Key observation:** `atp_base` in the sync log has been 0 since Mar 19 15:18, yet `pushed_qty` was 1000. This means the orchestrator was using the **allocation engine's** fungible ATP (pushed_qty=1000) for some syncs but switched to using **direct variant ATP** (pushed_qty=0) for others.

The most likely explanation: two code paths were competing.
1. The **allocation engine** (`allocateProduct`) uses `getAtpBaseByWarehouse` which computes **fungible ATP** across all variants → correctly yields 1000 packs
2. The **warehouse-aware sync** (`pushInventoryToChannelWarehouseAware`) then overrides with `getDirectVariantAtpByWarehouse` → yields 0 for P100

At 14:12 on March 20, the direct variant ATP path "won" and started pushing 0.

### Reservation Analysis

| Status | Orders | Total Qty |
|--------|--------|-----------|
| shipped | 639 | 608 |
| ready (pending pick) | 36 | 320 |
| ready_to_ship | 1 | 1 |
| cancelled | 7 | 0 |

- **608 packs shipped** from 50 initially received
- That's only possible because most "picks" were recorded but the inventory was replenished via case breaks or manual adjustments
- **320 packs pending** across 36 orders — these need to be picked from the case stock
- Only **1 reservation** exists in `inventory_levels` (reserved_qty=1 at C-13)

The reservation system is NOT the primary problem — the sync path is.

### Inventory Transaction Trail
- **Received:** 50 packs (Feb 8, initial receipt at C-13)
- **Picked:** 31 packs total across 16 pick transactions (Feb 9 – Mar 19)
- **Shipped:** 6 packs recorded in ship transactions (only 3 ship txns recorded)
- **Current on hand:** 1 pack at C-13, 10 cases at G-04-A

**Note:** 608 orders shipped but only 6 ship transactions recorded for this variant. The pick transactions account for 31 units deducted. The remaining ~570+ orders shipped without inventory transactions — this suggests many orders were fulfilled before Echelon's full inventory tracking was operational, or inventory was managed at the Shopify level during early operations.

### Channel Configuration
- Channel 36 (Shopify) — mode: **mirror**, sync_mode: **live**, sweep: 15min
- Channel allocation rule for product 36: only variant 73 (C10000) has a **fixed=0** rule (id 6), meaning cases are blocked from Shopify (correct — you don't sell cases on Shopify)
- No rule exists for variant 72 (P100), so it falls through to the channel default (mirror)

### The Core Problem

The `pushInventoryToChannelWarehouseAware` method computes `pushQty` from `rawAtp` which comes from `getDirectVariantAtpByWarehouse`. This is a **per-variant** calculation, not a **fungible pool** calculation.

For products with multiple UOM variants (pack + case), the per-variant ATP for the pack will be 0 as soon as the physical packs are depleted, even though cases holding 100,000+ base units are sitting on the shelf.

The **allocation engine** correctly computes fungible ATP (1000 packs), but the orchestrator then **overrides** it with the direct per-variant number.

### Fix Required (DO NOT IMPLEMENT — read-only investigation)

The `pushInventoryToChannelWarehouseAware` method needs to use the **fungible ATP** from the allocation engine's result (which already accounts for allocation rules like mirror/share/fixed) instead of computing direct per-variant ATP. The allocation engine correctly handles the multi-UOM pool — the orchestrator just needs to trust it instead of recalculating.

Specifically, in `echelon-sync-orchestrator.service.ts`:
- The `rawAtp = warehouseAtpMap.get(a.productVariantId) ?? 0` should use the allocation engine's `a.allocatedUnits` (which already went through fungible ATP → allocation rule → variant units)
- OR: `getDirectVariantAtpByWarehouse` should be replaced with a warehouse-scoped version of the fungible ATP calculation

---

## Summary

| Issue | Status | Severity | Action Needed |
|-------|--------|----------|---------------|
| #1: EG-SLV-STD-P100 "Out of Stock" | **No bug found** | Low | Picker training — scanner UI shows bin sequence, not SKU bins |
| #2: EG-SLV-PF-P100 Shopify OOS | **Bug confirmed** | **CRITICAL** | Sync orchestrator uses per-variant ATP instead of fungible ATP, causing all multi-UOM products to show 0 when pack inventory is depleted but cases exist |

### Impact of Issue 2
This bug affects **any product** where:
1. The sellable variant (pack) has low/zero physical inventory
2. A higher-level variant (case) holds significant stock
3. The sync relies on direct variant ATP instead of fungible pool ATP

This could be silently affecting other products beyond EG-SLV-PF-P100.
