export type BuildCostTotals = {
  poMills: bigint;
  packagingMills: bigint;
  landedMills: bigint;
};

export type BuildCostLayer = BuildCostTotals & {
  qty: number;
  totalMills: bigint;
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
