import { describe, expect, it } from "vitest";
import {
  availableCatalogProduct,
  availableCatalogVariant,
  catalogSelectionFlow,
  supportedVariant,
} from "../../domain/order-edit-variant";

const variant = {
  requiresComponents: false,
  availableForSale: true,
  inventoryPolicy: "DENY" as const,
  sellableOnlineQuantity: 10,
  inventoryItem: { requiresShipping: true, tracked: true },
  product: { status: "ACTIVE", isGiftCard: false, requiresSellingPlan: false },
  membershipVariant: null as { value: string } | null,
};

describe("availability independently of an order-edit purchase path", () => {
  it("uses publication without excluding gift cards or subscription products", () => {
    expect(availableCatalogProduct({ status: "ACTIVE", onlineStoreUrl: "https://shop.example/products/club" })).toBe(true);
    expect(availableCatalogProduct({ status: "DRAFT", onlineStoreUrl: "https://shop.example/products/club" })).toBe(false);
    expect(availableCatalogProduct({ status: "ACTIVE", onlineStoreUrl: null })).toBe(false);
  });
  it("finds available non-shipping and untracked products", () => {
    const product = {
      ...variant, sellableOnlineQuantity: 0,
      inventoryItem: { requiresShipping: false, tracked: false },
    };
    expect(availableCatalogVariant(product, 1)).toBe(true);
    expect(supportedVariant(product)).toBe(false);
    expect(catalogSelectionFlow(product)).toBe("non_shipping");
    expect(availableCatalogVariant({ ...product, availableForSale: false }, 1)).toBe(false);
  });
  it("uses real stock for tracked products even when Shopify allows backorders", () => {
    const product = { ...variant, inventoryPolicy: "CONTINUE" as const };
    expect(availableCatalogVariant(product, 10)).toBe(true);
    expect(availableCatalogVariant(product, 11)).toBe(false);
    expect(availableCatalogVariant({ ...product, sellableOnlineQuantity: 0 }, 1)).toBe(false);
    expect(catalogSelectionFlow(product)).toBe("inventory_review");
  });
  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid discovery quantity %s", (quantity) => {
    expect(availableCatalogVariant(variant, quantity)).toBe(false);
  });
  it("classifies membership before its subscription and shipping requirements", () => {
    const membership = {
      ...variant,
      membershipVariant: { value: "true" },
      inventoryItem: { requiresShipping: false, tracked: false },
      product: { ...variant.product, requiresSellingPlan: true },
    };
    expect(catalogSelectionFlow(membership)).toBe("membership");
    expect(availableCatalogVariant(membership, 1)).toBe(true);
    expect(supportedVariant(membership)).toBe(false);
  });
  it("separates ordinary edits, subscriptions, gift cards and bundles without modifying source data", () => {
    const input = [
      variant,
      { ...variant, product: { ...variant.product, requiresSellingPlan: true } },
      { ...variant, product: { ...variant.product, isGiftCard: true } },
      { ...variant, requiresComponents: true },
    ];
    const before = structuredClone(input);
    expect(input.map(catalogSelectionFlow)).toEqual(["order_edit", "subscription", "gift_card", "bundle"]);
    expect(input.every((item) => availableCatalogVariant(item, 1))).toBe(true);
    expect(input).toEqual(before);
  });
});
