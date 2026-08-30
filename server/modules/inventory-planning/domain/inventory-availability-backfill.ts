import { createHash } from "node:crypto";

import { PRODUCT_INVENTORY_STRATEGIES } from "@shared/catalog/inventory-strategy";
import { VARIANT_UOM_TYPES } from "@shared/catalog/variant-uom";
import type {
  InventoryAvailabilityBackfillDefinition,
  InventoryAvailabilityBackfillIssue,
} from "@shared/types/inventory-availability-backfill";
import {
  INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
  inventoryAvailabilityBackfillDefinitionSchema,
} from "@shared/types/inventory-availability-backfill";
import { canonicalJson } from "@shared/utils/canonical-json";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { z } from "zod";

import {
  calculateRecipeDefinitionHash,
  calculateTransformationModelDefinitionHash,
  transformationModelDefinitionSchema,
  type TransformationModelDefinition,
} from "./inventory-availability-master-data.contracts";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonblank = (max: number) => z.string().trim().min(1).max(max);

export const inventoryAvailabilityBackfillSourceVariantSchema = z.object({
  id: positiveInteger,
  productId: positiveInteger,
  sku: z.string().max(100).nullable(),
  name: z.string(),
  unitsPerVariant: positiveInteger,
  uomType: z.enum(VARIANT_UOM_TYPES),
  isActive: z.literal(true),
  requiresShipping: z.boolean().optional(),
  trackInventory: z.boolean().nullable().optional(),
}).strict();

export const inventoryAvailabilityBackfillSourceRecipeSchema = z.object({
  id: positiveInteger,
  code: nonblank(50),
  name: nonblank(150),
  version: positiveInteger,
  status: z.literal("active"),
  recipeType: z.enum(["assembly", "conversion"]),
  outputProductId: positiveInteger,
  outputVariantId: positiveInteger,
  outputUnitsPerVariant: positiveInteger,
  outputQty: positiveInteger,
  components: z.array(z.object({
    componentVariantId: positiveInteger,
    componentProductId: positiveInteger,
    componentUnitsPerVariant: positiveInteger,
    actualProductId: positiveInteger,
    actualUnitsPerVariant: positiveInteger,
    componentQty: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
    isActive: z.boolean(),
    requiresShipping: z.boolean().optional(),
    trackInventory: z.boolean().nullable().optional(),
  }).strict()),
}).strict();

export const inventoryAvailabilityBackfillSourceSchema = z.object({
  product: z.object({
    id: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
    isActive: z.literal(true),
    legacyInventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
  }).strict(),
  variants: z.array(inventoryAvailabilityBackfillSourceVariantSchema),
  recipes: z.array(inventoryAvailabilityBackfillSourceRecipeSchema),
}).strict();

export type InventoryAvailabilityBackfillSource = z.infer<
  typeof inventoryAvailabilityBackfillSourceSchema
>;

export interface InventoryAvailabilityBackfillCandidate {
  algorithmVersion: typeof INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION;
  source: InventoryAvailabilityBackfillSource;
  classification:
    | "exact_only"
    | "legacy_fungible_directed_pool"
    | "recipe_managed_explicit_review"
    | "excluded_unmanaged"
    | "blocked";
  inputHash: string;
  resultHash: string;
  definitionHash: string | null;
  definition: TransformationModelDefinition | null;
  publicDefinition: InventoryAvailabilityBackfillDefinition | null;
  issues: InventoryAvailabilityBackfillIssue[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function normalizedSource(
  raw: InventoryAvailabilityBackfillSource,
): InventoryAvailabilityBackfillSource {
  const source = inventoryAvailabilityBackfillSourceSchema.parse(raw);
  return {
    product: source.product,
    variants: [...source.variants].sort((left, right) =>
      compareNumbers(left.unitsPerVariant, right.unitsPerVariant)
      || compareNumbers(left.id, right.id)),
    recipes: [...source.recipes]
      .sort((left, right) => compareNumbers(left.id, right.id))
      .map((recipe) => ({
        ...recipe,
        components: [...recipe.components].sort((left, right) =>
          compareNumbers(left.componentVariantId, right.componentVariantId)),
      })),
  };
}

function issue(
  code: string,
  severity: "review" | "blocking",
  message: string,
  context: Record<string, unknown>,
): InventoryAvailabilityBackfillIssue {
  return { code, severity, message, context };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function packagingOperation(sourceUnits: number, destinationUnits: number) {
  if (sourceUnits < destinationUnits) return "assemble_pack" as const;
  if (sourceUnits > destinationUnits) return "break_pack" as const;
  return "directed_conversion" as const;
}

function packagingPath(
  productId: number,
  source: InventoryAvailabilityBackfillSource["variants"][number],
  destination: InventoryAvailabilityBackfillSource["variants"][number],
) {
  const divisor = greatestCommonDivisor(source.unitsPerVariant, destination.unitsPerVariant);
  return {
    sourceProductId: productId,
    sourceVariantId: source.id,
    destinationProductId: productId,
    destinationVariantId: destination.id,
    inputQty: destination.unitsPerVariant / divisor,
    outputQty: source.unitsPerVariant / divisor,
    sourceUnitsPerVariant: source.unitsPerVariant,
    destinationUnitsPerVariant: destination.unitsPerVariant,
    operationType: packagingOperation(source.unitsPerVariant, destination.unitsPerVariant),
    authorityState: "allowed" as const,
    transformationRecipeBindingKey: null,
  };
}

function toPublicDefinition(
  definition: TransformationModelDefinition,
): InventoryAvailabilityBackfillDefinition {
  return inventoryAvailabilityBackfillDefinitionSchema.parse({
    buildToPromiseEnabled: definition.buildToPromiseEnabled,
    paths: definition.paths.map((path) => ({
      sourceVariantId: path.sourceVariantId,
      destinationVariantId: path.destinationVariantId,
      inputQty: path.inputQty,
      outputQty: path.outputQty,
      operationType: path.operationType,
      authorityState: path.authorityState,
      transformationRecipeBindingKey: path.transformationRecipeBindingKey,
    })),
    recipeBindings: definition.recipeBindings.map((binding) => ({
      bindingKey: binding.bindingKey,
      recipeId: binding.recipeId,
      relationshipRole: binding.relationshipRole,
      warehouseId: binding.warehouseId,
    })),
  });
}

export function calculateInventoryAvailabilityBackfillInputHash(
  raw: InventoryAvailabilityBackfillSource,
): string {
  return hash({
    algorithmVersion: INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
    source: normalizedSource(raw),
  });
}

export function planInventoryAvailabilityBackfill(
  raw: InventoryAvailabilityBackfillSource,
): InventoryAvailabilityBackfillCandidate {
  const source = normalizedSource(raw);
  const inputHash = calculateInventoryAvailabilityBackfillInputHash(source);
  const issues: InventoryAvailabilityBackfillIssue[] = [];
  const managedVariants = source.variants.filter(isInventoryManagedVariant);
  const variantsById = new Map(managedVariants.map((variant) => [variant.id, variant] as const));

  if (source.variants.length === 0) {
    issues.push(issue(
      "NO_ACTIVE_VARIANTS",
      "blocking",
      "The active product has no active variants to classify.",
      { productId: source.product.id },
    ));
  } else if (managedVariants.length === 0) {
    issues.push(issue(
      "NO_INVENTORY_MANAGED_VARIANTS",
      "review",
      "The active product has no shippable, inventory-managed variants and is excluded from ATP migration.",
      { productId: source.product.id, activeVariantIds: source.variants.map((variant) => variant.id) },
    ));
  }

  const bindings: TransformationModelDefinition["recipeBindings"] = [];
  const pathsByIdentity = new Map<string, TransformationModelDefinition["paths"][number]>();
  const directedRecipeAuthorities = new Map<string, number>();
  const componentBuildAuthorities = new Map<number, number>();
  const addPath = (path: TransformationModelDefinition["paths"][number], authority: string) => {
    const identity = `${path.sourceVariantId}:${path.destinationVariantId}`;
    const existing = pathsByIdentity.get(identity);
    if (!existing) {
      pathsByIdentity.set(identity, path);
      return;
    }
    if (canonicalJson(existing) !== canonicalJson(path)) {
      issues.push(issue(
        "CONFLICTING_DIRECTED_PATHS",
        "blocking",
        "Two legacy authorities produce different candidates for the same directed path.",
        { productId: source.product.id, identity, authority },
      ));
    }
  };

  if (source.product.legacyInventoryStrategy === "physical_fungible") {
    for (let index = 0; index < managedVariants.length - 1; index += 1) {
      const left = managedVariants[index]!;
      const right = managedVariants[index + 1]!;
      addPath(packagingPath(source.product.id, left, right), "legacy_physical_fungible");
      addPath(packagingPath(source.product.id, right, left), "legacy_physical_fungible");
    }
    issues.push(issue(
      "LEGACY_FUNGIBLE_DIRECTIONS_REQUIRE_REVIEW",
      "review",
      "The legacy shared pool was expanded into explicit two-way directed paths; every direction must be reviewed.",
      { productId: source.product.id, pathCount: pathsByIdentity.size },
    ));
  }

  for (const recipe of source.recipes) {
    const outputVariant = variantsById.get(recipe.outputVariantId);
    if (!outputVariant || recipe.outputProductId !== source.product.id) {
      issues.push(issue(
        "RECIPE_OUTPUT_NOT_ACTIVE",
        "blocking",
        "An active recipe output is not an active variant of the product.",
        { productId: source.product.id, recipeId: recipe.id, outputVariantId: recipe.outputVariantId },
      ));
    } else if (outputVariant.unitsPerVariant !== recipe.outputUnitsPerVariant) {
      issues.push(issue(
        "RECIPE_OUTPUT_UNIT_SNAPSHOT_MISMATCH",
        "blocking",
        "An active recipe output unit snapshot differs from the active output variant.",
        {
          productId: source.product.id,
          recipeId: recipe.id,
          outputVariantId: recipe.outputVariantId,
          recipeUnitsPerVariant: recipe.outputUnitsPerVariant,
          actualUnitsPerVariant: outputVariant.unitsPerVariant,
        },
      ));
    }
    if (recipe.components.length === 0) {
      issues.push(issue(
        "RECIPE_HAS_NO_COMPONENTS",
        "blocking",
        "An active recipe has no component snapshot.",
        { productId: source.product.id, recipeId: recipe.id },
      ));
    }
    const inactiveComponents = recipe.components
      .filter((component) => !component.isActive)
      .map((component) => component.componentVariantId);
    if (inactiveComponents.length > 0) {
      issues.push(issue(
        "RECIPE_COMPONENT_INACTIVE",
        "blocking",
        "An active recipe references an inactive component variant.",
        { productId: source.product.id, recipeId: recipe.id, componentVariantIds: inactiveComponents },
      ));
    }
    const unmanagedComponents = recipe.components
      .filter((component) => !isInventoryManagedVariant(component))
      .map((component) => component.componentVariantId);
    if (unmanagedComponents.length > 0) {
      issues.push(issue(
        "RECIPE_COMPONENT_NOT_INVENTORY_MANAGED",
        "blocking",
        "An active recipe references a digital or inventory-untracked component variant.",
        { productId: source.product.id, recipeId: recipe.id, componentVariantIds: unmanagedComponents },
      ));
    }
    const staleComponents = recipe.components
      .filter((component) => component.componentProductId !== component.actualProductId
        || component.componentUnitsPerVariant !== component.actualUnitsPerVariant)
      .map((component) => ({
        componentVariantId: component.componentVariantId,
        recipeProductId: component.componentProductId,
        actualProductId: component.actualProductId,
        recipeUnitsPerVariant: component.componentUnitsPerVariant,
        actualUnitsPerVariant: component.actualUnitsPerVariant,
      }));
    if (staleComponents.length > 0) {
      issues.push(issue(
        "RECIPE_COMPONENT_SNAPSHOT_MISMATCH",
        "blocking",
        "An active recipe component snapshot differs from the active component variant.",
        { productId: source.product.id, recipeId: recipe.id, components: staleComponents },
      ));
    }

    if (
      source.product.legacyInventoryStrategy === "recipe_managed"
      && recipe.recipeType === "assembly"
    ) {
      const existingRecipeId = componentBuildAuthorities.get(recipe.outputVariantId);
      if (existingRecipeId !== undefined) {
        issues.push(issue(
          "AMBIGUOUS_COMPONENT_BUILD_AUTHORITY",
          "blocking",
          "More than one active network build recipe claims authority for the same output variant.",
          {
            productId: source.product.id,
            outputVariantId: recipe.outputVariantId,
            recipeIds: [existingRecipeId, recipe.id],
          },
        ));
      } else {
        componentBuildAuthorities.set(recipe.outputVariantId, recipe.id);
      }
    }

    const bindingKey = `recipe:${recipe.id}:network`;
    const snapshot = {
      bindingKey,
      recipeId: recipe.id,
      relationshipRole: recipe.recipeType === "assembly"
        ? "component_build" as const
        : "directional_conversion" as const,
      warehouseId: null,
      recipeCodeSnapshot: recipe.code,
      recipeVersionSnapshot: recipe.version,
      recipeDefinitionHash: "",
      outputProductIdSnapshot: recipe.outputProductId,
      outputVariantIdSnapshot: recipe.outputVariantId,
      outputUnitsPerVariantSnapshot: recipe.outputUnitsPerVariant,
      outputQtySnapshot: recipe.outputQty,
      components: recipe.components.map((component) => ({
        componentVariantId: component.componentVariantId,
        componentProductId: component.componentProductId,
        componentUnitsPerVariant: component.componentUnitsPerVariant,
        componentQty: component.componentQty,
      })),
    };
    bindings.push({
      ...snapshot,
      recipeDefinitionHash: calculateRecipeDefinitionHash(snapshot),
    });

    if (
      source.product.legacyInventoryStrategy === "recipe_managed"
      && recipe.recipeType === "conversion"
    ) {
      const component = recipe.components[0];
      if (
        recipe.components.length !== 1
        || !component
        || component.componentProductId !== source.product.id
        || component.componentVariantId === recipe.outputVariantId
      ) {
        issues.push(issue(
          "CONVERSION_RECIPE_SHAPE_INVALID",
          "blocking",
          "A conversion recipe must contain one distinct source variant from the same product.",
          { productId: source.product.id, recipeId: recipe.id },
        ));
      } else {
        const identity = `${component.componentVariantId}:${recipe.outputVariantId}`;
        const existingRecipeId = directedRecipeAuthorities.get(identity);
        if (existingRecipeId !== undefined) {
          issues.push(issue(
            "DUPLICATE_DIRECTED_RECIPE_AUTHORITY",
            "blocking",
            "More than one active conversion recipe claims authority for the same directed path.",
            {
              productId: source.product.id,
              sourceVariantId: component.componentVariantId,
              destinationVariantId: recipe.outputVariantId,
              recipeIds: [existingRecipeId, recipe.id],
            },
          ));
        } else {
          directedRecipeAuthorities.set(identity, recipe.id);
        }
        addPath({
          sourceProductId: source.product.id,
          sourceVariantId: component.componentVariantId,
          destinationProductId: source.product.id,
          destinationVariantId: recipe.outputVariantId,
          inputQty: component.componentQty,
          outputQty: recipe.outputQty,
          sourceUnitsPerVariant: component.componentUnitsPerVariant,
          destinationUnitsPerVariant: recipe.outputUnitsPerVariant,
          operationType: "directed_conversion",
          authorityState: "allowed",
          transformationRecipeBindingKey: bindingKey,
        }, `recipe:${recipe.id}`);
      }
    }
  }

  if (
    source.recipes.length > 0
    && source.product.legacyInventoryStrategy !== "recipe_managed"
  ) {
    issues.push(issue(
      "RECIPES_BOUND_BUT_BUILD_PROMISE_DISABLED",
      "review",
      "Active recipes are snapshotted, but build-to-promise remains disabled to preserve the legacy strategy during review.",
      { productId: source.product.id, recipeIds: source.recipes.map((recipe) => recipe.id) },
    ));
  }
  if (source.product.legacyInventoryStrategy === "recipe_managed") {
    issues.push(issue(
      "RECIPE_MANAGED_PACKAGE_DIRECTIONS_REQUIRE_REVIEW",
      "review",
      "No sibling-package direction is inferred; package directions must be explicitly reviewed.",
      { productId: source.product.id },
    ));
  }

  const hasBlockingIssue = issues.some((entry) => entry.severity === "blocking");
  const provisionalClassification = managedVariants.length === 0
    ? "excluded_unmanaged" as const
    : source.product.legacyInventoryStrategy === "physical_only"
    ? "exact_only" as const
    : source.product.legacyInventoryStrategy === "physical_fungible"
      ? "legacy_fungible_directed_pool" as const
      : "recipe_managed_explicit_review" as const;
  // A product with no warehouse-managed variants is outside ATP authority. Keep
  // stale recipe problems visible as evidence, but do not let irrelevant
  // physical-planning records turn a digital-only product into an ATP blocker.
  const classification = managedVariants.length === 0
    ? "excluded_unmanaged" as const
    : hasBlockingIssue
      ? "blocked" as const
      : provisionalClassification;

  let definition: TransformationModelDefinition | null = null;
  let publicDefinition: InventoryAvailabilityBackfillDefinition | null = null;
  let definitionHash: string | null = null;
  if (!hasBlockingIssue && managedVariants.length > 0) {
    definition = transformationModelDefinitionSchema.parse({
      productId: source.product.id,
      buildToPromiseEnabled: source.product.legacyInventoryStrategy === "recipe_managed"
        && bindings.some((binding) => binding.relationshipRole === "component_build"),
      paths: [...pathsByIdentity.values()],
      recipeBindings: bindings,
    });
    definitionHash = calculateTransformationModelDefinitionHash(definition);
    publicDefinition = toPublicDefinition(definition);
  }

  const resultHash = hash({
    algorithmVersion: INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
    inputHash,
    classification,
    definitionHash,
    publicDefinition,
    issues,
  });
  return {
    algorithmVersion: INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
    source,
    classification,
    inputHash,
    resultHash,
    definitionHash,
    definition,
    publicDefinition,
    issues,
  };
}

export function calculateInventoryAvailabilityBackfillCatalogHash(
  kind: "input" | "result",
  candidates: readonly InventoryAvailabilityBackfillCandidate[],
): string {
  return hash({
    algorithmVersion: INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
    kind,
    products: [...candidates]
      .sort((left, right) => left.source.product.id - right.source.product.id)
      .map((candidate) => ({
        productId: candidate.source.product.id,
        hash: kind === "input" ? candidate.inputHash : candidate.resultHash,
      })),
  });
}
