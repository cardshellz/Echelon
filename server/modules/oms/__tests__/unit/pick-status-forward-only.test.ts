import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Order #60927: a split shipment's first package (1 of 2 units) demoted a
 * fully-picked line ('completed', picked 2/2) back to 'in_progress', and the
 * pick queue resurfaced it for re-picking. Two invariants close that:
 *
 *  1. The canonical projection derives item status from
 *     GREATEST(picked_quantity, shipped_quantity) — a partial package can
 *     never demote a completed pick (shipped-only derivation is banned).
 *  2. Every pending-pick predicate treats a physically picked line
 *     (picked_quantity >= quantity) as NOT pickable, whatever its label.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("pick status is forward-only under shipment projection", () => {
  it("the projection derives status from GREATEST(picked, shipped)", () => {
    const src = read("../../../wms/channel-fulfillment-projection.repository.ts");
    const greatestStatus = src.match(
      /GREATEST\(\s*COALESCE\(order_item\.picked_quantity, 0\),\s*COALESCE\(shipped\.shipped_quantity, 0\)\s*\)/g,
    ) ?? [];
    expect(greatestStatus.length).toBeGreaterThanOrEqual(2);
    // shipped-only demotion must never come back
    expect(src).not.toMatch(/WHEN shipped\.shipped_quantity > 0 THEN 'in_progress'/);
  });

  it("pick-queue predicates treat picked_quantity >= quantity as done", () => {
    const storage = read("../../../orders/orders.storage.ts");
    const sqlGuards = storage.match(
      /AND COALESCE\((?:oi|open_items)\.picked_quantity, 0\) < COALESCE\((?:oi|open_items)\.quantity, 0\)/g,
    ) ?? [];
    expect(sqlGuards.length).toBe(2);
    expect(storage).toContain("(i.pickedQuantity ?? 0) < (i.quantity ?? 0)");
    const idx = read("../../../../index.ts");
    expect(idx).toContain("AND COALESCE(oi.picked_quantity, 0) < COALESCE(oi.quantity, 0)");
  });
});
