/**
 * Structural tests: orders with no pending shippable items must not stay
 * in active warehouse_status. Verifies the pick-queue EXISTS guard and
 * updateOrderProgress both handle zero-item / all-terminal-items cases.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);

describe("Zombie order prevention", () => {
  describe("pick queue EXISTS guard", () => {
    const existsSection = STORAGE_SRC.slice(
      STORAGE_SRC.indexOf("Exclude orders with zero shippable items"),
      STORAGE_SRC.indexOf("Completed orders: show for 24 hours"),
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
  });

  describe("updateOrderProgress handles edge cases", () => {
    const progressSection = STORAGE_SRC.slice(
      STORAGE_SRC.indexOf("async updateOrderProgress("),
      STORAGE_SRC.indexOf("async holdOrder("),
    );

    it("treats zero shippable items as allShippableDone", () => {
      expect(progressSection).toContain("shippableItems.length === 0");
    });

    it("transitions to cancelled when all items are cancelled", () => {
      expect(progressSection).toContain("allItemsCancelled");
      expect(progressSection).toContain('"cancelled"');
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
