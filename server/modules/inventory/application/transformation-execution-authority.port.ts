import type {
  BuildAuthorization,
  BuildAuthorizationRequest,
  PackageConversionAuthorization,
  PackageConversionAuthorizationRequest,
  TransformationRuntimeEvidence,
} from "../domain/transformation-execution-authority";

export type TransformationAuthorityTransaction = {
  execute: (...args: any[]) => any;
};

/**
 * Inventory owns the execution contract. Inventory-planning supplies the
 * persistence adapter so operational code cannot read planning tables itself.
 */
export interface TransformationExecutionAuthorityPort {
  readRuntime(expected?: TransformationRuntimeEvidence): Promise<TransformationRuntimeEvidence>;
  pinRuntime(
    tx: TransformationAuthorityTransaction,
    expected: TransformationRuntimeEvidence,
  ): Promise<TransformationRuntimeEvidence>;
  authorizePackageConversion(
    request: PackageConversionAuthorizationRequest,
    expectedRuntime?: TransformationRuntimeEvidence,
  ): Promise<PackageConversionAuthorization>;
  pinPackageConversion(
    tx: TransformationAuthorityTransaction,
    request: PackageConversionAuthorizationRequest,
    expected: PackageConversionAuthorization,
  ): Promise<PackageConversionAuthorization>;
  pinBuildRecipe(
    tx: TransformationAuthorityTransaction,
    recipeId: number,
    warehouseId: number,
  ): Promise<BuildAuthorization>;
  pinBuildOrder(
    tx: TransformationAuthorityTransaction,
    buildOrderId: number,
  ): Promise<BuildAuthorization>;
  validatePinnedBuildOrder(
    tx: TransformationAuthorityTransaction,
    buildOrderId: number,
  ): Promise<BuildAuthorization>;
  assertBuildSnapshot(
    authorization: BuildAuthorization,
    request: BuildAuthorizationRequest,
  ): void;
}

/** Explicit compatibility seam for isolated pre-cutover tests only. */
export const legacyTransformationExecutionAuthority: TransformationExecutionAuthorityPort = {
  async readRuntime(expected) {
    const runtime = Object.freeze({ authority: "legacy" as const, revision: "1", activationRunId: null });
    if (expected && JSON.stringify(expected) !== JSON.stringify(runtime)) {
      throw new Error("Legacy test transformation authority changed unexpectedly.");
    }
    return runtime;
  },
  async pinRuntime(_tx, expected) {
    if (expected.authority !== "legacy" || expected.revision !== "1" || expected.activationRunId !== null) {
      throw new Error("Legacy test transformation runtime changed unexpectedly.");
    }
    return expected;
  },
  async authorizePackageConversion(request) {
    return Object.freeze({
      runtime: Object.freeze({ authority: "legacy" as const, revision: "1", activationRunId: null }),
      productId: request.productId,
      operation: request.operation,
      headRevision: null,
      modelId: null,
      modelVersion: null,
      modelDefinitionHash: null,
      pathId: null,
      inputQty: null,
      outputQty: null,
    });
  },
  async pinPackageConversion(_tx, request, expected) {
    if (expected.runtime.authority !== "legacy" || expected.productId !== request.productId
      || expected.operation !== request.operation) {
      throw new Error("Legacy test package-conversion authorization changed unexpectedly.");
    }
    return expected;
  },
  async pinBuildRecipe(_tx, recipeId, warehouseId) {
    return Object.freeze({
      runtime: Object.freeze({ authority: "legacy" as const, revision: "1", activationRunId: null }),
      productId: 1, headRevision: null, modelId: null, modelVersion: null,
      modelDefinitionHash: null, bindingId: null, bindingDefinitionHash: null,
      relationshipRole: null, warehouseId: null,
      request: Object.freeze({ recipeId, recipeCode: "legacy", recipeVersion: 1, recipeType: "assembly" as const,
        warehouseId, outputProductId: 1, outputVariantId: 1, outputUnitsPerVariant: 1,
        outputQty: 1, components: Object.freeze([{ componentVariantId: 2, componentProductId: 2,
          componentUnitsPerVariant: 1, componentQty: 1 }]) }),
    });
  },
  async pinBuildOrder(tx, buildOrderId) {
    return this.pinBuildRecipe(tx, buildOrderId, 1);
  },
  async validatePinnedBuildOrder(tx, buildOrderId) {
    return this.pinBuildOrder(tx, buildOrderId);
  },
  assertBuildSnapshot() {},
};
