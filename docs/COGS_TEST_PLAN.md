# COGS System Test Plan

Covers Phases 1–8 of the FIFO COGS remediation. Organized into four tiers:
automated unit tests (already written), integration tests (need real DB),
production validation queries (read-only checks against live data), and
manual smoke tests (UI + API walkthrough).

---

## Tier 1: Automated Unit Tests (DONE — 115 tests passing)

These run in CI with mocked DB. Already committed.

| File | Tests | What it proves |
|------|-------|----------------|
| `cost-resolver.test.ts` | 10 | Waterfall: explicit → last_paid → standard → avg → unresolved. Return cost lookup from order COGS. |
| `record-shipment-no-dead-cogs.test.ts` | 2 | Ship-time does NOT write to dead `order_line_costs` ledger. |
| `transfer-preserves-layers.test.ts` | 2 | Transfer creates one dest lot per source layer (cost identity preserved). |
| `break-assembly-cost.test.ts` | 2 | Break/assembly propagates source cost ÷ target qty to new lots. |
| `pick-idempotency-unpick.test.ts` | 3 | Pick is idempotent (no duplicate COGS). Unpick reverses COGS + restores lot qty. |
| `recost-cascade.test.ts` | 3 | Landed cost change cascades to COGS rows. No-op when cost unchanged. |
| `invoice-variance-reconcile.test.ts` | 3 | Invoice price ≠ PO price → lots updated → COGS cascaded. |
| `backfill-lot-costs.test.ts` | 3 | SKU→cost upload stamps zero-cost lots, cascades. Invalid/unknown SKUs skipped. |
| `valuation-unified.test.ts` | 3 | Valuation uses `total_unit_cost_cents` (not just `unit_cost_cents`). Reports zero-cost + provisional flags. |
| Other existing tests | 84 | Reserve idempotency, receipt idempotency, freeze enforcement, ledger replay, etc. |

**Gap:** No unit test for `resolveReturnCost` fallback when order COGS is missing.
Add one test that returns empty from order_item_costs and verifies it falls
through to the standard waterfall.

---

## Tier 2: Integration Tests (need `ECHELON_TEST_DATABASE_URL`)

These must run against a real Postgres instance with the full schema. They
verify SQL correctness, FK constraints, transaction atomicity, and
concurrency behavior that mocks can't catch.

### 2.1 Receipt → Pick → Ship lifecycle

**Setup:** Create variant + location. Receive 10 units at $5.00 (500 cents).

| Step | Action | Assert |
|------|--------|--------|
| 1 | `receiveInventory(qty: 10, unitCostCents: 500)` | Lot created with `unit_cost_cents=500`, `total_unit_cost_cents=500`, `cost_source='explicit'` |
| 2 | `reserveForOrder(qty: 3, orderId: 1)` | Lot `qty_reserved` = 3 |
| 3 | `pickItem(qty: 3, orderId: 1, orderItemId: 1)` | `oms.order_item_costs` row: `unit_cost_cents=500`, `total_cost_cents=1500`, `inventory_lot_id` points to lot |
| 4 | `recordShipment(qty: 3)` | Lot `qty_picked` decremented. No write to `inventory.order_line_costs`. |
| 5 | Query `order_item_costs` for order 1 | Exactly 1 row, total=1500 |
| 6 | Call `getOrderCOGS(1)` | `totalCogsCents=1500`, 1 line item with correct lot breakdown |

### 2.2 Multi-lot FIFO ordering

**Setup:** Receive 3 lots at different times/costs:
- Lot A: 5 units @ $3.00 (received yesterday)
- Lot B: 5 units @ $4.00 (received today)
- Lot C: 5 units @ $5.00 (received tomorrow — future date for test determinism)

| Step | Action | Assert |
|------|--------|--------|
| 1 | Pick 7 units for order 1 | Lot A fully consumed (5 @ $3), Lot B partially consumed (2 @ $4). Total COGS = 5×300 + 2×400 = 2300 |
| 2 | Pick 5 units for order 2 | Lot B remaining (3 @ $4), Lot C partially consumed (2 @ $5). Total COGS = 3×400 + 2×500 = 2200 |
| 3 | Valuation query | Remaining: 3 units of Lot C @ $5 = 1500 |

### 2.3 Landed cost cascade

**Setup:** Receive 10 units via PO at $5.00. Pick 6 for an order.

| Step | Action | Assert |
|------|--------|--------|
| 1 | `updateLotLandedCost(lotId, 200)` | Lot `landed_cost_cents=200`, `total_unit_cost_cents=700` |
| 2 | Query `order_item_costs` for picked order | `unit_cost_cents` updated from 500 → 700 for all 6 units. `total_cost_cents` = 4200 |
| 3 | `cost_adjustment_log` row exists | Old=500, new=700, delta=200 |

### 2.4 Invoice variance reconciliation

**Setup:** PO with 10 units @ $5.00, received into lots. Pick 4 for an order.

| Step | Action | Assert |
|------|--------|--------|
| 1 | `reconcileInvoiceVariance({ poId, variantId, invoiceUnitCostCents: 550 })` | All lots updated: `unit_cost_cents` → 550 + landed addon |
| 2 | COGS rows for picked order | `unit_cost_cents` updated to new total. Delta = (550-500) × 4 = 200 |
| 3 | `cost_adjustment_log` entries | One per lot, reason='invoice_variance' |

### 2.5 Transfer preserves FIFO layers (real SQL)

**Setup:** Location A has Lot 1 (5 @ $3) and Lot 2 (5 @ $5).

| Step | Action | Assert |
|------|--------|--------|
| 1 | `transferLots(fromA, toB, qty: 7)` | Location B gets 2 new lots: one with 5 @ $3, one with 2 @ $5 |
| 2 | Source lots | Lot 1 depleted (qty=0), Lot 2 has 3 remaining |
| 3 | Dest lot `received_at` | Matches original source lots (not transfer timestamp) |

### 2.6 Break/assembly cost propagation (real SQL)

**Setup:** Case variant (parent) has 10 units @ $60.00. Pack variant (child)
has `base_unit_multiplier = 10`.

| Step | Action | Assert |
|------|--------|--------|
| 1 | `breakVariant(sourceQty: 2)` → 20 packs | Source lots consumed: 2 × 6000 = 12000 total. Target lot: 20 units @ 600 each |
| 2 | `assembleVariant(sourceQty: 10)` → 1 case | Source consumed: 10 × 600 = 6000. Target lot: 1 @ 6000 |

### 2.7 Return cost resolution

**Setup:** Pick 3 units @ $5.00 for order 1 (creates COGS row with unit_cost=500).

| Step | Action | Assert |
|------|--------|--------|
| 1 | `processReturn(orderId: 1, qty: 1, condition: 'sellable')` | New lot created with `unit_cost_cents=500` (from original COGS) |
| 2 | `processReturn(orderId: 1, qty: 1, condition: 'damaged')` | Lot created then immediately adjusted out. `consumedCostCents=500` |
| 3 | Return for order with no COGS data | Falls back to cost resolver waterfall (not $0) |

### 2.8 Pick idempotency (real SQL)

**Setup:** Receive 10 @ $5.00.

| Step | Action | Assert |
|------|--------|--------|
| 1 | `pickFromLots(orderId: 1, orderItemId: 1, qty: 3)` | 1 COGS row, lot qty_picked=3 |
| 2 | `pickFromLots(orderId: 1, orderItemId: 1, qty: 3)` — retry | Same 1 COGS row returned. Lot qty_picked still 3 (not 6) |
| 3 | `unpickFromLots(orderId: 1, orderItemId: 1, qty: 3)` | COGS row deleted, lot qty restored |

### 2.9 Backfill SKU→cost upload

**Setup:** 3 variants, each with 2 zero-cost lots.

| Step | Action | Assert |
|------|--------|--------|
| 1 | `backfillLotCostsBySku([{ sku: 'A', unitCostCents: 300 }])` | Both lots for variant A get `unit_cost_cents=300`, `total_unit_cost_cents=300` |
| 2 | Any COGS rows referencing those lots | Updated with new cost |
| 3 | `product_variants.last_cost_cents` | Updated to 300 |
| 4 | Call again with same SKU | No-op (lots already have cost, no zero-cost lots found) |

### 2.10 Concurrent pick (race condition)

**Setup:** 5 units in one lot.

| Step | Action | Assert |
|------|--------|--------|
| 1 | Start tx1: `pickFromLots(orderId: 1, qty: 3)` — hold open | |
| 2 | Start tx2: `pickFromLots(orderId: 2, qty: 3)` — should block or fail | tx2 gets at most 2 units (5-3=2 remaining), OR tx2 waits for tx1 commit then gets 2 |
| 3 | Both commit | Total picked ≤ 5. No negative inventory. |

### 2.11 Valuation accuracy

**Setup:** Multiple variants, mixed costs including zero-cost lots.

| Step | Action | Assert |
|------|--------|--------|
| 1 | Call `lots.getInventoryValuation()` | `total.valueCents` matches `SUM(qty_on_hand * COALESCE(total_unit_cost_cents, unit_cost_cents))` from direct SQL |
| 2 | Call `cogs.getInventoryValuation()` | `totalValueCents` matches same SQL. `zeroCostQty` matches `SUM(qty_on_hand) WHERE cost=0` |
| 3 | Both endpoints agree on total value | Cross-check |

---

## Tier 3: Production Validation Queries (read-only, run against prod)

These are SQL queries to run against the live Heroku database BEFORE and
AFTER the backfill to validate data integrity. **All read-only.**

### 3.1 Pre-backfill baseline

```sql
-- How many lots have zero cost?
SELECT
  COUNT(*) AS zero_cost_lots,
  SUM(qty_on_hand) AS zero_cost_qty,
  COUNT(*) FILTER (WHERE qty_on_hand > 0) AS active_zero_cost_lots
FROM inventory.inventory_lots
WHERE COALESCE(total_unit_cost_cents, unit_cost_cents, 0) = 0;

-- Zero-cost lots by variant (top 20)
SELECT
  pv.sku, p.name, COUNT(*) AS lots, SUM(il.qty_on_hand) AS qty
FROM inventory.inventory_lots il
JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
JOIN catalog.products p ON p.id = pv.product_id
WHERE COALESCE(il.total_unit_cost_cents, il.unit_cost_cents, 0) = 0
  AND il.status = 'active' AND il.qty_on_hand > 0
GROUP BY pv.sku, p.name
ORDER BY qty DESC
LIMIT 20;

-- Current COGS ledger size and zero-cost rows
SELECT
  COUNT(*) AS total_cogs_rows,
  COUNT(*) FILTER (WHERE unit_cost_cents = 0) AS zero_cost_cogs_rows,
  SUM(total_cost_cents) AS total_cogs_value
FROM oms.order_item_costs;

-- Dead ledger should be empty (Phase 1 verification)
SELECT COUNT(*) AS dead_ledger_rows FROM inventory.order_line_costs;

-- Total inventory valuation (current)
SELECT
  SUM(qty_on_hand) AS total_qty,
  SUM(qty_on_hand * COALESCE(total_unit_cost_cents, unit_cost_cents, 0)) AS total_value_cents,
  SUM(qty_on_hand * unit_cost_cents) AS value_without_landed,
  SUM(qty_on_hand * COALESCE(total_unit_cost_cents, unit_cost_cents, 0))
    - SUM(qty_on_hand * unit_cost_cents) AS landed_cost_delta
FROM inventory.inventory_lots
WHERE status = 'active' AND qty_on_hand > 0;
```

### 3.2 COGS ledger integrity

```sql
-- COGS rows with orphaned lot references (lot deleted or missing)
SELECT oic.id, oic.inventory_lot_id, oic.order_item_id
FROM oms.order_item_costs oic
LEFT JOIN inventory.inventory_lots il ON il.id = oic.inventory_lot_id
WHERE oic.inventory_lot_id IS NOT NULL AND il.id IS NULL;

-- COGS rows where unit_cost doesn't match lot's current cost
-- (expected after recosting — these should have been cascaded)
SELECT
  oic.id AS cogs_id,
  oic.unit_cost_cents AS cogs_cost,
  COALESCE(il.total_unit_cost_cents, il.unit_cost_cents) AS lot_cost,
  oic.qty
FROM oms.order_item_costs oic
JOIN inventory.inventory_lots il ON il.id = oic.inventory_lot_id
WHERE oic.unit_cost_cents != COALESCE(il.total_unit_cost_cents, il.unit_cost_cents);

-- Duplicate COGS rows (same order_item_id + lot_id, sign of failed idempotency)
SELECT order_item_id, inventory_lot_id, COUNT(*) AS dupes
FROM oms.order_item_costs
WHERE order_item_id IS NOT NULL AND inventory_lot_id IS NOT NULL
GROUP BY order_item_id, inventory_lot_id
HAVING COUNT(*) > 1;

-- Orders with COGS but no WMS fulfillment (orphaned cost)
SELECT oic.id, oic.order_item_id, wi.order_id AS wms_order_id
FROM oms.order_item_costs oic
JOIN wms.order_items wi ON wi.id = oic.order_item_id
JOIN wms.orders wo ON wo.id = wi.order_id
LEFT JOIN oms.oms_orders oo ON oo.id = wo.oms_fulfillment_order_id::bigint
WHERE oo.id IS NULL;
```

### 3.3 Cost consistency checks

```sql
-- Lots where unit_cost_cents and total_unit_cost_cents diverge unexpectedly
-- (total should be >= unit_cost if there's landed cost)
SELECT id, lot_number, unit_cost_cents, total_unit_cost_cents, landed_cost_cents,
       (unit_cost_cents + COALESCE(landed_cost_cents, 0)) AS expected_total
FROM inventory.inventory_lots
WHERE status = 'active'
  AND total_unit_cost_cents IS NOT NULL
  AND total_unit_cost_cents != (unit_cost_cents + COALESCE(landed_cost_cents, 0))
LIMIT 20;

-- Provisional lots that should have been finalized
SELECT COUNT(*) AS stale_provisional
FROM inventory.inventory_lots
WHERE cost_provisional = 1
  AND status = 'active'
  AND received_at < NOW() - INTERVAL '30 days';

-- Lots with cost_source breakdown
SELECT
  COALESCE(cost_source, 'null') AS source,
  COUNT(*) AS lots,
  SUM(qty_on_hand) AS qty,
  SUM(qty_on_hand * COALESCE(total_unit_cost_cents, unit_cost_cents, 0)) AS value_cents
FROM inventory.inventory_lots
WHERE status = 'active' AND qty_on_hand > 0
GROUP BY cost_source
ORDER BY value_cents DESC;
```

### 3.4 Post-backfill verification

Run after `backfillLotCostsBySku`:

```sql
-- Zero-cost lot count should have dropped
SELECT COUNT(*) AS remaining_zero_cost
FROM inventory.inventory_lots
WHERE COALESCE(total_unit_cost_cents, unit_cost_cents, 0) = 0
  AND status = 'active' AND qty_on_hand > 0;

-- Backfilled lots should have cost_source = 'backfill'
SELECT cost_source, COUNT(*) AS lots, SUM(qty_on_hand) AS qty
FROM inventory.inventory_lots
WHERE cost_source = 'backfill' AND status = 'active'
GROUP BY cost_source;

-- COGS rows updated by cascade (compare total_cost_cents before and after)
-- Save a snapshot of order_item_costs BEFORE the backfill for comparison:
-- CREATE TEMP TABLE cogs_snapshot AS SELECT id, unit_cost_cents, total_cost_cents FROM oms.order_item_costs;
-- Then after:
-- SELECT s.id, s.unit_cost_cents AS old, oic.unit_cost_cents AS new, oic.total_cost_cents
-- FROM cogs_snapshot s JOIN oms.order_item_costs oic ON oic.id = s.id
-- WHERE s.unit_cost_cents != oic.unit_cost_cents;

-- Valuation delta
-- Compare to the pre-backfill valuation number.
SELECT
  SUM(qty_on_hand * COALESCE(total_unit_cost_cents, unit_cost_cents, 0)) AS new_total_value
FROM inventory.inventory_lots
WHERE status = 'active' AND qty_on_hand > 0;
```

### 3.5 Finance analytics cross-check

```sql
-- Compare COGS from order_item_costs vs what finance dashboard shows
-- Pick a known date range (e.g. last 30 days)
SELECT
  SUM(oic.total_cost_cents) AS cogs_from_ledger
FROM oms.order_item_costs oic
JOIN wms.order_items wi ON wi.id = oic.order_item_id
JOIN wms.orders wo ON wo.id = wi.order_id
JOIN oms.oms_orders oo ON oo.id = wo.oms_fulfillment_order_id::bigint
WHERE oo.ordered_at >= NOW() - INTERVAL '30 days'
  AND oo.cancelled_at IS NULL;

-- Compare to finance summary endpoint for same range
-- GET /api/finance/summary?from=<30d-ago>&to=<now>
-- cogsCents.value should match the SQL above

-- Spot-check 5 individual orders: COGS from API vs direct SQL
SELECT
  oo.id, oo.external_order_number,
  oo.total_cents - oo.refund_amount_cents AS net_revenue,
  COALESCE(cogs.total, 0) AS cogs,
  (oo.total_cents - oo.refund_amount_cents) - COALESCE(cogs.total, 0) AS margin
FROM oms.oms_orders oo
LEFT JOIN LATERAL (
  SELECT SUM(oic.total_cost_cents) AS total
  FROM oms.order_item_costs oic
  JOIN wms.order_items wi ON wi.id = oic.order_item_id
  JOIN wms.orders wo ON wo.id = wi.order_id
  WHERE wo.oms_fulfillment_order_id = oo.id::text
) cogs ON true
WHERE oo.cancelled_at IS NULL
ORDER BY oo.ordered_at DESC
LIMIT 5;
```

---

## Tier 4: Manual Smoke Tests (UI + API)

Run these against the dev/staging environment after deployment. Each test
should be performed by a human clicking through the UI or calling the API.

### 4.1 Happy-path order lifecycle

1. Create a PO with 2 line items (different SKUs, different costs)
2. Receive against the PO → verify lots created with correct costs
3. Sync an order from Shopify (or create manually)
4. Reserve → Pick → Ship the order
5. Open Finance → Order Detail → verify COGS breakdown matches lot costs
6. Open `/api/cogs/valuation` → verify the picked units are no longer in valuation

### 4.2 Landed cost finalization

1. Create inbound shipment with freight charges
2. Receive inventory (lots appear with `costProvisional=1`)
3. Finalize landed costs on shipment
4. Verify lot `total_unit_cost_cents` = PO cost + allocated landed
5. If any of those units were already picked, verify COGS rows updated

### 4.3 Invoice variance

1. Create PO at $5.00/unit, receive
2. Create vendor invoice at $5.50/unit (price discrepancy auto-detected)
3. Approve invoice
4. Verify lots updated to $5.50 + landed
5. Verify any picked COGS rows cascaded

### 4.4 Manual backfill

1. Open `/api/cogs/valuation` → note `zeroCostQty`
2. POST `/api/cogs/backfill-costs` with 2-3 SKUs from your CSV
3. Verify response: `processed`, `lotsUpdated`, `cogsRowsUpdated`
4. Re-check valuation → `zeroCostQty` should have decreased
5. Check a specific order that used those lots → COGS should be non-zero now

### 4.5 Transfer

1. Transfer 5 units of a multi-lot SKU from Location A → Location B
2. Verify destination has individual lots (not one collapsed lot)
3. Verify each dest lot has the same cost as its source layer

### 4.6 Break/assembly

1. Break 1 case (@ $60) into 10 packs
2. Verify 10 pack lots created at $6 each
3. Assemble 10 packs back into 1 case
4. Verify case lot at $60

### 4.7 Return

1. Pick and ship an order
2. Process a sellable return for 1 unit
3. Verify returned lot has original COGS cost (not $0)
4. Process a damaged return for 1 unit
5. Verify lot was created then adjusted out (net zero qty, cost captured)

### 4.8 Unpick (order cancellation)

1. Pick an order (don't ship)
2. Cancel the order → unpick
3. Verify COGS row deleted, lot qty restored
4. Verify the units are available for a new order

### 4.9 Dashboard reporting

1. Open Finance Summary → verify COGS, margin, margin % are populated
2. Drill into channel breakdown → verify per-channel COGS
3. Drill into individual order → verify line-level COGS with lot breakdown
4. Open Inventory Valuation report → verify total matches expectations
5. Cross-check: valuation report total vs `/api/cogs/valuation` total

---

## Risk Areas & Known Gaps

| Risk | Severity | Mitigation |
|------|----------|------------|
| **84% zero-cost lots** — backfill is the critical path | HIGH | Dry-run flag on backfill endpoint. Small batch first. Pre/post valuation comparison. |
| `total_unit_cost_cents` column was raw-SQL only before Phase 1 — some lots may have NULL instead of 0 | MEDIUM | COALESCE fallback handles this. Validate with Tier 3 query 3.3. |
| `oms_fulfillment_order_id` is TEXT, joined to `oms_orders.id` as BIGINT | LOW | Existing prod behavior, not new. But casting (`::bigint`, `::text`) could silently drop non-numeric values. |
| Concurrent picks on same lot — row-level lock coverage | MEDIUM | Tier 2 test 2.10. Current code uses `FOR UPDATE` in reserves but not in picks. |
| Invoice variance cascades run inside invoice approval — failure could block approval | MEDIUM | Currently wrapped in try/catch (non-blocking). But silent failure means stale COGS. Monitor `cost_adjustment_log`. |
| Break/assembly rounding — $7.00 cost across 3 target units = $2.33 each, $0.01 lost | LOW | Acceptable for integer cents. Document the rounding policy. |

---

## Execution Order

1. **Run Tier 1** (automated) — `npx vitest run server/modules/inventory/__tests__/` ✅ Already passing
2. **Run Tier 3.1–3.3** (prod read-only) — establish baseline before any writes
3. **Deploy to staging** — run Tier 4 smoke tests
4. **Deploy to production** — run Tier 3.1 baseline, then small-batch backfill (Tier 4.4), then Tier 3.4 verification
5. **Full backfill** — load remaining SKU→cost CSV, run Tier 3.4 + 3.5 again
6. **Integration tests (Tier 2)** — set up test DB, add to CI pipeline for ongoing regression coverage
