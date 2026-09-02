import { describe, expect, it } from "vitest";

import {
  atpProjectionSchema,
  type ClaimSupplySnapshotContentDto,
  type SupplySnapshotContentDto,
} from "@shared/types/inventory-availability-planner";
import {
  calculateLegacyAtpFromSnapshot,
  calculateSupplySnapshotFingerprint,
  classifyShadowDifference,
  planCanonicalClaim,
  projectCanonicalAtp,
  sealClaimSupplySnapshot,
  sealSupplySnapshot,
} from "../../domain/inventory-availability-planner";

const HASH = "a".repeat(64);

function content(overrides: Partial<SupplySnapshotContentDto> = {}): SupplySnapshotContentDto {
  return {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: "2026-08-27T12:00:00.000Z",
    productId: 10,
    legacyInventoryStrategy: "physical_only",
    variants: [
      { id: 101, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1, isActive: true },
      { id: 105, productId: 10, sku: "P5", name: "Pack 5", unitsPerVariant: 5, isActive: true },
      { id: 125, productId: 10, sku: "C25", name: "Case 25", unitsPerVariant: 25, isActive: true },
    ],
    warehouses: [{ id: 1, code: "LEON", isActive: true, hubWarehouseId: null }],
    locations: [
      {
        id: 11,
        warehouseId: 1,
        code: "PICK-1",
        locationType: "pick",
        isPickable: true,
        isActive: true,
        isFrozen: false,
        promisePolicy: null,
      },
    ],
    inventoryPositions: [],
    safetyPolicies: [{
      policyId: 1,
      version: 1,
      lifecycleSelection: "draft_head",
      scopeKey: "business",
      scopeType: "business",
      productVariantId: null,
      warehouseId: null,
      policyMode: "off",
      fixedUnits: null,
      daysOfCoverMilliDays: null,
      untrustedDemandFallbackUnits: null,
      demandMethodVersion: null,
      definitionHash: HASH,
    }],
    demandEvidence: [],
    transformationModels: [{
      modelId: 501,
      productId: 10,
      version: 1,
      lifecycleSelection: "draft_head",
      lifecycleStatus: "draft",
      buildToPromiseEnabled: false,
      definitionHash: HASH,
      validationState: "valid",
      validationErrors: [],
      paths: [],
      recipeBindings: [],
    }],
    legacyRecipes: [],
    outputLocations: [
      { productVariantId: 101, warehouseId: 1, warehouseLocationId: 11 },
      { productVariantId: 105, warehouseId: 1, warehouseLocationId: 11 },
      { productVariantId: 125, warehouseId: 1, warehouseLocationId: 11 },
    ],
    claimProjectionSource: "inventory_levels.reserved_qty",
    ...overrides,
  };
}

function position(input: {
  id: number;
  locationId?: number;
  variantId: number;
  physical: number;
  reserved?: number;
  picked?: number;
  packed?: number;
}) {
  return {
    inventoryLevelId: input.id,
    warehouseLocationId: input.locationId ?? 11,
    productVariantId: input.variantId,
    variantQty: String(input.physical),
    reservedQty: String(input.reserved ?? 0),
    pickedQty: String(input.picked ?? 0),
    packedQty: String(input.packed ?? 0),
  };
}

function path(input: {
  id: number;
  source: number;
  destination: number;
  inputQty: number;
  outputQty: number;
  sourceUnits: number;
  destinationUnits: number;
}) {
  return {
    pathId: input.id,
    sourceVariantId: input.source,
    destinationVariantId: input.destination,
    inputQty: String(input.inputQty),
    outputQty: String(input.outputQty),
    sourceUnitsPerVariant: input.sourceUnits,
    destinationUnitsPerVariant: input.destinationUnits,
    operationType: input.sourceUnits < input.destinationUnits
      ? "assemble_pack" as const
      : "break_pack" as const,
    authorityState: "allowed" as const,
    validationState: "valid" as const,
    validationErrors: [],
    transformationRecipeBindingId: null,
  };
}

describe("inventory availability canonical planner", () => {
  it("aggregates eligible physical and claims before clamping once", () => {
    const snapshot = sealSupplySnapshot(content({
      inventoryPositions: [
        position({ id: 1, variantId: 101, physical: 2, reserved: 5 }),
        position({ id: 2, variantId: 101, physical: 10 }),
      ],
    }));
    const request = { targetVariantId: 101, scope: { kind: "warehouse" as const, warehouseId: 1 } };
    const proposed = projectCanonicalAtp(snapshot, request);

    expect(proposed).toMatchObject({
      atpUnits: "7",
      exactPhysicalUnits: "12",
      claimedUnits: "5",
      directUnits: "7",
    });
    expect(calculateLegacyAtpFromSnapshot(snapshot, request)).toBe(BigInt(10));
    expect(classifyShadowDifference(snapshot, request, BigInt(10), proposed))
      .toContain("aggregate_claim_clamp");
  });

  it("does not subtract picked or packed custody from physical on-hand again", () => {
    const snapshot = sealSupplySnapshot(content({
      inventoryPositions: [position({
        id: 1,
        variantId: 101,
        physical: 10,
        reserved: 2,
        picked: 3,
        packed: 1,
      })],
    }));

    expect(projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    }).atpUnits).toBe("8");
  });

  it("does not truncate valid inventory at an arbitrary planner quantity cap", () => {
    const snapshot = sealSupplySnapshot(content({
      inventoryPositions: [position({
        id: 1,
        variantId: 101,
        physical: 1_500_000_000,
      })],
    }));

    expect(projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    }).atpUnits).toBe("1500000000");
  });

  it("includes reserve by default and excludes receiving and frozen locations", () => {
    const snapshot = sealSupplySnapshot(content({
      locations: [
        {
          id: 11, warehouseId: 1, code: "PICK", locationType: "pick", isPickable: true,
          isActive: true, isFrozen: false, promisePolicy: null,
        },
        {
          id: 12, warehouseId: 1, code: "RESERVE", locationType: "reserve", isPickable: false,
          isActive: true, isFrozen: false, promisePolicy: null,
        },
        {
          id: 13, warehouseId: 1, code: "RECEIVING", locationType: "receiving", isPickable: false,
          isActive: true, isFrozen: false, promisePolicy: {
            policyId: 13,
            version: 1,
            lifecycleSelection: "draft_head",
            eligibilityMode: "eligible",
            definitionHash: HASH,
          },
        },
        {
          id: 14, warehouseId: 1, code: "FROZEN", locationType: "pick", isPickable: true,
          isActive: true, isFrozen: true, promisePolicy: null,
        },
      ],
      inventoryPositions: [
        position({ id: 1, locationId: 11, variantId: 101, physical: 2 }),
        position({ id: 2, locationId: 12, variantId: 101, physical: 10 }),
        position({ id: 3, locationId: 13, variantId: 101, physical: 20 }),
        position({ id: 4, locationId: 14, variantId: 101, physical: 30 }),
      ],
    }));

    expect(projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    }).atpUnits).toBe("12");
  });

  it("uses trusted days of cover or the untrusted fixed fallback, never both", () => {
    const safetyPolicy = {
      ...content().safetyPolicies[0]!,
      policyMode: "days_of_cover" as const,
      daysOfCoverMilliDays: "2500",
      untrustedDemandFallbackUnits: "2",
      demandMethodVersion: "shipments-v1",
    };
    const demand = {
      evidenceId: "1",
      productVariantId: 101,
      warehouseId: 1,
      dailyDemandMilliUnits: "1500",
      trustStatus: "trusted" as const,
      trustReasons: [],
      methodVersion: "shipments-v1",
      inputFingerprint: HASH,
      overrideExpiresAt: null,
      calculatedAt: "2026-08-27T11:00:00.000Z",
    };
    const trusted = sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })],
      safetyPolicies: [safetyPolicy],
      demandEvidence: [demand],
    }));
    const untrusted = sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })],
      safetyPolicies: [safetyPolicy],
      demandEvidence: [{ ...demand, trustStatus: "untrusted" }],
    }));
    const request = { targetVariantId: 101, scope: { kind: "warehouse" as const, warehouseId: 1 } };

    const trustedProjection = projectCanonicalAtp(trusted, request);
    const untrustedProjection = projectCanonicalAtp(untrusted, request);
    expect(trustedProjection.atpUnits).toBe("6");
    expect(trustedProjection.safetyEvidence[0]?.demandStatus).toBe("trusted");
    expect(untrustedProjection.atpUnits).toBe("8");
    expect(untrustedProjection.safetyEvidence[0]?.demandStatus).toBe("fallback_untrusted");
  });

  it("uses fallback units for stale or future-dated demand evidence", () => {
    const safetyPolicy = {
      ...content().safetyPolicies[0]!,
      policyMode: "days_of_cover" as const,
      daysOfCoverMilliDays: "2500",
      untrustedDemandFallbackUnits: "2",
      demandMethodVersion: "shipments-v1",
    };
    const demand = {
      evidenceId: "1",
      productVariantId: 101,
      warehouseId: 1,
      dailyDemandMilliUnits: "1500",
      trustStatus: "trusted" as const,
      trustReasons: [],
      methodVersion: "shipments-v1",
      inputFingerprint: HASH,
      overrideExpiresAt: null,
      calculatedAt: "2026-08-25T12:00:00.000Z",
    };
    const request = { targetVariantId: 101, scope: { kind: "warehouse" as const, warehouseId: 1 } };
    const stale = projectCanonicalAtp(sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })],
      safetyPolicies: [safetyPolicy],
      demandEvidence: [demand],
    })), request);
    const future = projectCanonicalAtp(sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })],
      safetyPolicies: [safetyPolicy],
      demandEvidence: [{ ...demand, calculatedAt: "2026-08-28T12:00:00.000Z" }],
    })), request);

    expect(stale.atpUnits).toBe("8");
    expect(stale.safetyEvidence[0]?.demandStatus).toBe("fallback_stale");
    expect(future.atpUnits).toBe("8");
    expect(future.safetyEvidence[0]?.demandStatus).toBe("fallback_future_dated");
  });

  it("labels persisted pre-status shadow evidence as unknown instead of inventing a reason", () => {
    const projection = projectCanonicalAtp(sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })],
    })), {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    });
    const legacyProjection = {
      ...projection,
      safetyEvidence: projection.safetyEvidence.map(({ demandStatus: _omitted, ...evidence }) =>
        evidence),
    };

    expect(atpProjectionSchema.parse(legacyProjection).safetyEvidence[0]?.demandStatus)
      .toBe("legacy_unknown");
  });

  it("defines network ATP as the sum of independently fulfillable warehouses", () => {
    const fixedSafety = {
      ...content().safetyPolicies[0]!,
      policyMode: "fixed_units" as const,
      fixedUnits: "2",
    };
    const snapshot = sealSupplySnapshot(content({
      warehouses: [
        { id: 1, code: "LEON", isActive: true, hubWarehouseId: null },
        { id: 2, code: "WEST", isActive: true, hubWarehouseId: null },
      ],
      locations: [
        {
          id: 11, warehouseId: 1, code: "PICK-1", locationType: "pick", isPickable: true,
          isActive: true, isFrozen: false, promisePolicy: null,
        },
        {
          id: 21, warehouseId: 2, code: "PICK-2", locationType: "pick", isPickable: true,
          isActive: true, isFrozen: false, promisePolicy: null,
        },
      ],
      inventoryPositions: [
        position({ id: 1, locationId: 11, variantId: 101, physical: 10 }),
        position({ id: 2, locationId: 21, variantId: 101, physical: 7 }),
      ],
      safetyPolicies: [fixedSafety],
    }));
    const first = projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    });
    const second = projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 2 },
    });
    const network = projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "network" },
    });

    expect(first.atpUnits).toBe("8");
    expect(second.atpUnits).toBe("5");
    expect(network.atpUnits).toBe("13");
    expect(BigInt(network.atpUnits)).toBe(BigInt(first.atpUnits) + BigInt(second.atpUnits));
  });

  it("counts another package only through an explicit directed path", () => {
    const base = content({
      inventoryPositions: [
        position({ id: 1, variantId: 101, physical: 100 }),
        position({ id: 2, variantId: 105, physical: 10 }),
      ],
    });
    const noPath = sealSupplySnapshot(base);
    const withPath = sealSupplySnapshot({
      ...base,
      transformationModels: [{
        ...base.transformationModels[0]!,
        paths: [path({
          id: 1, source: 101, destination: 105, inputQty: 5, outputQty: 1,
          sourceUnits: 1, destinationUnits: 5,
        })],
      }],
    });
    const request = { targetVariantId: 105, scope: { kind: "warehouse" as const, warehouseId: 1 } };

    expect(projectCanonicalAtp(noPath, request).atpUnits).toBe("10");
    expect(projectCanonicalAtp(withPath, request)).toMatchObject({
      atpUnits: "30",
      directUnits: "10",
      convertibleUnits: "20",
    });
  });

  it("uses internal-only EA as directed supply but never as a customer target", () => {
    const base = content({
      variants: content().variants.map((variant) => ({
        ...variant,
        salesEligibility: variant.id === 101 ? "internal_only" as const : "sellable" as const,
      })),
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 100 })],
    });
    const snapshot = sealSupplySnapshot({
      ...base,
      transformationModels: [{
        ...base.transformationModels[0]!,
        paths: [path({
          id: 1,
          source: 101,
          destination: 105,
          inputQty: 5,
          outputQty: 1,
          sourceUnits: 1,
          destinationUnits: 5,
        })],
      }],
    });

    expect(projectCanonicalAtp(snapshot, {
      targetVariantId: 105,
      scope: { kind: "warehouse", warehouseId: 1 },
    })).toMatchObject({
      atpUnits: "20",
      directUnits: "0",
      convertibleUnits: "20",
    });
    expect(() => projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    })).toThrow(expect.objectContaining({ code: "TARGET_VARIANT_NOT_CUSTOMER_SELLABLE" }));
    expect(calculateLegacyAtpFromSnapshot(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    })).toBe(BigInt(0));
    expect(() => planCanonicalClaim(snapshot, {
      requestKey: "order:internal-ea",
      scope: { kind: "warehouse", warehouseId: 1 },
      lines: [{ lineKey: "ea", targetVariantId: 101, requestedQty: "1" }],
    })).toThrow(expect.objectContaining({ code: "TARGET_VARIANT_NOT_CUSTOMER_SELLABLE" }));
  });

  it("plans a whole order once so alternative package lines cannot reuse the same EA", () => {
    const base = content({ inventoryPositions: [position({ id: 1, variantId: 101, physical: 100 })] });
    const snapshot = sealSupplySnapshot({
      ...base,
      transformationModels: [{
        ...base.transformationModels[0]!,
        paths: [
          path({ id: 1, source: 101, destination: 105, inputQty: 5, outputQty: 1, sourceUnits: 1, destinationUnits: 5 }),
          path({ id: 2, source: 101, destination: 125, inputQty: 25, outputQty: 1, sourceUnits: 1, destinationUnits: 25 }),
        ],
      }],
    });

    const plan = planCanonicalClaim(snapshot, {
      requestKey: "order:1",
      scope: { kind: "warehouse", warehouseId: 1 },
      lines: [
        { lineKey: "line:c25", targetVariantId: 125, requestedQty: "4" },
        { lineKey: "line:p5", targetVariantId: 105, requestedQty: "20" },
      ],
    });

    expect(plan.lines).toEqual([
      { lineKey: "line:c25", targetVariantId: 125, requestedQty: "4", plannedQty: "4", shortfallQty: "0" },
      { lineKey: "line:p5", targetVariantId: 105, requestedQty: "20", plannedQty: "0", shortfallQty: "20" },
    ]);
    expect(plan.resourceClaims.reduce((sum, claim) => sum + Number(claim.claimedQty), 0)).toBe(100);
    expect(plan.operations).toHaveLength(1);
    expect(plan.resourceClaims.every((claim) =>
      claim.consumerOperationKey === plan.operations[0]!.operationKey)).toBe(true);
    expect(plan.operations[0]).toEqual(expect.objectContaining({
      parentOperationKey: null,
      inputs: [{ sourceVariantId: 101, requiredQty: "100" }],
    }));
  });

  it("conserves the actual source resource across a deterministic basket matrix", () => {
    for (const physical of [0, 10, 25, 50, 100]) {
      for (const requestedCases of [1, 2, 4]) {
        for (const requestedPacks of [1, 5, 20]) {
          const base = content({
            inventoryPositions: [position({ id: 1, variantId: 101, physical })],
          });
          const snapshot = sealSupplySnapshot({
            ...base,
            transformationModels: [{
              ...base.transformationModels[0]!,
              paths: [
                path({
                  id: 1, source: 101, destination: 105, inputQty: 5, outputQty: 1,
                  sourceUnits: 1, destinationUnits: 5,
                }),
                path({
                  id: 2, source: 101, destination: 125, inputQty: 25, outputQty: 1,
                  sourceUnits: 1, destinationUnits: 25,
                }),
              ],
            }],
          });
          const plan = planCanonicalClaim(snapshot, {
            requestKey: `matrix:${physical}:${requestedCases}:${requestedPacks}`,
            scope: { kind: "warehouse", warehouseId: 1 },
            lines: [
              { lineKey: "case", targetVariantId: 125, requestedQty: String(requestedCases) },
              { lineKey: "pack", targetVariantId: 105, requestedQty: String(requestedPacks) },
            ],
          });
          const claimedEaches = plan.resourceClaims.reduce(
            (sum, claim) => sum + BigInt(claim.claimedQty),
            BigInt(0),
          );
          const plannedBaseUnits = plan.lines.reduce((sum, line) => {
            const unitsPerVariant = line.targetVariantId === 125 ? BigInt(25) : BigInt(5);
            return sum + BigInt(line.plannedQty) * unitsPerVariant;
          }, BigInt(0));

          expect(claimedEaches).toBeLessThanOrEqual(BigInt(physical));
          expect(plannedBaseUnits).toBe(claimedEaches);
          expect(plan.resourceClaims.every((claim) => claim.inventoryLevelId === 1)).toBe(true);
        }
      }
    }
  });

  it("uses one component-build graph for both ATP and claim evidence", () => {
    const componentVariant = {
      id: 201, productId: 20, sku: "COMP", name: "Component", unitsPerVariant: 1, isActive: true,
    };
    const base = content({
      variants: [...content().variants, componentVariant],
      inventoryPositions: [position({ id: 1, variantId: 201, physical: 8 })],
    });
    const snapshot = sealSupplySnapshot({
      ...base,
      transformationModels: [{
        ...base.transformationModels[0]!,
        buildToPromiseEnabled: true,
        recipeBindings: [{
          bindingId: 701,
          recipeId: 77,
          relationshipRole: "component_build",
          warehouseId: null,
          recipeCodeSnapshot: "BUILD-EA",
          recipeVersionSnapshot: 1,
          recipeDefinitionHash: HASH,
          outputProductId: 10,
          outputVariantId: 101,
          outputUnitsPerVariant: 1,
          outputQty: "4",
          validationState: "valid",
          validationErrors: [],
          components: [{
            componentVariantId: 201,
            componentProductId: 20,
            componentUnitsPerVariant: 1,
            componentQty: "2",
          }],
        }],
      }],
    });

    expect(projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "warehouse", warehouseId: 1 },
    }).buildableUnits).toBe("16");
    const plan = planCanonicalClaim(snapshot, {
      requestKey: "order:build",
      scope: { kind: "warehouse", warehouseId: 1 },
      lines: [{ lineKey: "line:ea", targetVariantId: 101, requestedQty: "3" }],
    });
    expect(plan.resourceClaims).toEqual([expect.objectContaining({ sourceVariantId: 201, claimedQty: "2" })]);
    expect(plan.operations).toEqual([expect.objectContaining({
      operationType: "component_build",
      outputQty: "4",
      committedOutputQty: "3",
      parentOperationKey: null,
      inputs: [{ sourceVariantId: 201, requiredQty: "2" }],
    })]);
    expect(plan.resourceClaims[0]!.consumerOperationKey).toBe(plan.operations[0]!.operationKey);
  });

  it("plans different root products against one shared component pool", () => {
    const base = content();
    const componentVariant = {
      id: 301, productId: 30, sku: "SHARED", name: "Shared component", unitsPerVariant: 1, isActive: true,
    };
    const secondTarget = {
      id: 201, productId: 20, sku: "SECOND", name: "Second product", unitsPerVariant: 1, isActive: true,
    };
    const recipe = (input: { bindingId: number; recipeId: number; productId: number; variantId: number }) => ({
      bindingId: input.bindingId,
      recipeId: input.recipeId,
      relationshipRole: "component_build" as const,
      warehouseId: null,
      recipeCodeSnapshot: `BUILD-${input.productId}`,
      recipeVersionSnapshot: 1,
      recipeDefinitionHash: HASH,
      outputProductId: input.productId,
      outputVariantId: input.variantId,
      outputUnitsPerVariant: 1,
      outputQty: "1",
      validationState: "valid" as const,
      validationErrors: [],
      components: [{
        componentVariantId: 301,
        componentProductId: 30,
        componentUnitsPerVariant: 1,
        componentQty: "2",
      }],
    });
    const claimContent: ClaimSupplySnapshotContentDto = {
      schemaVersion: "inventory_availability_claim_snapshot_v1",
      capturedAt: base.capturedAt,
      rootProducts: [
        { productId: 10, legacyInventoryStrategy: "physical_only" },
        { productId: 20, legacyInventoryStrategy: "physical_only" },
      ],
      variants: [base.variants[0]!, secondTarget, componentVariant],
      warehouses: base.warehouses,
      locations: base.locations,
      inventoryPositions: [position({ id: 1, variantId: 301, physical: 10 })],
      safetyPolicies: base.safetyPolicies,
      demandEvidence: [],
      transformationModels: [
        {
          ...base.transformationModels[0]!,
          buildToPromiseEnabled: true,
          recipeBindings: [recipe({ bindingId: 701, recipeId: 71, productId: 10, variantId: 101 })],
        },
        {
          ...base.transformationModels[0]!,
          modelId: 502,
          productId: 20,
          buildToPromiseEnabled: true,
          recipeBindings: [recipe({ bindingId: 702, recipeId: 72, productId: 20, variantId: 201 })],
        },
      ],
      legacyRecipes: [],
      outputLocations: [
        { productVariantId: 101, warehouseId: 1, warehouseLocationId: 11 },
        { productVariantId: 201, warehouseId: 1, warehouseLocationId: 11 },
      ],
      claimProjectionSource: "inventory_levels.reserved_qty",
    };
    const plan = planCanonicalClaim(sealClaimSupplySnapshot(claimContent), {
      requestKey: "order:shared-component",
      scope: { kind: "network" },
      lines: [
        { lineKey: "first", targetVariantId: 101, requestedQty: "4" },
        { lineKey: "second", targetVariantId: 201, requestedQty: "4" },
      ],
    });

    expect(plan.lines).toEqual([
      { lineKey: "first", targetVariantId: 101, requestedQty: "4", plannedQty: "4", shortfallQty: "0" },
      { lineKey: "second", targetVariantId: 201, requestedQty: "4", plannedQty: "1", shortfallQty: "3" },
    ]);
    expect(plan.resourceClaims.reduce((sum, claim) => sum + BigInt(claim.claimedQty), BigInt(0)))
      .toBe(BigInt(10));
    expect(plan.modelEvidence.map((model) => model.productId)).toEqual([10, 20]);
    expect(plan.fulfillmentGroups).toEqual([expect.objectContaining({
      warehouseId: 1,
      lineAllocations: [
        { lineKey: "first", targetVariantId: 101, plannedQty: "4" },
        { lineKey: "second", targetVariantId: 201, plannedQty: "1" },
      ],
    })]);
  });

  it("replays deterministically and fingerprints state independently of capture time", () => {
    const first = content({ inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })] });
    const second = { ...first, capturedAt: "2026-08-27T13:00:00.000Z" };
    expect(calculateSupplySnapshotFingerprint(first)).toBe(calculateSupplySnapshotFingerprint(second));
    const snapshot = sealSupplySnapshot(first);
    const request = { targetVariantId: 101, scope: { kind: "network" as const } };
    expect(projectCanonicalAtp(snapshot, request)).toEqual(projectCanonicalAtp(snapshot, request));
  });

  it("rejects snapshot content that was changed after its fingerprint was sealed", () => {
    const snapshot = sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 101, physical: 10 })],
    }));
    const tampered = {
      ...snapshot,
      inventoryPositions: [{ ...snapshot.inventoryPositions[0]!, variantQty: "11" }],
    };

    expect(() => projectCanonicalAtp(tampered, {
      targetVariantId: 101,
      scope: { kind: "network" },
    })).toThrow(expect.objectContaining({ code: "SUPPLY_SNAPSHOT_FINGERPRINT_MISMATCH" }));
  });

  it("rejects a correctly fingerprinted snapshot with dangling resource evidence", () => {
    const snapshot = sealSupplySnapshot(content({
      inventoryPositions: [position({ id: 1, variantId: 999, physical: 10 })],
    }));

    expect(() => projectCanonicalAtp(snapshot, {
      targetVariantId: 101,
      scope: { kind: "network" },
    })).toThrow(expect.objectContaining({ code: "SUPPLY_SNAPSHOT_REFERENCE_INVALID" }));
  });
});
