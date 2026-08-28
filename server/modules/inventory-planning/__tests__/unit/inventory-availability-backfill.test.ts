import { describe, expect, it } from "vitest";

import {
  calculateInventoryAvailabilityBackfillCatalogHash,
  planInventoryAvailabilityBackfill,
  type InventoryAvailabilityBackfillSource,
} from "../../domain/inventory-availability-backfill";

const variants: InventoryAvailabilityBackfillSource["variants"] = [
  { id: 11, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1, uomType: "each", isActive: true },
  { id: 12, productId: 10, sku: "P5", name: "Pack 5", unitsPerVariant: 5, uomType: "pack", isActive: true },
  { id: 13, productId: 10, sku: "C25", name: "Case 25", unitsPerVariant: 25, uomType: "case", isActive: true },
];

function source(
  legacyInventoryStrategy: InventoryAvailabilityBackfillSource["product"]["legacyInventoryStrategy"],
): InventoryAvailabilityBackfillSource {
  return {
    product: { id: 10, sku: "PRODUCT", name: "Product", isActive: true, legacyInventoryStrategy },
    variants,
    recipes: [],
  };
}

describe("deterministic inventory availability backfill", () => {
  it("maps physical-only products to an exact-only draft with no package paths", () => {
    const candidate = planInventoryAvailabilityBackfill(source("physical_only"));
    expect(candidate.classification).toBe("exact_only");
    expect(candidate.definition).toMatchObject({
      productId: 10,
      buildToPromiseEnabled: false,
      paths: [],
      recipeBindings: [],
    });
    expect(candidate.issues).toEqual([]);
  });

  it("expands a fungible pool into explicit adjacent directions without implicit shortcuts", () => {
    const candidate = planInventoryAvailabilityBackfill(source("physical_fungible"));
    const identities = candidate.definition!.paths.map((path) =>
      `${path.sourceVariantId}->${path.destinationVariantId}`);
    expect(candidate.classification).toBe("legacy_fungible_directed_pool");
    expect(identities).toEqual(["11->12", "12->11", "12->13", "13->12"]);
    expect(identities).not.toContain("11->13");
    expect(identities).not.toContain("13->11");
    expect(candidate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LEGACY_FUNGIBLE_DIRECTIONS_REQUIRE_REVIEW", severity: "review" }),
    ]));
  });

  it("binds exact active recipe versions but never invents a reverse recipe path", () => {
    const recipeSource = source("recipe_managed");
    recipeSource.recipes = [
      {
        id: 30,
        code: "EA-TO-P5",
        name: "Pack five",
        version: 4,
        status: "active",
        recipeType: "conversion",
        outputProductId: 10,
        outputVariantId: 12,
        outputUnitsPerVariant: 5,
        outputQty: 1,
        components: [{
          componentVariantId: 11,
           componentProductId: 10,
           componentUnitsPerVariant: 1,
           actualProductId: 10,
           actualUnitsPerVariant: 1,
           componentQty: 5,
          sku: "EA",
          name: "Each",
          isActive: true,
        }],
      },
      {
        id: 31,
        code: "BUILD-C25",
        name: "Build case",
        version: 2,
        status: "active",
        recipeType: "assembly",
        outputProductId: 10,
        outputVariantId: 13,
        outputUnitsPerVariant: 25,
        outputQty: 1,
        components: [{
          componentVariantId: 99,
           componentProductId: 90,
           componentUnitsPerVariant: 1,
           actualProductId: 90,
           actualUnitsPerVariant: 1,
           componentQty: 2,
          sku: "COMPONENT",
          name: "Component",
          isActive: true,
        }],
      },
    ];
    const candidate = planInventoryAvailabilityBackfill(recipeSource);
    expect(candidate.classification).toBe("recipe_managed_explicit_review");
    expect(candidate.definition?.buildToPromiseEnabled).toBe(true);
    expect(candidate.definition?.recipeBindings).toHaveLength(2);
    expect(candidate.definition?.paths).toEqual([
      expect.objectContaining({
        sourceVariantId: 11,
        destinationVariantId: 12,
        inputQty: 5,
        outputQty: 1,
        transformationRecipeBindingKey: "recipe:30:network",
      }),
    ]);
  });

  it("blocks malformed active recipe references instead of synthesizing authority", () => {
    const recipeSource = source("recipe_managed");
    recipeSource.recipes = [{
      id: 30,
      code: "EA-TO-P5",
      name: "Pack five",
      version: 1,
      status: "active",
      recipeType: "conversion",
      outputProductId: 10,
      outputVariantId: 12,
      outputUnitsPerVariant: 5,
      outputQty: 1,
      components: [{
        componentVariantId: 11,
       componentProductId: 10,
       componentUnitsPerVariant: 1,
       actualProductId: 10,
       actualUnitsPerVariant: 1,
       componentQty: 5,
        sku: "EA",
        name: "Each",
        isActive: false,
      }],
    }];
    const candidate = planInventoryAvailabilityBackfill(recipeSource);
    expect(candidate.classification).toBe("blocked");
    expect(candidate.definition).toBeNull();
    expect(candidate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RECIPE_COMPONENT_INACTIVE", severity: "blocking" }),
    ]));
  });

  it("blocks stale recipe unit snapshots before creating a draft", () => {
    const recipeSource = source("recipe_managed");
    recipeSource.recipes = [{
      id: 30,
      code: "EA-TO-P5",
      name: "Pack five",
      version: 1,
      status: "active",
      recipeType: "conversion",
      outputProductId: 10,
      outputVariantId: 12,
      outputUnitsPerVariant: 6,
      outputQty: 1,
      components: [{
        componentVariantId: 11,
        componentProductId: 10,
        componentUnitsPerVariant: 1,
        actualProductId: 10,
        actualUnitsPerVariant: 2,
        componentQty: 5,
        sku: "EA",
        name: "Each",
        isActive: true,
      }],
    }];

    const candidate = planInventoryAvailabilityBackfill(recipeSource);

    expect(candidate.classification).toBe("blocked");
    expect(candidate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RECIPE_OUTPUT_UNIT_SNAPSHOT_MISMATCH" }),
      expect.objectContaining({ code: "RECIPE_COMPONENT_SNAPSHOT_MISMATCH" }),
    ]));
  });

  it("blocks duplicate active recipe authority for the same directed path", () => {
    const recipeSource = source("recipe_managed");
    const conversion = {
      id: 30,
      code: "EA-TO-P5-A",
      name: "Pack five A",
      version: 1,
      status: "active" as const,
      recipeType: "conversion" as const,
      outputProductId: 10,
      outputVariantId: 12,
      outputUnitsPerVariant: 5,
      outputQty: 1,
      components: [{
        componentVariantId: 11,
        componentProductId: 10,
        componentUnitsPerVariant: 1,
        actualProductId: 10,
        actualUnitsPerVariant: 1,
        componentQty: 5,
        sku: "EA",
        name: "Each",
        isActive: true,
      }],
    };
    recipeSource.recipes = [
      conversion,
      { ...conversion, id: 31, code: "EA-TO-P5-B", name: "Pack five B" },
    ];

    const candidate = planInventoryAvailabilityBackfill(recipeSource);

    expect(candidate.classification).toBe("blocked");
    expect(candidate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DUPLICATE_DIRECTED_RECIPE_AUTHORITY" }),
    ]));
  });

  it("produces stable hashes regardless of source ordering", () => {
    const ordered = planInventoryAvailabilityBackfill(source("physical_fungible"));
    const reorderedSource = source("physical_fungible");
    reorderedSource.variants = [...reorderedSource.variants].reverse();
    const reordered = planInventoryAvailabilityBackfill(reorderedSource);
    expect(reordered.inputHash).toBe(ordered.inputHash);
    expect(reordered.resultHash).toBe(ordered.resultHash);
    expect(calculateInventoryAvailabilityBackfillCatalogHash("input", [ordered]))
      .toMatch(/^[0-9a-f]{64}$/);
  });
});
