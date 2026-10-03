import { Link } from "wouter";
import { useState } from "react";
import type { SupplyTransformationsAdminView, TransformationAdminModel } from "@shared/types/inventory-availability-admin";
import { recipeEquation } from "@/pages/supply-transformations-model";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { packageConversionHasChanges, selectBuildRecipe, type PackageConversionEdit } from "./package-conversion-draft";

/** Recipe definitions are reusable master data; only selected model bindings
 * authorize this product. A recipe marked active is not automatically live ATP. */
export function ProductRecipeRules({ view, model, edit, disabled, onChange }: {
  view: SupplyTransformationsAdminView; model: TransformationAdminModel | null;
  edit: PackageConversionEdit | null; disabled: boolean;
  onChange: (edit: PackageConversionEdit) => void;
}) {
  const { hasPermission } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const chooseRecipe = (recipeId: number, selected: boolean) => {
    if (!edit || disabled) return;
    try { onChange(selectBuildRecipe(edit, recipeId, selected)); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The recipe selection could not be changed."); }
  };
  const bindings = edit?.recipeBindings ?? model?.bindings ?? [];
  const selected = new Set(bindings.map(binding => binding.recipeId));
  const missing = bindings.filter(binding => !view.recipes.some(recipe => recipe.id === binding.recipeId));
  const canAuthor = hasPermission("inventory", "adjust");
  const authoringBlocked = disabled || Boolean(edit && packageConversionHasChanges(edit));
  const unboundPaths = edit ? edit.paths.filter(path => path.recipeBindingKey === null)
    : (model?.paths ?? []).filter(path => path.transformationRecipeBindingKey === null);
  return <section aria-label="Build recipes" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Build recipes</h3>
      {canAuthor && (authoringBlocked ? <Button size="sm" variant="outline" disabled>Create recipe</Button>
        : <Button asChild size="sm" variant="outline"><Link
          href={`/inventory/builds/recipes/new?productId=${view.product.id}`}>Create recipe</Link></Button>)}
    </div>
    <p className="text-sm text-muted-foreground">Select the exact recipes this product may use. No reverse direction is implied.
      Recipe changes must be selected, reviewed and applied here before they change live rules.</p>
    {canAuthor && authoringBlocked && <p className="text-sm">Save or cancel your draft changes before opening the recipe editor.</p>}
    {view.recipes.length === 0 && <p className="text-sm">No active recipes for this product. Create a recipe, then return here to select it.</p>}
    {view.recipes.map(recipe => <div key={recipe.id} className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={selected.has(recipe.id)} disabled={!edit || disabled}
            onChange={event => chooseRecipe(recipe.id, event.target.checked)} />
          {recipe.name} · v{recipe.version}
        </label>
        {canAuthor && !authoringBlocked && <Link className="text-sm underline" href={`/inventory/builds/recipes/${recipe.id}/edit?productId=${view.product.id}`}>
          Edit recipe {recipe.code}
        </Link>}
      </div>
      <p className="mt-2 break-words font-mono text-xs">{recipeEquation(recipe, view.variants)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{selected.has(recipe.id)
        ? edit ? "Selected for this draft — not live" : "Included in the active rules"
        : "Not included in these rules"}</p>
    </div>)}
    {missing.map(binding => <div key={binding.bindingKey} className="rounded-md border p-3 text-sm">
      <p>Retained recipe #{binding.recipeId}. This version is no longer offered for new drafts.</p>
      {edit && <Button variant="outline" size="sm" disabled={disabled}
        onClick={() => chooseRecipe(binding.recipeId, false)}>Remove recipe #{binding.recipeId} from draft</Button>}
    </div>)}
    {unboundPaths.length > 0 && <div className="rounded-md border p-3 text-sm">
      <p>These existing directions have no recipe. Build managed cannot allow them in a new version.</p>
      {unboundPaths.map(path => <div key={`${path.sourceVariantId}:${path.destinationVariantId}`} className="mt-2 flex flex-wrap items-center gap-2">
        <span>{view.variants.find(variant => variant.id === path.sourceVariantId)?.sku ?? path.sourceVariantId}
          {" → "}{view.variants.find(variant => variant.id === path.destinationVariantId)?.sku ?? path.destinationVariantId}
          {" · "}{path.authorityState}</span>
        {edit && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...edit,
          paths: edit.paths.filter(candidate => candidate.sourceVariantId !== path.sourceVariantId
            || candidate.destinationVariantId !== path.destinationVariantId) })}>Remove direction from draft</Button>}
      </div>)}
    </div>}
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={edit?.buildToPromiseEnabled ?? model?.buildToPromiseEnabled ?? false}
        disabled={!edit || disabled || !bindings.some(binding => binding.relationshipRole === "component_build")}
        onChange={event => { if (edit) onChange({ ...edit, buildToPromiseEnabled: event.target.checked }); }} />
      Include buildable component stock in ATP. Exact finished stock remains available either way.
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
