export interface InventoryAvailabilityLevel {
  variantId: number;
  parentVariantId: number | null;
  unitsPerVariant: number;
  available: number;
  inventoryStrategy: string | null;
}

export function calculateLegacyFungibleAvailability<T extends InventoryAvailabilityLevel>(
  levels: T[],
): Map<number, number> {
  const childrenByParent = new Map<number, T[]>();
  for (const level of levels) {
    if (level.parentVariantId != null) {
      const children = childrenByParent.get(level.parentVariantId) ?? [];
      children.push(level);
      childrenByParent.set(level.parentVariantId, children);
    }
  }

  const result = new Map<number, number>();
  for (const level of levels) {
    if (level.inventoryStrategy === "recipe_managed") continue;

    let total = level.available;
    const queue = [...(childrenByParent.get(level.variantId) ?? [])];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const child = queue.shift()!;
      if (visited.has(child.variantId)) continue;
      visited.add(child.variantId);
      total += Math.floor(child.available * child.unitsPerVariant / level.unitsPerVariant);
      queue.push(...(childrenByParent.get(child.variantId) ?? []));
    }
    if (total !== level.available) result.set(level.variantId, total);
  }
  return result;
}
