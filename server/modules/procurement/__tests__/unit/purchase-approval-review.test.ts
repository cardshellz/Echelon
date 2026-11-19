import { describe, expect, it } from "vitest";
import { purchaseApprovalLinesFingerprint } from "../../purchase-approval-review";

const line = { id: 11, purchaseOrderId: 1, status: "open", sku: "TEST-A", orderQty: 1, unitCostCents: 10000, lineTotalCents: 10000, updatedAt: new Date("2026-10-23T12:00:00Z") };
describe("purchase approval persisted line review", () => {
  it("is stable across row ordering and presentation-only joined fields", () => {
    const other = { ...line, id: 12 };
    expect(purchaseApprovalLinesFingerprint([line, other])).toBe(purchaseApprovalLinesFingerprint([{ ...other, quotedAtDate: "2026-10-23", vendorDisplayName: "Display" }, line]));
  });
  it.each([{ sku: "RENAMED" }, { vendorSku: "NEW-SUPPLIER-SKU" }, { orderQty: 2 }, { expectedReceiveUnitsPerVariant: 5 }, { description: "Different supplier terms" }, { notes: "Different terms" }, { productVariantId: 33 }, { id: 12 }])("detects changed saved terms even when timestamp and total stay equal: %j", patch => {
    expect(purchaseApprovalLinesFingerprint([{ ...line, ...patch }])).not.toBe(purchaseApprovalLinesFingerprint([line]));
  });
  it("detects added/removed active lines and ignores cancelled history", () => {
    expect(purchaseApprovalLinesFingerprint([line, { ...line, id: 12 }])).not.toBe(purchaseApprovalLinesFingerprint([line]));
    expect(purchaseApprovalLinesFingerprint([line, { ...line, id: 12, status: "cancelled" }])).toBe(purchaseApprovalLinesFingerprint([line]));
  });
  it("normalizes database Date values and their transport representation identically", () => {
    expect(purchaseApprovalLinesFingerprint([line])).toBe(purchaseApprovalLinesFingerprint([{ ...line, updatedAt: line.updatedAt.toISOString() }]));
  });
  it("rejects missing or invalid saved line identity", () => {
    expect(() => purchaseApprovalLinesFingerprint([{ ...line, id: 0 }])).toThrow("identity is invalid");
  });
});
