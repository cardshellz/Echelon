import { describe, expect, it } from "vitest";

import {
  activeBuildRecipeIdsFromModel,
  bindingSnapshotEquation,
  deriveLosslessPath,
  deriveRecipePath,
  directedPairIsOccupied,
  draftHasUnsupportedBindings,
  isCompatibleConversionRecipe,
  prefillPathsFromModel,
  preserveSelectedProductOption,
  productOptionLabel,
  type TransformationAdminBinding,
  type TransformationAdminModel,
  type TransformationAdminRecipe,
  type TransformationAdminVariant,
  unavailableBuildBindingsForEdit,
} from "../supply-transformations-model";

const variants: TransformationAdminVariant[] = [
  variant({ id: 1, sku: "EA", unitsPerVariant: 1 }),
  variant({ id: 2, sku: "P5", unitsPerVariant: 5 }),
  variant({ id: 3, sku: "C25", unitsPerVariant: 25 }),
];

const conversionRecipe: TransformationAdminRecipe = {
  id: 71,
  code: "P5-TO-C25",
  name: "Assemble five P5 packs",
  version: 3,
  status: "active",
  recipeType: "conversion",
  outputProductId: 10,
  outputVariantId: 3,
  outputUnitsPerVariant: 25,
  outputQty: 1,
  components: [{
    componentVariantId: 2,
    componentProductId: 10,
    componentUnitsPerVariant: 5,
    componentQty: 5,
    sku: "P5",
    name: "Five pack",
  }],
};

describe("Supply & Transformations deterministic edit model", () => {
  it("derives reduced lossless ratios and operation direction in both directions", () => {
    expect(deriveLosslessPath(1, variants[0]!, variants[2]!)).toMatchObject({
      inputQty: "25",
      outputQty: "1",
      operationType: "assemble_pack",
      sourceVariantId: 1,
      destinationVariantId: 3,
    });
    expect(deriveLosslessPath(2, variants[2]!, variants[0]!)).toMatchObject({
      inputQty: "1",
      outputQty: "25",
      operationType: "break_pack",
      sourceVariantId: 3,
      destinationVariantId: 1,
    });
    expect(deriveLosslessPath(3, variants[1]!, variants[2]!)).toMatchObject({
      inputQty: "5",
      outputQty: "1",
      operationType: "assemble_pack",
    });
    expect(() => deriveLosslessPath(
      4,
      variants[1]!,
      variant({ id: 4, sku: "ALT-P5", unitsPerVariant: 5 }),
    )).toThrow("Equal-size variants require an explicit directional recipe");
  });

  it("allows an equal-size directed pair only when an exact conversion recipe authorizes it", () => {
    const equalSizedOutput = variant({ id: 4, sku: "ALT-P5", unitsPerVariant: 5 });
    const recipe = {
      ...conversionRecipe,
      id: 72,
      code: "P5-TO-ALT-P5",
      outputVariantId: equalSizedOutput.id,
      outputUnitsPerVariant: equalSizedOutput.unitsPerVariant,
      outputQty: 1,
      components: [{
        ...conversionRecipe.components[0]!,
        componentVariantId: variants[1]!.id,
        componentUnitsPerVariant: variants[1]!.unitsPerVariant,
        componentQty: 1,
      }],
    } satisfies TransformationAdminRecipe;
    expect(isCompatibleConversionRecipe(recipe, equalSizedOutput, [
      ...variants,
      equalSizedOutput,
    ])).toBe(true);
    expect(deriveRecipePath({
      rowId: 4,
      sourceVariantId: variants[1]!.id,
      destinationVariantId: equalSizedOutput.id,
      inputQty: "1",
      outputQty: "1",
      operationType: "directed_conversion",
      authorityState: "allowed",
      recipeId: null,
      recipeBindingKey: null,
    }, recipe)).toMatchObject({
      operationType: "directed_conversion",
      recipeId: 72,
      recipeBindingKey: "recipe:72:network",
    });
  });

  it("offers a directional recipe only for its exact active output and source snapshot", () => {
    expect(isCompatibleConversionRecipe(conversionRecipe, variants[2]!, variants)).toBe(true);
    expect(isCompatibleConversionRecipe(conversionRecipe, variants[1]!, variants)).toBe(false);
    expect(isCompatibleConversionRecipe(
      { ...conversionRecipe, components: [
        ...conversionRecipe.components,
        { ...conversionRecipe.components[0]!, componentVariantId: 1 },
      ] },
      variants[2]!,
      variants,
    )).toBe(false);
    expect(isCompatibleConversionRecipe(
      conversionRecipe,
      variants[2]!,
      variants.map((item) => item.id === 2 ? { ...item, isActive: false } : item),
    )).toBe(false);
  });

  it("derives and locks the exact declared recipe path", () => {
    const lossless = deriveLosslessPath(9, variants[0]!, variants[2]!, "blocked");
    expect(deriveRecipePath(lossless, conversionRecipe)).toEqual({
      rowId: 9,
      sourceVariantId: 2,
      destinationVariantId: 3,
      inputQty: "5",
      outputQty: "1",
      operationType: "directed_conversion",
      authorityState: "blocked",
      recipeId: 71,
      recipeBindingKey: "recipe:71:network",
    });
  });

  it("treats a directed source/output pair as occupied regardless of authority mechanism", () => {
    const lossless = deriveLosslessPath(1, variants[0]!, variants[2]!);
    const recipeBacked = deriveRecipePath(
      deriveLosslessPath(2, variants[0]!, variants[2]!),
      conversionRecipe,
    );
    expect(directedPairIsOccupied([lossless], 3, 1)).toBe(true);
    expect(directedPairIsOccupied([recipeBacked], 3, 2)).toBe(true);
    expect(directedPairIsOccupied([recipeBacked], 3, 2, recipeBacked.rowId)).toBe(false);
    expect(directedPairIsOccupied([lossless, recipeBacked], 2, 1)).toBe(false);
  });

  it("prefills an editable draft without changing persisted identity or version", () => {
    const model = draftModel();
    expect(prefillPathsFromModel(model, 20)).toEqual({
      paths: [{
        rowId: 20,
        sourceVariantId: 2,
        destinationVariantId: 3,
        inputQty: "5",
        outputQty: "1",
        operationType: "directed_conversion",
        authorityState: "allowed",
        recipeId: 71,
        recipeBindingKey: "recipe:71:network",
      }],
      nextRowId: 21,
    });
    expect(model).toMatchObject({ id: 501, version: 4 });
  });

  it("preserves a selected product that is absent from refreshed search results", () => {
    expect(preserveSelectedProductOption(
      [{ id: 11, sku: "SEARCH", name: "Search result" }],
      { id: 10, sku: "SELECTED", name: "Selected product" },
    )).toEqual([
      { id: 10, sku: "SELECTED", name: "Selected product" },
      { id: 11, sku: "SEARCH", name: "Search result" },
    ]);
    expect(preserveSelectedProductOption(
      [{ id: 10, sku: "SELECTED", name: "Selected product" }],
      { id: 10, sku: "SELECTED", name: "Selected product" },
    )).toHaveLength(1);
    expect(productOptionLabel({ id: 10, sku: "SELECTED", name: "Selected product" }))
      .toBe("SELECTED — Selected product");
    expect(productOptionLabel({ id: 10, sku: null, name: "Selected product" }))
      .toBe("Selected product");
  });

  it("preserves exact warehouse binding identity and marks it unsafe for this editor", () => {
    const model = draftModel();
    model.bindings = [draftBinding({
      bindingKey: "recipe:71:warehouse:4",
      warehouseId: 4,
    })];
    model.paths[0] = {
      ...model.paths[0]!,
      transformationRecipeBindingKey: "recipe:71:warehouse:4",
    };
    expect(prefillPathsFromModel(model, 30).paths[0]).toMatchObject({
      recipeId: 71,
      recipeBindingKey: "recipe:71:warehouse:4",
    });
    expect(draftHasUnsupportedBindings(model)).toBe(true);
  });

  it("prefills only currently selectable build recipes and identifies frozen stale bindings", () => {
    const model = draftModel();
    const currentAssembly = {
      ...conversionRecipe,
      id: 81,
      recipeType: "assembly",
      code: "CURRENT-BUILD",
    } satisfies TransformationAdminRecipe;
    model.bindings = [
      draftBinding({
        bindingKey: "recipe:80:network",
        recipeId: 80,
        relationshipRole: "component_build",
        recipeCodeSnapshot: "RETIRED-BUILD",
      }),
      draftBinding({
        bindingKey: "recipe:81:network",
        recipeId: 81,
        relationshipRole: "component_build",
        recipeCodeSnapshot: "CURRENT-BUILD",
      }),
    ];
    expect(activeBuildRecipeIdsFromModel(model, [currentAssembly])).toEqual([81]);
    expect(unavailableBuildBindingsForEdit(model, [currentAssembly]))
      .toMatchObject([{ recipeId: 80, recipeCodeSnapshot: "RETIRED-BUILD" }]);
  });

  it("renders cross-product BOM identity from immutable snapshots without inventing a SKU", () => {
    const binding = draftBinding({
      components: [{
        componentVariantId: 999,
        componentProductId: 88,
        componentUnitsPerVariant: 12,
        componentQty: 2,
      }],
    });
    expect(bindingSnapshotEquation(binding, variants)).toContain(
      "2 × variant #999 (product #88, 12 units/package)",
    );
  });
});

function variant(input: {
  id: number;
  sku: string;
  unitsPerVariant: number;
}): TransformationAdminVariant {
  return {
    id: input.id,
    productId: 10,
    sku: input.sku,
    name: input.sku,
    unitsPerVariant: input.unitsPerVariant,
    uomType: "unit",
    isActive: true,
  };
}

function draftBinding(
  override: Partial<TransformationAdminBinding> = {},
): TransformationAdminBinding {
  return {
    bindingKey: "recipe:71:network",
    recipeId: 71,
    relationshipRole: "directional_conversion",
    warehouseId: null,
    recipeCodeSnapshot: "P5-TO-C25",
    recipeVersionSnapshot: 3,
    recipeDefinitionHash: "a".repeat(64),
    outputProductIdSnapshot: 10,
    outputVariantIdSnapshot: 3,
    outputUnitsPerVariantSnapshot: 25,
    outputQtySnapshot: 1,
    components: [{
      componentVariantId: 2,
      componentProductId: 10,
      componentUnitsPerVariant: 5,
      componentQty: 5,
    }],
    ...override,
  };
}

function draftModel(): TransformationAdminModel {
  return {
    id: 501,
    productId: 10,
    version: 4,
    lifecycleStatus: "draft",
    buildToPromiseEnabled: false,
    definitionHash: "b".repeat(64),
    validationState: "valid",
    validationErrors: [],
    changeReason: "Initial authority",
    createdBy: "operator-1",
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    bindings: [draftBinding()],
    paths: [{
      sourceVariantId: 2,
      destinationVariantId: 3,
      inputQty: 5,
      outputQty: 1,
      sourceUnitsPerVariant: 5,
      destinationUnitsPerVariant: 25,
      operationType: "directed_conversion",
      authorityState: "allowed",
      transformationRecipeBindingKey: "recipe:71:network",
    }],
  };
}
