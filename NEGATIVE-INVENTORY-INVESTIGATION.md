# Negative Inventory Investigation Report

**Date:** 2026-03-20  
**Investigator:** Archon (Systems Investigation Subagent)  
**Status:** ROOT CAUSE IDENTIFIED  

---

## Executive Summary

All three negative inventory records were caused by **Cycle Count #34** ("Initial count 02-10-26") approving variance adjustments with `allowNegative: true`. The cycle count correctly identified that inventory had been moved to different bins, but the adjustments were applied **after picks had already reduced the quantity**, making the adjustment overshoot into negative territory. Replenishment **did fire** in two of the three cases but the tasks were cancelled or blocked — the replen system cannot recover from negative inventory caused by accounting adjustments.

**This is NOT a ShipStation or shipment issue. No "shipped without picking" occurred. No race conditions.**

---

## The Three Negative Records

| SKU | Variant ID | Location | Code | Loc Type | Current Qty | Reserved | Cause |
|-----|-----------|----------|------|----------|------------|----------|-------|
| ARM-ENV-DBL-C300 | 63 | 1264 | H-05-A | pick | **-2** | 1 | Cycle count adjustment -49 applied when only 47 remained |
| ARM-ENV-SGL-NM-C500 | 69 | 1262 | H-04-A | pick | **-9** | 3 | Cycle count adjustment -58 applied when only 49 remained |
| ARM-ENV-SGL-C700 | 67 | 1272 | H-12 | reserve | **-2** | 0 | Cycle count adjustment -81 applied when only 79 remained |

---

## Root Cause Analysis

### What Happened: The Timeline

All three negative records follow the **exact same pattern**:

#### ARM-ENV-DBL-C300 (Variant 63) at H-05-A

| Time | Event | Qty Before → After |
|------|-------|-------------------|
| 2026-02-08 02:15 | Receipt from RCV-20260208-001 | 0 → **49** |
| 2026-02-10 22:13 | **Cycle count counted**: expected 49, found **0** (different SKU GLV-GRD-CGC-C5000 was in bin) | — |
| 2026-02-10 22:18 | Reserve for order #87944 | 49 (reserved +1) |
| 2026-02-12 18:05 | Reserve for order #88034 | 49 (reserved +1) |
| 2026-02-12 22:37 | **Pick for order #87944** (-1) | 49 → **48** |
| 2026-02-14 12:56 | **Pick for order #88034** (-1) | 48 → **47** |
| 2026-02-15 01:00 | Reserve for order #88170 | 47 (reserved +1) |
| 2026-02-15 14:12 | **Cycle count adjustment approved**: -49 | 47 → **-2** ⚠️ |

**What went wrong:** The cycle count was performed on Feb 10. At that time, there were 49 units at H-05-A. The counter found 0 (a different SKU was in the bin — the product had been physically moved). The cycle count recorded variance = -49. But the approval didn't happen until Feb 15 — by then, 2 units had been picked (orders #87944 and #88034). The system expected 49 at count time and adjusted -49, but only 47 remained. Result: -2.

#### ARM-ENV-SGL-NM-C500 (Variant 69) at H-04-A

| Time | Event | Qty Before → After |
|------|-------|-------------------|
| 2026-02-08 02:15 | Receipt from RCV-20260208-001 | 0 → **58** |
| 2026-02-10 22:11 | **Cycle count counted**: expected 58, found **0** (missing_item) | — |
| 2026-02-11 16:09 | **Pick for order #87822** (-1) | 58 → **57** |
| 2026-02-11 18:02 | **Pick for order #87844** (-6) | 57 → **51** |
| 2026-02-11 19:30 | Reserve for order #87976 | 51 (reserved +2) |
| 2026-02-13 14:32 | **Pick for order #87976** (-2) | 51 → **49** |
| 2026-02-13 19:49 | Reserve for order #88098 | 49 (reserved +1) |
| 2026-02-15 01:00 | Reserve for order #88170 | 49 (reserved +1) |
| 2026-02-15 14:12 | **Cycle count adjustment approved**: -58 | 49 → **-9** ⚠️ |

**Same pattern:** Counted on Feb 10 (expected 58, found 0), but 9 units were picked between counting and approval. Adjustment of -58 hit only 49 remaining. Result: -9.

#### ARM-ENV-SGL-C700 (Variant 67) at H-12 (reserve location)

| Time | Event | Qty Before → After |
|------|-------|-------------------|
| 2026-02-08 02:15 | Receipt from RCV-20260208-001 | 0 → **81** |
| 2026-02-10 22:15 | **Cycle count counted**: expected 81, found **0** (different SKU SHLZ-BNDR-TOP-9PCK-BLK-C10 in bin) | — |
| 2026-02-15 15:32 | **Pick for order #88077** (-1) | 81 → **80** |
| 2026-02-16 12:36 | **Pick for order #88095** (-1) | 80 → **79** |
| 2026-02-16 19:49 | **Cycle count adjustment approved**: -81 | 79 → **-2** ⚠️ |

**Same pattern.** This one was at a **reserve** location (H-12, `is_pickable=0`), which means the replen system wouldn't even evaluate it for replenishment.

---

### Why Cycle Count Adjustments Can Go Negative

In `cycle-count.service.ts`, line 281:
```typescript
await this.inventoryCore.adjustInventory({
    ...
    allowNegative: true,  // <-- THIS IS THE ISSUE
});
```

The `adjustInventory` method in `core.service.ts` has a guard:
```typescript
if (!params.allowNegative && params.qtyDelta < 0) {
    if (level.variantQty + params.qtyDelta < 0) {
        throw new Error(`Adjustment would result in negative inventory...`);
    }
}
```

But cycle counts explicitly bypass this guard with `allowNegative: true`. This is **by design** — the thinking is that if a physical count says 0, the system should trust the count. But the vulnerability is the **time gap between counting and approving**.

### The Core Bug: Stale Variance

The variance is calculated at **count time** (e.g., "expected 58, counted 0, variance = -58"). But the adjustment doesn't apply until **approval time** — potentially days later. During that gap, picks reduce the on-hand quantity. The adjustment then applies the **original variance** (-58) against a **reduced balance** (49), driving it negative.

**The cycle count system does NOT re-snapshot the current quantity at approval time.** It blindly applies the variance that was computed at count time.

---

## Why Replenishment Didn't Help

### Replen Tasks Were Created (and Cancelled/Blocked)

The replen system **did react** after the cycle count adjustments:

| Task ID | SKU | Status | Created | Notes |
|---------|-----|--------|---------|-------|
| #23 | ARM-ENV-DBL-C300 | **cancelled** | 2026-02-15 14:12 | Created same second as the CC adjustment. Coverage=-14.0d |
| #24 | ARM-ENV-SGL-NM-C500 | **cancelled** | 2026-02-15 14:12 | Created same second as the CC adjustment. Coverage=-14.0d |
| #303 | ARM-ENV-SGL-NM-C500 | **blocked** | 2026-02-22 02:45 | Min/max scan. "No source stock found in reserve locations" |
| #304 | ARM-ENV-DBL-C300 | **cancelled** | 2026-02-22 02:45 | Min/max scan |
| #504 | ARM-ENV-DBL-C300 | **blocked** | 2026-03-19 17:42 | Most recent. "No source stock found in reserve locations" |

Tasks #23 and #24 were created within the same second as the cycle count approval but were later **cancelled** (likely during a cleanup or because the locations were stale). Task #303 is still blocked — variant 69 has no reserve stock. Task #504 is blocked for the same reason for variant 63.

### Why Replen Can't Fix This

Several structural reasons:

1. **No bin assignment at the negative locations:** The `product_locations` table shows:
   - Variant 63 (ARM-ENV-DBL-C300) → assigned to **H-05-B** (not H-05-A where it's negative)
   - Variant 69 (ARM-ENV-SGL-NM-C500) → assigned to **G-03** (not H-04-A where it's negative)
   - Variant 67 (ARM-ENV-SGL-C700) → assigned to **F-02** (not H-12 where it's negative)
   
   The cycle count's `reconcileBinAssignment` correctly removed the assignments when it found different SKUs in those bins. Without a `product_locations` record, `evaluateReplenNeed()` returns `{ status: "skip", skipReason: "no_bin_assignment" }`.

2. **H-12 is a reserve location** (`is_pickable=0`): The replen system only evaluates pickable locations. `evaluateReplenNeed()` returns `{ status: "skip", skipReason: "location_not_pickable" }`.

3. **No replen rules exist** for these variants (the `replen_rules` table has zero rows for variants 63, 67, 69). They rely entirely on tier defaults.

4. **Tier default for hierarchy_level 3** (which all three variants are): `triggerValue=5`, `replenMethod=pallet_drop`, `sourceLocationType=reserve`. This means replen looks for reserve stock. But:
   - Variant 63 has no reserve stock (only in pick locations H-05-A and H-05-B)
   - Variant 69 has no reserve stock (only in pick locations H-04-A and G-03)
   - Variant 67 **does** have reserve stock (at H-11, I-12, I-10) but the negative is AT a reserve location (H-12) which replen doesn't evaluate

5. **Replen doesn't fix negatives — it prevents them.** The replen trigger condition is `currentQty <= triggerValue` (i.e., stock is low). But the negative locations don't have bin assignments, so they're skipped entirely. And even if they were evaluated, replen creates a **transfer task** — it doesn't create inventory from thin air. The negative here is a **phantom** — the real inventory was moved to different bins.

---

## Impact Assessment

### Channel Sync / Shopify Impact

The `allocation-engine.service.ts` uses `Math.max(0, ...)` when computing allocated units:
```typescript
const allocatedUnits = Math.max(0, Math.floor(atpBase / variant.unitsPerVariant));
```

The ATP calculation sums ALL inventory_levels across all variants and locations. So the -2, -9, and -2 negatives **are reducing the ATP pool**, meaning fewer units are showing as available on Shopify than actually exist. However, because these products have significant positive inventory at other locations, the net ATP is still positive:

- Variant 63 (ARM-ENV-DBL-C300): H-07 has 124, H-05-B has 0. Net with negative: 122 variant units = 36,600 base units. Real inventory is likely 124 + 0 = 124 (37,200 base).
- Variant 69 (ARM-ENV-SGL-NM-C500): G-03 has 88. Net with negative: 79 variant units = 39,500 base. Real: 88 (44,000 base).
- Variant 67 (ARM-ENV-SGL-C700): F-02 has 37, H-11 81, I-12 81, J-07 81, I-10 27. Net with negative: 305 variant units = 213,500 base. Real: 307 (214,900 base).

**The negatives are causing a small undercount on Shopify but these products are NOT showing as OOS.**

### Orphaned Reservations

- H-05-A (variant 63): `reserved_qty=1` — order #88170 has a reservation against a location with -2 on hand. This is an orphaned reservation.
- H-04-A (variant 69): `reserved_qty=3` — orders #88098, #88170, and one more have reservations against -9 on hand. Orphaned.
- H-12 (variant 67): `reserved_qty=0` — clean.

These orphaned reservations are tying up allocation capacity without any inventory to back them.

---

## Recommendations

### Immediate Fix (Data Correction)
1. **Zero out the negative inventory_levels** at the three affected locations (set `variant_qty` to 0)
2. **Release the orphaned reservations** at H-05-A and H-04-A (reallocate to locations with actual stock)
3. **Consider deleting** the inventory_levels rows entirely since these variants are no longer assigned to those bins

### Code Fixes (Prevent Recurrence)

1. **Re-snapshot quantity at approval time:** When approving a cycle count variance, recalculate `varianceQty = countedQty - currentActualQty` instead of using the stale variance from count time. This is the **primary fix**.

2. **Add a negative-inventory safety check in `adjustInventory` for cycle counts:** Even with `allowNegative: true`, add a warning/alert when the result would be negative. At minimum, log it prominently.

3. **Freeze-aware variance calculation:** The cycle count service already has location freeze logic (line 598: "Soft-freeze all in-scope locations — picks/reservations/replen will skip them"). Verify that picks are actually blocked on frozen locations during the count-to-approval window. If they're not being blocked, that's a separate bug.

4. **Replen should scan for negative inventory:** Add a periodic check (or trigger on `adjustInventory` with negative result) that detects `variant_qty < 0` records and either zeroes them out or creates a task to investigate.

---

## Summary of Findings

| Question | Answer |
|----------|--------|
| What caused the negatives? | Cycle count #34 adjustments applied with stale variance after picks reduced inventory |
| Were these from ShipStation? | **No.** All three were `adjustment` type from cycle count, not `ship` transactions |
| Was there a "shipped without picking" issue? | **No.** No ship transactions at any of the three negative locations |
| Why didn't replenishment fire? | It DID fire (tasks #23, #24, #303, #304, #504) but all were cancelled or blocked — no bin assignment at those locations, no reserve source stock |
| Why didn't the negative guard work? | `allowNegative: true` is explicitly set for cycle count adjustments — by design |
| Is Shopify affected? | Slightly — ATP is undercounted by the negative amounts but products are not showing OOS |
| Are there orphaned reservations? | Yes — 1 at H-05-A, 3 at H-04-A |
| Race condition? | **No.** This is a design gap: stale variance applied without re-checking current state |
