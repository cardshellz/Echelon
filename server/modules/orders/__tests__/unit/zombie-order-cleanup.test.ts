/**
 * Queue reads retain held demand and exclude terminal/empty pick work without
 * changing lifecycle state. The shared progress owner decides cancellation
 * and readiness from recorded lines; startup cleanup remains separately covered.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveWmsPickingProgress, type WmsPickingProgressLine } from "@shared/wms-picking-progress";

const STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);

describe("Zombie order prevention", () => {
  describe("pick queue EXISTS guard", () => {
    const existsSection = STORAGE_SRC.slice(
      STORAGE_SRC.indexOf("Exclude orders with zero shippable items"),
      STORAGE_SRC.indexOf("Historical orders are read separately"),
    );

    it("filters by quantity > 0 so zero-quantity items don't keep orders visible", () => {
      expect(existsSection).toContain("COALESCE(oi.quantity, 0) > 0");
    });

    it("excludes terminal item statuses", () => {
      expect(existsSection).toContain("NOT IN ('cancelled', 'completed', 'short')");
    });

    it("requires items to need shipping", () => {
      expect(existsSection).toContain("COALESCE(oi.requires_shipping, 1) <> 0");
    });

    // LINE-ITEM-HOLD-DESIGN.md P2: holding a line splits it onto its own held
    // shipment and pickItem rejects it ('line_on_hold'). Before this, the held
    // line still satisfied the guard, so the order stayed in the pick queue and
    // holding a line could not get it off the floor.
    it("excludes held lines so a held line cannot keep an order in the pick queue", () => {
      expect(existsSection).toContain("COALESCE(oi.on_hold, false) = false");
    });
  });

  // A held line is still owed: it ships when released. The terminal-transition
  // paths must keep counting it as outstanding work, or an order whose only
  // remaining line is held would be completed and the held line lost.
  describe("held lines still block terminal transitions", () => {
    it("pick queue reads preserve held work without changing lifecycle state", () => {
      const read = STORAGE_SRC.slice(STORAGE_SRC.indexOf("async getPickQueueOrders("),
        STORAGE_SRC.indexOf("async createOrderWithItems("));
      expect(read).toContain("COALESCE(oi.on_hold, false) = true");
      expect(read).not.toMatch(/completeOrder\(|cancelOrder\(|transitionOrderStatus\(|UPDATE wms\.orders/);
    });

    it("the startup zombie repair counts held lines as pending shippable", () => {
      const indexSrc = readFileSync(resolve(__dirname, "../../../../index.ts"), "utf-8");
      const repair = indexSrc.slice(
        indexSrc.indexOf("Zombie orders: active warehouse_status"),
        indexSrc.indexOf("Shipped-order cleanup error"),
      );
      expect(repair).toContain("oi.status NOT IN ('cancelled', 'completed', 'short')");
      expect(repair).not.toMatch(/on_hold/);
    });
  });

  describe("updateOrderProgress handles edge cases", () => {
    const progressSection = STORAGE_SRC.slice(
      STORAGE_SRC.indexOf("async updateOrderProgress("),
      STORAGE_SRC.indexOf("async holdOrder("),
    );

    const project = (lines: WmsPickingProgressLine[]) => deriveWmsPickingProgress({
      currentStatus: "in_progress", postPickStatus: "ready_to_ship", lines, additionalBlockers: [],
    });
    const item: WmsPickingProgressLine = { id: 1, sku: "SKU", quantity: 2, pickedQuantity: 0,
      requiresShipping: true, onHold: false, status: "pending", inventoryTracking: true,
      catalogProductId: 1, productId: 10, location: "A1" };

    it("delegates to the transaction-owned projection without fabricating completion for empty or held-only demand", () => {
      expect(progressSection).toContain("db.transaction(tx => reconcileWmsPickingProgress(tx, orderId,");
      expect(project([])).toMatchObject({ pickedCount: 0, completeNonShipping: false });
      expect(project([{ ...item, onHold: true }])).toMatchObject({ status: "in_progress", completeNonShipping: false });
    });

    it("transitions to cancelled only when every recorded item is cancelled", () => {
      expect(project([{ ...item, status: "cancelled" }])).toMatchObject({ status: "cancelled" });
      expect(project([{ ...item, status: "cancelled" }, { ...item, id: 2 }])).toMatchObject({ status: "in_progress" });
    });
  });
});

describe("Startup zombie repair", () => {
  const INDEX_SRC = readFileSync(
    resolve(__dirname, "../../../../index.ts"),
    "utf-8",
  );

  const repairSection = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Zombie orders: active warehouse_status"),
    INDEX_SRC.indexOf("Shipped-order cleanup error"),
  );

  it("targets orders in active pick-queue statuses", () => {
    expect(repairSection).toContain("'ready', 'in_progress', 'partially_shipped', 'ready_to_ship'");
  });

  it("cancels orders with zero items", () => {
    expect(repairSection).toContain("THEN 'cancelled'");
  });

  it("completes orders where items exist but all are terminal", () => {
    expect(repairSection).toContain("THEN 'completed'");
  });

  it("checks for pending shippable items with quantity > 0", () => {
    expect(repairSection).toContain("COALESCE(oi.quantity, 0) > 0");
  });
});
