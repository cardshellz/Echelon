import {
  createTransformationModelDraftRequestSchema,
  createTransformationModelDraftResultSchema,
  supplyTransformationsAdminViewSchema,
  updateTransformationModelDraftRequestSchema,
  type CreateTransformationModelDraftRequest,
  type SupplyTransformationsAdminView,
  type UpdateTransformationModelDraftRequest,
} from "@shared/types/inventory-availability-admin";
import { deriveRecipePath, isCompatibleConversionRecipe, prefillPathsFromModel, type PathDraft } from "@/pages/supply-transformations-model";
import { packageLadderModelEditIssues } from "./package-conversion-ladder";
import { describeInventoryBehavior, inventoryBehaviorDefinitionIssues, type InventoryBehavior } from "@shared/inventory/inventory-behavior";
import { fetchJson } from "@/pages/inventory-planning-http";
export { HttpResponseError as PackageConversionHttpError } from "@/pages/inventory-planning-http";

export const PACKAGE_CONVERSION_AUDIT_NOTE =
  "Updated inventory behavior, directions and recipe selections from the product Variants tab.";
export const transformationQueryKey = (productId: number) =>
  ["/api/inventory-planning/admin/supply-transformations", productId] as const;

export type PackageConversionEdit = {
  /** Capture once. Background refresh must never rebase the operator's edit. */
  baseline: SupplyTransformationsAdminView;
  paths: PathDraft[];
  nextRowId: number;
  inventoryBehavior: InventoryBehavior;
  buildToPromiseEnabled: boolean;
  recipeBindings: CreateTransformationModelDraftRequest["recipeBindings"];
};

export type PackageConversionCommand =
  | { method: "POST"; url: string; request: CreateTransformationModelDraftRequest }
  | { method: "PUT"; url: string; request: UpdateTransformationModelDraftRequest };

export function packageConversionEditIssues(view: SupplyTransformationsAdminView): string[] {
  const issues: string[] = [];
  if (view.variants.some(variant => variant.productId !== view.product.id)
    || (view.draftModel !== null && view.draftModel.productId !== view.product.id)
    || (view.activeModel !== null && view.activeModel.productId !== view.product.id)) {
    issues.push("The model or variants belong to a different product. Reload before editing.");
  }
  if (!view.product.isActive) issues.push("Archived products cannot be edited here.");
  if ((view.head?.draftModelId ?? null) !== (view.draftModel?.id ?? null)
    || (view.head?.activeModelId ?? null) !== (view.activeModel?.id ?? null)
    || (view.draftModel !== null && view.draftModel.lifecycleStatus !== "draft")
    || (view.activeModel !== null && view.activeModel.lifecycleStatus !== "sealed")) {
    issues.push("The loaded model does not match its saved head. Reload before editing.");
  }
  return issues;
}

export function modelInventoryBehavior(model: SupplyTransformationsAdminView["activeModel"]): InventoryBehavior {
  return model ? describeInventoryBehavior({ ...model, recipeBindings: model.bindings }) : "physical_only";
}

export function beginPackageConversionEdit(view: SupplyTransformationsAdminView): PackageConversionEdit {
  const baseline = supplyTransformationsAdminViewSchema.parse(view);
  const issues = packageConversionEditIssues(baseline);
  if (issues.length) throw new Error(issues.join(" "));
  const model = baseline.draftModel ?? baseline.activeModel;
  return { baseline, ...(model ? prefillPathsFromModel(model, 1) : { paths: [], nextRowId: 1 }),
    inventoryBehavior: modelInventoryBehavior(model), buildToPromiseEnabled: model?.buildToPromiseEnabled ?? false,
    recipeBindings: (model?.bindings ?? []).map(binding => ({ bindingKey: binding.bindingKey,
      recipeId: binding.recipeId, relationshipRole: binding.relationshipRole, warehouseId: binding.warehouseId })),
  };
}

export function changeInventoryBehavior(edit: PackageConversionEdit, inventoryBehavior: InventoryBehavior): PackageConversionEdit {
  if (edit.inventoryBehavior === inventoryBehavior) return edit;
  // This is an explicit draft reset, displayed before Save/Review/Apply. Never
  // create directions or recipes merely because package quantities divide.
  return { ...edit, inventoryBehavior, paths: [], recipeBindings: [], buildToPromiseEnabled: false };
}

export function selectBuildRecipe(edit: PackageConversionEdit, recipeId: number, selected: boolean): PackageConversionEdit {
  if (edit.inventoryBehavior !== "build_managed") throw new Error("Choose Build managed before selecting recipes.");
  const existing = edit.recipeBindings.filter(binding => binding.recipeId === recipeId);
  if (!selected) {
    const keys = new Set(existing.map(binding => binding.bindingKey));
    const recipeBindings = edit.recipeBindings.filter(binding => binding.recipeId !== recipeId);
    return { ...edit, recipeBindings, paths: edit.paths.filter(path => !keys.has(path.recipeBindingKey ?? "")),
      buildToPromiseEnabled: edit.buildToPromiseEnabled && recipeBindings.some(binding => binding.relationshipRole === "component_build") };
  }
  if (existing.length > 0) return edit;
  const recipe = edit.baseline.recipes.find(candidate => candidate.id === recipeId);
  if (!recipe) throw new Error("This recipe is no longer selectable. Reload the product.");
  const binding = { bindingKey: `recipe:${recipe.id}:network`, recipeId: recipe.id,
    relationshipRole: recipe.recipeType === "assembly" ? "component_build" as const : "directional_conversion" as const,
    warehouseId: null };
  if (recipe.recipeType === "assembly") return { ...edit, recipeBindings: [...edit.recipeBindings, binding] };
  const destination = edit.baseline.variants.find(variant => variant.id === recipe.outputVariantId);
  if (!destination || !isCompatibleConversionRecipe(recipe, destination, edit.baseline.variants)) {
    throw new Error("This conversion recipe does not match the active product variants.");
  }
  const path = deriveRecipePath({ rowId: edit.nextRowId, sourceVariantId: 0, destinationVariantId: 0,
    inputQty: "0", outputQty: "0", operationType: "directed_conversion", authorityState: "allowed",
    recipeId: null, recipeBindingKey: null }, recipe);
  if (edit.paths.some(candidate => candidate.sourceVariantId === path.sourceVariantId && candidate.destinationVariantId === path.destinationVariantId)) {
    throw new Error("A direction already exists for these two SKUs. Remove its recipe before replacing it.");
  }
  return { ...edit, recipeBindings: [...edit.recipeBindings, binding], paths: [...edit.paths, path], nextRowId: edit.nextRowId + 1 };
}

export function packageConversionHasChanges(edit: PackageConversionEdit): boolean {
  const model = edit.baseline.draftModel ?? edit.baseline.activeModel;
  const original = model ? prefillPathsFromModel(model, 1).paths : [];
  const comparable = (paths: PathDraft[]) => JSON.stringify(paths.map(({ rowId: _rowId, ...path }) => path)
    .sort((a, b) => a.sourceVariantId - b.sourceVariantId || a.destinationVariantId - b.destinationVariantId));
  return comparable(original) !== comparable(edit.paths)
    || model?.inventoryBehavior !== edit.inventoryBehavior
    || (model?.buildToPromiseEnabled ?? false) !== edit.buildToPromiseEnabled
    || JSON.stringify((model?.bindings ?? []).map(binding => ({ bindingKey: binding.bindingKey, recipeId: binding.recipeId,
      relationshipRole: binding.relationshipRole, warehouseId: binding.warehouseId }))) !== JSON.stringify(edit.recipeBindings);
}

export function buildPackageConversionCommand(edit: PackageConversionEdit, idempotencyKey: string): PackageConversionCommand {
  const { baseline } = edit;
  const issues = packageConversionEditIssues(baseline);
  if (issues.length) throw new Error(issues.join(" "));
  if (!packageConversionHasChanges(edit)) throw new Error("Change the inventory behavior, directions or recipes before saving.");
  const model = baseline.draftModel ?? baseline.activeModel;
  if (edit.inventoryBehavior === "package_hierarchy") {
    // Preserve the existing ladder's exact-unit and unsupported-path safeguards.
    const ladderIssues = packageLadderModelEditIssues(baseline.variants,
      model && modelInventoryBehavior(model) === "package_hierarchy" ? model : null);
    if (ladderIssues.length) throw new Error(ladderIssues.join(" "));
  }
  const definition = {
    inventoryBehavior: edit.inventoryBehavior,
    buildToPromiseEnabled: edit.buildToPromiseEnabled,
    paths: edit.paths.map(path => ({
      sourceVariantId: path.sourceVariantId,
      destinationVariantId: path.destinationVariantId,
      inputQty: Number(path.inputQty),
      outputQty: Number(path.outputQty),
      operationType: path.operationType,
      authorityState: path.authorityState,
      transformationRecipeBindingKey: path.recipeBindingKey,
    })),
    recipeBindings: edit.recipeBindings,
    changeReason: PACKAGE_CONVERSION_AUDIT_NOTE,
    idempotencyKey,
  };
  const behaviorIssues = inventoryBehaviorDefinitionIssues(definition);
  if (behaviorIssues.length) throw new Error(behaviorIssues.join(" "));
  const url = `/api/inventory-planning/admin/supply-transformations/${baseline.product.id}/drafts`;
  if (baseline.draftModel && baseline.head) {
    return { method: "PUT", url: `${url}/${baseline.draftModel.id}`, request: updateTransformationModelDraftRequestSchema.parse({
      ...definition,
      expectedVersion: baseline.draftModel.version,
      expectedDefinitionHash: baseline.draftModel.definitionHash,
      expectedHeadRevision: baseline.head.revision,
    }) };
  }
  return { method: "POST", url, request: createTransformationModelDraftRequestSchema.parse({
    ...definition, productId: baseline.product.id, expectedHeadRevision: baseline.head?.revision ?? "0",
  }) };
}

export async function loadProductConversions(productId: number, signal?: AbortSignal): Promise<SupplyTransformationsAdminView> {
  const view = await fetchJson(`/api/inventory-planning/admin/supply-transformations/${productId}`,
    supplyTransformationsAdminViewSchema, { signal });
  if (view.product.id !== productId) throw new Error("The server returned a different product. Reload before editing.");
  return view;
}

export async function savePackageConversionCommand(command: PackageConversionCommand) {
  return fetchJson(command.url, createTransformationModelDraftResultSchema, {
    method: command.method, credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command.request),
  });
}
