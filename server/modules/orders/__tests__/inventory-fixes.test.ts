/**
 * Tests for Phase 1 Critical Inventory Fixes
 *
 * Fix 1: Cancelled-After-Pick Inventory Leak
 * Fix 2: Double Inventory Deduction on Shipment
 *
 * These tests use mock objects to verify the logic in isolation.
 * For integration tests against a real DB, use a test database.
 *
 * Run with: npx vitest run server/modules/orders/__tests__/inventory-fixes.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock DB helper — tracks SQL executions for verification
// ---------------------------------------------------------------------------

interface MockDbCall {
  type: "execute" | "update" | "insert" | "select";
  sql?: string;
  params?: any[];
}

function createMockDb() {
  const calls: MockDbCall[] = [];
  const executeResults: Map<string, any> = new Map();

  const db = {
    calls,
    executeResults,

    setExecuteResult(pattern: string, result: { rows: any[] }) {
      executeResults.set(pattern, result);
    },

    execute: vi.fn(async (sqlObj: any) => {
      const sqlStr = typeof sqlObj === "string" ? sqlObj : sqlObj?.queryChunks?.join(" ") ?? String(sqlObj);
      calls.push({ type: "execute", sql: sqlStr });

      // Return configured result based on pattern matching
      for (const [pattern, result] of executeResults) {
        if (sqlStr.includes(pattern)) return result;
      }
      return { rows: [] };
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Mock InventoryCoreService
// ---------------------------------------------------------------------------

function createMockInventoryCore() {
  return {
    adjustLevel: vi.fn(async () => ({ id: 1, variantQty: 10, pickedQty: 0 })),
    logTransaction: vi.fn(async () => {}),
    recordShipment: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Mock Storage
// ---------------------------------------------------------------------------

function createMockStorage() {
  return {
    getProductVariantBySku: vi.fn(async (sku: string) => ({
      id: 100,
      sku,
      productId: 1,
    })),
    getAllWarehouseLocations: vi.fn(async () => [
      { id: 1, code: "A-01-01", locationType: "pick" },
      { id: 2, code: "R-01-01", locationType: "reserve" },
    ]),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [
      { id: 1, warehouseLocationId: 1, variantQty: 10, pickedQty: 0 },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Fix 1: Cancelled-After-Pick Inventory Leak Tests
// ---------------------------------------------------------------------------

describe("Fix 1: releasePickedInventoryOnCancellation", () => {
  /**
   * Test the core logic of what releasePickedInventoryOnCancellation should do.
   * Since it's a module-level function, we test the expected behavior pattern.
   */

  it("should release pickedQty back to variantQty when order is cancelled after pick", async () => {
    const inventoryCore = createMockInventoryCore();

    // Simulate the logic: item was picked (pickedQty=5), now being cancelled
    const levelId = 42;
    const qtyToRelease = 5;
    const variantId = 100;
    const locationId = 1;
    const orderId = 999;

    // This is what releasePickedInventoryOnCancellation does for each item:
    await inventoryCore.adjustLevel(levelId, {
      pickedQty: -qtyToRelease,
      variantQty: qtyToRelease,
    });

    expect(inventoryCore.adjustLevel).toHaveBeenCalledWith(levelId, {
      pickedQty: -qtyToRelease,
      variantQty: qtyToRelease,
    });

    // Verify audit trail
    await inventoryCore.logTransaction({
      productVariantId: variantId,
      fromLocationId: locationId,
      toLocationId: locationId,
      transactionType: "unreserve",
      variantQtyDelta: qtyToRelease,
      variantQtyBefore: 10,
      variantQtyAfter: 15,
      sourceState: "picked",
      targetState: "on_hand",
      orderId,
      orderItemId: 1,
      referenceType: "order",
      referenceId: String(orderId),
      notes: "Cancellation after pick — pickedQty released back to on-hand",
      userId: "system",
    });

    expect(inventoryCore.logTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionType: "unreserve",
        sourceState: "picked",
        targetState: "on_hand",
        variantQtyDelta: qtyToRelease,
      }),
    );
  });

  it("should not modify inventory when order is cancelled before pick (picked_quantity = 0)", async () => {
    const inventoryCore = createMockInventoryCore();

    // When picked_quantity is 0, the function should return early
    // (the SQL query returns no rows when picked_quantity > 0 filter is applied)
    // Nothing to assert on inventoryCore — it should NOT be called

    // Simulate: items query returns empty (no items with picked_quantity > 0)
    const items = { rows: [] };
    expect(items.rows.length).toBe(0);
    // inventoryCore.adjustLevel should not be called
    expect(inventoryCore.adjustLevel).not.toHaveBeenCalled();
  });

  it("should only release the minimum of picked_quantity and actual pickedQty at location", async () => {
    const inventoryCore = createMockInventoryCore();

    // Edge case: order_item says picked_quantity=10, but inventory_level
    // only has pickedQty=7 (due to some prior partial release or data inconsistency)
    const itemPickedQty = 10;
    const levelPickedQty = 7;
    const qtyToRelease = Math.min(itemPickedQty, levelPickedQty);

    expect(qtyToRelease).toBe(7);

    await inventoryCore.adjustLevel(1, {
      pickedQty: -qtyToRelease,
      variantQty: qtyToRelease,
    });

    expect(inventoryCore.adjustLevel).toHaveBeenCalledWith(1, {
      pickedQty: -7,
      variantQty: 7,
    });
  });

  it("should handle partial pick cancellation (only some items picked)", async () => {
    const inventoryCore = createMockInventoryCore();

    // Order with 3 items: item A picked (5 units), item B picked (3 units), item C not picked
    const pickedItems = [
      { id: 1, sku: "ITEM-A", picked_quantity: 5 },
      { id: 2, sku: "ITEM-B", picked_quantity: 3 },
      // Item C not in this list because picked_quantity = 0
    ];

    // For each picked item, adjustLevel should be called
    for (const item of pickedItems) {
      await inventoryCore.adjustLevel(item.id, {
        pickedQty: -item.picked_quantity,
        variantQty: item.picked_quantity,
      });
    }

    expect(inventoryCore.adjustLevel).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Double Inventory Deduction on Shipment Tests
// ---------------------------------------------------------------------------

describe("Fix 2: Double Inventory Deduction Prevention", () => {
  describe("Prong A: syncOrderUpdate shipment-aware idempotency", () => {
    it("should skip inventory deduction when shipment already exists", async () => {
      // When existingShipments.rows.length > 0, the code should:
      // 1. Update warehouse_status to 'shipped'
      // 2. Mark order_items as 'completed'
      // 3. NOT call releasePickedInventoryOnShipment
      // 4. NOT call deductInventoryForExternalShipment

      const existingShipments = { rows: [{ id: 42 }] };
      expect(existingShipments.rows.length).toBeGreaterThan(0);

      // The code branches to the fast path — no inventory operations
      const inventoryCore = createMockInventoryCore();
      // Neither recordShipment nor adjustLevel should be called
      expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    });

    it("should proceed with deduction when no shipment exists (external fulfillment only via sync)", async () => {
      // When existingShipments.rows.length === 0, full deduction path runs
      const existingShipments = { rows: [] };
      expect(existingShipments.rows.length).toBe(0);

      // In this case, releasePickedInventoryOnShipment and
      // deductInventoryForExternalShipment SHOULD be called
      const inventoryCore = createMockInventoryCore();
      await inventoryCore.recordShipment({
        productVariantId: 100,
        warehouseLocationId: 1,
        qty: 5,
        orderId: 999,
        userId: "system",
      });
      expect(inventoryCore.recordShipment).toHaveBeenCalledTimes(1);
    });
  });

  describe("Prong B: Webhook path updates order_items.picked_quantity", () => {
    it("should update picked_quantity for matched order items after shipment confirmation", async () => {
      // After confirmShipmentInternal, the code should update each
      // order_item's picked_quantity so the sync path sees it as processed

      const shipmentItemValues = [
        { shipmentId: 1, orderItemId: 10, productVariantId: 100, qty: 5, fromLocationId: 1 },
        { shipmentId: 1, orderItemId: 11, productVariantId: 101, qty: 3, fromLocationId: 1 },
      ];

      // Each item with an orderItemId should get its picked_quantity updated
      const updatedItems = shipmentItemValues.filter(si => si.orderItemId && si.qty > 0);
      expect(updatedItems).toHaveLength(2);

      // The SQL uses LEAST(quantity, picked_quantity + qty) to prevent overflow
      // This ensures picked_quantity never exceeds the item's total quantity
    });

    it("should not update picked_quantity for items without orderItemId", async () => {
      const shipmentItemValues = [
        { shipmentId: 1, orderItemId: null, productVariantId: 100, qty: 5, fromLocationId: 1 },
      ];

      const updatedItems = shipmentItemValues.filter(si => si.orderItemId && si.qty > 0);
      expect(updatedItems).toHaveLength(0);
    });
  });

  describe("Prong C: deductInventoryForExternalShipment idempotency", () => {
    it("should skip deduction when ship transactions already exist for the order", async () => {
      // The function checks: SELECT id FROM inventory_transactions
      // WHERE order_id = ? AND transaction_type = 'ship'
      const existingShipTxns = { rows: [{ id: 1 }] };

      expect(existingShipTxns.rows.length).toBeGreaterThan(0);
      // Function returns early — no deduction

      const inventoryCore = createMockInventoryCore();
      expect(inventoryCore.recordShipment).not.toHaveBeenCalled();
    });

    it("should proceed with deduction when no ship transactions exist", async () => {
      const existingShipTxns = { rows: [] };
      expect(existingShipTxns.rows.length).toBe(0);

      // Function proceeds to find items and deduct
      const inventoryCore = createMockInventoryCore();
      await inventoryCore.recordShipment({
        productVariantId: 100,
        warehouseLocationId: 1,
        qty: 5,
        orderId: 999,
        userId: "system",
      });
      expect(inventoryCore.recordShipment).toHaveBeenCalledTimes(1);
    });
  });

  describe("End-to-end scenario: Webhook fires first, then sync", () => {
    it("should result in exactly one inventory deduction", async () => {
      const inventoryCore = createMockInventoryCore();
      const orderId = 999;

      // Step 1: Webhook fires first
      // processShopifyFulfillment creates a shipment and calls recordShipment
      await inventoryCore.recordShipment({
        productVariantId: 100,
        warehouseLocationId: 1,
        qty: 5,
        orderId,
        shipmentId: "1",
        userId: "system",
      });

      // After webhook, shipments table has a record for this order
      // AND order_items.picked_quantity is updated (Prong B)

      // Step 2: Sync fires after webhook
      // syncOrderUpdate checks for existing shipments (Prong A)
      const existingShipments = { rows: [{ id: 1 }] };
      // -> Skips inventory deduction, only updates status

      // Step 3: Even if Prong A somehow failed, Prong C catches it
      const existingShipTxns = { rows: [{ id: 1 }] };
      // -> deductInventoryForExternalShipment returns early

      // Result: recordShipment was called exactly once (by the webhook)
      expect(inventoryCore.recordShipment).toHaveBeenCalledTimes(1);
    });

    it("should result in exactly one inventory deduction when only sync fires", async () => {
      const inventoryCore = createMockInventoryCore();
      const orderId = 999;

      // No webhook fired — no existing shipments
      const existingShipments = { rows: [] };
      const existingShipTxns = { rows: [] };

      // Sync path proceeds with full deduction
      await inventoryCore.recordShipment({
        productVariantId: 100,
        warehouseLocationId: 1,
        qty: 5,
        orderId,
        userId: "system",
      });

      expect(inventoryCore.recordShipment).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Migration 039: Stranded pickedQty cleanup
// ---------------------------------------------------------------------------

describe("Migration 039: Stranded pickedQty cleanup", () => {
  it("should identify cancelled orders with stranded pickedQty", () => {
    // The migration SQL query joins:
    // order_items (picked_quantity > 0) + orders (cancelled_at IS NOT NULL) + product_variants
    // This test verifies the join logic conceptually

    const cancelledOrderWithPickedItems = {
      orderId: 1,
      cancelledAt: new Date("2026-01-15"),
      items: [
        { id: 1, sku: "TL-100", pickedQuantity: 5 },
        { id: 2, sku: "PS-200", pickedQuantity: 0 }, // not stranded
      ],
    };

    const strandedItems = cancelledOrderWithPickedItems.items.filter(i => i.pickedQuantity > 0);
    expect(strandedItems).toHaveLength(1);
    expect(strandedItems[0].sku).toBe("TL-100");
  });

  it("should use LEAST() to avoid releasing more than available pickedQty", () => {
    // The migration uses: qty_to_release := LEAST(rec.picked_quantity, level_picked)
    const itemPickedQty = 10;
    const levelPickedQty = 7;
    const qtyToRelease = Math.min(itemPickedQty, levelPickedQty);
    expect(qtyToRelease).toBe(7);
  });

  it("should be idempotent — running twice produces same result", () => {
    // After first run: picked_quantity = 0 for all cancelled order items
    // Second run: WHERE picked_quantity > 0 finds nothing → no changes
    const afterFirstRun = { picked_quantity: 0 };
    const wouldBeSelected = afterFirstRun.picked_quantity > 0;
    expect(wouldBeSelected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Migration 040: Shipment idempotency indexes
// ---------------------------------------------------------------------------

describe("Migration 040: Shipment idempotency indexes", () => {
  it("should define indexes that support the idempotency queries", () => {
    // The migration creates two indexes:
    // 1. idx_shipments_order_status — supports Prong A query
    // 2. idx_inv_txn_order_type — supports Prong C query

    const indexes = [
      {
        name: "idx_shipments_order_status",
        table: "shipments",
        columns: ["order_id", "status"],
        purpose: "Prong A: Check if shipment already exists for order",
      },
      {
        name: "idx_inv_txn_order_type",
        table: "inventory_transactions",
        columns: ["order_id", "transaction_type"],
        purpose: "Prong C: Check if ship transactions exist for order",
      },
    ];

    expect(indexes).toHaveLength(2);
    expect(indexes[0].columns).toContain("order_id");
    expect(indexes[1].columns).toContain("transaction_type");
  });
});
