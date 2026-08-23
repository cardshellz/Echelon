export type RecipeType = "conversion" | "assembly";

export type BuildVariantResult = {
  productVariantId: number;
  productId: number;
  unitsPerVariant: number;
  sku: string;
  name: string;
};

export type RecipeComponentDraft = {
  key: number;
  variant: BuildVariantResult | null;
  qtyPerBuild: string;
};

export type RecipeEvidence = {
  valid: boolean;
  inputBaseUnits: bigint;
  outputBaseUnits: bigint;
  message: string;
};

export function calculateRecipeEvidence(input: {
  recipeType: RecipeType;
  outputVariant: BuildVariantResult | null;
  outputQty: string;
  components: RecipeComponentDraft[];
}): RecipeEvidence | null {
  const outputQty = Number(input.outputQty);
  if (
    !input.outputVariant
    || !Number.isSafeInteger(outputQty)
    || outputQty <= 0
    || !Number.isSafeInteger(input.outputVariant.unitsPerVariant)
    || input.outputVariant.unitsPerVariant <= 0
    || input.components.length === 0
  ) {
    return null;
  }

  let inputBaseUnits = BigInt(0);
  let sameProduct = true;
  let duplicateComponent = false;
  let outputUsedAsComponent = false;
  const componentVariantIds = new Set<number>();
  for (const component of input.components) {
    const qty = Number(component.qtyPerBuild);
    if (
      !component.variant
      || !Number.isSafeInteger(qty)
      || qty <= 0
      || !Number.isSafeInteger(component.variant.unitsPerVariant)
      || component.variant.unitsPerVariant <= 0
    ) {
      return null;
    }
    outputUsedAsComponent = outputUsedAsComponent
      || component.variant.productVariantId === input.outputVariant.productVariantId;
    duplicateComponent = duplicateComponent
      || componentVariantIds.has(component.variant.productVariantId);
    componentVariantIds.add(component.variant.productVariantId);
    inputBaseUnits += BigInt(qty) * BigInt(component.variant.unitsPerVariant);
    sameProduct = sameProduct && component.variant.productId === input.outputVariant.productId;
  }

  const outputBaseUnits = BigInt(outputQty) * BigInt(input.outputVariant.unitsPerVariant);
  if (outputUsedAsComponent) {
    return { valid: false, inputBaseUnits, outputBaseUnits, message: "The output variant cannot also be a component." };
  }
  if (duplicateComponent) {
    return { valid: false, inputBaseUnits, outputBaseUnits, message: "Each component variant can only be added once." };
  }
  if (input.recipeType === "conversion") {
    if (!sameProduct) {
      return { valid: false, inputBaseUnits, outputBaseUnits, message: "Conversion variants must belong to one catalog product." };
    }
    const valid = inputBaseUnits === outputBaseUnits;
    return {
      valid,
      inputBaseUnits,
      outputBaseUnits,
      message: valid ? "Base units conserved." : "Input and output base units must match exactly.",
    };
  }

  return {
    valid: !sameProduct,
    inputBaseUnits,
    outputBaseUnits,
    message: sameProduct ? "Same-product repacks must use Conversion." : "Cross-product assembly.",
  };
}
