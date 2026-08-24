import { describe, expect, it } from "vitest";

import {
  calculateRecipeCapacity,
  planRecipeDemand,
  RecipeCapacityError,
  type RecipeDefinition,
  type WarehouseRecipeSnapshot,
} from "../../domain/recipe-capacity.domain";

const WAREHOUSE_ID = 1;

function snapshot(input: {
  recipes?: RecipeDefinition[];
  stock?: WarehouseRecipeSnapshot["stock"];
  outputLocations?: Array<[number, number]>;
} = {}): WarehouseRecipeSnapshot {
  return {
    warehouseId: WAREHOUSE_ID,
    recipes: input.recipes ?? [],
    stock: input.stock ?? [],
    outputLocations: new Map(input.outputLocations ?? []),
  };
}

const eaAssembly: RecipeDefinition = {
  id: 10,
  outputVariantId: 100,
  outputProductId: 1000,
  outputQty: 1,
  components: [
    { variantId: 1, productId: 1001, qtyPerBuild: 1 },
    { variantId: 2, productId: 1002, qtyPerBuild: 1 },
    { variantId: 3, productId: 1003, qtyPerBuild: 1 },
  ],
};

const p5Conversion: RecipeDefinition = {
  id: 20,
  outputVariantId: 200,
  outputProductId: 1000,
  outputQty: 1,
  components: [{ variantId: 100, productId: 1000, qtyPerBuild: 5 }],
};

const c25Conversion: RecipeDefinition = {
  id: 30,
  outputVariantId: 300,
  outputProductId: 1000,
  outputQty: 1,
  components: [{ variantId: 100, productId: 1000, qtyPerBuild: 25 }],
};

function rawStock(qty: number): WarehouseRecipeSnapshot["stock"] {
  return [
    { variantId: 1, locationId: 11, availableQty: qty },
    { variantId: 2, locationId: 12, availableQty: qty },
    { variantId: 3, locationId: 13, availableQty: qty },
  ];
}

describe("recipe capacity domain", () => {
  it("uses exact finished stock without creating build nodes", () => {
    const plan = planRecipeDemand(snapshot({
      stock: [{ variantId: 200, locationId: 21, availableQty: 7 }],
    }), 200, 7);

    expect(plan).toMatchObject({
      sourceLocationId: 21,
      requestedQty: 7,
      directAllocations: [{ sourceLocationId: 21, qty: 7 }],
      rootNodeKey: null,
      nodes: [],
    });
    expect(calculateRecipeCapacity(snapshot({
      stock: [{ variantId: 200, locationId: 21, availableQty: 7 }],
    }), 200)).toBe(7);
  });

  it("uses finished stock first and builds only the remaining demand", () => {
    const plan = planRecipeDemand(snapshot({
      recipes: [eaAssembly, p5Conversion],
      stock: [
        ...rawStock(10),
        { variantId: 200, locationId: 21, availableQty: 1 },
      ],
      outputLocations: [[100, 20], [200, 21]],
    }), 200, 2);

    expect(plan.directAllocations).toEqual([{ sourceLocationId: 21, qty: 1 }]);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]).toMatchObject({
      recipeId: 10,
      plannedBuilds: 5,
      outputQty: 5,
    });
    expect(plan.nodes[1]).toMatchObject({
      recipeId: 20,
      plannedBuilds: 1,
      outputQty: 1,
      components: [{ variantId: 100, requiredQty: 5 }],
    });
  });

  it("plans a nested pack conversion through the each assembly", () => {
    const plan = planRecipeDemand(snapshot({
      recipes: [eaAssembly, p5Conversion],
      stock: rawStock(10),
      outputLocations: [[100, 20], [200, 21]],
    }), 200, 2);

    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]).toMatchObject({
      recipeId: 10,
      outputVariantId: 100,
      plannedBuilds: 10,
      outputQty: 10,
    });
    expect(plan.nodes[1]).toMatchObject({
      recipeId: 20,
      outputVariantId: 200,
      plannedBuilds: 2,
      outputQty: 2,
      components: [{
        variantId: 100,
        requiredQty: 10,
        sourceLocationId: 20,
        prerequisiteNodeKey: "root.1",
      }],
    });
    expect(plan.rootNodeKey).toBe("root");
  });

  it("adds direct finished stock to independently buildable P5 and C25 capacity", () => {
    const common = {
      recipes: [eaAssembly, p5Conversion, c25Conversion],
      stock: [
        ...rawStock(2_200),
        { variantId: 200, locationId: 21, availableQty: 2 },
        { variantId: 300, locationId: 22, availableQty: 84 },
      ],
      outputLocations: [[100, 20], [200, 21], [300, 22]] as Array<[number, number]>,
    };

    expect(calculateRecipeCapacity(snapshot(common), 200)).toBe(442);
    expect(calculateRecipeCapacity(snapshot(common), 300)).toBe(172);
  });

  it("uses one deterministic finished-goods location and builds any remainder", () => {
    const plan = planRecipeDemand(snapshot({
      recipes: [p5Conversion],
      stock: [
        { variantId: 200, locationId: 23, availableQty: 2 },
        { variantId: 200, locationId: 21, availableQty: 3 },
        { variantId: 200, locationId: 22, availableQty: 3 },
        { variantId: 100, locationId: 20, availableQty: 20 },
      ],
      outputLocations: [[200, 21]],
    }), 200, 7);

    expect(plan.directAllocations).toEqual([{ sourceLocationId: 21, qty: 3 }]);
    expect(plan.nodes).toEqual([expect.objectContaining({
      outputVariantId: 200,
      plannedBuilds: 4,
      outputQty: 4,
    })]);
  });

  it("does not mix non-output-location stock into a build promise", () => {
    const plan = planRecipeDemand(snapshot({
      recipes: [p5Conversion],
      stock: [
        { variantId: 200, locationId: 23, availableQty: 2 },
        { variantId: 100, locationId: 20, availableQty: 10 },
      ],
      outputLocations: [[200, 21]],
    }), 200, 2);

    expect(plan.directAllocations).toEqual([]);
    expect(plan.nodes).toEqual([expect.objectContaining({
      outputLocationId: 21,
      plannedBuilds: 2,
    })]);
  });

  it("fails closed when active recipes are ambiguous", () => {
    const duplicate = { ...p5Conversion, id: 21 };
    expect(() => planRecipeDemand(snapshot({
      recipes: [p5Conversion, duplicate],
      stock: [{ variantId: 100, locationId: 20, availableQty: 5 }],
      outputLocations: [[200, 21]],
    }), 200, 1)).toThrowError(expect.objectContaining({
      code: "AMBIGUOUS_ACTIVE_RECIPE",
    }) as RecipeCapacityError);
  });

  it("rejects recipe cycles", () => {
    const cyclicEa: RecipeDefinition = {
      ...eaAssembly,
      components: [{ variantId: 200, productId: 1000, qtyPerBuild: 1 }],
    };
    expect(() => planRecipeDemand(snapshot({
      recipes: [cyclicEa, p5Conversion],
      outputLocations: [[100, 20], [200, 21]],
    }), 200, 1)).toThrowError(expect.objectContaining({ code: "RECIPE_CYCLE" }) as RecipeCapacityError);
  });

  it("requires an active output location for every planned output", () => {
    expect(() => planRecipeDemand(snapshot({
      recipes: [eaAssembly],
      stock: rawStock(1),
    }), 100, 1)).toThrowError(expect.objectContaining({
      code: "RECIPE_OUTPUT_LOCATION_REQUIRED",
    }) as RecipeCapacityError);
  });

  it("does not aggregate one component across locations because a build order has one source per component", () => {
    expect(() => planRecipeDemand(snapshot({
      recipes: [eaAssembly],
      stock: [
        { variantId: 1, locationId: 11, availableQty: 1 },
        { variantId: 1, locationId: 14, availableQty: 1 },
        { variantId: 2, locationId: 12, availableQty: 2 },
        { variantId: 3, locationId: 13, availableQty: 2 },
      ],
      outputLocations: [[100, 20]],
    }), 100, 2)).toThrowError(expect.objectContaining({
      code: "RECIPE_COMPONENT_SHORTAGE",
    }) as RecipeCapacityError);
  });
});
