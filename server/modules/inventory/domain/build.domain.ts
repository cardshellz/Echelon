export type BuildCostTotals = {
  poMills: bigint;
  packagingMills: bigint;
  landedMills: bigint;
};

export type BuildCostLayer = BuildCostTotals & {
  qty: number;
  totalMills: bigint;
};
export const BUILD_RECIPE_TYPES = ["conversion", "assembly"] as const;

export type BuildRecipeType = (typeof BUILD_RECIPE_TYPES)[number];

export type BuildVariantFacts = {
  variantId: number;
  productId: number;
  unitsPerVariant: number;
};

export type BuildVariantSnapshot = BuildVariantFacts;

export type BuildRecipeConservation = {
  recipeType: BuildRecipeType;
  sameProduct: boolean;
  inputBaseUnits: number;
  outputBaseUnits: number;
};

export class BuildDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BuildDomainError";
  }
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BuildDomainError(
      "INVALID_BUILD_INPUT",
      `${field} must be a positive safe integer`,
      { field, value },
    );
  }
  return value;
}
export function requireBuildRecipeType(value: unknown): BuildRecipeType {
  if (value !== "conversion" && value !== "assembly") {
    throw new BuildDomainError(
      "INVALID_BUILD_RECIPE_TYPE",
      "recipeType must be conversion or assembly",
      { field: "recipeType", value },
    );
  }
  return value;
}

function multiplyBaseUnits(quantity: number, unitsPerVariant: number, field: string): number {
  const normalizedQuantity = requirePositiveInteger(quantity, field + ".quantity");
  const normalizedUnits = requirePositiveInteger(unitsPerVariant, field + ".unitsPerVariant");
  const result = normalizedQuantity * normalizedUnits;
  if (!Number.isSafeInteger(result)) {
    throw new BuildDomainError(
      "BUILD_QUANTITY_OVERFLOW",
      field + " base-unit quantity exceeds the safe integer range",
      { field, quantity: normalizedQuantity, unitsPerVariant: normalizedUnits },
    );
  }
  return result;
}

export function validateBuildRecipeDefinition(input: {
  recipeType: unknown;
  output: BuildVariantFacts & { qtyPerBuild: number };
  components: Array<BuildVariantFacts & { qtyPerBuild: number }>;
}): BuildRecipeConservation {
  const recipeType = requireBuildRecipeType(input.recipeType);
  if (input.components.length === 0) {
    throw new BuildDomainError("BUILD_RECIPE_EMPTY", "A build recipe must contain at least one component");
  }

  const outputVariantId = requirePositiveInteger(input.output.variantId, "output.variantId");
  const outputProductId = requirePositiveInteger(input.output.productId, "output.productId");
  const outputBaseUnits = multiplyBaseUnits(
    input.output.qtyPerBuild,
    input.output.unitsPerVariant,
    "output",
  );
  let inputBaseUnits = 0;
  let sameProduct = true;

  const componentVariantIds = new Set<number>();
  for (const [index, component] of input.components.entries()) {
    const componentVariantId = requirePositiveInteger(
      component.variantId,
      "components[" + index + "].variantId",
    );
    if (componentVariantId === outputVariantId) {
      throw new BuildDomainError(
        "BUILD_OUTPUT_IS_COMPONENT",
        "A build output cannot also be one of its own components",
        { outputVariantId },
      );
    }
    if (componentVariantIds.has(componentVariantId)) {
      throw new BuildDomainError(
        "DUPLICATE_BUILD_COMPONENT",
        "Component variant " + componentVariantId + " appears more than once",
        { componentVariantId },
      );
    }
    componentVariantIds.add(componentVariantId);
    const productId = requirePositiveInteger(component.productId, "components[" + index + "].productId");
    const componentBaseUnits = multiplyBaseUnits(
      component.qtyPerBuild,
      component.unitsPerVariant,
      "components[" + index + "]",
    );
    inputBaseUnits += componentBaseUnits;
    if (!Number.isSafeInteger(inputBaseUnits)) {
      throw new BuildDomainError(
        "BUILD_QUANTITY_OVERFLOW",
        "Component base-unit quantity exceeds the safe integer range",
      );
    }
    sameProduct = sameProduct && productId === outputProductId;
  }

  if (recipeType === "conversion") {
    if (!sameProduct) {
      throw new BuildDomainError(
        "BUILD_CONVERSION_PRODUCT_MISMATCH",
        "A conversion must use variants from the same catalog product",
        { outputVariantId },
      );
    }
    if (inputBaseUnits !== outputBaseUnits) {
      throw new BuildDomainError(
        "BUILD_CONVERSION_NOT_CONSERVED",
        "A conversion must preserve the exact number of base units",
        { outputVariantId, inputBaseUnits, outputBaseUnits },
      );
    }
  } else if (sameProduct) {
    throw new BuildDomainError(
      "BUILD_ASSEMBLY_REQUIRES_CROSS_PRODUCT_COMPONENT",
      "A same-product recipe must be classified as a conversion",
      { outputVariantId },
    );
  }

  return { recipeType, sameProduct, inputBaseUnits, outputBaseUnits };
}

export function assertBuildVariantSnapshotsCurrent(input: {
  snapshots: BuildVariantSnapshot[];
  currentVariants: ReadonlyMap<number, BuildVariantFacts>;
  context?: Record<string, unknown>;
}): void {
  for (const snapshot of input.snapshots) {
    const current = input.currentVariants.get(snapshot.variantId);
    if (!current) {
      throw new BuildDomainError(
        "BUILD_VARIANT_UNAVAILABLE",
        "Build variant " + snapshot.variantId + " is unavailable",
        { ...input.context, variantId: snapshot.variantId },
      );
    }
    if (
      current.productId !== snapshot.productId
      || current.unitsPerVariant !== snapshot.unitsPerVariant
    ) {
      throw new BuildDomainError(
        "BUILD_CATALOG_CONFIGURATION_CHANGED",
        "Catalog configuration changed for build variant " + snapshot.variantId,
        {
          ...input.context,
          variantId: snapshot.variantId,
          snapshotProductId: snapshot.productId,
          currentProductId: current.productId,
          snapshotUnitsPerVariant: snapshot.unitsPerVariant,
          currentUnitsPerVariant: current.unitsPerVariant,
        },
      );
    }
  }
}

export function calculateBuildQuantities(input: {
  plannedBuilds: number;
  outputQtyPerBuild: number;
  components: Array<{ componentVariantId: number; qtyPerBuild: number }>;
}): {
  outputQty: number;
  components: Array<{ componentVariantId: number; requiredQty: number }>;
} {
  const plannedBuilds = requirePositiveInteger(input.plannedBuilds, "plannedBuilds");
  const outputQtyPerBuild = requirePositiveInteger(input.outputQtyPerBuild, "outputQtyPerBuild");
  const outputQty = plannedBuilds * outputQtyPerBuild;
  if (!Number.isSafeInteger(outputQty)) {
    throw new BuildDomainError("BUILD_QUANTITY_OVERFLOW", "Output quantity exceeds the safe integer range");
  }

  if (input.components.length === 0) {
    throw new BuildDomainError("BUILD_RECIPE_EMPTY", "A build recipe must contain at least one component");
  }

  const seen = new Set<number>();
  const components = input.components.map((component, index) => {
    const componentVariantId = requirePositiveInteger(
      component.componentVariantId,
      `components[${index}].componentVariantId`,
    );
    const qtyPerBuild = requirePositiveInteger(component.qtyPerBuild, `components[${index}].qtyPerBuild`);
    if (seen.has(componentVariantId)) {
      throw new BuildDomainError(
        "DUPLICATE_BUILD_COMPONENT",
        `Component variant ${componentVariantId} appears more than once`,
        { componentVariantId },
      );
    }
    seen.add(componentVariantId);
    const requiredQty = plannedBuilds * qtyPerBuild;
    if (!Number.isSafeInteger(requiredQty)) {
      throw new BuildDomainError(
        "BUILD_QUANTITY_OVERFLOW",
        `Required quantity for component ${componentVariantId} exceeds the safe integer range`,
        { componentVariantId },
      );
    }
    return { componentVariantId, requiredQty };
  });

  return { outputQty, components };
}

export type BuildRunQuantities = {
  buildsCompleted: number;
  remainingBuildsBefore: number;
  remainingBuildsAfter: number;
  outputQty: number;
  components: Array<{ componentVariantId: number; requiredQty: number }>;
};

export function calculateBuildRunQuantities(input: {
  plannedBuilds: number;
  completedBuilds: number;
  requestedBuilds: number;
  outputQtyPerBuild: number;
  components: Array<{ componentVariantId: number; qtyPerBuild: number }>;
}): BuildRunQuantities {
  const plannedBuilds = requirePositiveInteger(input.plannedBuilds, "plannedBuilds");
  if (!Number.isSafeInteger(input.completedBuilds) || input.completedBuilds < 0) {
    throw new BuildDomainError(
      "INVALID_BUILD_PROGRESS",
      "completedBuilds must be a non-negative safe integer",
      { completedBuilds: input.completedBuilds },
    );
  }
  if (input.completedBuilds > plannedBuilds) {
    throw new BuildDomainError(
      "INVALID_BUILD_PROGRESS",
      "completedBuilds cannot exceed plannedBuilds",
      { plannedBuilds, completedBuilds: input.completedBuilds },
    );
  }

  const requestedBuilds = requirePositiveInteger(input.requestedBuilds, "requestedBuilds");
  const remainingBuildsBefore = plannedBuilds - input.completedBuilds;
  if (requestedBuilds > remainingBuildsBefore) {
    throw new BuildDomainError(
      "BUILD_RUN_EXCEEDS_REMAINING",
      `Build run requests ${requestedBuilds} builds but only ${remainingBuildsBefore} remain`,
      { requestedBuilds, remainingBuilds: remainingBuildsBefore },
    );
  }

  const quantities = calculateBuildQuantities({
    plannedBuilds: requestedBuilds,
    outputQtyPerBuild: input.outputQtyPerBuild,
    components: input.components,
  });
  return {
    buildsCompleted: requestedBuilds,
    remainingBuildsBefore,
    remainingBuildsAfter: remainingBuildsBefore - requestedBuilds,
    ...quantities,
  };
}

export type BuildReversalProgress = {
  completedBuilds: number;
  status: "released" | "in_progress";
};

export function calculateBuildReversalProgress(input: {
  completedBuilds: number;
  reversedBuilds: number;
}): BuildReversalProgress {
  if (!Number.isSafeInteger(input.completedBuilds) || input.completedBuilds < 0) {
    throw new BuildDomainError(
      "INVALID_BUILD_PROGRESS",
      "completedBuilds must be a non-negative safe integer",
      { completedBuilds: input.completedBuilds },
    );
  }
  const reversedBuilds = requirePositiveInteger(input.reversedBuilds, "reversedBuilds");
  if (reversedBuilds > input.completedBuilds) {
    throw new BuildDomainError(
      "INVALID_BUILD_PROGRESS",
      "A reversal cannot remove more builds than have been completed",
      { completedBuilds: input.completedBuilds, reversedBuilds },
    );
  }
  const completedBuilds = input.completedBuilds - reversedBuilds;
  return {
    completedBuilds,
    status: completedBuilds === 0 ? "released" : "in_progress",
  };
}

export function assertBuildRunOutputUntouched(input: {
  buildRunId: number;
  latestPostedRunId: number;
  outputLocationId: number;
  outputLots: Array<{
    lotId: number;
    warehouseLocationId: number;
    qtyReceived: number;
    qtyOnHand: number;
    qtyReserved: number;
    qtyPicked: number;
  }>;
}): void {
  if (input.buildRunId !== input.latestPostedRunId) {
    throw new BuildDomainError(
      "BUILD_REVERSAL_NOT_LATEST_RUN",
      "Only the latest posted build run can be reversed",
      { buildRunId: input.buildRunId, latestPostedRunId: input.latestPostedRunId },
    );
  }
  const changedLot = input.outputLots.find((lot) =>
    lot.warehouseLocationId !== input.outputLocationId
    || lot.qtyOnHand !== lot.qtyReceived
    || lot.qtyReserved !== 0
    || lot.qtyPicked !== 0
  );
  if (changedLot) {
    throw new BuildDomainError(
      "BUILD_OUTPUT_ALREADY_USED",
      "Build output cannot be reversed after it has been moved, reserved, or consumed",
      { buildRunId: input.buildRunId, lotId: changedLot.lotId },
    );
  }
}

/**
 * Allocate exact integer-mill component cost across output units. A remainder
 * is represented as an additional cost layer instead of being rounded away.
 * The resulting layers therefore preserve both total value and its PO,
 * packaging, and landed-cost breakdown exactly.
 */
export function allocateBuildCostLayers(totals: BuildCostTotals, outputQty: number): BuildCostLayer[] {
  requirePositiveInteger(outputQty, "outputQty");
  for (const [field, value] of Object.entries(totals)) {
    if (value < BigInt(0)) {
      throw new BuildDomainError("NEGATIVE_BUILD_COST", `${field} cannot be negative`, {
        field,
        value: value.toString(),
      });
    }
  }

  const quantity = BigInt(outputQty);
  const categories = [totals.poMills, totals.packagingMills, totals.landedMills] as const;
  const bases = categories.map((value) => value / quantity);
  const remainders = categories.map((value) => Number(value % quantity));
  const boundaries = [...new Set([0, ...remainders, outputQty])].sort((a, b) => a - b);
  const layers: BuildCostLayer[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    const poMills = bases[0] + (start < remainders[0] ? BigInt(1) : BigInt(0));
    const packagingMills = bases[1] + (start < remainders[1] ? BigInt(1) : BigInt(0));
    const landedMills = bases[2] + (start < remainders[2] ? BigInt(1) : BigInt(0));
    layers.push({
      qty: end - start,
      poMills,
      packagingMills,
      landedMills,
      totalMills: poMills + packagingMills + landedMills,
    });
  }

  return layers;
}

export function sumLayerValue(layers: BuildCostLayer[]): BuildCostTotals & { totalMills: bigint } {
  return layers.reduce(
    (sum, layer) => ({
      poMills: sum.poMills + layer.poMills * BigInt(layer.qty),
      packagingMills: sum.packagingMills + layer.packagingMills * BigInt(layer.qty),
      landedMills: sum.landedMills + layer.landedMills * BigInt(layer.qty),
      totalMills: sum.totalMills + layer.totalMills * BigInt(layer.qty),
    }),
    { poMills: BigInt(0), packagingMills: BigInt(0), landedMills: BigInt(0), totalMills: BigInt(0) },
  );
}
