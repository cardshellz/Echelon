import {
  type InventoryPlanningProductOptionsResponse,
  type SupplyTransformationsAdminView,
  type TransformationAdminBinding,
  type TransformationAdminModel,
  type TransformationAdminRecipe,
  type TransformationAdminVariant,
} from "@shared/types/inventory-availability-admin";

export type {
  SupplyTransformationsAdminView,
  TransformationAdminBinding,
  TransformationAdminModel,
  TransformationAdminRecipe,
  TransformationAdminVariant,
} from "@shared/types/inventory-availability-admin";

export type ProductOption = InventoryPlanningProductOptionsResponse["products"][number];

/** Approval is not runtime selection; a sealed head alone is not proof of use. */
export function transformationRuntimeLabel(
  view: Pick<SupplyTransformationsAdminView, "runtimeSelection" | "head" | "activeModel">,
): string {
  if (!view.runtimeSelection) return "Runtime status unavailable";
  if (view.runtimeSelection.authority === "legacy") return "Existing inventory rules are in use";
  if (view.activeModel?.lifecycleStatus === "sealed"
    && view.head?.activeModelId === view.activeModel.id) {
    return `Active — in use: v${view.activeModel.version}`;
  }
  return "Canonical runtime selected, but this product has no verified active rules";
}

export type PathDraft = {
  rowId: number;
  sourceVariantId: number;
  destinationVariantId: number;
  inputQty: string;
  outputQty: string;
  operationType: "break_pack" | "assemble_pack" | "directed_conversion";
  authorityState: "allowed" | "blocked";
  recipeId: number | null;
  recipeBindingKey: string | null;
};

export function deriveLosslessPath(
  rowId: number,
  source: TransformationAdminVariant,
  destination: TransformationAdminVariant,
  authorityState: PathDraft["authorityState"] = "allowed",
): PathDraft {
  if (source.id === destination.id) {
    throw new Error("A transformation path requires different source and output variants.");
  }
  if (source.unitsPerVariant === destination.unitsPerVariant) {
    throw new Error(
      "Equal-size variants require an explicit directional recipe; they are not a lossless package path.",
    );
  }
  const divisor = greatestCommonDivisor(source.unitsPerVariant, destination.unitsPerVariant);
  return {
    rowId,
    sourceVariantId: source.id,
    destinationVariantId: destination.id,
    inputQty: String(destination.unitsPerVariant / divisor),
    outputQty: String(source.unitsPerVariant / divisor),
    operationType: source.unitsPerVariant < destination.unitsPerVariant
      ? "assemble_pack"
      : "break_pack",
    authorityState,
    recipeId: null,
    recipeBindingKey: null,
  };
}

export function isCompatibleConversionRecipe(
  recipe: TransformationAdminRecipe,
  destination: TransformationAdminVariant,
  variants: readonly TransformationAdminVariant[],
): boolean {
  if (
    recipe.recipeType !== "conversion"
    || recipe.status !== "active"
    || recipe.outputProductId !== destination.productId
    || recipe.outputVariantId !== destination.id
    || recipe.outputUnitsPerVariant !== destination.unitsPerVariant
    || recipe.components.length !== 1
  ) {
    return false;
  }
  const component = recipe.components[0]!;
  return variants.some((variant) =>
    variant.id === component.componentVariantId
    && variant.productId === component.componentProductId
    && variant.unitsPerVariant === component.componentUnitsPerVariant
    && variant.isActive
    && variant.id !== destination.id);
}

export function deriveRecipePath(
  path: PathDraft,
  recipe: TransformationAdminRecipe,
): PathDraft {
  const component = recipe.components[0];
  if (!component) {
    throw new Error(`Recipe ${recipe.code} does not declare one source component.`);
  }
  return {
    ...path,
    sourceVariantId: component.componentVariantId,
    destinationVariantId: recipe.outputVariantId,
    inputQty: String(component.componentQty),
    outputQty: String(recipe.outputQty),
    operationType: "directed_conversion",
    recipeId: recipe.id,
    recipeBindingKey: `recipe:${recipe.id}:network`,
  };
}

export function directedPairIsOccupied(
  paths: readonly PathDraft[],
  destinationVariantId: number,
  sourceVariantId: number,
  excludedRowId?: number,
): boolean {
  return paths.some((path) =>
    path.rowId !== excludedRowId
    && path.destinationVariantId === destinationVariantId
    && path.sourceVariantId === sourceVariantId);
}

export function prefillPathsFromModel(
  model: TransformationAdminModel,
  firstRowId: number,
): { paths: PathDraft[]; nextRowId: number } {
  const recipeIdByBindingKey = new Map(
    model.bindings.map((binding) => [binding.bindingKey, binding.recipeId] as const),
  );
  let nextRowId = firstRowId;
  const paths = model.paths.map((path): PathDraft => ({
    rowId: nextRowId++,
    sourceVariantId: path.sourceVariantId,
    destinationVariantId: path.destinationVariantId,
    inputQty: String(path.inputQty),
    outputQty: String(path.outputQty),
    operationType: path.operationType,
    authorityState: path.authorityState,
    recipeId: path.transformationRecipeBindingKey === null
      ? null
      : recipeIdByBindingKey.get(path.transformationRecipeBindingKey) ?? null,
    recipeBindingKey: path.transformationRecipeBindingKey,
  }));
  return { paths, nextRowId };
}

export function draftHasUnsupportedBindings(model: TransformationAdminModel): boolean {
  return model.bindings.some((binding) =>
    binding.warehouseId !== null
    || !["component_build", "directional_conversion"].includes(binding.relationshipRole));
}

export function activeBuildRecipeIdsFromModel(
  model: TransformationAdminModel,
  recipes: readonly TransformationAdminRecipe[],
): number[] {
  const selectableRecipeIds = new Set(recipes
    .filter((recipe) => recipe.recipeType === "assembly" && recipe.status === "active")
    .map((recipe) => recipe.id));
  return Array.from(new Set(model.bindings
    .filter((binding) =>
      binding.relationshipRole === "component_build"
      && selectableRecipeIds.has(binding.recipeId))
    .map((binding) => binding.recipeId)));
}

export function unavailableBuildBindingsForEdit(
  model: TransformationAdminModel,
  recipes: readonly TransformationAdminRecipe[],
): TransformationAdminBinding[] {
  const selectableRecipeIds = new Set(recipes
    .filter((recipe) => recipe.recipeType === "assembly" && recipe.status === "active")
    .map((recipe) => recipe.id));
  return model.bindings.filter((binding) =>
    binding.relationshipRole === "component_build"
    && !selectableRecipeIds.has(binding.recipeId));
}

export function preserveSelectedProductOption(
  options: readonly ProductOption[],
  selected: ProductOption | null,
): ProductOption[] {
  if (selected === null || options.some((option) => option.id === selected.id)) {
    return [...options];
  }
  return [selected, ...options];
}

export function productOptionLabel(product: ProductOption): string {
  return product.sku ? `${product.sku} — ${product.name}` : product.name;
}

export function recipeEquation(
  recipe: TransformationAdminRecipe,
  variants: readonly TransformationAdminVariant[],
): string {
  const variantById = new Map(variants.map((variant) => [variant.id, variant] as const));
  const inputs = recipe.components.map((component) => {
    const variant = variantById.get(component.componentVariantId);
    return `${component.componentQty} × ${variantLabel(variant, component.sku, component.name)}`;
  }).join(" + ");
  const output = variantById.get(recipe.outputVariantId);
  return `${inputs} → ${recipe.outputQty} × ${variantLabel(output, null, `variant ${recipe.outputVariantId}`)}`;
}

export function bindingSnapshotEquation(
  binding: TransformationAdminBinding,
  variants: readonly TransformationAdminVariant[],
): string {
  const variantById = new Map(variants.map((variant) => [variant.id, variant] as const));
  const inputs = binding.components.map((component) => {
    const variant = variantById.get(component.componentVariantId);
    const identity = variant
      ? `${variantDisplayName(variant)} (current catalog; variant #${component.componentVariantId})`
      : `variant #${component.componentVariantId} (product #${component.componentProductId}, ${component.componentUnitsPerVariant} units/package)`;
    return `${component.componentQty} × ${identity}`;
  }).join(" + ");
  const output = variantById.get(binding.outputVariantIdSnapshot);
  const outputIdentity = output
    ? `${variantDisplayName(output)} (current catalog; variant #${binding.outputVariantIdSnapshot})`
    : `variant #${binding.outputVariantIdSnapshot} (product #${binding.outputProductIdSnapshot}, ${binding.outputUnitsPerVariantSnapshot} units/package)`;
  return `${inputs} → ${binding.outputQtySnapshot} × ${outputIdentity}`;
}

export function variantDisplayName(variant: TransformationAdminVariant | undefined): string {
  return variant ? variantLabel(variant, variant.sku, variant.name) : "unknown variant";
}

function variantLabel(
  variant: TransformationAdminVariant | undefined,
  fallbackSku: string | null,
  fallbackName: string,
): string {
  return variant?.sku ?? variant?.name ?? fallbackSku ?? fallbackName;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}
