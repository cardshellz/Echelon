import type { SupplyTransformationsAdminView, TransformationAdminModel, TransformationAdminRecipe } from "../types/inventory-availability-admin";

export type TransformationDraftLifecycle = {
  definition: Pick<TransformationAdminModel, "paths" | "bindings" | "buildToPromiseEnabled">;
  removedPaths: TransformationAdminModel["paths"];
  removedBindings: TransformationAdminModel["bindings"];
};

/** Archived identities remain in immutable model/claim history. A successor draft
 * removes their authority, never composes replacement paths or substitutes SKUs.
 * Missing catalog references are NOT evidence of archival and must still fail
 * normal reference validation. Recipe snapshots are indivisible: removing only
 * a component would authorize a different build with fewer required inputs.
 */
export function prepareTransformationDraft(
  model: TransformationAdminModel,
  archivedVariantIds: readonly number[],
): TransformationDraftLifecycle {
  const archived = new Set(archivedVariantIds);
  const removedBindings = model.bindings.filter(binding => archived.has(binding.outputVariantIdSnapshot)
    || binding.components.some(component => archived.has(component.componentVariantId)));
  const removedKeys = new Set(removedBindings.map(binding => binding.bindingKey));
  const removesPath = (path: TransformationAdminModel["paths"][number]) =>
    archived.has(path.sourceVariantId) || archived.has(path.destinationVariantId)
    || (path.transformationRecipeBindingKey !== null && removedKeys.has(path.transformationRecipeBindingKey));
  const bindings = model.bindings.filter(binding => !removedKeys.has(binding.bindingKey));
  return {
    definition: {
      paths: model.paths.filter(path => !removesPath(path)),
      bindings,
      buildToPromiseEnabled: model.buildToPromiseEnabled && !(removedBindings.some(binding => binding.relationshipRole === "component_build")
        && !bindings.some(binding => binding.relationshipRole === "component_build")),
    },
    removedPaths: model.paths.filter(removesPath),
    removedBindings,
  };
}

export function archivedTransformationVariantIds(view: SupplyTransformationsAdminView): number[] {
  return [...new Set([...(view.archivedVariantIds ?? []), ...view.variants.filter(variant => !variant.isActive).map(variant => variant.id)])]
    .sort((left, right) => left - right);
}

/** An active recipe may still reference an archived SKU. Recipe status alone
 * cannot make that SKU selectable again in a successor definition. */
export function recipeHasArchivedVariant(recipe: TransformationAdminRecipe, archivedVariantIds: readonly number[]): boolean {
  const archived = new Set(archivedVariantIds);
  return archived.has(recipe.outputVariantId)
    || recipe.components.some(component => !component.isActive || archived.has(component.componentVariantId));
}
