export const MAX_RECIPE_PROMISE_QTY = 1_000_000_000;

export type RecipeComponentDefinition = {
  variantId: number;
  productId: number;
  qtyPerBuild: number;
};

export type RecipeDefinition = {
  id: number;
  outputVariantId: number;
  outputProductId: number;
  outputQty: number;
  components: RecipeComponentDefinition[];
};

export type RecipeStockPosition = {
  variantId: number;
  locationId: number;
  availableQty: number;
};

export type RecipeFinishedVariantDefinition = {
  variantId: number;
  productId: number;
  unitsPerVariant: number;
};

export type RecipeFinishedStockPosition = RecipeFinishedVariantDefinition & {
  availableQty: number;
};

export type RecipePlanComponent = {
  variantId: number;
  requiredQty: number;
  sourceLocationId: number;
  prerequisiteNodeKey: string | null;
};

export type RecipePlanNode = {
  nodeKey: string;
  recipeId: number;
  outputVariantId: number;
  outputLocationId: number;
  plannedBuilds: number;
  outputQty: number;
  components: RecipePlanComponent[];
};

export type RecipeDirectAllocation = {
  sourceLocationId: number;
  qty: number;
};

export type WarehouseRecipeSnapshot = {
  warehouseId: number;
  recipes: RecipeDefinition[];
  stock: RecipeStockPosition[];
  finishedVariants: RecipeFinishedVariantDefinition[];
  finishedStock: RecipeFinishedStockPosition[];
  outputLocations: ReadonlyMap<number, number>;
};

export type RecipeDemandPlan = {
  warehouseId: number;
  targetVariantId: number;
  requestedQty: number;
  sourceLocationId: number;
  directAllocations: RecipeDirectAllocation[];
  nodes: RecipePlanNode[];
  rootNodeKey: string | null;
};

export class RecipeCapacityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RecipeCapacityError";
  }
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RecipeCapacityError("INVALID_RECIPE_CAPACITY_INPUT", `${field} must be a positive safe integer`, {
      field,
      value,
    });
  }
  return value;
}

function safeMultiply(left: number, right: number, context: Record<string, unknown>): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > MAX_RECIPE_PROMISE_QTY) {
    throw new RecipeCapacityError("RECIPE_CAPACITY_OVERFLOW", "Recipe quantity exceeds the supported promise range", {
      ...context,
      left,
      right,
    });
  }
  return result;
}

function makeRecipeMap(recipes: RecipeDefinition[]): Map<number, RecipeDefinition> {
  const result = new Map<number, RecipeDefinition>();
  for (const recipe of recipes) {
    positiveSafeInteger(recipe.id, "recipe.id");
    positiveSafeInteger(recipe.outputVariantId, "recipe.outputVariantId");
    positiveSafeInteger(recipe.outputQty, "recipe.outputQty");
    if (result.has(recipe.outputVariantId)) {
      throw new RecipeCapacityError(
        "AMBIGUOUS_ACTIVE_RECIPE",
        `Variant ${recipe.outputVariantId} has more than one active recipe`,
        { outputVariantId: recipe.outputVariantId },
      );
    }
    if (recipe.components.length === 0) {
      throw new RecipeCapacityError("EMPTY_ACTIVE_RECIPE", `Recipe ${recipe.id} has no components`, {
        recipeId: recipe.id,
      });
    }
    for (const component of recipe.components) {
      positiveSafeInteger(component.variantId, "component.variantId");
      positiveSafeInteger(component.qtyPerBuild, "component.qtyPerBuild");
    }
    result.set(recipe.outputVariantId, recipe);
  }
  return result;
}

function makeStockMap(stock: RecipeStockPosition[]): Map<number, Map<number, number>> {
  const result = new Map<number, Map<number, number>>();
  for (const position of stock) {
    positiveSafeInteger(position.variantId, "stock.variantId");
    positiveSafeInteger(position.locationId, "stock.locationId");
    if (!Number.isSafeInteger(position.availableQty) || position.availableQty < 0) {
      throw new RecipeCapacityError("INVALID_RECIPE_STOCK", "Available inventory must be a non-negative safe integer", {
        position,
      });
    }
    const locations = result.get(position.variantId) ?? new Map<number, number>();
    locations.set(position.locationId, (locations.get(position.locationId) ?? 0) + position.availableQty);
    result.set(position.variantId, locations);
  }
  return result;
}

function makeFinishedVariantMap(
  variants: RecipeFinishedVariantDefinition[],
): Map<number, RecipeFinishedVariantDefinition> {
  const result = new Map<number, RecipeFinishedVariantDefinition>();
  for (const variant of variants) {
    positiveSafeInteger(variant.variantId, "finishedVariant.variantId");
    positiveSafeInteger(variant.productId, "finishedVariant.productId");
    positiveSafeInteger(variant.unitsPerVariant, "finishedVariant.unitsPerVariant");
    if (result.has(variant.variantId)) {
      throw new RecipeCapacityError("DUPLICATE_FINISHED_VARIANT", `Finished variant ${variant.variantId} is duplicated`, {
        variantId: variant.variantId,
      });
    }
    result.set(variant.variantId, variant);
  }
  return result;
}

function makeFinishedPoolMap(stock: RecipeFinishedStockPosition[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const position of stock) {
    positiveSafeInteger(position.variantId, "finishedStock.variantId");
    positiveSafeInteger(position.productId, "finishedStock.productId");
    positiveSafeInteger(position.unitsPerVariant, "finishedStock.unitsPerVariant");
    if (!Number.isSafeInteger(position.availableQty)) {
      throw new RecipeCapacityError("INVALID_FINISHED_STOCK", "Finished inventory must be a signed safe integer", {
        position,
      });
    }
    const availableBase = position.availableQty * position.unitsPerVariant;
    if (!Number.isSafeInteger(availableBase)) {
      throw new RecipeCapacityError("RECIPE_CAPACITY_OVERFLOW", "Finished inventory exceeds the supported range", {
        position,
      });
    }
    const nextTotal = (result.get(position.productId) ?? 0) + availableBase;
    if (!Number.isSafeInteger(nextTotal)) {
      throw new RecipeCapacityError("RECIPE_CAPACITY_OVERFLOW", "Finished inventory pool exceeds the supported range", {
        productId: position.productId,
      });
    }
    result.set(position.productId, nextTotal);
  }
  for (const [productId, availableBase] of result) {
    result.set(productId, Math.max(0, availableBase));
  }
  return result;
}

function consumeFinishedPool(
  pools: Map<number, number>,
  variant: RecipeFinishedVariantDefinition | undefined,
  requestedQty: number,
  outputLocationId: number | undefined,
  allowPartial: boolean,
): RecipeDirectAllocation | null {
  if (!variant || outputLocationId == null) return null;
  const availableBase = pools.get(variant.productId) ?? 0;
  const availableQty = Math.floor(availableBase / variant.unitsPerVariant);
  if (availableQty <= 0 || (!allowPartial && availableQty < requestedQty)) return null;

  const qty = allowPartial ? Math.min(requestedQty, availableQty) : requestedQty;
  pools.set(variant.productId, availableBase - (qty * variant.unitsPerVariant));
  return { sourceLocationId: outputLocationId, qty };
}

function locationWithEnough(
  stock: Map<number, Map<number, number>>,
  variantId: number,
  qty: number,
): number | null {
  const candidates = [...(stock.get(variantId)?.entries() ?? [])]
    .filter(([, available]) => available >= qty)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  return candidates[0]?.[0] ?? null;
}

function consume(
  stock: Map<number, Map<number, number>>,
  variantId: number,
  locationId: number,
  qty: number,
): void {
  const locations = stock.get(variantId);
  const available = locations?.get(locationId) ?? 0;
  if (available < qty) {
    throw new RecipeCapacityError("RECIPE_COMPONENT_SHORTAGE", `Variant ${variantId} is short at location ${locationId}`, {
      variantId,
      locationId,
      requiredQty: qty,
      availableQty: available,
    });
  }
  locations!.set(locationId, available - qty);
}

function consumeDirectTargetStock(
  stock: Map<number, Map<number, number>>,
  variantId: number,
  requestedQty: number,
  outputLocationId: number | undefined,
): RecipeDirectAllocation[] {
  const locations = stock.get(variantId);
  if (outputLocationId != null && locations) {
    for (const locationId of locations.keys()) {
      if (locationId !== outputLocationId) locations.set(locationId, 0);
    }
  }

  const candidates = [...(stock.get(variantId)?.entries() ?? [])]
    .filter(([, availableQty]) => availableQty > 0)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  const selected = outputLocationId == null
    ? candidates[0]
    : candidates.find(([locationId]) => locationId === outputLocationId);
  if (!selected) return [];

  const [sourceLocationId, availableQty] = selected;
  const qty = Math.min(availableQty, requestedQty);
  consume(stock, variantId, sourceLocationId, qty);
  return [{ sourceLocationId, qty }];
}

function addStock(
  stock: Map<number, Map<number, number>>,
  variantId: number,
  locationId: number,
  qty: number,
): void {
  const locations = stock.get(variantId) ?? new Map<number, number>();
  locations.set(locationId, (locations.get(locationId) ?? 0) + qty);
  stock.set(variantId, locations);
}

type SatisfiedRequirement = {
  sourceLocationId: number;
  prerequisiteNodeKey: string | null;
};

export function planRecipeDemand(
  snapshot: WarehouseRecipeSnapshot,
  targetVariantId: number,
  requestedQty: number,
): RecipeDemandPlan {
  positiveSafeInteger(snapshot.warehouseId, "warehouseId");
  positiveSafeInteger(targetVariantId, "targetVariantId");
  positiveSafeInteger(requestedQty, "requestedQty");

  const recipes = makeRecipeMap(snapshot.recipes);
  const stock = makeStockMap(snapshot.stock);
  const finishedVariants = makeFinishedVariantMap(snapshot.finishedVariants);
  const finishedPools = makeFinishedPoolMap(snapshot.finishedStock);
  // Finished variants belonging to a recipe output product share one base-unit
  // pool. Remove their exact-SKU rows from component stock so the same physical
  // units cannot be consumed once as finished supply and again as recipe input.
  for (const variantId of finishedVariants.keys()) stock.delete(variantId);
  const nodes: RecipePlanNode[] = [];
  // Normalize the shared finished-package pool into target units at the
  // target's assigned output location, then build only the remaining demand.
  const targetOutputLocationId = snapshot.outputLocations.get(targetVariantId);
  const pooledTarget = consumeFinishedPool(
    finishedPools,
    finishedVariants.get(targetVariantId),
    requestedQty,
    targetOutputLocationId,
    true,
  );
  const directAllocations = pooledTarget
    ? [pooledTarget]
    : consumeDirectTargetStock(stock, targetVariantId, requestedQty, targetOutputLocationId);
  const directQty = directAllocations.reduce((total, allocation) => total + allocation.qty, 0);
  const buildQty = requestedQty - directQty;

  const satisfy = (
    variantId: number,
    qty: number,
    path: string,
    stack: ReadonlySet<number>,
  ): SatisfiedRequirement => {
    const pooled = consumeFinishedPool(
      finishedPools,
      finishedVariants.get(variantId),
      qty,
      snapshot.outputLocations.get(variantId),
      false,
    );
    if (pooled) {
      return { sourceLocationId: pooled.sourceLocationId, prerequisiteNodeKey: null };
    }

    const directLocation = locationWithEnough(stock, variantId, qty);
    if (directLocation != null) {
      consume(stock, variantId, directLocation, qty);
      return { sourceLocationId: directLocation, prerequisiteNodeKey: null };
    }

    const recipe = recipes.get(variantId);
    if (!recipe) {
      throw new RecipeCapacityError("RECIPE_COMPONENT_SHORTAGE", `Variant ${variantId} has insufficient physical stock and no active recipe`, {
        warehouseId: snapshot.warehouseId,
        variantId,
        requiredQty: qty,
      });
    }
    if (stack.has(variantId)) {
      throw new RecipeCapacityError("RECIPE_CYCLE", `Recipe graph contains a cycle at variant ${variantId}`, {
        warehouseId: snapshot.warehouseId,
        variantId,
        path,
      });
    }

    const outputLocationId = snapshot.outputLocations.get(variantId);
    if (!outputLocationId) {
      throw new RecipeCapacityError("RECIPE_OUTPUT_LOCATION_REQUIRED", `Variant ${variantId} has no active output location in warehouse ${snapshot.warehouseId}`, {
        warehouseId: snapshot.warehouseId,
        variantId,
      });
    }
    const plannedBuilds = Math.ceil(qty / recipe.outputQty);
    const producedQty = safeMultiply(plannedBuilds, recipe.outputQty, {
      recipeId: recipe.id,
      outputVariantId: variantId,
    });
    const nextStack = new Set(stack);
    nextStack.add(variantId);
    const components = recipe.components
      .slice()
      .sort((left, right) => left.variantId - right.variantId)
      .map((component, index): RecipePlanComponent => {
        const requiredQty = safeMultiply(plannedBuilds, component.qtyPerBuild, {
          recipeId: recipe.id,
          componentVariantId: component.variantId,
        });
        const requirement = satisfy(component.variantId, requiredQty, `${path}.${index + 1}`, nextStack);
        return {
          variantId: component.variantId,
          requiredQty,
          sourceLocationId: requirement.sourceLocationId,
          prerequisiteNodeKey: requirement.prerequisiteNodeKey,
        };
      });
    const nodeKey = path;
    nodes.push({
      nodeKey,
      recipeId: recipe.id,
      outputVariantId: variantId,
      outputLocationId,
      plannedBuilds,
      outputQty: producedQty,
      components,
    });
    addStock(stock, variantId, outputLocationId, producedQty);
    consume(stock, variantId, outputLocationId, qty);
    return { sourceLocationId: outputLocationId, prerequisiteNodeKey: nodeKey };
  };

  const target = buildQty > 0
    ? satisfy(targetVariantId, buildQty, "root", new Set<number>())
    : {
        sourceLocationId: directAllocations[0]!.sourceLocationId,
        prerequisiteNodeKey: null,
      };
  return {
    warehouseId: snapshot.warehouseId,
    targetVariantId,
    requestedQty,
    sourceLocationId: target.sourceLocationId,
    directAllocations,
    nodes,
    rootNodeKey: target.prerequisiteNodeKey,
  };
}

export function calculateRecipeCapacity(
  snapshot: WarehouseRecipeSnapshot,
  targetVariantId: number,
): number {
  let low = 0;
  let high = 1;
  const canSatisfy = (qty: number): boolean => {
    try {
      planRecipeDemand(snapshot, targetVariantId, qty);
      return true;
    } catch (error) {
      if (error instanceof RecipeCapacityError) return false;
      throw error;
    }
  };

  while (high < MAX_RECIPE_PROMISE_QTY && canSatisfy(high)) {
    low = high;
    high = Math.min(MAX_RECIPE_PROMISE_QTY, high * 2);
  }
  if (high === MAX_RECIPE_PROMISE_QTY && canSatisfy(high)) return high;

  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (canSatisfy(middle)) low = middle;
    else high = middle;
  }
  return low;
}
