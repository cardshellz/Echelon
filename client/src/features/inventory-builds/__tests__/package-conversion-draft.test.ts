import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SupplyTransformationsAdminView,
  type TransformationAdminBinding,
  type TransformationAdminModel,
} from "@shared/types/inventory-availability-admin";
import { updatePackageLadderDirection } from "../package-conversion-ladder";
import {
  beginPackageConversionEdit,
  buildPackageConversionCommand,
  loadProductConversions,
  PACKAGE_CONVERSION_AUDIT_NOTE,
  packageConversionEditIssues,
  packageConversionHasChanges,
  PackageConversionHttpError,
  savePackageConversionCommand,
  transformationQueryKey,
  type PackageConversionEdit,
} from "../package-conversion-draft";

afterEach(() => vi.unstubAllGlobals());

describe("package conversion draft commands", () => {
  it("creates a new draft with explicit paths, deterministic reason, and caller idempotency", () => {
    const command = buildPackageConversionCommand(changeDirection(beginPackageConversionEdit(view())), "attempt-1");
    expect(command).toEqual({
      method: "POST", url: "/api/inventory-planning/admin/supply-transformations/10/drafts",
      request: {
        productId: 10, buildToPromiseEnabled: false, recipeBindings: [],
        paths: [
          { sourceVariantId: 1, destinationVariantId: 2, inputQty: 5, outputQty: 1,
            operationType: "assemble_pack", authorityState: "allowed", transformationRecipeBindingKey: null },
          { sourceVariantId: 2, destinationVariantId: 1, inputQty: 1, outputQty: 5,
            operationType: "break_pack", authorityState: "allowed", transformationRecipeBindingKey: null },
        ], changeReason: PACKAGE_CONVERSION_AUDIT_NOTE, idempotencyKey: "attempt-1",
      },
    });
  });

  it("updates the current draft with the captured version, definition hash and head revision", () => {
    const baseline = view({ draftModel: model(), head: { revision: "9007199254740993", draftModelId: 501, activeModelId: null } });
    const edit = changeDirection(beginPackageConversionEdit(baseline));
    const command = buildPackageConversionCommand(edit, "attempt-2");
    expect(command).toMatchObject({ method: "PUT", url: "/api/inventory-planning/admin/supply-transformations/10/drafts/501",
      request: { expectedVersion: 4, expectedDefinitionHash: "a".repeat(64), expectedHeadRevision: "9007199254740993" } });
    expect(command.request).not.toHaveProperty("productId");
    expect(command.request.paths).toHaveLength(3);
    expect(command.request.paths[0]).toEqual({
      sourceVariantId: 1, destinationVariantId: 3, inputQty: 25, outputQty: 1,
      operationType: "assemble_pack", authorityState: "allowed", transformationRecipeBindingKey: null,
    });
  });

  it("creates from the sealed model without changing its unrelated paths or identity", () => {
    const baseline = view({ activeModel: model({ lifecycleStatus: "sealed" }), head: { revision: "4", activeModelId: 501, draftModelId: null } });
    const before = structuredClone(baseline);
    const command = buildPackageConversionCommand(changeDirection(beginPackageConversionEdit(baseline)), "attempt-3");
    expect(command.method).toBe("POST");
    expect(command.request.paths[0]).toMatchObject({ sourceVariantId: 1, destinationVariantId: 3, inputQty: 25, outputQty: 1 });
    expect(baseline).toEqual(before);
  });

  it("deep-captures the baseline instead of rebasing edits onto refreshed response objects", () => {
    const response = view({ draftModel: model(), head: { revision: "4", draftModelId: 501, activeModelId: null } });
    const edit = changeDirection(beginPackageConversionEdit(response));
    response.head!.revision = "5";
    response.draftModel!.definitionHash = "b".repeat(64);
    response.variants[0]!.unitsPerVariant = 2;
    expect(buildPackageConversionCommand(edit, "attempt-4").request).toMatchObject({
      expectedHeadRevision: "4", expectedDefinitionHash: "a".repeat(64),
    });
    expect(edit.baseline.variants[0]?.unitsPerVariant).toBe(1);
  });

  it("ignores row IDs and array order when detecting operator changes", () => {
    const initial = beginPackageConversionEdit(view({ draftModel: model(), head: { revision: "4", draftModelId: 501, activeModelId: null } }));
    expect(packageConversionHasChanges(initial)).toBe(false);
    expect(packageConversionHasChanges({ ...initial, paths: initial.paths.map(path => ({ ...path, rowId: 88 })).reverse() })).toBe(false);
    expect(() => buildPackageConversionCommand(initial, "attempt-no-change")).toThrow("Choose a conversion direction");
    const changed = changeDirection(initial);
    expect(packageConversionHasChanges(changed)).toBe(true);
    const reverted = { ...changed, ...updatePackageLadderDirection({
      variants: changed.baseline.variants, paths: changed.paths, nextRowId: changed.nextRowId,
      lowerVariantId: 1, upperVariantId: 2, direction: "none",
    }) };
    expect(packageConversionHasChanges(reverted)).toBe(false);
  });

  it("prefers a current draft over the active definition", () => {
    const active = model({ id: 500, version: 3, lifecycleStatus: "sealed", paths: [] });
    const draft = model();
    const edit = beginPackageConversionEdit(view({ activeModel: active, draftModel: draft,
      head: { revision: "5", activeModelId: 500, draftModelId: 501 } }));
    expect(edit.paths).toHaveLength(1);
    expect(edit.paths[0]).toMatchObject({ sourceVariantId: 1, destinationVariantId: 3 });
  });

  it.each([
    ["missing draft head", { draftModel: model() }],
    ["missing draft model", { head: { revision: "4", draftModelId: 501, activeModelId: null } }],
    ["mismatched head", { draftModel: model(), head: { revision: "4", draftModelId: 999, activeModelId: null } }],
    ["draft not in draft lifecycle", { draftModel: model({ lifecycleStatus: "sealed" }), head: { revision: "4", draftModelId: 501, activeModelId: null } }],
    ["active not sealed", { activeModel: model(), head: { revision: "4", draftModelId: null, activeModelId: 501 } }],
  ] satisfies [string, Partial<SupplyTransformationsAdminView>][])("rejects %s before editing", (_label, patch) => {
    expect(() => beginPackageConversionEdit(view(patch))).toThrow("saved head");
  });

  it("rejects inactive products, unsupported strategies, and malformed responses", () => {
    const inactive = view();
    inactive.product.isActive = false;
    expect(packageConversionEditIssues(inactive)).toContain("Archived products cannot be edited here.");
    const recipeManaged = view();
    recipeManaged.product.legacyInventoryStrategy = "recipe_managed";
    expect(() => beginPackageConversionEdit(recipeManaged)).toThrow("Package hierarchy products only");
    const invalid = view();
    invalid.variants[0]!.unitsPerVariant = 0;
    expect(() => beginPackageConversionEdit(invalid)).toThrow();
  });

  it("rejects foreign variants even when there is no existing model", () => {
    const mismatched = view();
    mismatched.variants = mismatched.variants.map(variant => ({ ...variant, productId: 99 }));
    expect(() => beginPackageConversionEdit(mismatched)).toThrow("belong to a different product");
  });

  it("rejects a foreign model even when the catalog is empty", () => {
    const mismatched = view({ variants: [], draftModel: model({ productId: 99, paths: [] }),
      head: { revision: "4", draftModelId: 501, activeModelId: null } });
    expect(() => beginPackageConversionEdit(mismatched)).toThrow("belong to a different product");
  });

  it("checks the active model product identity even when editing a valid draft", () => {
    const mismatched = view({ draftModel: model(), activeModel: model({ id: 500, productId: 99, lifecycleStatus: "sealed" }),
      head: { revision: "4", draftModelId: 501, activeModelId: 500 } });
    expect(() => beginPackageConversionEdit(mismatched)).toThrow("belong to a different product");
  });

  it("blocks any recipe-binding model instead of resnapshotting or dropping its authority", () => {
    const original = view({ draftModel: model({ bindings: [binding()] }), head: { revision: "4", draftModelId: 501, activeModelId: null } });
    const before = structuredClone(original);
    expect(() => beginPackageConversionEdit(original)).toThrow("cannot save it without re-snapshotting");
    expect(original).toEqual(before);
  });

  it("validates command quantity and idempotency fields before transport", () => {
    const edit = changeDirection(beginPackageConversionEdit(view()));
    expect(() => buildPackageConversionCommand(edit, "")).toThrow();
    const invalid = { ...edit, paths: edit.paths.map((path, index) => index === 0 ? { ...path, inputQty: "NaN" } : path) };
    expect(() => buildPackageConversionCommand(invalid, "attempt-invalid")).toThrow();
  });

  it("retains the detailed editor query cache identity", () => {
    expect(transformationQueryKey(10)).toEqual(["/api/inventory-planning/admin/supply-transformations", 10]);
  });
});

describe("package conversion API boundary", () => {
  it("loads and validates the requested product with credentials and cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(view()));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await loadProductConversions(10, controller.signal)).toEqual(view());
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory-planning/admin/supply-transformations/10", {
      credentials: "include", signal: controller.signal,
    });
  });

  it("rejects successful responses for the wrong product or malformed data", async () => {
    const wrongProduct = view();
    wrongProduct.product.id = 99;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(wrongProduct)));
    await expect(loadProductConversions(10)).rejects.toThrow("different product");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(loadProductConversions(10)).rejects.toThrow();
  });

  it.each([403, 409, 429, 500])("preserves HTTP %s as a distinguishable response error", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { code: "SPECIFIC_REJECTION", message: "Specific rejection" } }, status)));
    await expect(loadProductConversions(10)).rejects.toMatchObject({ status, code: "SPECIFIC_REJECTION", message: "Specific rejection" });
  });

  it("handles an unreadable failure body without discarding the response status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 409 })));
    const result = loadProductConversions(10);
    await expect(result).rejects.toBeInstanceOf(PackageConversionHttpError);
    await expect(result).rejects.toMatchObject({ status: 409, message: "Request failed (409)." });
  });

  it("retries an identical caller-owned command and reports the recorded idempotent result", async () => {
    const command = buildPackageConversionCommand(changeDirection(beginPackageConversionEdit(view())), "same-attempt");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Network interruption"))
      .mockResolvedValueOnce(jsonResponse({ modelId: 501, version: 4, definitionHash: "a".repeat(64), alreadyApplied: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(savePackageConversionCommand(command)).rejects.toThrow("Network interruption");
    await expect(savePackageConversionCommand(command)).resolves.toMatchObject({ alreadyApplied: true });
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
    expect(fetchMock).toHaveBeenLastCalledWith(command.url, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.request),
    });
  });

  it("does not treat a malformed success body as a confirmed save", async () => {
    const command = buildPackageConversionCommand(changeDirection(beginPackageConversionEdit(view())), "attempt-malformed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    await expect(savePackageConversionCommand(command)).rejects.toThrow();
  });
});

function changeDirection(edit: PackageConversionEdit): PackageConversionEdit {
  return { ...edit, ...updatePackageLadderDirection({
    variants: edit.baseline.variants, paths: edit.paths, nextRowId: edit.nextRowId,
    lowerVariantId: 1, upperVariantId: 2, direction: "reversible",
  }) };
}

function view(patch: Partial<SupplyTransformationsAdminView> = {}): SupplyTransformationsAdminView {
  return {
    product: { id: 10, sku: "PRODUCT", name: "Product", isActive: true, legacyInventoryStrategy: "physical_fungible" },
    variants: [1, 5, 25].map((unitsPerVariant, index) => ({
      id: index + 1, productId: 10, sku: `V${index + 1}`, name: `Variant ${index + 1}`,
      unitsPerVariant, uomType: "pack", isActive: true,
    })), recipes: [], activeModel: null, draftModel: null, head: null,
    runtimeSelection: { authority: "legacy", revision: "1", activationRunId: null },
    runtimeAuthority: { kind: "legacy_inventory_strategy", value: "physical_fungible", draftAffectsRuntime: false },
    ...patch,
  };
}

function model(patch: Partial<TransformationAdminModel> = {}): TransformationAdminModel {
  return {
    id: 501, productId: 10, version: 4, lifecycleStatus: "draft", buildToPromiseEnabled: false,
    definitionHash: "a".repeat(64), origin: "operator", originInputHash: null, originResultHash: null,
    validationState: "valid", validationErrors: [], changeReason: "Existing model", createdBy: "operator",
    createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z", bindings: [],
    paths: [{ sourceVariantId: 1, destinationVariantId: 3, inputQty: 25, outputQty: 1,
      sourceUnitsPerVariant: 1, destinationUnitsPerVariant: 25, operationType: "assemble_pack",
      authorityState: "allowed", transformationRecipeBindingKey: null }], ...patch,
  };
}

function binding(): TransformationAdminBinding {
  return {
    bindingKey: "recipe:71", recipeId: 71, relationshipRole: "directional_conversion", warehouseId: null,
    recipeCodeSnapshot: "ASSEMBLE-P5", recipeVersionSnapshot: 1, recipeDefinitionHash: "b".repeat(64),
    outputProductIdSnapshot: 10, outputVariantIdSnapshot: 2, outputUnitsPerVariantSnapshot: 5, outputQtySnapshot: 1,
    components: [{ componentVariantId: 1, componentProductId: 10, componentUnitsPerVariant: 1, componentQty: 5 }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
