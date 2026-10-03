import { z } from "zod";

/** This belongs to the versioned transformation model, never the legacy catalog flag. */
export const inventoryBehaviorSchema = z.enum(["physical_only", "package_hierarchy", "build_managed"]);
export type InventoryBehavior = z.infer<typeof inventoryBehaviorSchema>;

export const INVENTORY_BEHAVIORS: ReadonlyArray<{
  value: InventoryBehavior; label: string; description: string;
}> = [
  { value: "physical_only", label: "Physical only", description: "Use stock of the exact SKU. No conversions or builds." },
  { value: "package_hierarchy", label: "Package hierarchy", description: "Use only the package directions you explicitly allow." },
  { value: "build_managed", label: "Build managed", description: "Every transformation requires an explicitly selected recipe." },
];

/** Old sealed models have no mode field. Describe their existing rules without
 * consulting catalog.inventory_strategy or adding any transformation permission. */
export function describeInventoryBehavior(model: {
  inventoryBehavior?: InventoryBehavior;
  paths: readonly unknown[];
  recipeBindings: readonly unknown[];
}): InventoryBehavior {
  if (model.inventoryBehavior) return model.inventoryBehavior;
  if (model.recipeBindings.length > 0) return "build_managed";
  return model.paths.length > 0 ? "package_hierarchy" : "physical_only";
}

export function permitsPackagePath(
  behavior: InventoryBehavior | undefined,
  operationType: "break_pack" | "assemble_pack" | "directed_conversion",
  hasRecipeBinding: boolean,
): boolean {
  // Compatibility means the old model's explicit paths still govern it; it is
  // not permission to infer an additional path from a parent or package ratio.
  if (behavior === undefined) return true;
  if (behavior === "physical_only") return false;
  if (behavior === "package_hierarchy") return operationType !== "directed_conversion" && !hasRecipeBinding;
  return operationType === "directed_conversion" && hasRecipeBinding;
}

export function permitsRecipeBuild(behavior: InventoryBehavior | undefined): boolean {
  return behavior === undefined || behavior === "build_managed";
}

export function inventoryBehaviorDefinitionIssues(definition: {
  inventoryBehavior?: InventoryBehavior;
  buildToPromiseEnabled: boolean;
  paths: readonly {
    operationType: "break_pack" | "assemble_pack" | "directed_conversion";
    authorityState: "allowed" | "blocked";
    transformationRecipeBindingKey: string | null;
  }[];
  recipeBindings: readonly unknown[];
}): string[] {
  const behavior = definition.inventoryBehavior;
  if (behavior === undefined) return [];
  const issues: string[] = [];
  if (!permitsRecipeBuild(behavior) && (definition.recipeBindings.length > 0 || definition.buildToPromiseEnabled)) {
    issues.push("Only Build managed may bind recipes or promise component builds.");
  }
  if (definition.paths.some(path => path.authorityState === "allowed"
    && !permitsPackagePath(behavior, path.operationType, path.transformationRecipeBindingKey !== null))) {
    issues.push(behavior === "physical_only" ? "Physical only cannot allow transformation paths."
      : behavior === "build_managed" ? "Build managed requires a recipe for every allowed transformation."
        : "Package hierarchy allows only explicit, recipe-free break-down and build-up directions.");
  }
  return issues;
}
