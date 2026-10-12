import { describe, expect, it } from "vitest";
import { orderEditCatalogSelectionNotice } from "../../order-edit-catalog-selection";
import { orderEditCatalogVariantSchema } from "@shared/order-edits/order-edit-catalog";

describe("post-selection purchase requirements", () => {
  it("keeps normal item selection on the existing order-edit path", () => {
    expect(orderEditCatalogSelectionNotice("order_edit")).toBeNull();
  });
  it.each([
    ["membership", "Membership selected"],
    ["subscription", "Subscription selected"],
    ["gift_card", "Gift card selected"],
    ["bundle", "Bundle selected"],
    ["non_shipping", "Product selected"],
    ["inventory_review", "inventory validation"],
  ] as const)("explains %s after selection without pretending a purchase completed", (flow, text) => {
    expect(orderEditCatalogSelectionNotice(flow)).toContain(text);
  });
  it("validates selection metadata and accepts an older physical-only response", () => {
    const variant = { variantId: "gid://shopify/ProductVariant/1", title: "Product", variantTitle: null, sku: null, priceCents: 100, available: true };
    expect(orderEditCatalogVariantSchema.safeParse(variant).success).toBe(true);
    expect(orderEditCatalogVariantSchema.safeParse({ ...variant, selectionFlow: "membership" }).success).toBe(true);
    expect(orderEditCatalogVariantSchema.safeParse({ ...variant, selectionFlow: "bypass_payment" }).success).toBe(false);
  });
});
