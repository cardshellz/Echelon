import { describe, expect, it } from "vitest";
import { comparePurchaseBuyingPriority, purchaseBuyingCounts, purchaseBuyingDisposition, type PurchasePriorityItem } from "../purchase-buying-review";
import { isPurchaseInventoryManaged } from "../purchase-inventory-eligibility";

const item = (overrides: Partial<PurchasePriorityItem> = {}): PurchasePriorityItem => ({
  productId: 1, sku: "STOCK", status: "stockout", suggestedOrderPieces: 100,
  daysOfSupply: 0, skippedReason: null, ...overrides,
});

describe("consistent purchase needs", () => {
  it("excludes empty stock without a purchase quantity but retains supplier work", () => {
    expect(purchaseBuyingDisposition(item({ suggestedOrderPieces: 0 }))).toBe("no_purchase_needed");
    expect(purchaseBuyingDisposition(item({ skippedReason: "no_vendor" }))).toBe("purchase_now");
    expect(purchaseBuyingDisposition(item({ status: "order_soon", skippedReason: "not_actionable_status" }))).toBe("purchase_soon");
  });
  it("separates committed supply and receipt review from new purchases", () => {
    expect(purchaseBuyingDisposition(item({ skippedReason: "already_on_order" }))).toBe("no_purchase_needed");
    expect(purchaseBuyingDisposition(item({ skippedReason: "already_on_order", supplyTiming: { reviewRequired: true } }))).toBe("supply_review");
    expect(purchaseBuyingDisposition(item({ skippedReason: "excluded", supplyTiming: { reviewRequired: true } }))).toBe("excluded");
  });
  it("retains upcoming alerts before a quantity is due, but reviews their existing supply", () => {
    expect(purchaseBuyingDisposition(item({ status: "order_soon", suggestedOrderPieces: 0, onOrderPieces: 0 }))).toBe("purchase_soon");
    expect(purchaseBuyingDisposition(item({ status: "order_soon", suggestedOrderPieces: 0, onOrderPieces: 100 }))).toBe("no_purchase_needed");
    expect(purchaseBuyingDisposition(item({ status: "order_soon", suggestedOrderPieces: 0, onOrderPieces: 100, supplyTiming: { reviewRequired: true } }))).toBe("supply_review");
  });
  it("does not count positive fallback quantities when receipts make buy/no-buy unverified", () => {
    const unresolved = item({ suggestedOrderPieces: 270, supplyTiming: { reviewRequired: true, signal: "unverified_receipts" } });
    expect(purchaseBuyingDisposition(unresolved)).toBe("supply_review");
    expect(purchaseBuyingCounts([unresolved])).toEqual({ stockout: 0, orderNow: 0, orderSoon: 0, supplyReview: 1 });
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("does not promote invalid quantity %s to a purchase", (quantity) => {
    expect(purchaseBuyingDisposition(item({ suggestedOrderPieces: quantity }))).toBe("no_purchase_needed");
  });
  it("counts the same dispositions regardless of row order", () => {
    const rows = [item(), item({ status: "order_now", skippedReason: "no_vendor" }), item({ status: "order_soon" }), item({ suggestedOrderPieces: 0 }), item({ suggestedOrderPieces: 0, supplyTiming: { reviewRequired: true } })];
    const expected = { stockout: 1, orderNow: 1, orderSoon: 1, supplyReview: 1 };
    expect(purchaseBuyingCounts(rows)).toEqual(expected);
    expect(purchaseBuyingCounts([...rows].reverse())).toEqual(expected);
  });
  it("orders urgency and essential stock before catalog order without mutating inputs", () => {
    const rows = [item({ productId: 3, suggestedOrderPieces: 0 }), item({ productId: 2 }), item({ productId: 1, planningBasis: { essential: true } })];
    expect([...rows].sort(comparePurchaseBuyingPriority).map((row) => row.productId)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.productId)).toEqual([3, 2, 1]);
  });
});

describe("explicit catalog inventory eligibility", () => {
  it("excludes digital and untracked products while keeping a mixed physical product", () => {
    const digital = { requiresShipping: false, trackInventory: false };
    const untracked = { requiresShipping: true, trackInventory: false };
    expect(isPurchaseInventoryManaged([digital, untracked])).toBe(false);
    expect(isPurchaseInventoryManaged([digital, { requiresShipping: true, trackInventory: true }])).toBe(true);
  });
  it("preserves missing and legacy evidence without guessing product type from its name", () => {
    for (const value of [undefined, null, [], [{ requiresShipping: null, trackInventory: null }]]) expect(isPurchaseInventoryManaged(value)).toBe(true);
  });
  it("rejects malformed policy evidence", () => {
    expect(() => isPurchaseInventoryManaged([{ requiresShipping: "false", trackInventory: true }])).toThrow();
    expect(() => isPurchaseInventoryManaged({})).toThrow();
  });
});
