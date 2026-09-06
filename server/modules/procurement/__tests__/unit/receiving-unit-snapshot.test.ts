import { describe, expect, it } from "vitest";
import { resolveReceivingUnitSnapshot, type ReceivingUnitSnapshotInput } from "../../receiving-unit-snapshot";

const input = (patch: Partial<ReceivingUnitSnapshotInput> = {}): ReceivingUnitSnapshotInput => ({
  receivingLineId: 11, receivingOrderId: 10, purchaseOrderLineId: 21, purchaseOrderId: 20,
  receivedQty: 3, unitsPerVariantSnapshot: 250, receiptStatus: "closed", postedReceipts: [], ...patch,
});
const posting = { receivingLineId: 11, receivingOrderId: 10, purchaseOrderLineId: 21, purchaseOrderId: 20, qtyReceived: 750 };

describe("receiving unit snapshot authority", () => {
  it("uses the frozen factor for a new receipt without needing a catalog value", () => {
    expect(resolveReceivingUnitSnapshot(input())).toBe(250);
  });

  it("permits a zero-quantity recorded receipt only when its factor is frozen", () => {
    expect(resolveReceivingUnitSnapshot(input({ receivedQty: 0 }))).toBe(250);
  });

  it("validates a frozen factor against the exact original PO posting", () => {
    expect(resolveReceivingUnitSnapshot(input({ postedReceipts: [posting] }))).toBe(250);
    expect(() => resolveReceivingUnitSnapshot(input({ postedReceipts: [{ ...posting, qtyReceived: 501 }] }))).toThrow(/disagrees/);
  });

  it("uses exact immutable PO evidence for a closed legacy receipt without changing input", () => {
    const value = input({ unitsPerVariantSnapshot: null, postedReceipts: [posting] });
    const before = structuredClone(value);
    expect(resolveReceivingUnitSnapshot(value)).toBe(250);
    expect(value).toEqual(before);
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid frozen factor %s", (factor) => {
    expect(() => resolveReceivingUnitSnapshot(input({ unitsPerVariantSnapshot: factor }))).toThrow(/frozen units/);
  });

  it.each(["draft", "open", "receiving", "verified", "cancelled"])("does not reinterpret a legacy %s receipt", (status) => {
    expect(() => resolveReceivingUnitSnapshot(input({ unitsPerVariantSnapshot: null, receiptStatus: status, postedReceipts: [posting] }))).toThrow(/no frozen/);
  });

  it("uses the original PO posting ratio without deriving anything from cartons", () => {
    // The exact recorded PO posting does prove 167 units per received unit;
    // carton counts are intentionally absent from this API and cannot supply it.
    expect(() => resolveReceivingUnitSnapshot(input({ unitsPerVariantSnapshot: null, postedReceipts: [] }))).toThrow(/no frozen/);
    expect(resolveReceivingUnitSnapshot(input({ unitsPerVariantSnapshot: null, postedReceipts: [{ ...posting, qtyReceived: 501 }] }))).toBe(167);
  });

  it.each([
    { receivingLineId: 12 }, { receivingOrderId: 12 }, { purchaseOrderLineId: 22 },
    { purchaseOrderId: 22 }, { qtyReceived: -1 },
  ])("rejects foreign or invalid posting evidence %j", (patch) => {
    expect(() => resolveReceivingUnitSnapshot(input({ unitsPerVariantSnapshot: null, postedReceipts: [{ ...posting, ...patch }] }))).toThrow(/does not prove/);
  });

  it("rejects multiple PO postings instead of guessing an allocation", () => {
    expect(() => resolveReceivingUnitSnapshot(input({ postedReceipts: [posting, posting] }))).toThrow(/more than one/);
  });

  it("rejects nonintegral legacy conversion and missing or zero posting proof", () => {
    for (const qtyReceived of [0, 749]) {
      expect(() => resolveReceivingUnitSnapshot(input({ unitsPerVariantSnapshot: null, postedReceipts: [{ ...posting, qtyReceived }] }))).toThrow();
    }
  });

  it("rejects database integer overflow with a structured review error", () => {
    try {
      resolveReceivingUnitSnapshot(input({ receivedQty: 2_147_483_647, unitsPerVariantSnapshot: 2 }));
      throw new Error("Expected frozen unit validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_SNAPSHOT_REVIEW_REQUIRED", receivingLineId: 11 } });
    }
  });
});
