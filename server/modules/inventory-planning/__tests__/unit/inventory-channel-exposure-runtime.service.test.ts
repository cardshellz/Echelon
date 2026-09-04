import { describe, expect, it, vi } from "vitest";

import type { SupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";

import {
  InventoryChannelExposureRuntimeService,
  type ActiveInventoryPublicationTargetSnapshot,
  type InventoryChannelExposureRuntimeContext,
} from "../../application/inventory-channel-exposure-runtime.service";
import { sealSupplySnapshot } from "../../domain/inventory-availability-planner";

const HASH = "a".repeat(64);

describe("InventoryChannelExposureRuntimeService", () => {
  it("returns no canonical target calculations or side effects while legacy owns authority", async () => {
    const service = new InventoryChannelExposureRuntimeService(executor({
      authority: "legacy",
      authorityRevision: "8",
      activationRunId: null,
      supplySnapshot: null,
      managedSellableVariantIds: [],
      publicationTargets: [],
    }));

    await expect(service.planProduct(10)).resolves.toEqual({
      authority: "legacy",
      authorityRevision: "8",
      activationRunId: null,
      productId: 10,
      snapshotFingerprint: null,
      snapshotCapturedAt: null,
      targets: [],
      providerWriteAttempted: false,
      outboxEnqueued: false,
    });
  });

  it("sums exact bound warehouses and applies active SKU policy to canonical target-SKU ATP", async () => {
    const logger = { warn: vi.fn() };
    const service = new InventoryChannelExposureRuntimeService(executor(canonicalContext([
      target({
        sourceWarehouseIds: [1, 2],
        policy: policyValue({ shareBps: 5_000, holdbackSellableUnits: "1" }),
      }),
    ])), logger);

    const plan = await service.planProduct(10);

    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({
      publicationTargetId: 91,
      publishable: true,
      blockers: [],
      sourceBinding: { fulfillmentNodeIds: [11, 12], warehouseIds: [1, 2] },
    });
    expect(plan.targets[0]!.rows).toMatchObject([
      {
        productVariantId: 101,
        canonicalAtpUnits: "35",
        sharedUnits: "17",
        afterHoldbackUnits: "16",
        publishedUnits: "16",
        sourceWarehouseBreakdown: [
          { warehouseId: 1, canonicalAtpUnits: "25" },
          { warehouseId: 2, canonicalAtpUnits: "10" },
        ],
      },
      {
        productVariantId: 102,
        canonicalAtpUnits: "9",
        sharedUnits: "4",
        afterHoldbackUnits: "3",
        publishedUnits: "3",
        sourceWarehouseBreakdown: [
          { warehouseId: 1, canonicalAtpUnits: "7" },
          { warehouseId: 2, canonicalAtpUnits: "2" },
        ],
      },
    ]);
    expect(plan.targets[0]!.rows.map((row) => row.productVariantId)).toEqual([101, 102]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("requires an active provider identity even when policy intentionally publishes zero", async () => {
    const configured = target({ policy: policyValue({ eligible: false }) });
    configured.mappings = configured.mappings.filter((mapping) => mapping.productVariantId !== 102);
    const service = new InventoryChannelExposureRuntimeService(executor(canonicalContext([configured])));

    const plan = await service.planProduct(10);
    const pack = plan.targets[0]!.rows.find((row) => row.productVariantId === 102)!;

    expect(pack.publishedUnits).toBe("0");
    expect(pack.mapping).toBeNull();
    expect(pack.blockers.map((blocker) => blocker.code)).toEqual([
      "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",
    ]);
    expect(plan.targets[0]!.publishable).toBe(false);
  });

  it("plans a Dropship storefront with the same exact-target ATP and channel dial", async () => {
    const dropship = target();
    dropship.destinationKind = "dropship_store_connection";
    dropship.channelConnectionId = null;
    dropship.dropshipStoreConnectionId = 77;
    dropship.channelProvider = "ebay";
    const service = new InventoryChannelExposureRuntimeService(executor(canonicalContext([dropship])));

    const plan = await service.planProduct(10);

    expect(plan.targets[0]).toMatchObject({
      destinationKind: "dropship_store_connection",
      channelId: 7,
      channelProvider: "ebay",
      channelConnectionId: null,
      dropshipStoreConnectionId: 77,
      publishable: true,
    });
    expect(plan.targets[0]!.rows.map((row) => row.publishedUnits)).toEqual(["25", "7"]);
  });

  it("keeps exact physical SKU supply when an invalid conversion path fails locally", async () => {
    const context = canonicalContext([target()]);
    context.supplySnapshot = canonicalSnapshot({ invalidModel: true });
    const service = new InventoryChannelExposureRuntimeService(executor(context));

    const plan = await service.planProduct(10);
    const pack = plan.targets[0]!.rows.find((row) => row.productVariantId === 102)!;

    expect(pack.canonicalAtpUnits).toBe("2");
    expect(pack.publishedUnits).toBe("2");
    expect(pack.warnings).toMatchObject([{
      code: "CANONICAL_ATP_PROJECTION_BLOCKED",
      context: { blockerCodes: ["INVALID_TRANSFORMATION_MODEL"] },
    }]);
    expect(plan.targets[0]!.publishable).toBe(true);
  });

  it("fails every overlapping partitioned target closed when active shares exceed 100 percent", async () => {
    const first = target({
      publicationTargetId: 91,
      channelId: 7,
      sourceWarehouseIds: [1],
      policy: policyValue({ allocationSemantics: "partitioned", shareBps: 6_000 }),
    });
    const second = target({
      publicationTargetId: 92,
      channelId: 8,
      sourceWarehouseIds: [1],
      policy: policyValue({ allocationSemantics: "partitioned", shareBps: 5_000 }),
    });
    const service = new InventoryChannelExposureRuntimeService(executor(canonicalContext([first, second])));

    const plan = await service.planProduct(10);

    expect(plan.targets.map((entry) => entry.publishable)).toEqual([false, false]);
    for (const plannedTarget of plan.targets) {
      expect(plannedTarget.rows.every((row) => row.blockers.some((blocker) =>
        blocker.code === "PARTITIONED_CHANNEL_SHARE_EXCEEDS_100_PERCENT"))).toBe(true);
    }
  });

  it("fails closed when active source evidence is missing and rejects mismatched snapshots", async () => {
    const missingBinding = target();
    missingBinding.sourceBinding = null;
    const service = new InventoryChannelExposureRuntimeService(executor(canonicalContext([missingBinding])));

    const plan = await service.planProduct(10);
    expect(plan.targets[0]).toMatchObject({
      publishable: false,
      sourceBinding: null,
      blockers: [{ code: "CHANNEL_SOURCE_BINDING_MISSING" }],
    });

    const mismatch = canonicalContext([]);
    mismatch.managedSellableVariantIds = [999];
    await expect(new InventoryChannelExposureRuntimeService(executor(mismatch)).planProduct(10))
      .rejects.toMatchObject({ code: "CANONICAL_CHANNEL_EXPOSURE_VARIANT_MISMATCH" });
  });
});

function executor(context: InventoryChannelExposureRuntimeContext) {
  return { execute: <T>(_productId: number, work: (value: InventoryChannelExposureRuntimeContext) => Promise<T>) =>
    work(context) };
}

function canonicalContext(
  publicationTargets: ActiveInventoryPublicationTargetSnapshot[],
): InventoryChannelExposureRuntimeContext {
  return {
    authority: "canonical",
    authorityRevision: "9",
    activationRunId: "44",
    supplySnapshot: canonicalSnapshot(),
    managedSellableVariantIds: [101, 102],
    publicationTargets,
  };
}

function target(input: {
  publicationTargetId?: number;
  channelId?: number;
  sourceWarehouseIds?: number[];
  policy?: ReturnType<typeof policyValue>;
} = {}): ActiveInventoryPublicationTargetSnapshot {
  const publicationTargetId = input.publicationTargetId ?? 91;
  const channelId = input.channelId ?? 7;
  const sourceWarehouseIds = input.sourceWarehouseIds ?? [1];
  return {
    publicationTargetId,
    publicationTargetRevision: "3",
    destinationKind: "channel_connection",
    channelId,
    channelName: `Channel ${channelId}`,
    channelProvider: "shopify",
    channelConnectionId: 71 + channelId,
    dropshipStoreConnectionId: null,
    providerScopeType: "location",
    externalScopeId: `location-${publicationTargetId}`,
    publicationAuthority: "echelon",
    publicationTargetState: "live",
    sourceBinding: {
      bindingId: publicationTargetId + 100,
      version: 1,
      definitionHash: HASH,
      members: sourceWarehouseIds.map((warehouseId, index) => ({
        fulfillmentNodeId: 11 + index,
        warehouseId,
        fulfillmentNodeLifecycleStatus: "active" as const,
      })),
    },
    policies: [{
      scopeKey: `channel:${channelId}`,
      scopeType: "channel",
      policyId: publicationTargetId + 200,
      version: 1,
      definitionHash: HASH,
      value: input.policy ?? policyValue(),
    }],
    mappings: [101, 102].map((productVariantId) => ({
      mappingId: publicationTargetId * 10 + productVariantId,
      productVariantId,
      version: 1,
      definitionHash: HASH,
      externalInventoryItemId: `external-${publicationTargetId}-${productVariantId}`,
      externalSku: productVariantId === 101 ? "EA" : "P5",
    })),
  };
}

function policyValue(patch: Record<string, unknown> = {}) {
  return {
    allocationSemantics: "exposure" as const,
    eligible: true,
    shareBps: 10_000,
    holdbackSellableUnits: "0",
    maxPublish: { mode: "unlimited" as const },
    minPublishSellableUnits: "0",
    ...patch,
  };
}

function canonicalSnapshot(options: { invalidModel?: boolean } = {}) {
  const content: SupplySnapshotContentDto = {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: "2026-09-04T12:00:00.000Z",
    productId: 10,
    legacyInventoryStrategy: "physical_fungible",
    variants: [
      { id: 101, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1,
        isActive: true, salesEligibility: "sellable" },
      { id: 102, productId: 10, sku: "P5", name: "Pack 5", unitsPerVariant: 5,
        isActive: true, salesEligibility: "sellable" },
      { id: 103, productId: 10, sku: "DIGITAL", name: "Digital", unitsPerVariant: 1,
        isActive: true, salesEligibility: "sellable" },
    ],
    warehouses: [
      { id: 1, code: "LEON", isActive: true, hubWarehouseId: null },
      { id: 2, code: "WEST", isActive: true, hubWarehouseId: null },
    ],
    locations: [
      { id: 11, warehouseId: 1, code: "LEON-EA", locationType: "reserve", isPickable: false,
        isActive: true, isFrozen: false, promisePolicy: null },
      { id: 12, warehouseId: 1, code: "LEON-P5", locationType: "pick", isPickable: true,
        isActive: true, isFrozen: false, promisePolicy: null },
      { id: 21, warehouseId: 2, code: "WEST-EA", locationType: "reserve", isPickable: false,
        isActive: true, isFrozen: false, promisePolicy: null },
    ],
    inventoryPositions: [
      { inventoryLevelId: 1, warehouseLocationId: 11, productVariantId: 101,
        variantQty: "25", reservedQty: "0", pickedQty: "0", packedQty: "0" },
      { inventoryLevelId: 2, warehouseLocationId: 12, productVariantId: 102,
        variantQty: "2", reservedQty: "0", pickedQty: "0", packedQty: "0" },
      { inventoryLevelId: 3, warehouseLocationId: 21, productVariantId: 101,
        variantQty: "10", reservedQty: "0", pickedQty: "0", packedQty: "0" },
    ],
    safetyPolicies: [{
      policyId: 1,
      version: 1,
      lifecycleSelection: "active_head",
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
      lifecycleSelection: "active_head",
      lifecycleStatus: "sealed",
      buildToPromiseEnabled: false,
      definitionHash: HASH,
      validationState: options.invalidModel ? "invalid" : "valid",
      validationErrors: options.invalidModel ? [{ code: "MALFORMED_PATH" }] : [],
      paths: [{
        pathId: 1,
        sourceVariantId: 101,
        destinationVariantId: 102,
        inputQty: "5",
        outputQty: "1",
        sourceUnitsPerVariant: 1,
        destinationUnitsPerVariant: 5,
        operationType: "assemble_pack",
        authorityState: "allowed",
        validationState: "valid",
        validationErrors: [],
        transformationRecipeBindingId: null,
      }],
      recipeBindings: [],
    }],
    legacyRecipes: [],
    outputLocations: [
      { productVariantId: 101, warehouseId: 1, warehouseLocationId: 11 },
      { productVariantId: 102, warehouseId: 1, warehouseLocationId: 12 },
      { productVariantId: 101, warehouseId: 2, warehouseLocationId: 21 },
      { productVariantId: 102, warehouseId: 2, warehouseLocationId: 21 },
    ],
    claimProjectionSource: "inventory_levels.reserved_qty",
  };
  return sealSupplySnapshot(content);
}
