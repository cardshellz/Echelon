import { describe, expect, it } from "vitest";

import {
  calculateRecipeDefinitionHash,
  calculateTransformationModelDefinitionHash,
  demandEvidenceSnapshotSchema,
  promiseSafetyPolicyDraftSchema,
  safetyPolicyScopeKey,
  transformationModelDefinitionSchema,
  type TransformationModelDefinition,
} from "../../domain/inventory-availability-master-data.contracts";

const HASH = "a".repeat(64);

function directionalBinding() {
  const binding = {
    bindingKey: "ea-to-p5-recipe",
    recipeId: 41,
    relationshipRole: "directional_conversion" as const,
    warehouseId: null,
    recipeCodeSnapshot: "EA-TO-P5",
    recipeVersionSnapshot: 2,
    recipeDefinitionHash: HASH,
    outputProductIdSnapshot: 10,
    outputVariantIdSnapshot: 102,
    outputUnitsPerVariantSnapshot: 5,
    outputQtySnapshot: 1,
    components: [{
      componentVariantId: 101,
      componentProductId: 10,
      componentUnitsPerVariant: 1,
      componentQty: 1,
    }],
  };
  return { ...binding, recipeDefinitionHash: calculateRecipeDefinitionHash(binding) };
}

function explicitPackagingDefinition(): TransformationModelDefinition {
  return {
    productId: 10,
    buildToPromiseEnabled: false,
    recipeBindings: [],
    paths: [
      {
        sourceProductId: 10,
        sourceVariantId: 101,
        destinationProductId: 10,
        destinationVariantId: 102,
        inputQty: 5,
        outputQty: 1,
        sourceUnitsPerVariant: 1,
        destinationUnitsPerVariant: 5,
        operationType: "assemble_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      },
      {
        sourceProductId: 10,
        sourceVariantId: 102,
        destinationProductId: 10,
        destinationVariantId: 101,
        inputQty: 1,
        outputQty: 5,
        sourceUnitsPerVariant: 5,
        destinationUnitsPerVariant: 1,
        operationType: "break_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      },
    ],
  };
}

describe("inventory availability master-data contracts", () => {
  it("accepts separately authorized paths in both directions", () => {
    expect(transformationModelDefinitionSchema.safeParse(explicitPackagingDefinition()).success).toBe(true);
  });

  it("enforces operation direction from the immutable package sizes", () => {
    const reversedAssemble = explicitPackagingDefinition();
    reversedAssemble.paths = [{
      ...reversedAssemble.paths[1]!,
      operationType: "assemble_pack",
    }];
    const assembleResult = transformationModelDefinitionSchema.safeParse(reversedAssemble);
    expect(assembleResult.success).toBe(false);
    expect(assembleResult.error?.issues.some((issue) =>
      issue.message.includes("smaller package to a larger package"))).toBe(true);

    const reversedBreak = explicitPackagingDefinition();
    reversedBreak.paths = [{
      ...reversedBreak.paths[0]!,
      operationType: "break_pack",
    }];
    const breakResult = transformationModelDefinitionSchema.safeParse(reversedBreak);
    expect(breakResult.success).toBe(false);
    expect(breakResult.error?.issues.some((issue) =>
      issue.message.includes("larger package to a smaller package"))).toBe(true);
  });

  it("rejects competing authority modes for the same directed pair", () => {
    const definition = explicitPackagingDefinition();
    definition.paths.push({
      ...definition.paths[0]!,
      operationType: "directed_conversion",
      authorityState: "blocked",
    });
    const result = transformationModelDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) =>
      issue.message.includes("only one authority path"))).toBe(true);
  });

  it("makes model hashes independent of UI row order", () => {
    const first = explicitPackagingDefinition();
    const second = { ...first, paths: [...first.paths].reverse() };
    expect(calculateTransformationModelDefinitionHash(first))
      .toBe(calculateTransformationModelDefinitionHash(second));
  });

  it("excludes transient UI binding keys from the persisted model hash", () => {
    const binding = directionalBinding();
    const first: TransformationModelDefinition = {
      productId: 10,
      buildToPromiseEnabled: false,
      recipeBindings: [binding],
      paths: [{
        sourceProductId: 10,
        sourceVariantId: 101,
        destinationProductId: 10,
        destinationVariantId: 102,
        inputQty: 1,
        outputQty: 1,
        sourceUnitsPerVariant: 1,
        destinationUnitsPerVariant: 5,
        operationType: "directed_conversion",
        authorityState: "allowed",
        transformationRecipeBindingKey: binding.bindingKey,
      }],
    };
    const second = structuredClone(first);
    second.recipeBindings[0]!.bindingKey = "client-row-2";
    second.paths[0]!.transformationRecipeBindingKey = "client-row-2";

    expect(calculateTransformationModelDefinitionHash(first))
      .toBe(calculateTransformationModelDefinitionHash(second));
  });

  it("rejects duplicate recipe and warehouse scopes before persistence", () => {
    const first = directionalBinding();
    const second = { ...first, bindingKey: "same-recipe-second-row" };
    const result = transformationModelDefinitionSchema.safeParse({
      productId: 10,
      buildToPromiseEnabled: false,
      recipeBindings: [first, second],
      paths: [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("warehouse scope"))).toBe(true);
  });

  it("requires a recipe only for an allowed non-conserving path", () => {
    const blocked = explicitPackagingDefinition();
    blocked.paths = [{
      ...blocked.paths[0]!,
      inputQty: 1,
      authorityState: "blocked",
      operationType: "directed_conversion",
    }];
    expect(transformationModelDefinitionSchema.safeParse(blocked).success).toBe(true);

    const allowed = structuredClone(blocked);
    allowed.paths[0]!.authorityState = "allowed";
    const result = transformationModelDefinitionSchema.safeParse(allowed);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("explicit recipe"))).toBe(true);
  });

  it("validates directional recipe output, exact input, and canonical BOM hash", () => {
    const binding = directionalBinding();
    const definition: TransformationModelDefinition = {
      productId: 10,
      buildToPromiseEnabled: false,
      recipeBindings: [binding],
      paths: [{
        sourceProductId: 10,
        sourceVariantId: 101,
        destinationProductId: 10,
        destinationVariantId: 102,
        inputQty: 1,
        outputQty: 1,
        sourceUnitsPerVariant: 1,
        destinationUnitsPerVariant: 5,
        operationType: "directed_conversion",
        authorityState: "allowed",
        transformationRecipeBindingKey: binding.bindingKey,
      }],
    };
    expect(transformationModelDefinitionSchema.safeParse(definition).success).toBe(true);

    const badHash = structuredClone(definition);
    badHash.recipeBindings[0]!.recipeDefinitionHash = HASH;
    const result = transformationModelDefinitionSchema.safeParse(badHash);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("definition hash"))).toBe(true);
  });

  it("requires component-build authority when build-to-promise is enabled", () => {
    const definition = explicitPackagingDefinition();
    definition.buildToPromiseEnabled = true;
    const result = transformationModelDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("component-build"))).toBe(true);
  });

  it("encodes safety policy precedence scopes without ambiguous keys", () => {
    expect(safetyPolicyScopeKey({ scopeType: "business" })).toBe("business");
    expect(safetyPolicyScopeKey({ scopeType: "network_variant", productVariantId: 19 }))
      .toBe("network:variant:19");
    expect(safetyPolicyScopeKey({
      scopeType: "warehouse_variant",
      warehouseId: 3,
      productVariantId: 19,
    })).toBe("warehouse:3:variant:19");

    expect(promiseSafetyPolicyDraftSchema.safeParse({
      scope: { scopeType: "business" },
      value: { policyMode: "inherit" },
    }).success).toBe(false);
    expect(promiseSafetyPolicyDraftSchema.safeParse({
      scope: { scopeType: "network_variant", productVariantId: 19 },
      value: { policyMode: "off" },
    }).success).toBe(true);
  });

  it("rejects policy identifiers and quantities outside PostgreSQL integer range", () => {
    expect(promiseSafetyPolicyDraftSchema.safeParse({
      scope: { scopeType: "network_variant", productVariantId: 2_147_483_648 },
      value: { policyMode: "off" },
    }).success).toBe(false);
    expect(promiseSafetyPolicyDraftSchema.safeParse({
      scope: { scopeType: "network_variant", productVariantId: 19 },
      value: { policyMode: "fixed_units", fixedUnits: 2_147_483_648 },
    }).success).toBe(false);
  });

  it("keeps demand quantities as bigint and requires bounded override evidence", () => {
    const base = {
      productVariantId: 19,
      warehouseId: 3,
      windowStartedAt: new Date("2026-08-01T00:00:00.000Z"),
      windowEndedAt: new Date("2026-08-08T00:00:00.000Z"),
      irreversibleConsumptionUnits: 9007199254740993n,
      observedDays: 7,
      dailyDemandMilliUnits: 1286742750677284714n,
      trustStatus: "overridden" as const,
      trustReasons: ["legacy window manually attested"],
      methodVersion: "irreversible-demand-v1",
      inputFingerprint: HASH,
      calculatedAt: new Date("2026-08-08T01:00:00.000Z"),
      override: {
        actorId: "inventory-admin",
        reason: "Validated against shipment ledger",
        expiresAt: new Date("2026-08-15T00:00:00.000Z"),
      },
    };
    expect(demandEvidenceSnapshotSchema.safeParse(base).success).toBe(true);
    expect(demandEvidenceSnapshotSchema.safeParse({
      ...base,
      override: { ...base.override, expiresAt: base.calculatedAt },
    }).success).toBe(false);
  });
});
