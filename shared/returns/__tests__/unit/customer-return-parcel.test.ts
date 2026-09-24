import { describe, expect, it } from "vitest";
import {
  calculateCustomerReturnProductWeight,
  customerReturnDimensionsSchema,
  sameCustomerReturnDimensions,
} from "../../customer-return-parcel";
import { MAX_DIMENSION_MM } from "../../../shipping/dimensions";

describe("return parcel product weight", () => {
  it("sums exact per-variant quantities and rounds up once, with no packaging allowance", () => {
    expect(calculateCustomerReturnProductWeight([
      { quantity: 3, unitWeightGrams: 0.1 },
      { quantity: 1, unitWeightGrams: 0.7 },
    ])).toBe(1);
    expect(calculateCustomerReturnProductWeight([
      { quantity: 2, unitWeightGrams: 137.45 },
      { quantity: 1, unitWeightGrams: 215.9 },
    ])).toBe(491);
    expect(calculateCustomerReturnProductWeight([{ quantity: 2, unitWeightGrams: 100 }])).toBe(200);
  });

  it("ignores unreturned items but never invents weight for returned items", () => {
    expect(calculateCustomerReturnProductWeight([
      { quantity: 0, unitWeightGrams: null },
      { quantity: 1, unitWeightGrams: 100 },
    ])).toBe(100);
    expect(calculateCustomerReturnProductWeight([])).toBeNull();
    expect(calculateCustomerReturnProductWeight([{ quantity: 0, unitWeightGrams: 100 }])).toBeNull();
  });

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "returns unknown for invalid product weight %s", unitWeightGrams => {
      expect(calculateCustomerReturnProductWeight([{ quantity: 1, unitWeightGrams }])).toBeNull();
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid quantity %s", quantity => {
      expect(calculateCustomerReturnProductWeight([{ quantity, unitWeightGrams: 100 }])).toBeNull();
    },
  );

  it("fails closed on overflowing totals and leaves inputs unchanged", () => {
    const items = [{ quantity: Number.MAX_SAFE_INTEGER, unitWeightGrams: 2 }];
    const original = structuredClone(items);
    expect(calculateCustomerReturnProductWeight(items)).toBeNull();
    expect(items).toEqual(original);
    expect(calculateCustomerReturnProductWeight([
      { quantity: 1, unitWeightGrams: Number.MAX_SAFE_INTEGER },
      { quantity: 1, unitWeightGrams: 0.01 },
    ])).toBeNull();
  });
});

describe("return box dimensions", () => {
  const dimensions = { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 };
  it("keeps exact positive metric values without truncating converted inches", () => {
    expect(customerReturnDimensionsSchema.parse(dimensions)).toEqual(dimensions);
    expect(sameCustomerReturnDimensions(dimensions, { ...dimensions })).toBe(true);
    expect(sameCustomerReturnDimensions(dimensions, { ...dimensions, heightMm: 101.6254 })).toBe(false);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_DIMENSION_MM + 1, 0.00001, "254"])(
    "rejects invalid or unsupported precision %s", lengthMm => {
      expect(customerReturnDimensionsSchema.safeParse({ ...dimensions, lengthMm }).success).toBe(false);
    },
  );
  it("rejects missing dimensions and customer weight injection", () => {
    expect(customerReturnDimensionsSchema.safeParse({ lengthMm: 254, widthMm: 203.2 }).success).toBe(false);
    expect(customerReturnDimensionsSchema.safeParse({ ...dimensions, weightGrams: 1 }).success).toBe(false);
  });
});
