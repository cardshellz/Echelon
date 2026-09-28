import { inventoryPublicationScopeSchema } from "@shared/types/inventory-publication-scope";

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
