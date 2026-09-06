import { describe, expect, it } from "vitest";
import { convertReceiptCounts, planReceiptUnits, receivingUnitVersion } from "../../receiving-unit-contract";

const piece = { id: 1, productId: 9, unitsPerVariant: 1, isActive: true };
const pack = { id: 2, productId: 9, unitsPerVariant: 50, isActive: true };
const input = { productId: 9, preferredVariantId: 2, recordedPreferredUnits: 50, variants: [piece, pack] };

describe("receipt unit planning", () => {
  it("preserves whole selected packs and freezes their conversion", () => {
    expect(planReceiptUnits({ ...input, baseQty: 500 })).toMatchObject({ productVariantId: 2, unitsPerVariant: 50, expectedQty: 10 });
  });
  it("preserves every partial-pack piece without deriving a carton conversion", () => {
    expect(planReceiptUnits({ ...input, baseQty: 501 })).toMatchObject({ productVariantId: 1, unitsPerVariant: 1, expectedQty: 501, countsAsPieces: true });
  });
  it("requires a real active piece variant for a partial quantity", () => {
    expect(() => planReceiptUnits({ ...input, baseQty: 501, variants: [pack] })).toThrow(/active one-piece variant/);
    expect(() => planReceiptUnits({ ...input, baseQty: 501, variants: [pack, { ...piece, isActive: false }] })).toThrow(/active one-piece variant/);
  });
  it("rejects missing or cross-product preferred variants instead of guessing", () => {
    expect(() => planReceiptUnits({ ...input, baseQty: 500, variants: [piece, { ...pack, productId: 10 }] })).toThrow(/another product/);
  });
  it("rejects changed recorded source packs", () => {
    expect(() => planReceiptUnits({ ...input, baseQty: 500, recordedPreferredUnits: 100 })).toThrow(/differs/);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, null, "501"])("rejects invalid expected pieces %s", (baseQty) => {
    expect(() => planReceiptUnits({ ...input, baseQty: baseQty as number })).toThrow();
  });
  it("does not mutate the supplied variant list", () => {
    const variants = Object.freeze([Object.freeze(pack), Object.freeze(piece)]);
    expect(planReceiptUnits({ ...input, variants, baseQty: 501 }).expectedQty).toBe(501);
    expect(variants[0].id).toBe(2);
  });
});

describe("receipt count conversion", () => {
  it("preserves expected, received and damaged pieces independently", () => {
    expect(convertReceiptCounts({ expectedQty: 10, receivedQty: 8, damagedQty: 1 }, 50, 1))
      .toEqual({ expectedQty: 500, receivedQty: 400, damagedQty: 50 });
  });
  it.each(["expectedQty", "receivedQty", "damagedQty"] as const)("rejects an inexact %s without rounding", (field) => {
    expect(() => convertReceiptCounts({ expectedQty: 500, receivedQty: 400, damagedQty: 50, [field]: 501 }, 1, 50)).toThrow(/exactly/);
  });
  it("rejects count overflow", () => {
    expect(() => convertReceiptCounts({ expectedQty: 2_147_483_647, receivedQty: 0, damagedQty: 0 }, 50, 1)).toThrow(/range/);
  });
  it("versions the recorded unit and count so stale-unit count saves conflict", () => {
    const line = { id: 1, expectedQty: 10, receivedQty: 8, damagedQty: 0, unitsPerVariantSnapshot: 50 };
    expect(receivingUnitVersion(line)).not.toBe(receivingUnitVersion({ ...line, unitsPerVariantSnapshot: 1 }));
    expect(receivingUnitVersion(line)).not.toBe(receivingUnitVersion({ ...line, receivedQty: 9 }));
    expect(receivingUnitVersion(line)).toBe(receivingUnitVersion({ ...line }));
  });
});
