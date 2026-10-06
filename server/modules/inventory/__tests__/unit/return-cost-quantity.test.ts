import { describe, expect, it } from "vitest";
import { returnableCostQuantities } from "../../domain/return-cost-quantity";

const sold = { id: 1, inventoryLotId: 4, quantity: 3, unitMills: BigInt(149) };
const unpicked = { ...sold, id: 2, quantity: -1 };
const link = { negativeCostId: 2, originalCostId: 1, quantity: 1 };
describe("exact sold quantity for return costing", () => {
  it("nets only the linked original pick and preserves unrelated same-lot sales", () => {
    const input = [sold, unpicked, { ...sold, id: 3, quantity: 2 }];
    expect([...returnableCostQuantities(input, [link])]).toEqual([[1,2],[3,2]]);
    expect(input[0].quantity).toBe(3);
  });
  it("keeps confirmed zero and full unpick distinct from missing history", () => {
    expect([...returnableCostQuantities([{ ...sold, unitMills: BigInt(0) },
      { ...unpicked, quantity: -3, unitMills: BigInt(0) }], [{ ...link, quantity: 3 }])]).toEqual([[1,0]]);
    expect([...returnableCostQuantities([], [])]).toEqual([]);
  });
  it.each([
    [], [{ ...link, originalCostId: 999 }], [link,link], [{ ...link, quantity: 2 }],
  ].map(links=>({ links })))("rejects absent, mismatched or duplicated reversal evidence %j", ({ links }) => {
    expect(()=>returnableCostQuantities([sold,unpicked],links)).toThrow();
  });
  it("rejects another lot, another price and an over-reversal", () => {
    for (const negative of [{ ...unpicked, inventoryLotId: 5 }, { ...unpicked, unitMills: BigInt(150) },
      { ...unpicked, quantity: -4 }]) {
      expect(()=>returnableCostQuantities([sold,negative],[{ ...link, quantity: -negative.quantity }])).toThrow();
    }
  });
});
