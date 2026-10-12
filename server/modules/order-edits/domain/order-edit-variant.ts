import type { OrderEditCatalogSelectionFlow } from "@shared/order-edits/order-edit-catalog";

interface OrderEditVariantEligibility {
  requiresComponents: boolean;
  availableForSale: boolean;
  inventoryPolicy: "DENY" | "CONTINUE";
  sellableOnlineQuantity: number;
  inventoryItem: { requiresShipping: boolean; tracked: boolean };
  product: {
    status: string;
    isGiftCard: boolean;
    requiresSellingPlan: boolean;
  };
  membershipVariant: { value: string } | null;
}

/** Storefront discovery does not imply eligibility for an order-edit command. */
export function availableCatalogProduct(product: {
  status: string;
  onlineStoreUrl: string | null;
}): boolean {
  return product.status === "ACTIVE" && product.onlineStoreUrl !== null;
}

export function availableCatalogVariant(
  variant: Pick<
    OrderEditVariantEligibility,
    "availableForSale" | "sellableOnlineQuantity" | "inventoryItem"
  >,
  quantity: number,
): boolean {
  return (
    Number.isSafeInteger(quantity) &&
    quantity > 0 &&
    variant.availableForSale &&
    // Shopify's availability is authoritative when inventory is not tracked.
    // Tracked products still need actual stock, even if backorders are allowed.
    (!variant.inventoryItem.tracked || variant.sellableOnlineQuantity >= quantity)
  );
}

/** Requirements are evaluated after discovery, independently of availability. */
export function catalogSelectionFlow(
  variant: OrderEditVariantEligibility,
): OrderEditCatalogSelectionFlow {
  if (variant.membershipVariant?.value === "true") return "membership";
  if (variant.product.isGiftCard) return "gift_card";
  if (variant.product.requiresSellingPlan) return "subscription";
  if (variant.requiresComponents) return "bundle";
  if (!variant.inventoryItem.requiresShipping) return "non_shipping";
  if (!stockAvailable(variant, 1)) return "inventory_review";
  return "order_edit";
}

export function supportedCatalogProduct(product: {
  status: string;
  isGiftCard: boolean;
  requiresSellingPlan: boolean;
  onlineStoreUrl: string | null;
}): boolean {
  return (
    product.status === "ACTIVE" &&
    !product.isGiftCard &&
    !product.requiresSellingPlan &&
    product.onlineStoreUrl !== null
  );
}

export function supportedVariant(
  variant: OrderEditVariantEligibility,
): boolean {
  return (
    !variant.requiresComponents &&
    variant.inventoryItem.requiresShipping &&
    variant.product.status === "ACTIVE" &&
    !variant.product.isGiftCard &&
    !variant.product.requiresSellingPlan &&
    variant.membershipVariant?.value !== "true"
  );
}

export function stockAvailable(
  variant: OrderEditVariantEligibility,
  quantity: number,
): boolean {
  return (
    Number.isSafeInteger(quantity) &&
    quantity > 0 &&
    variant.availableForSale &&
    variant.inventoryItem.tracked &&
    variant.inventoryPolicy === "DENY" &&
    variant.sellableOnlineQuantity >= quantity
  );
}
