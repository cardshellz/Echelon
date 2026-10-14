import { describe, expect, it } from "vitest";
import { allocateIntegerCostInterval } from "@shared/utils/integer-cost-interval";
import {
  costForQuantityIntervals,
  sliceCostQuantityIntervals,
  subtractCostQuantityIntervals,
  takeCostQuantityIntervals,
  validateCostQuantityIntervals,
} from "../../domain/cost-quantity-intervals";
import { lotCostsForIntervals, lotCostTotals } from "../../domain/lot-cost";

describe("exact quantity-cost custody", () => {
  it("conserves the shipment charge that cannot fit one rounded unit price", () => {
    const amount = BigInt(11_907_200);
    const first = takeCostQuantityIntervals(80_000, [], 30_000);
    const second = takeCostQuantityIntervals(80_000, first, 50_000);
    expect(costForQuantityIntervals(amount, 80_000, first)).toBe(
      BigInt(4_465_200),
    );
    expect(costForQuantityIntervals(amount, 80_000, second)).toBe(
      BigInt(7_442_000),
    );
    expect(
      costForQuantityIntervals(amount, 80_000, first) +
        costForQuantityIntervals(amount, 80_000, second),
    ).toBe(amount);
  });

  it("retains a repeating fractional case price without increasing decimal precision", () => {
    const total = BigInt(50_838_700);
    const amounts = [0, 108, 216].map((start, index) =>
      allocateIntegerCostInterval(
        total,
        BigInt(330),
        BigInt(start),
        BigInt(index === 2 ? 114 : 108),
      ),
    );
    expect(amounts.reduce((sum, amount) => sum + amount, BigInt(0))).toBe(
      total,
    );
  });

  it("reuses only the original reversed ranges after a partial unpick", () => {
    const original = [{ start: 0, quantity: 10 }];
    const occupied = subtractCostQuantityIntervals(
      original,
      [{ start: 7, quantity: 3 }],
      10,
    );
    const repick = takeCostQuantityIntervals(10, occupied, 3);
    expect(repick).toEqual([{ start: 7, quantity: 3 }]);
    expect(
      costForQuantityIntervals(BigInt(101), 10, occupied) +
        costForQuantityIntervals(BigInt(101), 10, repick),
    ).toBe(BigInt(101));
  });

  it("can allocate several free fragments without overlapping existing custody", () => {
    expect(
      takeCostQuantityIntervals(
        12,
        [
          { start: 2, quantity: 3 },
          { start: 8, quantity: 2 },
        ],
        6,
      ),
    ).toEqual([
      { start: 0, quantity: 2 },
      { start: 5, quantity: 3 },
      { start: 10, quantity: 1 },
    ]);
    expect(
      sliceCostQuantityIntervals(
        [
          { start: 2, quantity: 3 },
          { start: 10, quantity: 2 },
        ],
        2,
        2,
      ),
    ).toEqual([
      { start: 4, quantity: 1 },
      { start: 10, quantity: 1 },
    ]);
  });

  it.each(
    [
      [{ start: -1, quantity: 1 }],
      [{ start: 0, quantity: 0 }],
      [{ start: 0, quantity: 1.5 }],
      [{ start: 9, quantity: 2 }],
      [
        { start: 0, quantity: 4 },
        { start: 3, quantity: 2 },
      ],
    ].map((intervals) => ({ intervals })),
  )(
    "rejects invalid, overlapping and out-of-bounds financial ranges",
    ({ intervals }) => {
      expect(() => validateCostQuantityIntervals(intervals, 10)).toThrow();
    },
  );

  it("rejects a reversal that does not belong to its original allocation", () => {
    expect(() =>
      subtractCostQuantityIntervals(
        [{ start: 0, quantity: 3 }],
        [{ start: 4, quantity: 1 }],
        5,
      ),
    ).toThrow();
    expect(() =>
      takeCostQuantityIntervals(3, [{ start: 0, quantity: 2 }], 2),
    ).toThrow();
    expect(() =>
      sliceCostQuantityIntervals([{ start: 0, quantity: 2 }], 2, 1),
    ).toThrow();
  });

  it("preserves exact signed reversals and large intermediate multiplication", () => {
    const amount = BigInt("9007199254740991");
    const part = allocateIntegerCostInterval(
      amount,
      BigInt(7),
      BigInt(0),
      BigInt(3),
    );
    expect(
      part +
        allocateIntegerCostInterval(amount, BigInt(7), BigInt(3), BigInt(4)),
    ).toBe(amount);
    expect(
      allocateIntegerCostInterval(-amount, BigInt(7), BigInt(0), BigInt(3)),
    ).toBe(-part);
  });

  it("reads authoritative component totals independently of rounded unit mirrors", () => {
    const lot = {
      id: 1,
      qty_received: 80_000,
      cost_basis_qty: 80_000,
      product_total_cost_mills: "48000000",
      packaging_total_cost_mills: "1000000",
      landed_total_cost_mills: "11907200",
    };
    expect(lotCostTotals(lot).totals.totalMills).toBe(BigInt(60_907_200));
    const all = lotCostsForIntervals(lot, [{ start: 0, quantity: 80_000 }]);
    expect(all.landedMills).toBe(BigInt(11_907_200));
    expect(all.poMills + all.packagingMills + all.landedMills).toBe(
      all.totalMills,
    );
  });

  it("rejects missing or changed original quantity evidence", () => {
    expect(() => lotCostTotals({ qty_received: 0 })).toThrow();
    expect(() =>
      lotCostTotals({
        qty_received: 2,
        cost_basis_qty: 3,
        product_total_cost_mills: 0,
        packaging_total_cost_mills: 0,
        landed_total_cost_mills: 0,
      }),
    ).toThrow();
    expect(() =>
      lotCostTotals({
        qty_received: 3,
        cost_basis_qty: 3,
        product_total_cost_mills: -1,
        packaging_total_cost_mills: 0,
        landed_total_cost_mills: 0,
      }),
    ).toThrow();
  });
});
