export const PRODUCT_INVENTORY_STRATEGIES = [
  "physical_fungible",
  "recipe_managed",
  "physical_only",
] as const;

export type ProductInventoryStrategy = (typeof PRODUCT_INVENTORY_STRATEGIES)[number];

export const DEFAULT_PRODUCT_INVENTORY_STRATEGY: ProductInventoryStrategy = "physical_fungible";

export const PRODUCT_INVENTORY_STRATEGY_DEFINITIONS: ReadonlyArray<{
  strategy: ProductInventoryStrategy;
  label: string;
  description: string;
}> = [
  {
    strategy: "physical_fungible",
    label: "Package hierarchy",
    description: "Cases, packs, and eaches share one base-unit pool and use direct break/assemble operations.",
  },
  {
    strategy: "recipe_managed",
    label: "Build managed",
    description: "Inventory transformations require versioned recipes and auditable build orders.",
  },
  {
    strategy: "physical_only",
    label: "Physical only",
    description: "Each variant is available only from its own physical on-hand inventory.",
  },
] as const;

export function isProductInventoryStrategy(value: unknown): value is ProductInventoryStrategy {
  return typeof value === "string"
    && PRODUCT_INVENTORY_STRATEGIES.includes(value as ProductInventoryStrategy);
}

export function getProductInventoryStrategyDefinition(strategy: ProductInventoryStrategy) {
  return PRODUCT_INVENTORY_STRATEGY_DEFINITIONS.find((definition) => definition.strategy === strategy)!;
}

export function usesFungibleBaseUnitPool(strategy: ProductInventoryStrategy): boolean {
  return strategy === "physical_fungible";
}

export function allowsDirectPackageConversion(strategy: ProductInventoryStrategy): boolean {
  return strategy === "physical_fungible";
}

export function requiresBuildRecipe(strategy: ProductInventoryStrategy): boolean {
  return strategy === "recipe_managed";
}

export function calculateSellableVariantAtp(input: {
  strategy: ProductInventoryStrategy;
  unitsPerVariant: number;
  sharedAtpBase: number;
  directAtpUnits: number;
}): { atpUnits: number; atpBase: number } {
  if (!Number.isSafeInteger(input.unitsPerVariant) || input.unitsPerVariant <= 0) {
    throw new RangeError("unitsPerVariant must be a positive safe integer");
  }
  if (!Number.isFinite(input.sharedAtpBase) || !Number.isFinite(input.directAtpUnits)) {
    throw new RangeError("ATP inputs must be finite numbers");
  }

  if (usesFungibleBaseUnitPool(input.strategy)) {
    const atpBase = Math.max(0, Math.floor(input.sharedAtpBase));
    return {
      atpUnits: Math.floor(atpBase / input.unitsPerVariant),
      atpBase,
    };
  }

  const atpUnits = Math.max(0, Math.floor(input.directAtpUnits));
  return {
    atpUnits,
    atpBase: atpUnits * input.unitsPerVariant,
  };
}
