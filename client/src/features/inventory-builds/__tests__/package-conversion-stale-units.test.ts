import { describe, expect, it } from "vitest";
import type {
  SupplyTransformationsAdminView,
  TransformationAdminModel,
  TransformationAdminVariant,
} from "@shared/types/inventory-availability-admin";
import {
  STALE_SIZE_ISSUE,
  buildPackageLadder,
  packageLadderModelEditIssues,
  staleLadderUnitRefreshes,
} from "../package-conversion-ladder";
import {
  beginPackageConversionEdit,
  buildPackageConversionCommand,
  changeInventoryBehavior,
  packageConversionHasChanges,
} from "../package-conversion-draft";
import { prefillPathsFromModel } from "@/pages/supply-transformations-model";

// Production case (product 324): the case variant went from 1000 to 2000 units
// after the rule "1 C1000 = 50 P20" was approved.
const P20: TransformationAdminVariant = { id: 776, productId: 324, sku: "GLV-GRD-SGC-JRSY-P20", name: "Pack of 20",
  unitsPerVariant: 20, uomType: "pack", isActive: true };
const CASE: TransformationAdminVariant = { id: 774, productId: 324, sku: "GLV-GRD-SGC-JRSY-C2000", name: "Case of 2,000",
  unitsPerVariant: 2000, uomType: "case", isActive: true };
type Path = TransformationAdminModel["paths"][number];
const breakPath = (patch: Partial<Path> = {}): Path => ({
  sourceVariantId: 774, destinationVariantId: 776, inputQty: 1, outputQty: 50,
  sourceUnitsPerVariant: 1000, destinationUnitsPerVariant: 20, operationType: "break_pack",
  authorityState: "allowed", transformationRecipeBindingKey: null, ...patch,
});

function model(paths: Path[] = [breakPath()], patch: Partial<TransformationAdminModel> = {}): TransformationAdminModel {
  return {
    id: 673, productId: 324, version: 1, lifecycleStatus: "sealed", inventoryBehavior: "package_hierarchy",
    buildToPromiseEnabled: false, definitionHash: "a".repeat(64), origin: "operator", originInputHash: null,
    originResultHash: null, validationState: "valid", validationErrors: [], changeReason: "Applied",
    createdBy: "operator", createdAt: "2026-11-06T14:32:56.000Z", updatedAt: "2026-11-06T14:32:56.000Z",
    bindings: [], paths, ...patch,
  };
}

function view(active: TransformationAdminModel = model()): SupplyTransformationsAdminView {
  return {
    product: { id: 324, sku: "GLV-GRD-SGC-JRSY", name: "Jersey Glove Guard", isActive: true, legacyInventoryStrategy: "physical_fungible" },
    variants: [P20, CASE], recipes: [], activeModel: active, draftModel: null,
    head: { revision: "1", activeModelId: active.id, draftModelId: null },
    runtimeSelection: { authority: "legacy", revision: "1", activationRunId: null },
    runtimeAuthority: { kind: "legacy_inventory_strategy", value: "physical_fungible", draftAffectsRuntime: false },
  };
}

describe("stale package-size ladder refresh", () => {
  it("recognises a lossless ladder step whose package size changed and recalculates it", () => {
    expect(staleLadderUnitRefreshes([P20, CASE], model())).toEqual([{
      sourceVariantId: 774, destinationVariantId: 776,
      sourceLabel: expect.any(String), destinationLabel: expect.any(String),
      before: { inputQty: "1", outputQty: "50", sourceUnitsPerVariant: 1000, destinationUnitsPerVariant: 20 },
      after: { inputQty: "1", outputQty: "100", operationType: "break_pack" },
    }]);
  });

  it("refreshes both directions of a reversible pair", () => {
    const build = breakPath({ sourceVariantId: 776, destinationVariantId: 774, inputQty: 50, outputQty: 1,
      sourceUnitsPerVariant: 20, destinationUnitsPerVariant: 1000, operationType: "assemble_pack" });
    const refreshes = staleLadderUnitRefreshes([P20, CASE], model([breakPath(), build]));
    expect(refreshes.map(refresh => [refresh.sourceVariantId, refresh.after.inputQty, refresh.after.outputQty]))
      .toEqual([[774, "1", "100"], [776, "100", "1"]]);
  });

  it("never refreshes custom quantities, recipes, blocked paths, or direction flips", () => {
    const variants = [P20, CASE];
    // Custom ratio at the old size (1 case -> 40 packs is not the lossless 1 -> 50).
    expect(staleLadderUnitRefreshes(variants, model([breakPath({ outputQty: 40 })]))).toEqual([]);
    expect(staleLadderUnitRefreshes(variants, model([breakPath({ authorityState: "blocked" })]))).toEqual([]);
    expect(staleLadderUnitRefreshes(variants, model([breakPath({ transformationRecipeBindingKey: "recipe:1" })]))).toEqual([]);
    expect(staleLadderUnitRefreshes(variants, model([breakPath({ operationType: "directed_conversion" })]))).toEqual([]);
    // The "case" became smaller than the pack: a break would now be an assembly.
    expect(staleLadderUnitRefreshes([P20, { ...CASE, unitsPerVariant: 10 }], model())).toEqual([]);
    // Inactive variant.
    expect(staleLadderUnitRefreshes([P20, { ...CASE, isActive: false }], model())).toEqual([]);
  });

  it("does nothing when the snapshot still matches the catalog", () => {
    expect(staleLadderUnitRefreshes([P20, { ...CASE, unitsPerVariant: 1000 }], model())).toEqual([]);
  });

  it("no longer blocks editing for refreshable drift, but still blocks unrefreshable drift", () => {
    expect(packageLadderModelEditIssues([P20, CASE], model())).toEqual([]);
    expect(packageLadderModelEditIssues([P20, CASE], model([breakPath({ outputQty: 30, sourceUnitsPerVariant: 800 })])))
      .toEqual(expect.arrayContaining([expect.stringContaining("catalog unit snapshot drift")]));
  });

  it("shows an actionable message in the read-only ladder instead of 'custom quantities'", () => {
    const active = model();
    const ladder = buildPackageLadder([P20, CASE], prefillPathsFromModel(active, 1).paths,
      staleLadderUnitRefreshes([P20, CASE], active));
    expect(ladder.rows).toHaveLength(1);
    expect(ladder.rows[0]).toMatchObject({ issue: STALE_SIZE_ISSUE, direction: null });
  });

  it("starts an edit with the recalculated step, flags it, and saves 1 case -> 100 packs", () => {
    const edit = beginPackageConversionEdit(view());
    expect(edit.unitRefreshes).toHaveLength(1);
    expect(edit.paths).toEqual([expect.objectContaining({ sourceVariantId: 774, destinationVariantId: 776,
      inputQty: "1", outputQty: "100", operationType: "break_pack" })]);
    // The ladder in edit mode is now a normal, editable ladder row.
    expect(buildPackageLadder(edit.baseline.variants, edit.paths).rows[0]).toMatchObject({ issue: null, direction: "break_down" });
    expect(packageConversionHasChanges(edit)).toBe(true);
    const command = buildPackageConversionCommand(edit, "attempt-1");
    expect(command.method).toBe("POST");
    expect(command.request.paths).toEqual([{ sourceVariantId: 774, destinationVariantId: 776, inputQty: 1, outputQty: 100,
      operationType: "break_pack", authorityState: "allowed", transformationRecipeBindingKey: null }]);
  });

  it("drops the refresh notice when the operator resets the behavior", () => {
    const edit = changeInventoryBehavior(beginPackageConversionEdit(view()), "physical_only");
    expect(edit.unitRefreshes).toEqual([]);
    expect(edit.paths).toEqual([]);
  });
});
