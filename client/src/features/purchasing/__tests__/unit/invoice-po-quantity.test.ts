import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvoicePoQuantity } from "../../InvoicePoQuantity";

function text(comparison: unknown, quantity: "ordered" | "received" = "ordered", recordedQuantity: number | null = 12500, compact = false) {
  return renderToStaticMarkup(createElement(InvoicePoQuantity, { comparison, recordedQuantity, quantity, compact })).replace(/<[^>]*>/g, "");
}
const comparison = { status: "current", purchaseOrderId: 113, purchaseOrderLineId: 160, orderedQty: 25000, receivedQty: 20000 };

describe("invoice PO comparison presentation", () => {
  it("shows the current ordered quantity and identifies the older recorded comparison", () => {
    expect(text(comparison)).toBe("25,000Saved: 12,500");
    expect(text(comparison, "received")).toBe("20,000");
  });
  it("keeps the compact mobile comparison readable", () => {
    expect(text(comparison, "ordered", 12500, true)).toBe("25,000");
  });
  it("does not present a missing PO or a malformed response as a current saved value", () => {
    expect(text({ status: "unavailable" })).toBe("PO comparison unavailable");
    expect(text({ ...comparison, orderedQty: -1 })).toBe("PO comparison unavailable");
    expect(text(null)).toBe("PO comparison unavailable");
  });
  it("shows no PO quantity for invoice lines without a PO", () => {
    expect(text({ status: "unlinked" })).toBe("—");
  });
  it("labels legacy cached comparisons explicitly instead of asserting they are current", () => {
    expect(text(undefined)).toBe("12,500Saved on invoice");
    expect(text(undefined, "ordered", null)).toBe("—Saved on invoice");
  });
  it("preserves zero and avoids misleading historical captions for an unchanged count", () => {
    expect(text({ ...comparison, orderedQty: 0 }, "ordered", 0)).toBe("0");
    expect(text(comparison, "ordered", 25000)).toBe("25,000");
  });
});
