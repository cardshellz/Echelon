/**
 * C6 Phase 3 tests: Inventory truth on unhappy pick paths.
 *
 * Tests for:
 * - D-PICKGUARD: pickItem re-checks parent order status under lock
 * - D-LEDGER: item status NOT set to completed when deduction fails
 * - D-QGUARD: recordShipment dedup constraint handling
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PICKING_SRC = readFileSync(
  fileURLToPath(
    new URL("../../picking.use-cases.ts", import.meta.url),
  ),
  "utf8",
);

const INVENTORY_SRC = readFileSync(
  fileURLToPath(
    new URL(
      "../../../inventory/application/inventory.use-cases.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);

// ─── D-PICKGUARD structural checks ─────────────────────────────────

describe("D-PICKGUARD: pickItem order-state guard", () => {
  it("locks the parent order row with FOR UPDATE before deducting", () => {
    const txBlock = PICKING_SRC.substring(
      PICKING_SRC.indexOf('status === "completed" && beforeItem.status !== "completed"'),
      PICKING_SRC.indexOf("const txInventoryCore"),
    );
    expect(txBlock).toContain("FROM wms.orders");
    expect(txBlock).toContain("FOR UPDATE");
  });

  it("checks warehouse_status before allowing deduction", () => {
    const txBlock = PICKING_SRC.substring(
      PICKING_SRC.indexOf("D-PICKGUARD"),
      PICKING_SRC.indexOf("Lock the item row"),
    );
    expect(txBlock).toContain("warehouse_status");
    expect(txBlock).toContain("cancelled");
    expect(txBlock).toContain("shipped");
  });

  it("throws IntegrityError for cancelled orders", () => {
    const guardBlock = PICKING_SRC.substring(
      PICKING_SRC.indexOf("blockedStatuses"),
      PICKING_SRC.indexOf("Lock the item row"),
    );
    expect(guardBlock).toContain('["cancelled", "shipped"]');
    expect(guardBlock).toContain("IntegrityError");
  });

  it("order lock precedes item lock (correct lock ordering)", () => {
    const txBlock = PICKING_SRC.substring(
      PICKING_SRC.indexOf('status === "completed" && beforeItem.status !== "completed"'),
      PICKING_SRC.indexOf("alreadyCompleted: true"),
    );
    const orderLockPos = txBlock.indexOf("FROM wms.orders");
    const itemLockPos = txBlock.indexOf("FROM wms.order_items");
    expect(orderLockPos).toBeGreaterThan(-1);
    expect(itemLockPos).toBeGreaterThan(-1);
    expect(orderLockPos).toBeLessThan(itemLockPos);
  });
});

// ─── D-LEDGER structural checks ────────────────────────────────────

describe("D-LEDGER: item status conditional on deduction success", () => {
  it("status assignment references deductResult.success", () => {
    const statusBlock = PICKING_SRC.substring(
      PICKING_SRC.indexOf("D-LEDGER"),
      PICKING_SRC.indexOf(".update(orderItems)"),
    );
    expect(statusBlock).toContain("deductResult.success");
    expect(statusBlock).toContain("beforeItem.status");
  });

  it("does NOT unconditionally set status to 'completed'", () => {
    const txBlock = PICKING_SRC.substring(
      PICKING_SRC.indexOf("D-LEDGER"),
      PICKING_SRC.indexOf("alreadyCompleted: false"),
    );
    expect(txBlock).toContain("deductResult.success ? status : beforeItem.status");
  });

  it("only sets pickedQuantity on successful deduction", () => {
    const dLedgerPos = PICKING_SRC.indexOf("D-LEDGER");
    const updateBlock = PICKING_SRC.substring(
      dLedgerPos,
      PICKING_SRC.indexOf(".update(orderItems)", dLedgerPos),
    );
    expect(updateBlock).toContain("if (deductResult.success)");
  });
});

// ─── D-QGUARD structural checks ────────────────────────────────────

describe("D-QGUARD: recordShipment DB-level dedup", () => {
  it("catches unique constraint violation (23505) on ship_dedup", () => {
    const recordShipmentBlock = INVENTORY_SRC.substring(
      INVENTORY_SRC.indexOf("async recordShipment"),
      INVENTORY_SRC.indexOf("async adjustInventory") > 0
        ? INVENTORY_SRC.indexOf("async adjustInventory")
        : INVENTORY_SRC.length,
    );
    expect(recordShipmentBlock).toContain('err?.code === "23505"');
    expect(recordShipmentBlock).toContain("ship_dedup");
  });

  it("still has the application-level SELECT dedup as fast-path", () => {
    const recordShipmentBlock = INVENTORY_SRC.substring(
      INVENTORY_SRC.indexOf("async recordShipment"),
      INVENTORY_SRC.indexOf("async adjustInventory") > 0
        ? INVENTORY_SRC.indexOf("async adjustInventory")
        : INVENTORY_SRC.length,
    );
    expect(recordShipmentBlock).toContain("transaction_type = 'ship'");
    expect(recordShipmentBlock).toContain("reference_id =");
    expect(recordShipmentBlock).toContain("order_item_id =");
  });

  it("migration exists for the unique index", () => {
    const fs = require("node:fs");
    const migrationPath =
      "/home/user/Echelon/migrations/0570_shipment_inventory_txn_dedup.sql";
    const exists = fs.existsSync(migrationPath);
    expect(exists).toBe(true);

    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("uq_inventory_transactions_ship_dedup");
    expect(sql).toContain("transaction_type = 'ship'");
    // Corrected key: scoped to real shipment-backed rows (shipment_id column),
    // not the reference_id fallback which legitimately repeats for partial ships.
    expect(sql).toContain("shipment_id IS NOT NULL");
    expect(sql).toContain("order_item_id IS NOT NULL");
  });
});
