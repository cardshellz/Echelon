# COGS Engine — FIFO Cost Lot Technical Specification

> **System:** Echelon WMS/ERP — Card Shellz, LLC
> **Owner:** WMS (per BOUNDARIES.md — `inventory_lots` is a WMS-owned table)
> **Status:** SPEC — no code
> **Date:** 2026-03-22

---

## Table of Contents

1. [Overview](#1-overview)
2. [Cost Lot Model](#2-cost-lot-model)
3. [How Lots Are Created](#3-how-lots-are-created)
4. [FIFO Depletion](#4-fifo-depletion)
5. [Integration Points](#5-integration-points)
6. [Reporting](#6-reporting)
7. [Retroactive Load](#7-retroactive-load)
8. [Existing `inventory_lots` Table — Gap Analysis](#8-existing-inventory_lots-table--gap-analysis)
9. [Replen Alignment](#9-replen-alignment)
10. [Worked Examples](#10-worked-examples)

---

## 1. Overview

### Problem

Card Shellz currently has an `inventory_lots` table (54 active rows, most with `unitCostCents = 0`) and an `InventoryLotService` that creates lots on receive but stores only a single `unitCostCents` field — the raw PO cost. There is **no separation of PO cost vs. landed cost**, no mechanism to mark costs as estimated vs. finalized, and no FIFO depletion that records which lots fed a given order's COGS.

### Goal

Upgrade the cost lot system so that:

- Every piece of inventory has a **total unit cost** = PO cost + allocated landed cost (freight, duty, brokerage, customs, platform fees).
- Costs start as **estimated** and become **finalized** when all shipment invoices are in.
- FIFO depletion on shipment produces a precise **COGS per order line item**.
- Inventory valuation reports show total value with estimated/finalized breakdown.
- A one-time retroactive load gives existing inventory a cost basis.

### Design Principle: Piece-Level Costs

All costs in this system are expressed **per piece** (the atomic sellable unit).

| Product | PO Unit | PO Cost | Pieces per Unit | Per-Piece Cost |
|---------|---------|---------|-----------------|----------------|
| CS-PS-STD (Easy Glide Penny Sleeves) | Case of 10,000 | $120.00 | 10,000 | $0.0120 |
| CS-TL-35PT (UV Shield Toploaders) | Case of 2,000 | $200.00 | 2,000 | $0.1000 |
| CS-MH-35PT (Magnetic Holders) | Case of 200 | $240.00 | 200 | $1.2000 |
| CS-ARM-STD (Armalopes) | Case of 5,000 | $350.00 | 5,000 | $0.0700 |

When a case is broken into packs of 100 sleeves, each pack's 100 pieces carry the **same per-piece cost** from the original lot. No new lot is created.

---

## 2. Cost Lot Model

### Schema: `inventory_lots` (modified — use existing table)

```sql
ALTER TABLE inventory_lots
  -- Rename for clarity
  RENAME COLUMN unit_cost_cents TO po_unit_cost_cents;

  -- New columns
  ADD COLUMN po_line_id            INTEGER REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  ADD COLUMN landed_cost_cents     DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN total_unit_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN qty_received          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cost_status           VARCHAR(20) NOT NULL DEFAULT 'estimated',
  -- cost_status: 'estimated' | 'finalized'

  -- Drop unused columns (or keep for backward compat)
  -- qty_picked stays (used by existing lot service)
  -- expiry_date stays (future use, no cost impact)
```

**Full column list after migration:**

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | `integer` (identity) | NO | auto | PK |
| `lot_number` | `varchar(50)` | NO | — | Human-readable: `LOT-YYYYMMDD-###` |
| `product_variant_id` | `integer` FK → `product_variants` | NO | — | Which variant this lot tracks |
| `warehouse_location_id` | `integer` FK → `warehouse_locations` | NO | — | Physical location |
| `receiving_order_id` | `integer` FK → `receiving_orders` | YES | NULL | Source receiving event |
| `purchase_order_id` | `integer` FK → `purchase_orders` | YES | NULL | Source PO (header) |
| `po_line_id` | `integer` FK → `purchase_order_lines` | YES | NULL | **NEW** — Source PO line (for unit cost) |
| `inbound_shipment_id` | `integer` FK → `inbound_shipments` | YES | NULL | Linked shipment (for landed cost) |
| `po_unit_cost_cents` | `double precision` | NO | 0 | **RENAMED** — Raw PO cost per piece |
| `landed_cost_cents` | `double precision` | NO | 0 | **NEW** — Allocated freight/duty/customs per piece |
| `total_unit_cost_cents` | `double precision` | NO | 0 | **NEW** — `po_unit_cost + landed_cost` = COGS per piece |
| `qty_received` | `integer` | NO | 0 | **NEW** — Original pieces received (immutable after creation) |
| `qty_on_hand` | `integer` | NO | 0 | Pieces currently on hand (decremented by pick/ship/adjust) |
| `qty_reserved` | `integer` | NO | 0 | Pieces reserved for pending orders |
| `qty_picked` | `integer` | NO | 0 | Pieces in picker carts |
| `received_at` | `timestamp` | NO | — | FIFO sort key |
| `cost_status` | `varchar(20)` | NO | `'estimated'` | **NEW** — `estimated` or `finalized` |
| `cost_provisional` | `integer` | NO | 0 | Legacy flag (1 = not finalized). Superseded by `cost_status` but kept for backward compat during migration. |
| `status` | `varchar(20)` | YES | `'active'` | `active`, `depleted`, `expired` |
| `expiry_date` | `timestamp` | YES | NULL | Future use |
| `notes` | `text` | YES | NULL | |
| `created_at` | `timestamp` | NO | now() | |

### Indexes

```sql
-- FIFO query: oldest active lots for a variant
CREATE INDEX idx_lots_variant_fifo
  ON inventory_lots (product_variant_id, received_at ASC)
  WHERE status = 'active';

-- Shipment cost finalization: find all lots for a shipment
CREATE INDEX idx_lots_shipment
  ON inventory_lots (inbound_shipment_id)
  WHERE inbound_shipment_id IS NOT NULL;

-- PO line lookup
CREATE INDEX idx_lots_po_line
  ON inventory_lots (po_line_id)
  WHERE po_line_id IS NOT NULL;

-- Cost status filtering for reports
CREATE INDEX idx_lots_cost_status
  ON inventory_lots (cost_status)
  WHERE status = 'active';
```

### Constraints

```sql
-- total_unit_cost_cents must equal po + landed
ALTER TABLE inventory_lots
  ADD CONSTRAINT chk_total_unit_cost
  CHECK (total_unit_cost_cents = po_unit_cost_cents + landed_cost_cents);

-- qty_remaining cannot go negative
ALTER TABLE inventory_lots
  ADD CONSTRAINT chk_qty_on_hand_non_negative
  CHECK (qty_on_hand >= 0);

-- qty_received is immutable (enforced at application level, not DB)
```

---

## 3. How Lots Are Created

### Trigger: Receiving Order Close

When `receiving.service.ts` calls `inventoryCore.receiveInventory()`, a cost lot is created for each receiving line.

#### Cost Resolution Waterfall

```
1. Look up PO line → purchase_order_lines.unit_cost_cents (per variant unit)
2. Convert to per-piece: po_unit_cost_cents = unit_cost_cents / units_per_variant
3. Look up landed cost:
   a. If inbound_shipment_id is set AND shipment costs are finalized:
      → landed_cost_cents = allocated_cost_for_this_lot / qty_received_pieces
      → cost_status = 'finalized'
   b. If inbound_shipment_id is set BUT costs NOT finalized:
      → landed_cost_cents = estimated_allocated_cost / qty_received_pieces
      → cost_status = 'estimated'
   c. If no shipment linked:
      → landed_cost_cents = 0
      → cost_status = 'finalized' (no landed cost to wait on)
4. total_unit_cost_cents = po_unit_cost_cents + landed_cost_cents
```

#### Landed Cost Allocation

Shipment costs are allocated to lots via `shipment_cost_allocations`, which already exist. The allocation flows:

```
shipment_costs (N cost rows per shipment: freight, duty, brokerage, customs, platform_fees)
  → shipment_cost_allocations (one per cost × shipment_line)
      allocation_method: by_weight | by_value | by_volume | by_unit_count
      allocation_basis_value / allocation_basis_total → share_percent → allocated_cents
  → inbound_shipment_lines.allocated_cost_cents (sum of all cost allocations for that line)
  → landed_unit_cost_cents = allocated_cost_cents / qty_shipped (per piece)
```

The existing `shipment_cost_allocations` table and `landed_cost_snapshots` table handle this. The COGS engine reads the result.

#### Function Signature: `createCostLot()`

```typescript
// In InventoryLotService (lots.service.ts)

async createCostLot(params: {
  productVariantId: number;
  warehouseLocationId: number;
  qtyPieces: number;              // Total pieces received
  poLineId: number | null;        // FK to purchase_order_lines
  poUnitCostCents: number;        // Raw PO cost per piece
  inboundShipmentId: number | null;
  landedCostCents: number;        // Allocated landed cost per piece
  costStatus: 'estimated' | 'finalized';
  receivingOrderId: number | null;
  purchaseOrderId: number | null;
  notes?: string;
}): Promise<InventoryLot>
```

**Implementation notes:**
- `total_unit_cost_cents` is computed: `poUnitCostCents + landedCostCents`
- `qty_received` is set to `qtyPieces` (immutable — historical record)
- `qty_on_hand` starts at `qtyPieces`
- `received_at` = `new Date()` (FIFO ordering)
- Lot number: existing `LOT-YYYYMMDD-###` generator

---

## 4. FIFO Depletion

### 4.1 Depletion on Shipment (Order Fulfilled)

When `inventoryCore.recordShipment()` fires (triggered by ShipStation webhook via `shipstation.service.ts`):

```
For each order line item shipped:
  1. Query active lots for that variant, ordered by received_at ASC (FIFO)
  2. Consume qty from oldest lot first:
     - Decrement qty_on_hand
     - If lot qty_on_hand reaches 0 → set status = 'depleted'
  3. Record consumption in order_item_costs:
     - { orderId, orderItemId, inventoryLotId, qty, unitCostCents, totalCostCents }
  4. COGS for this line = SUM(qty × total_unit_cost_cents) across consumed lots
```

#### Cross-Lot Consumption Example

```
Lot #1: 500 pieces @ $0.012/pc (received 2026-01-15)
Lot #2: 800 pieces @ $0.014/pc (received 2026-02-20)

Order ships 700 pieces:
  → Take 500 from Lot #1 (depleted) → 500 × $0.012 = $6.00
  → Take 200 from Lot #2 (300 remaining) → 200 × $0.014 = $2.80
  → Total COGS = $8.80
  → Weighted avg COGS/piece = $0.01257
```

#### Function Signature: `consumeLotsForShipment()`

```typescript
// In InventoryLotService (lots.service.ts)

async consumeLotsForShipment(params: {
  productVariantId: number;
  warehouseLocationId: number;
  qty: number;                    // Pieces to consume
  orderId: number;
  orderItemId: number;
}): Promise<{
  allocations: Array<{
    lotId: number;
    lotNumber: string;
    qty: number;
    unitCostCents: number;
    totalCostCents: number;
    costStatus: 'estimated' | 'finalized';
  }>;
  totalCogsCents: number;
}>
```

**This replaces the current `shipFromLots()` and `pickFromLots()` methods**, which don't record `total_unit_cost_cents` (they use `unitCostCents` which is just the PO cost, not landed).

### 4.2 Reservation (FIFO)

When `reserveForOrder()` is called:

```
1. Query active lots for that variant, ordered by received_at ASC
2. Increment qty_reserved on oldest lots first
3. Available = qty_on_hand - qty_reserved - qty_picked
4. On shipment: qty_reserved decremented, qty_on_hand decremented
```

**Existing `reserveFromLots()` is correct** — no changes needed. It already does FIFO reservation.

### 4.3 Unreserve (Reverse FIFO)

When an order is cancelled:

```
1. Query lots with qty_reserved > 0, ordered by received_at DESC (newest first)
2. Decrement qty_reserved from newest lots first
```

**Existing `releaseFromLots()` is correct** — no changes needed.

### 4.4 Case Break

Case breaks do **not** create new cost lots. The cost engine is piece-level.

**Scenario:** Break 1 case of 10,000 Easy Glide Penny Sleeves into 100 packs of 100.

```
Before:
  Lot #5: variant=CS-PS-STD-C10000, qty_on_hand=1, total_unit_cost_cents=$120.00/case

After break (handled by break-assembly.service.ts):
  Lot #5: qty_on_hand=0, status='depleted'
  New Lot #6: variant=CS-PS-STD-P100, qty_on_hand=100,
              total_unit_cost_cents=$1.20/pack (same per-piece cost: $0.012)
```

**Key insight:** The per-piece cost ($0.012) is preserved. The lot's `total_unit_cost_cents` is recalculated for the new variant's UOM:

```
new_total_unit_cost = source_lot.total_unit_cost_cents / source_units_per_variant × dest_units_per_variant
= $120.00 / 10000 × 100 = $1.20/pack
```

**Modification needed in `transferLots()`:** Currently creates a new lot with weighted average cost. For case breaks, it should carry forward the **exact source lot cost** scaled to the destination UOM, not average across lots.

#### Function Signature: `breakLotCost()`

```typescript
// In InventoryLotService (lots.service.ts) — NEW

async breakLotCost(params: {
  sourceVariantId: number;
  destVariantId: number;
  sourceLocationId: number;
  destLocationId: number;
  sourceQty: number;              // Variant units consumed (e.g., 1 case)
  destQty: number;                // Variant units produced (e.g., 100 packs)
  sourceUnitsPerVariant: number;  // e.g., 10000 pieces/case
  destUnitsPerVariant: number;    // e.g., 100 pieces/pack
}): Promise<void>
```

### 4.5 Inventory Adjustments (Cycle Count / Manual)

**Negative adjustments** (shrinkage, damage, count variance):
- Consume from **newest lot first** (reverse FIFO)
- Rationale: if something is wrong, it's most likely the most recently received stock (miscounted, damaged in receiving, etc.)
- The existing `adjustLots()` method consumes from oldest first — **this needs to change to newest-first for negative adjustments**

**Positive adjustments** (found stock):
- Create a new lot with `cost_status = 'estimated'` and `po_unit_cost_cents = 0`
- If a cost can be inferred (e.g., cycle count reconciliation against known PO), set it
- Otherwise, leave at 0 — it will be the oldest lot consumed next (FIFO), so it minimally distorts COGS

#### Function Signature Change: `adjustLots()`

```typescript
// MODIFIED — reverse FIFO for negative adjustments

async adjustLots(params: {
  productVariantId: number;
  warehouseLocationId: number;
  qtyDelta: number;
  notes?: string;
  costCents?: number;             // Optional: known cost for positive adjustments
}): Promise<void>
// Negative: consume from NEWEST lots first (ORDER BY received_at DESC)
// Positive: create lot with costCents or 0
```

---

## 5. Integration Points

### 5.1 Receiving (`receiving.service.ts`) — MODIFY

**Current behavior:** Calls `inventoryCore.receiveInventory()` which calls `lotService.createLot()` with a single `unitCostCents`.

**New behavior:** Pass full cost breakdown:

```typescript
// In receiving.service.ts close() method

// Before calling inventoryCore.receiveInventory():
let poUnitCostCents = 0;
let landedCostCents = 0;
let costStatus: 'estimated' | 'finalized' = 'finalized';
let poLineId: number | null = null;

// 1. Get PO line cost
if (line.purchaseOrderLineId) {
  const poLine = await storage.getPurchaseOrderLine(line.purchaseOrderLineId);
  if (poLine) {
    poLineId = poLine.id;
    const variant = await storage.getProductVariantById(line.productVariantId);
    const unitsPerVariant = variant?.unitsPerVariant ?? 1;
    poUnitCostCents = poLine.unitCostCents / unitsPerVariant; // Convert to per-piece
  }
}

// 2. Get landed cost
if (order.inboundShipmentId) {
  const landedSnapshot = await shipmentTracking.getLandedCostForPoLine(line.purchaseOrderLineId);
  if (landedSnapshot !== null) {
    // Landed cost is already per-piece from the snapshot
    landedCostCents = landedSnapshot - poUnitCostCents; // Snapshot includes PO cost
    costStatus = 'finalized';
  } else {
    // Shipment costs not finalized — use estimated
    const estimatedLanded = await shipmentTracking.getEstimatedLandedCost(line.purchaseOrderLineId);
    landedCostCents = estimatedLanded ?? 0;
    costStatus = 'estimated';
  }
}

await inventoryCore.receiveInventory({
  productVariantId: line.productVariantId,
  warehouseLocationId: line.putawayLocationId,
  qty: qtyToAdd,
  poLineId,
  poUnitCostCents,
  landedCostCents,
  costStatus,
  // ... existing params
});
```

**Changes to `inventoryCore.receiveInventory()` signature:**

```typescript
async receiveInventory(params: {
  // ... existing params ...
  poLineId?: number;                    // NEW
  poUnitCostCents?: number;             // NEW (replaces unitCostCents)
  landedCostCents?: number;             // NEW
  costStatus?: 'estimated' | 'finalized'; // NEW
}): Promise<void>
```

### 5.2 Shipment (`shipstation.service.ts`) — MODIFY

**Current behavior:** Calls `inventoryCore.recordShipment()` → `lotService.shipFromLots()`. The ship function depletes lots but doesn't create `order_item_costs` entries with landed cost.

**New behavior:** After shipment is recorded, create detailed COGS entries:

```typescript
// In shipstation.service.ts webhook handler, after inventory update:

// The inventoryCore.recordShipment() now calls
// lotService.consumeLotsForShipment() which:
// 1. Depletes lots FIFO
// 2. Creates order_item_costs entries with total_unit_cost_cents (not just PO cost)
// 3. Returns total COGS for the line
```

**Changes to `inventoryCore.recordShipment()`:**

```typescript
async recordShipment(params: {
  // ... existing params ...
}): Promise<{
  cogsCents: number;  // NEW — total COGS for this shipment line
}>
```

Internally, `recordShipment` now calls `consumeLotsForShipment()` instead of the separate `shipFromLots()` + `pickFromLots()` flow.

### 5.3 Inbound Shipment Cost Finalization (`shipment-tracking.service.ts`) — MODIFY

**Current behavior:** When shipment costs are finalized, `landed_cost_snapshots` are created/updated.

**New behavior:** Additionally update all affected `inventory_lots`:

#### Function Signature: `finalizeShipmentCosts()`

```typescript
// NEW function in shipment-tracking.service.ts (or cost.service.ts)

async finalizeShipmentCosts(inboundShipmentId: number): Promise<{
  lotsUpdated: number;
  totalCostAdjustmentCents: number;
}>
```

**Logic:**

```
1. Get all shipment_cost_allocations for this shipment
2. For each inbound_shipment_line:
   a. Sum allocated_cents across all cost types
   b. landed_unit_cost_cents = total_allocated / qty_shipped (per piece)
3. Find all inventory_lots WHERE inbound_shipment_id = this shipment
4. For each lot:
   a. Update landed_cost_cents = new per-piece landed cost
   b. Update total_unit_cost_cents = po_unit_cost_cents + landed_cost_cents
   c. Set cost_status = 'finalized'
5. Log the cost change for audit (optional: cost_adjustment_log)
```

**Important:** If lots have already been partially or fully consumed (some shipped orders used estimated costs), those `order_item_costs` entries retain the estimated cost at time of shipment. This is correct — COGS is locked at time of sale. Only **remaining inventory** gets the updated cost.

**Optional (Phase 2):** Create a `cost_adjustments` table to track the delta between estimated and finalized costs for financial reporting.

### 5.4 Inventory Core (`core.service.ts`) — MODIFY

**`receiveInventory()`:**
- Accept new params: `poLineId`, `poUnitCostCents`, `landedCostCents`, `costStatus`
- Pass them through to `lotService.createCostLot()`

**`recordShipment()`:**
- Replace `lotService.shipFromLots()` with `lotService.consumeLotsForShipment()`
- Return COGS result

**`adjustInventory()`:** (existing adjust methods)
- Negative: call `lotService.adjustLots()` with reverse FIFO
- Positive: call `lotService.adjustLots()` which creates a new lot

### 5.5 ATP Service — NO CHANGE

ATP doesn't care about costs. No modifications.

### 5.6 Channel Sync — NO CHANGE

Sync doesn't care about costs. No modifications.

---

## 6. Reporting

### 6.1 Inventory Valuation Report

**Existing:** `InventoryLotService.getInventoryValuation()` — returns sum of `qty_on_hand × unit_cost_cents`.

**Enhanced:**

```typescript
async getInventoryValuation(filters?: {
  productId?: number;
  warehouseId?: number;
  costStatus?: 'estimated' | 'finalized';
}): Promise<{
  total: {
    qty: number;
    valueCents: number;
    estimatedValueCents: number;    // Lots with cost_status='estimated'
    finalizedValueCents: number;    // Lots with cost_status='finalized'
  };
  byVariant: Array<{
    productVariantId: number;
    sku: string | null;
    productName: string | null;
    qty: number;
    avgTotalUnitCostCents: number;  // Weighted avg total_unit_cost
    avgPoUnitCostCents: number;     // Weighted avg PO cost
    avgLandedCostCents: number;     // Weighted avg landed cost
    valueCents: number;             // qty × total_unit_cost
    estimatedValueCents: number;
    finalizedValueCents: number;
    lotCount: number;
  }>;
}>
```

**SQL:**

```sql
SELECT
  il.product_variant_id,
  pv.sku,
  p.name AS product_name,
  SUM(il.qty_on_hand) AS qty,
  ROUND(SUM(il.qty_on_hand * il.total_unit_cost_cents) / NULLIF(SUM(il.qty_on_hand), 0), 4)
    AS avg_total_unit_cost_cents,
  SUM(il.qty_on_hand * il.total_unit_cost_cents) AS value_cents,
  SUM(CASE WHEN il.cost_status = 'estimated'
      THEN il.qty_on_hand * il.total_unit_cost_cents ELSE 0 END)
    AS estimated_value_cents,
  SUM(CASE WHEN il.cost_status = 'finalized'
      THEN il.qty_on_hand * il.total_unit_cost_cents ELSE 0 END)
    AS finalized_value_cents,
  COUNT(*) AS lot_count
FROM inventory_lots il
JOIN product_variants pv ON pv.id = il.product_variant_id
JOIN products p ON p.id = pv.product_id
WHERE il.status = 'active'
  AND il.qty_on_hand > 0
GROUP BY il.product_variant_id, pv.sku, p.name
ORDER BY value_cents DESC;
```

### 6.2 COGS Report

#### Per Order

```typescript
async getOrderCogs(orderId: number): Promise<{
  orderId: number;
  lines: Array<{
    orderItemId: number;
    sku: string;
    qtyShipped: number;
    revenueCents: number;
    cogsCents: number;
    grossProfitCents: number;
    marginPercent: number;
    lotBreakdown: Array<{
      lotId: number;
      lotNumber: string;
      qty: number;
      unitCostCents: number;
      totalCostCents: number;
      costStatus: 'estimated' | 'finalized';
    }>;
  }>;
  totalRevenueCents: number;
  totalCogsCents: number;
  totalGrossProfitCents: number;
  overallMarginPercent: number;
}>
```

**SQL:**

```sql
SELECT
  oic.order_id,
  oic.order_item_id,
  oic.inventory_lot_id,
  il.lot_number,
  oic.qty,
  oic.unit_cost_cents,
  oic.total_cost_cents,
  il.cost_status
FROM order_item_costs oic
JOIN inventory_lots il ON il.id = oic.inventory_lot_id
WHERE oic.order_id = $1
ORDER BY oic.order_item_id, il.received_at;
```

#### Per Period

```typescript
async getPeriodCogs(params: {
  startDate: Date;
  endDate: Date;
  groupBy?: 'day' | 'week' | 'month';
}): Promise<{
  periods: Array<{
    period: string;
    totalRevenueCents: number;
    totalCogsCents: number;
    grossProfitCents: number;
    marginPercent: number;
    orderCount: number;
  }>;
  total: {
    revenueCents: number;
    cogsCents: number;
    grossProfitCents: number;
    marginPercent: number;
  };
}>
```

### 6.3 Lot Detail Report

```typescript
async getLotDetail(productVariantId: number): Promise<{
  variant: { id: number; sku: string; name: string };
  lots: Array<{
    lotId: number;
    lotNumber: string;
    poNumber: string | null;
    poUnitCostCents: number;
    landedCostCents: number;
    totalUnitCostCents: number;
    qtyReceived: number;
    qtyOnHand: number;
    qtyReserved: number;
    ageDays: number;
    costStatus: 'estimated' | 'finalized';
    receivedAt: Date;
  }>;
  summary: {
    totalQtyOnHand: number;
    weightedAvgCostCents: number;
    totalValueCents: number;
    oldestLotAgeDays: number;
    estimatedLotCount: number;
    finalizedLotCount: number;
  };
}>
```

---

## 7. Retroactive Load

### Strategy: One-Time Backfill Script

Every product variant with current inventory gets a single "opening balance" lot.

#### Step 1: Identify Variants with Inventory

```sql
SELECT DISTINCT
  il.product_variant_id,
  il.warehouse_location_id,
  il.variant_qty
FROM inventory_levels il
WHERE il.variant_qty > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots lot
    WHERE lot.product_variant_id = il.product_variant_id
      AND lot.warehouse_location_id = il.warehouse_location_id
      AND lot.status = 'active'
      AND lot.po_unit_cost_cents > 0  -- Exclude existing zero-cost legacy lots
  );
```

#### Step 2: Resolve Cost Per Variant

```
For each variant:
  1. Find most recent purchase_order_line for this variant
     WHERE status IN ('received', 'closed', 'partially_received')
     ORDER BY fully_received_date DESC NULLS LAST, created_at DESC
     → po_unit_cost_cents = unit_cost_cents

  2. If PO line found AND linked to an inbound_shipment via inbound_shipment_lines:
     → Look up landed_cost_snapshots for that PO line
     → landed_cost_cents = landed_unit_cost_cents - po_unit_cost_cents
     → If no snapshot: landed_cost_cents = 0

  3. If no PO line found:
     → Use product_variants.last_cost_cents as po_unit_cost_cents
     → If last_cost_cents is null: use product_variants.avg_cost_cents
     → If both null: po_unit_cost_cents = 0 (flagged for manual review)
     → landed_cost_cents = 0

  4. total_unit_cost_cents = po_unit_cost_cents + landed_cost_cents
```

#### Step 3: Create Opening Balance Lots

```typescript
async backfillCostLots(): Promise<{
  created: number;
  skipped: number;
  zeroCosted: number;
  details: Array<{
    variantId: number;
    sku: string;
    qty: number;
    poUnitCostCents: number;
    landedCostCents: number;
    totalUnitCostCents: number;
    costSource: 'po_line' | 'last_cost' | 'avg_cost' | 'none';
  }>;
}>
```

**For each variant:**

```typescript
const lot = await lotService.createCostLot({
  productVariantId: variant.id,
  warehouseLocationId: level.warehouseLocationId,
  qtyPieces: level.variantQty,
  poLineId: mostRecentPoLine?.id ?? null,
  poUnitCostCents: resolvedPoCost,
  inboundShipmentId: linkedShipmentId ?? null,
  landedCostCents: resolvedLandedCost,
  costStatus: 'estimated',  // Always estimated — these are approximations
  receivingOrderId: null,
  purchaseOrderId: mostRecentPo?.id ?? null,
  notes: `Backfill opening balance — cost source: ${costSource}`,
});
```

#### Step 4: Handle Existing Zero-Cost Legacy Lots

The current `createLegacyLots()` method created lots with `unitCostCents = 0`. These need to be updated:

```sql
-- Update existing legacy lots with resolved costs
UPDATE inventory_lots
SET
  po_unit_cost_cents = $resolved_po_cost,
  landed_cost_cents = $resolved_landed_cost,
  total_unit_cost_cents = $resolved_po_cost + $resolved_landed_cost,
  cost_status = 'estimated',
  notes = COALESCE(notes, '') || ' | Cost backfilled from ' || $cost_source
WHERE id = $legacy_lot_id
  AND po_unit_cost_cents = 0
  AND status = 'active';
```

#### Step 5: Validation

```sql
-- After backfill, verify no active inventory lacks a costed lot
SELECT
  il.product_variant_id,
  pv.sku,
  il.variant_qty,
  COALESCE(lot_sum.total_qty, 0) AS lot_qty,
  il.variant_qty - COALESCE(lot_sum.total_qty, 0) AS gap
FROM inventory_levels il
JOIN product_variants pv ON pv.id = il.product_variant_id
LEFT JOIN (
  SELECT product_variant_id, SUM(qty_on_hand) AS total_qty
  FROM inventory_lots
  WHERE status = 'active'
  GROUP BY product_variant_id
) lot_sum ON lot_sum.product_variant_id = il.product_variant_id
WHERE il.variant_qty > 0
  AND il.variant_qty != COALESCE(lot_sum.total_qty, 0);
```

### Worked Example: Backfill for CS-PS-STD (Easy Glide Penny Sleeves)

```
Current inventory: 45,000 pieces across locations
  - BIN-A-01: 20,000 pieces (variant: CS-PS-STD-P100, pack of 100)
  - BIN-B-05: 25,000 pieces (variant: CS-PS-STD-C10000, case of 10,000)

Most recent PO: PO-20260215-001
  - Line: CS-PS-STD-C10000, unit_cost_cents = 12000 ($120.00/case)
  - Linked shipment: SHP-20260201-001
  - Freight allocated: $250.00, Duty: $180.00, Brokerage: $75.00
  - Total landed cost: $505.00 for 50,000 pieces = $0.0101/piece

Cost resolution:
  - po_unit_cost_cents = $120.00 / 10000 = $0.0120/piece
  - landed_cost_cents = $0.0101/piece
  - total_unit_cost_cents = $0.0120 + $0.0101 = $0.0221/piece

Created lots:
  Lot BACKFILL-001: variant=CS-PS-STD-P100, location=BIN-A-01
    qty_on_hand=200 (packs), po_unit_cost=$1.20/pack, landed=$1.01/pack
    total_unit_cost=$2.21/pack, cost_status='estimated'

  Lot BACKFILL-002: variant=CS-PS-STD-C10000, location=BIN-B-05
    qty_on_hand=2.5 (cases... wait — inventory_levels stores variant units)

Actually: inventory_levels.variant_qty for cases = 2 or 3 (whole cases).
The per-piece cost is the same: $0.0221/piece.
For case variant: total_unit_cost_cents = $0.0221 × 10000 = $221.00/case.
For pack variant: total_unit_cost_cents = $0.0221 × 100 = $2.21/pack.
```

---

## 8. Existing `inventory_lots` Table — Gap Analysis

### Columns That Match the Spec

| Existing Column | Spec Field | Match? |
|----------------|------------|--------|
| `id` | `lot_id` | ✅ Exact |
| `lot_number` | `lot_number` | ✅ Exact |
| `product_variant_id` | `product_variant_id` | ✅ Exact |
| `warehouse_location_id` | (location tracking) | ✅ Exact |
| `receiving_order_id` | `receiving_order_id` | ✅ Exact |
| `purchase_order_id` | `purchase_order_id` | ✅ Exact (header-level) |
| `inbound_shipment_id` | `inbound_shipment_id` | ✅ Exact |
| `unit_cost_cents` | `po_unit_cost_cents` | ⚠️ Rename — currently stores raw PO cost |
| `qty_on_hand` | `qty_remaining` in spec | ✅ Equivalent (use `qty_on_hand` name) |
| `qty_reserved` | `qty_reserved` | ✅ Exact |
| `qty_picked` | — | ✅ Keep (WMS workflow state) |
| `received_at` | `received_at` | ✅ Exact (FIFO key) |
| `status` | `status` | ✅ Exact |
| `cost_provisional` | `cost_status` | ⚠️ Replace integer flag with enum |
| `notes` | `notes` | ✅ Exact |
| `created_at` | `created_at` | ✅ Exact |
| `expiry_date` | — | ✅ Keep (future use) |

### Columns That Need to Be Added

| New Column | Type | Purpose |
|-----------|------|---------|
| `po_line_id` | `INTEGER FK` | Links to specific PO line (not just PO header) |
| `landed_cost_cents` | `DOUBLE PRECISION DEFAULT 0` | Allocated freight/duty/customs per piece |
| `total_unit_cost_cents` | `DOUBLE PRECISION DEFAULT 0` | po_unit_cost + landed_cost = COGS per piece |
| `qty_received` | `INTEGER DEFAULT 0` | Immutable original qty (for cost allocation math) |
| `cost_status` | `VARCHAR(20) DEFAULT 'estimated'` | `estimated` or `finalized` |

### Columns That Need Renaming

| Current | New | Reason |
|---------|-----|--------|
| `unit_cost_cents` | `po_unit_cost_cents` | Clarify this is raw PO cost, not total |

### Decision: Use Existing Table

**Use the existing `inventory_lots` table.** Reasons:

1. The table already has 54 rows with active lot associations
2. The `InventoryLotService` already references it throughout `core.service.ts`
3. The `order_item_costs` table already FKs to it
4. Schema is close enough — just need 5 new columns + 1 rename
5. Migration is additive, not destructive

### Migration SQL

```sql
-- Step 1: Add new columns
ALTER TABLE inventory_lots
  ADD COLUMN po_line_id INTEGER REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  ADD COLUMN landed_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN total_unit_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN qty_received INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cost_status VARCHAR(20) NOT NULL DEFAULT 'estimated';

-- Step 2: Rename unit_cost_cents → po_unit_cost_cents
ALTER TABLE inventory_lots RENAME COLUMN unit_cost_cents TO po_unit_cost_cents;

-- Step 3: Backfill total_unit_cost for existing rows (no landed cost known yet)
UPDATE inventory_lots
SET total_unit_cost_cents = po_unit_cost_cents,
    qty_received = qty_on_hand + qty_picked,  -- Best approximation
    cost_status = CASE
      WHEN cost_provisional = 1 THEN 'estimated'
      WHEN po_unit_cost_cents > 0 THEN 'finalized'
      ELSE 'estimated'
    END;

-- Step 4: Add indexes
CREATE INDEX idx_lots_variant_fifo
  ON inventory_lots (product_variant_id, received_at ASC)
  WHERE status = 'active';

CREATE INDEX idx_lots_shipment
  ON inventory_lots (inbound_shipment_id)
  WHERE inbound_shipment_id IS NOT NULL;

CREATE INDEX idx_lots_po_line
  ON inventory_lots (po_line_id)
  WHERE po_line_id IS NOT NULL;

CREATE INDEX idx_lots_cost_status
  ON inventory_lots (cost_status)
  WHERE status = 'active';

-- Step 5: Add check constraint
ALTER TABLE inventory_lots
  ADD CONSTRAINT chk_total_unit_cost
  CHECK (ABS(total_unit_cost_cents - (po_unit_cost_cents + landed_cost_cents)) < 0.01);
```

### Schema Update (`inventory.schema.ts`)

```typescript
export const inventoryLots = pgTable("inventory_lots", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  lotNumber: varchar("lot_number", { length: 50 }).notNull(),
  productVariantId: integer("product_variant_id").notNull()
    .references(() => productVariants.id),
  warehouseLocationId: integer("warehouse_location_id").notNull()
    .references(() => warehouseLocations.id),
  receivingOrderId: integer("receiving_order_id")
    .references(() => receivingOrders.id, { onDelete: "set null" }),
  purchaseOrderId: integer("purchase_order_id")
    .references(() => purchaseOrders.id, { onDelete: "set null" }),
  poLineId: integer("po_line_id")                              // NEW
    .references(() => purchaseOrderLines.id, { onDelete: "set null" }),
  inboundShipmentId: integer("inbound_shipment_id"),

  // Cost fields
  poUnitCostCents: doublePrecision("po_unit_cost_cents")       // RENAMED
    .notNull().default(0),
  landedCostCents: doublePrecision("landed_cost_cents")        // NEW
    .notNull().default(0),
  totalUnitCostCents: doublePrecision("total_unit_cost_cents") // NEW
    .notNull().default(0),

  // Quantity fields
  qtyReceived: integer("qty_received").notNull().default(0),   // NEW
  qtyOnHand: integer("qty_on_hand").notNull().default(0),
  qtyReserved: integer("qty_reserved").notNull().default(0),
  qtyPicked: integer("qty_picked").notNull().default(0),

  receivedAt: timestamp("received_at").notNull(),
  costStatus: varchar("cost_status", { length: 20 })           // NEW
    .notNull().default("estimated"),
  costProvisional: integer("cost_provisional")                 // KEEP for backward compat
    .notNull().default(0),
  status: varchar("status", { length: 20 }).default("active"),
  expiryDate: timestamp("expiry_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

---

## 9. Replen Alignment

### Current State

The replen system (`replen.service.ts`) picks source cases based on location ordering and replen rules. It does **not** consider lot age.

### Phase 1 (Now): FIFO-Approximate

The replen system currently uses `sourcePriority: 'fifo'` in replen tier defaults, which orders by **location sequence** (aisle/bay/level). If cases are put away in chronological order (oldest in front), this roughly aligns with FIFO cost.

**No code changes needed for Phase 1.** Document the assumption:

> **Assumption:** Cases are put away in chronological order within reserve locations. FIFO location ordering approximates FIFO cost ordering. This is valid as long as the warehouse follows standard put-away discipline (new stock goes behind old stock or into higher-numbered bins).

### Phase 2 (Future): Lot-Aware Replen

When replen picks a case to break:

```
1. Find all active lots for the source variant at reserve locations
2. Order by received_at ASC (oldest first)
3. Prefer the case from the oldest lot
4. If multiple locations have the same lot, prefer the standard location priority
```

**Function signature (Phase 2):**

```typescript
// In replen.service.ts — future enhancement

async selectSourceForReplen(params: {
  productId: number;
  sourceVariantId: number;
  sourceLocationType: string;
}): Promise<{
  locationId: number;
  lotId: number;
  lotAge: number;
}>
// Returns: location with the oldest lot for FIFO-aligned replen
```

---

## 10. Worked Examples

### Example 1: Full Lifecycle — UV Shield Toploaders

**PO Creation:**

```
PO-20260301-001 to YiFeng Packaging (Vendor #1)
  Line 1: CS-TL-35PT-C2000 (Case of 2,000 toploaders)
    order_qty: 10 cases
    unit_cost_cents: 20000 ($200.00/case)
    → per-piece cost: $200.00 / 2000 = $0.10/piece
```

**Inbound Shipment:**

```
SHP-20260301-001 (Ocean freight from Shenzhen)
  Shipment line: CS-TL-35PT-C2000, qty_shipped: 10 cases (20,000 pieces)
  weight: 120 kg

  Costs:
    freight:    $800.00 (estimated, allocation: by_weight)
    duty:       $250.00 (estimated, 12.5% ad valorem)
    brokerage:  $125.00 (actual, flat fee, allocation: by_unit_count)
    customs:    $45.00  (actual, allocation: by_value)

  Total shipment costs: $1,220.00
  This is the only product on the shipment, so 100% allocated.
  Landed cost per piece: $1,220.00 / 20,000 = $0.061/piece
```

**Receiving:**

```
RCV-20260315-001: Receive 10 cases of CS-TL-35PT-C2000
  → Creates Lot LOT-20260315-001:
    product_variant_id: CS-TL-35PT-C2000
    po_line_id: 1
    po_unit_cost_cents: $200.00/case (stored as $0.10/piece × 2000 = $200.00 per variant unit)
    landed_cost_cents: $0.061/piece × 2000 = $122.00/case
    total_unit_cost_cents: $200.00 + $122.00 = $322.00/case
    qty_received: 10 cases
    qty_on_hand: 10 cases
    cost_status: 'estimated' (freight not yet finalized)
```

**Case Break:**

```
Break 1 case → 20 packs of 100 (CS-TL-35PT-P100)
  → Lot LOT-20260315-001: qty_on_hand = 9 cases
  → New Lot LOT-20260316-001:
    product_variant_id: CS-TL-35PT-P100
    po_unit_cost_cents: $0.10 × 100 = $10.00/pack
    landed_cost_cents: $0.061 × 100 = $6.10/pack
    total_unit_cost_cents: $16.10/pack
    qty_received: 20 packs
    qty_on_hand: 20 packs
    cost_status: 'estimated' (inherited from source lot)
```

**Order Ships:**

```
Order #5501: 3 packs of CS-TL-35PT-P100
  → Consume from Lot LOT-20260316-001 (FIFO, only lot):
    3 packs × $16.10/pack = $48.30 COGS

  → order_item_costs entry:
    { orderId: 5501, orderItemId: X, inventoryLotId: LOT-20260316-001,
      qty: 3, unitCostCents: 1610, totalCostCents: 4830 }

  → Lot LOT-20260316-001: qty_on_hand = 17 packs
```

**Revenue vs. COGS:**

```
Retail price: $8.99 per pack of 100 toploaders
Revenue: 3 × $8.99 = $26.97
COGS: $48.30
Gross margin: -$21.33 (negative — this is the case variant cost,
  need to ensure we're using per-piece throughout!)
```

**Wait — correction.** The costs should be stored per-piece in the lot, and then the lot's display cost is calculated by multiplying by the variant's `units_per_variant`. Let me re-do:

```
Lot LOT-20260316-001 (variant: CS-TL-35PT-P100, units_per_variant=100):
  po_unit_cost_cents: $0.10/piece (stored raw)
  landed_cost_cents: $0.061/piece (stored raw)
  total_unit_cost_cents: $0.161/piece (stored raw)

Order ships 3 packs (= 300 pieces):
  COGS = 300 pieces × $0.161/piece = $48.30

Revenue: 3 × $8.99 = $26.97
Gross margin: $26.97 - $48.30 = -$21.33

Hmm, that's negative. Let me use real Card Shellz pricing.
UV Shield 35pt Toploaders sell for ~$9.99/pack of 25 on the site.
Let me adjust the example.
```

**Corrected Example with Real Pricing:**

```
Product: CS-TL-35PT (UV Shield 35pt Toploaders)
Pack of 25: $9.99 retail
Case of 2,000: $200.00 wholesale from vendor

Per-piece cost: $200.00 / 2000 = $0.10/piece
Per-piece landed: $0.061/piece
Per-piece total COGS: $0.161/piece

Order: 3 packs of 25 (75 pieces total)
  COGS: 75 × $0.161 = $12.08
  Revenue: 3 × $9.99 = $29.97
  Gross profit: $17.89
  Margin: 59.7%
```

### Example 2: Multi-Lot FIFO Depletion — Easy Glide Penny Sleeves

```
Active lots for CS-PS-STD (per-piece):
  Lot #10: 5,000 pcs @ $0.012/pc (received 2026-01-15, finalized)
  Lot #11: 8,000 pcs @ $0.014/pc (received 2026-02-20, estimated)
  Lot #12: 10,000 pcs @ $0.013/pc (received 2026-03-10, estimated)

Order ships 7,000 pieces (as 70 packs of 100):
  → Lot #10: consume 5,000 pcs → 5,000 × $0.012 = $60.00 (lot depleted)
  → Lot #11: consume 2,000 pcs → 2,000 × $0.014 = $28.00 (6,000 remaining)
  → Total COGS: $88.00
  → Effective per-piece: $0.01257

order_item_costs entries:
  { lotId: 10, qty: 5000, unitCostCents: 0.012, totalCostCents: 60.00, costStatus: 'finalized' }
  { lotId: 11, qty: 2000, unitCostCents: 0.014, totalCostCents: 28.00, costStatus: 'estimated' }
```

### Example 3: Shipment Cost Finalization

```
Lot #11 was created with estimated landed cost:
  po_unit_cost_cents: $0.012/piece
  landed_cost_cents: $0.002/piece (estimated)
  total_unit_cost_cents: $0.014/piece
  cost_status: 'estimated'

Freight invoice arrives: actual freight = $300 (was estimated $250)
  → Recompute allocation for this shipment line
  → New landed_cost_cents: $0.0025/piece
  → New total_unit_cost_cents: $0.012 + $0.0025 = $0.0145/piece

Update Lot #11:
  landed_cost_cents: $0.0025
  total_unit_cost_cents: $0.0145
  cost_status: 'finalized'

NOTE: The 2,000 pieces already shipped in Example 2 retain $0.014/piece
in their order_item_costs. Only the remaining 6,000 pieces get the
updated $0.0145 cost. This is correct — COGS is locked at time of sale.
```

### Example 4: Cycle Count Adjustment

```
Cycle count finds 200 fewer pieces of CS-ARM-STD than expected.

Active lots (newest first for negative adjustment):
  Lot #20: 3,000 pcs @ $0.075/pc (received 2026-03-05)
  Lot #19: 5,000 pcs @ $0.070/pc (received 2026-02-01)

Adjustment: -200 pieces
  → Lot #20: consume 200 pcs → qty_on_hand = 2,800
  → inventory_transactions: {
      type: 'adjustment',
      variant_qty_delta: -200,
      unit_cost_cents: 0.075,  // From the lot consumed
      inventory_lot_id: 20,
      cycle_count_id: X
    }
```

---

## Summary of Code Changes

### Modified Files

| File | Change |
|------|--------|
| `shared/schema/inventory.schema.ts` | Add `poLineId`, `landedCostCents`, `totalUnitCostCents`, `qtyReceived`, `costStatus` columns. Rename `unitCostCents` → `poUnitCostCents`. |
| `server/modules/inventory/lots.service.ts` | New `createCostLot()`. Modify `adjustLots()` for reverse-FIFO on negatives. New `consumeLotsForShipment()`. New `breakLotCost()`. Modify `getInventoryValuation()`. |
| `server/modules/inventory/core.service.ts` | Update `receiveInventory()` params. Update `recordShipment()` to use `consumeLotsForShipment()`. |
| `server/modules/procurement/receiving.service.ts` | Resolve PO line cost + landed cost before calling `receiveInventory()`. |
| `server/modules/procurement/shipment-tracking.service.ts` | New `finalizeShipmentCosts()` — updates lots when costs are finalized. |
| `server/modules/oms/shipstation.service.ts` | No direct changes — it calls `recordShipment()` which handles lot depletion internally. |
| `server/modules/inventory/break-assembly.service.ts` | Use `breakLotCost()` for cost-aware case breaks. |

### New Files

| File | Purpose |
|------|---------|
| `server/modules/inventory/cogs-report.service.ts` | COGS reporting: per-order, per-period, margin analysis |
| `server/scripts/backfill-cost-lots.ts` | One-time retroactive load script |

### No Changes Needed

| File | Reason |
|------|--------|
| `server/modules/inventory/atp.service.ts` | ATP doesn't care about costs |
| `server/modules/channels/*` | Channel sync doesn't care about costs |
| `server/modules/inventory/replen.service.ts` | Phase 1: location-based FIFO is sufficient |
| `server/modules/inventory/cycle-count.service.ts` | Uses `adjustLots()` which handles reverse-FIFO |

---

*End of spec.*
