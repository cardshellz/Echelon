import { inventoryPublicationScopeSchema } from "@shared/types/inventory-publication-scope";

/** An initial deferral is not a lasting opt-in: any later membership decision
 * replaces it. Restrict reads to the requested product's managed sellable SKUs. */
export function selectDeferredPublicationQuantityVariants(deferredIds: readonly number[],
  managedIds: readonly number[], decidedIds: readonly number[]): number[] {
  const managed = new Set(managedIds);
  const decided = new Set(decidedIds);
  return deferredIds.filter(id => managed.has(id) && !decided.has(id)).sort((a, b) => a - b);
}

/** One outbound selector for preview and runtime; caller retains the full supply snapshot. */
export function selectPublicationVariants<T extends { id: number }>(
  variants: readonly T[], scope: { mode: "whole_product" } | { mode: "explicit"; includedVariantIds: readonly number[] },
): { selected: T[]; unavailableVariantIds: number[] } {
  const parsed = inventoryPublicationScopeSchema.parse(scope);
  if (parsed.mode === "whole_product") return { selected: [...variants], unavailableVariantIds: [] };
  const included = new Set(parsed.includedVariantIds);
  const available = new Set(variants.map(variant => variant.id));
  return {
    selected: variants.filter(variant => included.has(variant.id)),
    unavailableVariantIds: [...included].filter(id => !available.has(id)).sort((a, b) => a - b),
  };
}
