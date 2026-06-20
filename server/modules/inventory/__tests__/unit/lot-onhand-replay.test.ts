import { describe, expect, it } from "vitest";
import {
  sumLotsOnHand,
  reconcile,
  cellKey,
  type LotRow,
  type LevelRow,
} from "../../reconcile/lot-onhand-replay";

describe("sumLotsOnHand", () => {
  it("sums qty_on_hand per (variant, location) cell", () => {
    const lots: LotRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 5 },
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 3 }, // same cell → adds
      { productVariantId: 1, warehouseLocationId: 20, qtyOnHand: 7 }, // diff location
      { productVariantId: 2, warehouseLocationId: 10, qtyOnHand: 4 }, // diff variant
    ];
    const map = sumLotsOnHand(lots);
    expect(map.get(cellKey(1, 10))).toBe(8);
    expect(map.get(cellKey(1, 20))).toBe(7);
    expect(map.get(cellKey(2, 10))).toBe(4);
    expect(map.size).toBe(3);
  });

  it("counts depleted/zero lots as zero (no effect) and includes expired with qty", () => {
    const lots: LotRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 0 }, // depleted
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 6 }, // expired-but-present still counts
    ];
    const map = sumLotsOnHand(lots);
    expect(map.get(cellKey(1, 10))).toBe(6);
  });

  it("skips rows with null variant or location", () => {
    const lots = [
      { productVariantId: null as any, warehouseLocationId: 10, qtyOnHand: 5 },
      { productVariantId: 1, warehouseLocationId: null as any, qtyOnHand: 5 },
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 2 },
    ] as LotRow[];
    const map = sumLotsOnHand(lots);
    expect(map.size).toBe(1);
    expect(map.get(cellKey(1, 10))).toBe(2);
  });
});

describe("lot → levels reconciliation", () => {
  it("reports zero variance when lot sums equal levels", () => {
    const lots: LotRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 5 },
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 3 },
      { productVariantId: 2, warehouseLocationId: 20, qtyOnHand: 4 },
    ];
    const levels: LevelRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, variantQty: 8 },
      { productVariantId: 2, warehouseLocationId: 20, variantQty: 4 },
    ];
    const result = reconcile(sumLotsOnHand(lots), levels);
    expect(result.variances).toHaveLength(0);
    expect(result.totalAbsDrift).toBe(0);
  });

  it("flags a cell where the lot sum drifts from the level (diff = level − lot sum)", () => {
    const lots: LotRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 8 },
    ];
    const levels: LevelRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, variantQty: 10 },
    ];
    const result = reconcile(sumLotsOnHand(lots), levels);
    expect(result.variances).toHaveLength(1);
    expect(result.variances[0]).toEqual(
      expect.objectContaining({ productVariantId: 1, warehouseLocationId: 10, expected: 8, actual: 10, diff: 2 }),
    );
  });

  it("flags lot-only cells (lots present, no level row) and level-only cells (level, no lots)", () => {
    const lots: LotRow[] = [
      { productVariantId: 1, warehouseLocationId: 10, qtyOnHand: 5 }, // lots, no level row
    ];
    const levels: LevelRow[] = [
      { productVariantId: 2, warehouseLocationId: 20, variantQty: 3 }, // level, no lots
    ];
    const result = reconcile(sumLotsOnHand(lots), levels);
    expect(result.variances).toHaveLength(2);
    expect(result.totalAbsDrift).toBe(8); // |0-5| + |3-0|
  });
});
