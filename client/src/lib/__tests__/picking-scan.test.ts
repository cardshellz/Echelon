import { describe, expect, it } from "vitest";
import {
  findMatchingScannableItemIndex,
  isScannablePickItem,
  normalizeScanCode,
  scanCouldStillMatchItem,
  scanMatchesItem,
} from "../picking-scan";

describe("picking scan helpers", () => {
  const item = {
    sku: "ABC-123",
    barcode: "00 123-456",
    status: "pending",
    picked: 0,
    qty: 1,
  };

  it("normalizes scanner input without changing the product identity", () => {
    expect(normalizeScanCode(" abc-123 ")).toBe("ABC123");
    expect(normalizeScanCode("00 123-456")).toBe("00123456");
  });

  it("matches either SKU or barcode after normalization", () => {
    expect(scanMatchesItem("ABC123", item)).toBe(true);
    expect(scanMatchesItem("00123456", item)).toBe(true);
    expect(scanMatchesItem("999999", item)).toBe(false);
  });

  it("distinguishes partial scanner input from a completed wrong scan", () => {
    expect(scanCouldStillMatchItem("00 123", item)).toBe(true);
    expect(scanCouldStillMatchItem("00 999", item)).toBe(false);
  });

  it("does not match empty missing barcodes", () => {
    expect(scanMatchesItem("", { sku: "ABC-123", barcode: null })).toBe(false);
    expect(scanMatchesItem("   ", { sku: "ABC-123", barcode: "" })).toBe(false);
  });

  it("only finds items that can still be picked", () => {
    const items = [
      { sku: "DONE", barcode: "111", status: "completed", picked: 1, qty: 1 },
      { sku: "FULL", barcode: "222", status: "in_progress", picked: 2, qty: 2 },
      { sku: "OPEN", barcode: "333", status: "pending", picked: 0, qty: 1 },
    ];

    expect(isScannablePickItem(items[0])).toBe(false);
    expect(isScannablePickItem(items[1])).toBe(false);
    expect(findMatchingScannableItemIndex(items, "333")).toBe(2);
    expect(findMatchingScannableItemIndex(items, "111")).toBe(-1);
  });
});
