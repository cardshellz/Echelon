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
