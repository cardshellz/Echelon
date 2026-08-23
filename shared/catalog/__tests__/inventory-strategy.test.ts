import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_INVENTORY_STRATEGY,
  PRODUCT_INVENTORY_STRATEGIES,
  allowsDirectPackageConversion,
  calculateSellableVariantAtp,
  requiresBuildRecipe,
  usesFungibleBaseUnitPool,
  getProductInventoryStrategyDefinition,
  isProductInventoryStrategy,
} from "../inventory-strategy";

describe("product inventory strategy", () => {
  it("keeps the legacy package hierarchy as the default", () => {
    expect(DEFAULT_PRODUCT_INVENTORY_STRATEGY).toBe("physical_fungible");
  });

  it.each(PRODUCT_INVENTORY_STRATEGIES)("accepts %s", (strategy) => {
    expect(isProductInventoryStrategy(strategy)).toBe(true);
    expect(getProductInventoryStrategyDefinition(strategy).strategy).toBe(strategy);
  });

  it.each([undefined, null, "", "build", "physical-fungible"])("rejects %s", (value) => {
    expect(isProductInventoryStrategy(value)).toBe(false);
  });

  it("keeps shared capacity only for physical package hierarchies", () => {
    expect(usesFungibleBaseUnitPool("physical_fungible")).toBe(true);
    expect(usesFungibleBaseUnitPool("recipe_managed")).toBe(false);
    expect(usesFungibleBaseUnitPool("physical_only")).toBe(false);
  });

  it("allows only the legacy strategy to bypass build recipes", () => {
    expect(allowsDirectPackageConversion("physical_fungible")).toBe(true);
    expect(allowsDirectPackageConversion("recipe_managed")).toBe(false);
    expect(allowsDirectPackageConversion("physical_only")).toBe(false);
    expect(requiresBuildRecipe("recipe_managed")).toBe(true);
    expect(requiresBuildRecipe("physical_fungible")).toBe(false);
  });

  it("advertises alternative pack capacities from one shared pool for physical package hierarchies", () => {
    expect(calculateSellableVariantAtp({
      strategy: "physical_fungible",
      unitsPerVariant: 5,
      sharedAtpBase: 2200,
      directAtpUnits: 0,
    })).toEqual({ atpUnits: 440, atpBase: 2200 });
    expect(calculateSellableVariantAtp({
      strategy: "physical_fungible",
      unitsPerVariant: 25,
      sharedAtpBase: 2200,
      directAtpUnits: 0,
    })).toEqual({ atpUnits: 88, atpBase: 2200 });
  });

  it("does not use the generic shared pool for recipe-managed products", () => {
    expect(calculateSellableVariantAtp({
      strategy: "recipe_managed",
      unitsPerVariant: 5,
      sharedAtpBase: 2200,
      directAtpUnits: 3,
    })).toEqual({ atpUnits: 3, atpBase: 15 });
  });

  it("does not borrow physical-only inventory across variants", () => {
    expect(calculateSellableVariantAtp({
      strategy: "physical_only",
      unitsPerVariant: 25,
      sharedAtpBase: 2200,
      directAtpUnits: 3,
    })).toEqual({ atpUnits: 3, atpBase: 75 });
  });

  it("rejects invalid variant conversion factors", () => {
    expect(() => calculateSellableVariantAtp({
      strategy: "recipe_managed",
      unitsPerVariant: 0,
      sharedAtpBase: 2200,
      directAtpUnits: 0,
    })).toThrow("unitsPerVariant must be a positive safe integer");
  });
});
