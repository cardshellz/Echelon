import { describe, expect, it } from "vitest";
import { validateCustomerReturnBoxPlan } from "../../application/customer-return-box-plan";

const dimensions = { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 };
const lines = [
  { id: "line-a", title: "Same product", eligibleQuantity: 3, unitWeightGrams: 137.45 },
  { id: "line-b", title: "Same product", eligibleQuantity: 2, unitWeightGrams: 215.9 },
];
function plan() {
  return {
    selections: lines.map(line => ({ lineId: line.id, quantity: line.eligibleQuantity, reasonCode: null })),
    parcels: [
      { dimensions: { ...dimensions }, originalBoxId: null as string | null,
        items: [{ lineId: "line-a", quantity: 1 }, { lineId: "line-b", quantity: 1 }] },
      { dimensions: { ...dimensions }, originalBoxId: null as string | null,
        items: [{ lineId: "line-a", quantity: 2 }, { lineId: "line-b", quantity: 1 }] },
    ],
  };
}

describe("return box measurement validation", () => {
  it("recalculates each box from exact returned line quantities without mutating the request", () => {
    const input = plan();
    const before = structuredClone(input);
    const result = validateCustomerReturnBoxPlan(lines, input);
    expect(result.parcels.map(parcel => parcel.weightGrams)).toEqual([354, 491]);
    expect(result.parcels.map(parcel => parcel.dimensions)).toEqual([dimensions, dimensions]);
    expect(input).toEqual(before);
    result.parcels[0].dimensions.lengthMm = 999;
    expect(input.parcels[0].dimensions.lengthMm).toBe(254);
  });

  it("blocks missing catalog weights for selected items", () => {
    const unknown = lines.map(line => ({ ...line, unitWeightGrams: line.id === "line-b" ? null : line.unitWeightGrams }));
    expect(() => validateCustomerReturnBoxPlan(unknown, plan())).toThrow("product weight");
    expect(validateCustomerReturnBoxPlan(unknown, {
      selections: [{ lineId: "line-a", quantity: 1, reasonCode: null }],
      parcels: [{ dimensions, originalBoxId: null, items: [{ lineId: "line-a", quantity: 1 }] }],
    }).parcels[0].weightGrams).toBe(138);
  });

  it("accepts an original size only from this order's verified presets", () => {
    const input = plan();
    input.parcels[0].originalBoxId = "original-a";
    const options = [{ id: "original-a", dimensions, items: [{ lineId: "line-a", quantity: 1 }] }];
    // Selecting a known size is not a claim that its original contents match the
    // return: a customer may explicitly reuse that box for combined items.
    expect(validateCustomerReturnBoxPlan(lines, input, options).parcels[0].dimensions).toEqual(dimensions);
    expect(() => validateCustomerReturnBoxPlan(lines, input, [])).toThrow("original box size changed");
    input.parcels[0].dimensions.lengthMm += 1;
    expect(() => validateCustomerReturnBoxPlan(lines, input, options)).toThrow("original box size changed");
    input.parcels[0].originalBoxId = null;
    expect(validateCustomerReturnBoxPlan(lines, input, options).parcels[0].dimensions.lengthMm).toBe(255);
  });

  it("rejects browser-supplied parcel and unit weights", () => {
    const parcelWeight = plan();
    const withWeight = { ...parcelWeight, parcels: parcelWeight.parcels.map(parcel => ({ ...parcel, weightGrams: 1 })) };
    expect(() => validateCustomerReturnBoxPlan(lines, withWeight)).toThrow("valid items");
    const itemWeight = plan();
    expect(() => validateCustomerReturnBoxPlan(lines, {
      ...itemWeight,
      parcels: itemWeight.parcels.map(parcel => ({ ...parcel, items: parcel.items.map(item => ({ ...item, unitWeightGrams: 1 })) })),
    })).toThrow("valid items");
  });
});
