import { describe, expect, it } from "vitest";
import type { TransformationAdminBinding, TransformationAdminModel, TransformationAdminPath } from "../../types/inventory-availability-admin";
import { prepareTransformationDraft } from "../transformation-draft-lifecycle";

const path = (source: number, destination: number, binding: string | null = null): TransformationAdminPath => ({
  sourceVariantId: source, destinationVariantId: destination, sourceUnitsPerVariant: 1, destinationUnitsPerVariant: 5,
  inputQty: 5, outputQty: 1, operationType: "assemble_pack", authorityState: "allowed", transformationRecipeBindingKey: binding,
});
const binding = (key: string, output: number, components: number[]): TransformationAdminBinding => ({
  bindingKey: key, recipeId: output, relationshipRole: "component_build", warehouseId: null,
  recipeCodeSnapshot: key, recipeVersionSnapshot: 1, recipeDefinitionHash: "b".repeat(64),
  outputProductIdSnapshot: 99, outputVariantIdSnapshot: output, outputUnitsPerVariantSnapshot: 5, outputQtySnapshot: 1,
  components: components.map(id => ({ componentVariantId: id, componentProductId: 78, componentUnitsPerVariant: 1, componentQty: 5 })),
});
const model = (paths: TransformationAdminPath[], bindings: TransformationAdminBinding[] = []): TransformationAdminModel => ({
  id: 91, productId: 99, version: 6, lifecycleStatus: "sealed", buildToPromiseEnabled: bindings.length > 0,
  definitionHash: "a".repeat(64), origin: "operator", originInputHash: null, originResultHash: null,
  validationState: "valid", validationErrors: [], changeReason: "Fixture", createdBy: "operator",
  createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z", paths, bindings,
});

describe("transformation draft lifecycle", () => {
  it.each([17, 915, 2147483647])("excludes any archived variant %i at either end without inferring a replacement", id => {
    const retained = { ...path(73, 85), authorityState: "blocked" as const };
    const original = model([path(id, 73), path(85, id), retained]);
    const before = structuredClone(original);
    const result = prepareTransformationDraft(original, [id]);
    expect(result.definition.paths).toEqual([retained]);
    expect(result.removedPaths).toEqual(original.paths.slice(0, 2));
    expect(original).toEqual(before);
  });

  it("removes the entire multi-component binding and its paths if an external component is archived", () => {
    const removed = binding("affected", 73, [1001, 1002]);
    const retained = binding("retained", 85, [1003]);
    const original = model([path(91, 73, "affected"), path(92, 85, "retained")], [removed, retained]);
    const result = prepareTransformationDraft(original, [1002]);
    expect(result.removedBindings).toEqual([removed]);
    expect(result.definition.bindings).toEqual([retained]);
    expect(result.definition.paths).toEqual([original.paths[1]]);
    expect(result.definition.buildToPromiseEnabled).toBe(true);
    expect(removed.components).toHaveLength(2);
  });

  it("disables build-to-promise only when removal retires the last component-build authority", () => {
    const original = model([], [binding("last", 73, [1001])]);
    expect(prepareTransformationDraft(original, [73]).definition).toEqual({ paths: [], bindings: [], buildToPromiseEnabled: false });
    const invalid = { ...model([]), buildToPromiseEnabled: true };
    expect(prepareTransformationDraft(invalid, []).definition.buildToPromiseEnabled).toBe(true);
  });

  it("does not reinterpret missing references or other catalog changes as archived", () => {
    const original = model([path(73, 85)], [binding("unchanged", 73, [1001])]);
    expect(prepareTransformationDraft(original, [9999]).definition).toEqual({
      paths: original.paths, bindings: original.bindings, buildToPromiseEnabled: true,
    });
  });

  it("handles all variants archived and repeated preparation deterministically", () => {
    const original = model([path(73, 85), path(85, 91)]);
    const first = prepareTransformationDraft(original, [73, 85, 91, 85]);
    expect(first.definition.paths).toEqual([]);
    expect(prepareTransformationDraft({ ...original, ...first.definition }, [91, 85, 73]).removedPaths).toEqual([]);
    expect(prepareTransformationDraft(original, [91, 85, 73])).toEqual(first);
  });
});
