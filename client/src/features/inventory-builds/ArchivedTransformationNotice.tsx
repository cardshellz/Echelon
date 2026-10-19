import type { TransformationDraftLifecycle } from "@shared/inventory/transformation-draft-lifecycle";
import type { SupplyTransformationsAdminView } from "@shared/types/inventory-availability-admin";

export function ArchivedTransformationNotice({ lifecycle, view }: {
  lifecycle: TransformationDraftLifecycle | null;
  view: SupplyTransformationsAdminView;
}) {
  if (!lifecycle || (lifecycle.removedPaths.length === 0 && lifecycle.removedBindings.length === 0)) return null;
  const variants = new Map(view.variants.map(variant => [variant.id, variant]));
  const label = (id: number) => variants.get(id)?.sku ?? `Variant #${id}`;
  return <div role="note" aria-label="Archived SKU rules excluded from draft" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
    <p className="font-medium">Archived SKU rules excluded from this draft</p>
    <p>{lifecycle.removedPaths.length} direction(s) and {lifecycle.removedBindings.length} recipe binding(s) will be removed when you save.
      Review and Apply are required to change live rules. Saved history remains available.</p>
    <details className="mt-2"><summary className="cursor-pointer">Review excluded rules</summary>
      <ul className="list-disc pl-5">
        {lifecycle.removedPaths.map(path => <li key={`path:${path.sourceVariantId}:${path.destinationVariantId}`}>
          {label(path.sourceVariantId)} → {label(path.destinationVariantId)} ({path.authorityState})
        </li>)}
        {lifecycle.removedBindings.map(binding => <li key={`binding:${binding.bindingKey}`}>
          {binding.recipeCodeSnapshot} v{binding.recipeVersionSnapshot}: entire recipe binding excluded
        </li>)}
      </ul>
    </details>
  </div>;
}
