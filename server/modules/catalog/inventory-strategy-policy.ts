import {
  DEFAULT_PRODUCT_INVENTORY_STRATEGY,
  isProductInventoryStrategy,
  type ProductInventoryStrategy,
} from "@shared/catalog/inventory-strategy";

export class ProductInventoryStrategyError extends Error {
  constructor(
    readonly code: "INVALID_INVENTORY_STRATEGY" | "INVENTORY_STRATEGY_HAS_RECIPES",
    message: string,
    readonly statusCode: 400 | 409,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProductInventoryStrategyError";
  }
}

export function parseProductInventoryStrategy(
  value: unknown,
  options: { useDefaultWhenMissing: boolean },
): ProductInventoryStrategy | undefined {
  if (value === undefined) {
    return options.useDefaultWhenMissing ? DEFAULT_PRODUCT_INVENTORY_STRATEGY : undefined;
  }
  if (!isProductInventoryStrategy(value)) {
    throw new ProductInventoryStrategyError(
      "INVALID_INVENTORY_STRATEGY",
      "Inventory strategy must be physical_fungible, recipe_managed, or physical_only",
      400,
      { value },
    );
  }
  return value;
}

export function assertProductInventoryStrategyTransition(input: {
  productId: number;
  current: ProductInventoryStrategy;
  requested: ProductInventoryStrategy;
  hasBuildRecipes: boolean;
}): void {
  if (input.current === input.requested) return;
  if (input.current === "recipe_managed" && input.requested !== "recipe_managed" && input.hasBuildRecipes) {
    throw new ProductInventoryStrategyError(
      "INVENTORY_STRATEGY_HAS_RECIPES",
      "Archive this product's build recipes before changing away from build-managed inventory",
      409,
      {
        productId: input.productId,
        current: input.current,
        requested: input.requested,
      },
    );
  }
}
