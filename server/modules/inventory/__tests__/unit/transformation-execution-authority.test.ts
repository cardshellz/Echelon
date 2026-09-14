import { describe, expect, it } from "vitest";

import {
  assertAuthorizedPackageConversionQuantity,
  authorizeBuildBindingDefinition,
  authorizePackageConversionDefinition,
  parseTransformationRuntimeAuthority,
  type BuildAuthorizationRequest,
  type BuildBindingDefinitionRecord,
  type PackageConversionAuthorizationRequest,
  type PackageConversionDefinitionRecord,
} from "../../domain/transformation-execution-authority";

const HASH = "a".repeat(64);
const BINDING_HASH = "b".repeat(64);
const canonicalRuntime = Object.freeze({
  authority: "canonical" as const,
  revision: "7",
  activationRunId: "11",
});

function packageRequest(
  sourceVariantId = 125,
  destinationVariantId = 105,
): PackageConversionAuthorizationRequest {
  return {
    productId: 10,
    operation: "break_pack",
    source: { variantId: sourceVariantId, productId: 10, unitsPerVariant: 25 },
    destination: { variantId: destinationVariantId, productId: 10, unitsPerVariant: 5 },
  };
}

function packageRecord(overrides: Partial<PackageConversionDefinitionRecord> = {}): PackageConversionDefinitionRecord {
  return {
    headRevision: "0",
    modelId: 501,
    modelProductId: 10,
    modelVersion: 2,
    modelLifecycleStatus: "sealed",
    modelValidationState: "valid",
    modelValidationErrors: [],
    modelDefinitionHash: HASH,
    pathId: 601,
    pathModelId: 501,
    sourceVariantId: 125,
    destinationVariantId: 105,
    inputQty: 1,
    outputQty: 5,
    sourceUnitsPerVariant: 25,
    destinationUnitsPerVariant: 5,
    operationType: "break_pack",
    authorityState: "allowed",
    pathValidationState: "valid",
    pathValidationErrors: [],
    sourceProductId: 10,
    currentSourceUnitsPerVariant: 25,
    destinationProductId: 10,
    currentDestinationUnitsPerVariant: 5,
    ...overrides,
  };
}

function buildRequest(): BuildAuthorizationRequest {
  return {
    recipeId: 77,
    recipeCode: "BUILD-EA",
    recipeVersion: 3,
    recipeType: "assembly",
    warehouseId: 1,
    outputProductId: 10,
    outputVariantId: 101,
    outputUnitsPerVariant: 1,
    outputQty: 4,
    components: [{
      componentVariantId: 201,
      componentProductId: 20,
      componentUnitsPerVariant: 1,
      componentQty: 2,
    }],
  };
}

function buildRecord(overrides: Partial<BuildBindingDefinitionRecord> = {}): BuildBindingDefinitionRecord {
  return {
    headRevision: "4",
    modelId: 501,
    modelProductId: 10,
    modelVersion: 2,
    modelLifecycleStatus: "sealed",
    modelValidationState: "valid",
    modelValidationErrors: [],
    modelDefinitionHash: HASH,
    bindingId: 701,
    bindingModelId: 501,
    recipeId: 77,
    relationshipRole: "component_build",
    warehouseId: null,
    recipeCodeSnapshot: "BUILD-EA",
    recipeVersionSnapshot: 3,
    recipeDefinitionHash: BINDING_HASH,
    outputProductIdSnapshot: 10,
    outputVariantIdSnapshot: 101,
    outputUnitsPerVariantSnapshot: 1,
    outputQtySnapshot: 4,
    bindingValidationState: "valid",
    bindingValidationErrors: [],
    definitionHashValid: true,
    catalogSnapshotsValid: true,
    components: [{
      componentVariantId: 201,
      componentProductId: 20,
      componentUnitsPerVariant: 1,
      componentQty: 2,
    }],
    linkedPath: null,
    ...overrides,
  };
}

describe("transformation execution authority", () => {
  it("parses exact runtime lineage and rejects a changed activation", () => {
    expect(parseTransformationRuntimeAuthority([{
      authority: "canonical",
      revision: 7n,
      activationRunId: 11n,
    }])).toEqual(canonicalRuntime);

    expect(() => parseTransformationRuntimeAuthority([{
      authority: "canonical",
      revision: "8",
      activationRunId: "11",
    }], canonicalRuntime)).toThrow(expect.objectContaining({
      code: "TRANSFORMATION_RUNTIME_AUTHORITY_CHANGED",
    }));
  });

  it("authorizes only the exact directed path and accepts head revision zero", () => {
    const authorization = authorizePackageConversionDefinition({
      request: packageRequest(),
      runtime: canonicalRuntime,
      records: [packageRecord()],
    });

    expect(authorization).toMatchObject({ pathId: 601, headRevision: "0", inputQty: 1, outputQty: 5 });
    expect(() => authorizePackageConversionDefinition({
      request: packageRequest(105, 125),
      runtime: canonicalRuntime,
      records: [],
    })).toThrow(expect.objectContaining({ code: "PACKAGE_CONVERSION_PATH_NOT_ALLOWED" }));
  });

  it("fails closed when a path UOM or operation direction drifts", () => {
    expect(() => authorizePackageConversionDefinition({
      request: packageRequest(),
      runtime: canonicalRuntime,
      records: [packageRecord({ currentSourceUnitsPerVariant: 20 })],
    })).toThrow(expect.objectContaining({ code: "PACKAGE_CONVERSION_PATH_INVALID" }));
    expect(() => authorizePackageConversionDefinition({
      request: packageRequest(),
      runtime: canonicalRuntime,
      records: [packageRecord({ sourceUnitsPerVariant: 5, destinationUnitsPerVariant: 25 })],
    })).toThrow(expect.objectContaining({ code: "PACKAGE_CONVERSION_PATH_INVALID" }));
  });

  it("requires whole repetitions of the authorized path quantities", () => {
    const authorization = authorizePackageConversionDefinition({
      request: packageRequest(),
      runtime: canonicalRuntime,
      records: [packageRecord({ inputQty: 2, outputQty: 10 })],
    });
    expect(() => assertAuthorizedPackageConversionQuantity(authorization, 1, 5))
      .toThrow(expect.objectContaining({ code: "PACKAGE_CONVERSION_QUANTITY_NOT_AUTHORIZED" }));
    expect(() => assertAuthorizedPackageConversionQuantity(authorization, 4, 20)).not.toThrow();
  });

  it("accepts an exact retained retired binding without requiring the active head", () => {
    const authorization = authorizeBuildBindingDefinition({
      request: buildRequest(),
      runtime: canonicalRuntime,
      records: [buildRecord({ modelLifecycleStatus: "retired", headRevision: null })],
      retained: true,
    });

    expect(authorization).toMatchObject({ modelId: 501, bindingId: 701, headRevision: null });
  });

  it("rejects an unbound canonical build recipe", () => {
    expect(() => authorizeBuildBindingDefinition({
      request: buildRequest(),
      runtime: canonicalRuntime,
      records: [],
    })).toThrow(expect.objectContaining({ code: "BUILD_BINDING_NOT_ACTIVE" }));
  });

  it("rejects a binding from a draft model", () => {
    expect(() => authorizeBuildBindingDefinition({
      request: buildRequest(),
      runtime: canonicalRuntime,
      records: [buildRecord({ modelLifecycleStatus: "draft" })],
    })).toThrow(expect.objectContaining({ code: "ACTIVE_TRANSFORMATION_MODEL_INVALID" }));
  });

  it("rejects build bindings after catalog UOM drift", () => {
    expect(() => authorizeBuildBindingDefinition({
      request: buildRequest(),
      runtime: canonicalRuntime,
      records: [buildRecord({ catalogSnapshotsValid: false })],
    })).toThrow(expect.objectContaining({ code: "BUILD_BINDING_INVALID" }));
  });
});
