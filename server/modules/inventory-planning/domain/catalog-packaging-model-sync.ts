import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import {
  isCustomerSellableVariant,
  type VariantSalesEligibility,
} from "@shared/catalog/variant-sales-eligibility";
import type { InventoryBehavior } from "@shared/inventory/inventory-behavior";
import {
  calculateTransformationModelDefinitionHash,
  transformationModelDefinitionSchema,
  type TransformationModelDefinition,
} from "./inventory-availability-master-data.contracts";

export interface PackagingSyncVariantSnapshot {
  id: number;
  productId: number;
  unitsPerVariant: number;
  hierarchyLevel?: number | null;
  isActive: boolean;
  requiresShipping: boolean;
  trackInventory: boolean | null;
  salesEligibility: VariantSalesEligibility;
}

export interface PackagingSyncExistingPath {
  sourceVariantId: number;
  destinationVariantId: number;
  inputQty: number;
  outputQty: number;
  sourceUnitsPerVariant: number;
  destinationUnitsPerVariant: number;
  operationType: "break_pack" | "assemble_pack" | "directed_conversion";
  authorityState: "allowed" | "blocked";
  transformationRecipeBindingKey: string | null;
}

export interface PackagingSyncExistingModel {
  definitionHash: string;
  inventoryBehavior?: InventoryBehavior | null;
  buildToPromiseEnabled: boolean;
  paths: readonly PackagingSyncExistingPath[];
  recipeBindings: readonly unknown[];
}

export type PackagingModelAutoSyncPlan =
  | {
      kind: "skip";
      reason:
        | "product_inactive"
        | "unapplied_draft_exists"
        | "recipe_or_build_managed"
        | "no_sellable_managed_variants";
    }
  | {
      kind: "up_to_date";
      definitionHash: string;
      pathCount: number;
    }
  | {
      kind: "sync_needed";
      definition: TransformationModelDefinition;
      definitionHash: string;
      pathCount: number;
    };

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

/**
 * Synthesizes an exact-integer same-product `break_pack` transformation model
 * directly from `catalog.product_variants` so operators never have to manually
 * maintain 6 separate transformation tables when creating/updating Case/Box/Pack
 * hierarchies.
 *
 * Safety invariants:
 * - Never touches products with active `build_recipes` or `build_managed` models.
 * - Never overwrites an unapplied draft (`draft_model_id IS NOT NULL`).
 * - Preserves explicit operator `blocked` and `assemble_pack` rules on active
 *   variants while automatically provisioning/updating downward exact-multiple
 *   `break_pack` paths (`source.unitsPerVariant % dest.unitsPerVariant === 0`).
 */
export function buildAutoSyncedPackagingModelDefinition(input: {
  product: { id: number; isActive: boolean };
  variants: readonly PackagingSyncVariantSnapshot[];
  activeRecipeCount: number;
  existingActiveModel: PackagingSyncExistingModel | null;
  hasUnappliedDraft: boolean;
}): PackagingModelAutoSyncPlan {
  if (!input.product.isActive) {
    return { kind: "skip", reason: "product_inactive" };
  }
  if (input.hasUnappliedDraft) {
    return { kind: "skip", reason: "unapplied_draft_exists" };
  }
  if (
    input.activeRecipeCount > 0 ||
    (input.existingActiveModel !== null &&
      (input.existingActiveModel.recipeBindings.length > 0 ||
        input.existingActiveModel.buildToPromiseEnabled ||
        input.existingActiveModel.inventoryBehavior === "build_managed"))
  ) {
    return { kind: "skip", reason: "recipe_or_build_managed" };
  }

  const managedVariants = input.variants
    .filter(
      (variant) =>
        variant.productId === input.product.id &&
        variant.isActive &&
        Number.isSafeInteger(variant.unitsPerVariant) &&
        variant.unitsPerVariant > 0 &&
        isInventoryManagedVariant(variant),
    )
    .sort(
      (left, right) =>
        left.unitsPerVariant - right.unitsPerVariant ||
        (left.hierarchyLevel ?? 0) - (right.hierarchyLevel ?? 0) ||
        left.id - right.id,
    );

  if (managedVariants.filter(isCustomerSellableVariant).length === 0) {
    return { kind: "skip", reason: "no_sellable_managed_variants" };
  }

  const managedById = new Map(managedVariants.map((variant) => [variant.id, variant] as const));
  const pathsByKey = new Map<string, TransformationModelDefinition["paths"][number]>();

  // 1. Preserve explicit operator `blocked` overrides and `assemble_pack` paths
  // when both variants are still active and inventory-managed.
  for (const existing of input.existingActiveModel?.paths ?? []) {
    if (existing.transformationRecipeBindingKey !== null || existing.operationType === "directed_conversion") {
      continue;
    }
    const source = managedById.get(existing.sourceVariantId);
    const dest = managedById.get(existing.destinationVariantId);
    if (!source || !dest || source.id === dest.id) continue;

    if (existing.operationType === "assemble_pack" && source.unitsPerVariant < dest.unitsPerVariant) {
      const divisor = greatestCommonDivisor(source.unitsPerVariant, dest.unitsPerVariant);
      pathsByKey.set(`${source.id}:${dest.id}`, {
        sourceProductId: input.product.id,
        sourceVariantId: source.id,
        destinationProductId: input.product.id,
        destinationVariantId: dest.id,
        inputQty: dest.unitsPerVariant / divisor,
        outputQty: source.unitsPerVariant / divisor,
        sourceUnitsPerVariant: source.unitsPerVariant,
        destinationUnitsPerVariant: dest.unitsPerVariant,
        operationType: "assemble_pack",
        authorityState: existing.authorityState,
        transformationRecipeBindingKey: null,
      });
    } else if (
      existing.operationType === "break_pack" &&
      existing.authorityState === "blocked" &&
      source.unitsPerVariant > dest.unitsPerVariant
    ) {
      const divisor = greatestCommonDivisor(source.unitsPerVariant, dest.unitsPerVariant);
      pathsByKey.set(`${source.id}:${dest.id}`, {
        sourceProductId: input.product.id,
        sourceVariantId: source.id,
        destinationProductId: input.product.id,
        destinationVariantId: dest.id,
        inputQty: dest.unitsPerVariant / divisor,
        outputQty: source.unitsPerVariant / divisor,
        sourceUnitsPerVariant: source.unitsPerVariant,
        destinationUnitsPerVariant: dest.unitsPerVariant,
        operationType: "break_pack",
        authorityState: "blocked",
        transformationRecipeBindingKey: null,
      });
    }
  }

  // 2. Synthesize exact-integer downward `break_pack` paths (`1 source -> N dest`)
  // across the product's UOM hierarchy (e.g. Case -> Box, Box -> Pack, Case -> Pack).
  for (const source of managedVariants) {
    for (const dest of managedVariants) {
      if (source.id === dest.id) continue;
      if (source.unitsPerVariant <= dest.unitsPerVariant) continue;
      if (source.unitsPerVariant % dest.unitsPerVariant !== 0) continue;

      const key = `${source.id}:${dest.id}`;
      if (pathsByKey.has(key)) continue;

      pathsByKey.set(key, {
        sourceProductId: input.product.id,
        sourceVariantId: source.id,
        destinationProductId: input.product.id,
        destinationVariantId: dest.id,
        inputQty: 1,
        outputQty: source.unitsPerVariant / dest.unitsPerVariant,
        sourceUnitsPerVariant: source.unitsPerVariant,
        destinationUnitsPerVariant: dest.unitsPerVariant,
        operationType: "break_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      });
    }
  }

  const paths = [...pathsByKey.values()];
  const hasAllowedPath = paths.some((path) => path.authorityState === "allowed");
  const inventoryBehavior: InventoryBehavior = hasAllowedPath ? "package_hierarchy" : "physical_only";

  const definition = transformationModelDefinitionSchema.parse({
    productId: input.product.id,
    inventoryBehavior,
    buildToPromiseEnabled: false,
    paths,
    recipeBindings: [],
  });
  const definitionHash = calculateTransformationModelDefinitionHash(definition);

  if (input.existingActiveModel?.definitionHash === definitionHash) {
    return {
      kind: "up_to_date",
      definitionHash,
      pathCount: paths.length,
    };
  }

  return {
    kind: "sync_needed",
    definition,
    definitionHash,
    pathCount: paths.length,
  };
}
