import { describe, expect, it } from "vitest";
import {
  ProductInventoryStrategyError,
  assertProductInventoryStrategyTransition,
  parseProductInventoryStrategy,
} from "../../inventory-strategy-policy";

describe("product inventory strategy policy", () => {
  it("defaults missing create values without defaulting omitted updates", () => {
    expect(parseProductInventoryStrategy(undefined, { useDefaultWhenMissing: true })).toBe("physical_fungible");
    expect(parseProductInventoryStrategy(undefined, { useDefaultWhenMissing: false })).toBeUndefined();
  });

  it("rejects unknown values with a boundary error", () => {
    expect(() => parseProductInventoryStrategy("build", { useDefaultWhenMissing: false })).toThrowError(
      expect.objectContaining<ProductInventoryStrategyError>({
        code: "INVALID_INVENTORY_STRATEGY",
        statusCode: 400,
      }),
    );
  });

  it("blocks abandoning recipe management while recipes remain", () => {
    expect(() => assertProductInventoryStrategyTransition({
      productId: 12,
      current: "recipe_managed",
      requested: "physical_fungible",
      hasBuildRecipes: true,
    })).toThrowError(
      expect.objectContaining<ProductInventoryStrategyError>({
        code: "INVENTORY_STRATEGY_HAS_RECIPES",
        statusCode: 409,
      }),
    );
  });

  it("allows reviewed transitions when no recipes would be orphaned", () => {
    expect(() => assertProductInventoryStrategyTransition({
      productId: 12,
      current: "physical_fungible",
      requested: "recipe_managed",
      hasBuildRecipes: false,
    })).not.toThrow();
    expect(() => assertProductInventoryStrategyTransition({
      productId: 12,
      current: "recipe_managed",
      requested: "physical_only",
      hasBuildRecipes: false,
    })).not.toThrow();
  });
});
