import { describe, expect, it, vi } from "vitest";

import type { InventoryAtpServiceContract } from "../../../inventory/atp.service";
import type { SupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";
import { sealSupplySnapshot } from "../../domain/inventory-availability-planner";
import {
  AuthorityAwareInventoryAtpService,
  type InventoryAvailabilityRuntimeAtpContext,
  type InventoryAvailabilityRuntimeAtpExecutor,
} from "../../application/inventory-availability-runtime-atp.service";

const HASH = "a".repeat(64);

describe("AuthorityAwareInventoryAtpService", () => {
  it("delegates the complete read to the legacy calculator while legacy owns runtime authority", async () => {
    const legacy = fakeLegacy();
    const captureActiveSupplySnapshot = vi.fn();
    const service = new AuthorityAwareInventoryAtpService(executor({
      authority: "legacy",
      legacy,
      captureActiveSupplySnapshot,
    }));

    const result = await service.getAtpPerVariant(10);

    expect(result).toMatchObject([{ productVariantId: 101, atpUnits: 35 }]);
    expect(legacy.getAtpPerVariant).toHaveBeenCalledOnce();
    expect(captureActiveSupplySnapshot).not.toHaveBeenCalled();
  });

  it("projects every sellable SKU through active directed transformation authority", async () => {
    const legacy = fakeLegacy();
    const snapshot = canonicalSnapshot();
    const service = new AuthorityAwareInventoryAtpService(executor({
      authority: "canonical",
      legacy,
      captureActiveSupplySnapshot: vi.fn(async () => snapshot),
    }));

    await expect(service.getAtpPerVariant(10)).resolves.toMatchObject([
      { productVariantId: 101, sku: "EA", atpUnits: 25, atpBase: 25 },
      { productVariantId: 102, sku: "P5", atpUnits: 7, atpBase: 35 },
    ]);
    await expect(service.getAtpPerVariantByWarehouse(10, 1)).resolves.toMatchObject([
      { productVariantId: 101, atpUnits: 25 },
      { productVariantId: 102, atpUnits: 7 },
    ]);
    expect(legacy.getAtpPerVariant).not.toHaveBeenCalled();
  });

  it("uses canonical target-SKU ATP for the legacy-named direct warehouse seam", async () => {
    const service = new AuthorityAwareInventoryAtpService(executor({
      authority: "canonical",
      legacy: fakeLegacy(),
      captureActiveSupplySnapshot: vi.fn(async () => canonicalSnapshot()),
      getProductIdsByVariantIds: vi.fn(async () => new Map([[102, 10]])),
    }));

    await expect(service.getDirectVariantAtpByWarehouse([102, 999], 1)).resolves.toEqual(
      new Map([[102, 7], [999, 0]]),
    );
  });

  it("fails closed for scalar product ATP and unallocated channel reads after canonical cutover", async () => {
    const service = new AuthorityAwareInventoryAtpService(executor({
      authority: "canonical",
      legacy: fakeLegacy(),
      captureActiveSupplySnapshot: vi.fn(async () => canonicalSnapshot()),
    }));

    await expect(service.getAtpBase(10)).rejects.toMatchObject({
      code: "CANONICAL_PRODUCT_BASE_ATP_UNSUPPORTED",
      context: expect.objectContaining({ authorityRevision: "9", activationRunId: "44" }),
    });
    await expect(service.getAtpForChannel(10, 67)).rejects.toMatchObject({
      code: "CANONICAL_CHANNEL_EXPOSURE_REQUIRED",
    });
    await expect(service.getProductInventoryStrategy(10)).rejects.toMatchObject({
      code: "CANONICAL_CLAIM_ROUTING_REQUIRED",
    });
  });

  it("overlays canonical per-SKU values onto the backward-compatible inventory summary", async () => {
    const legacy = fakeLegacy();
    const service = new AuthorityAwareInventoryAtpService(executor({
      authority: "canonical",
      legacy,
      captureActiveSupplySnapshot: vi.fn(async () => canonicalSnapshot()),
    }));

    await expect(service.getInventoryItemSummary(10)).resolves.toMatchObject({
      totalAtpPieces: 35,
      variants: [
        { variantId: 101, available: 25, atpPieces: 25 },
        { variantId: 102, available: 7, atpPieces: 35 },
      ],
    });
  });
});

function executor(input: {
  authority: "legacy" | "canonical";
  legacy: InventoryAtpServiceContract;
  captureActiveSupplySnapshot: InventoryAvailabilityRuntimeAtpContext["captureActiveSupplySnapshot"];
  getProductIdsByVariantIds?: InventoryAvailabilityRuntimeAtpContext["getProductIdsByVariantIds"];
}): InventoryAvailabilityRuntimeAtpExecutor {
  return {
    execute: (work) => work({
      authority: input.authority,
      authorityRevision: "9",
      activationRunId: input.authority === "canonical" ? "44" : null,
      legacy: input.legacy,
      captureActiveSupplySnapshot: input.captureActiveSupplySnapshot,
      getProductIdsByVariantIds: input.getProductIdsByVariantIds ?? vi.fn(async () => new Map()),
    }),
  };
}

function fakeLegacy(): InventoryAtpServiceContract {
  return {
    getProductInventoryStrategy: vi.fn(async () => "physical_fungible"),
    getTotalBaseUnits: vi.fn(async () => ({
      onHand: 35,
      reserved: 0,
      picked: 0,
      packed: 0,
      backorder: 0,
    })),
    getAtpBase: vi.fn(async () => 35),
    getAtpBaseByWarehouse: vi.fn(async () => 35),
    getDirectVariantAtpByWarehouse: vi.fn(async () => new Map([[101, 25], [102, 2]])),
    getAtpPerVariantByWarehouse: vi.fn(async () => [{
      productVariantId: 101,
      sku: "EA",
      name: "Each",
      unitsPerVariant: 1,
      salesEligibility: "sellable",
      atpUnits: 35,
      atpBase: 35,
    }]),
    getAtpPerVariant: vi.fn(async () => [{
      productVariantId: 101,
      sku: "EA",
      name: "Each",
      unitsPerVariant: 1,
      salesEligibility: "sellable",
      atpUnits: 35,
      atpBase: 35,
    }]),
    getAtpForChannel: vi.fn(async () => []),
    getProductSummary: vi.fn(async () => null),
    getInventoryItemSummary: vi.fn(async () => ({
      productId: 10,
      baseSku: "PRODUCT",
      name: "Product",
      totalOnHandPieces: 35,
      totalReservedPieces: 0,
      totalAtpPieces: 35,
      variants: [
        { variantId: 101, sku: "EA", name: "Each", unitsPerVariant: 1,
          available: 35, variantQty: 25, reservedQty: 0, pickedQty: 0, atpPieces: 35 },
        { variantId: 102, sku: "P5", name: "Pack 5", unitsPerVariant: 5,
          available: 7, variantQty: 2, reservedQty: 0, pickedQty: 0, atpPieces: 35 },
      ],
    })),
    getBulkAtp: vi.fn(async () => new Map([[10, 35]])),
  };
}

function canonicalSnapshot() {
  const content: SupplySnapshotContentDto = {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: "2026-09-03T12:00:00.000Z",
    productId: 10,
    legacyInventoryStrategy: "physical_fungible",
    variants: [
      { id: 101, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1,
        isActive: true, salesEligibility: "sellable" },
      { id: 102, productId: 10, sku: "P5", name: "Pack 5", unitsPerVariant: 5,
        isActive: true, salesEligibility: "sellable" },
    ],
    warehouses: [{ id: 1, code: "LEON", isActive: true, hubWarehouseId: null }],
    locations: [
      { id: 11, warehouseId: 1, code: "RES-EA", locationType: "reserve", isPickable: false,
        isActive: true, isFrozen: false, promisePolicy: null },
      { id: 12, warehouseId: 1, code: "PICK-P5", locationType: "pick", isPickable: true,
        isActive: true, isFrozen: false, promisePolicy: null },
    ],
    inventoryPositions: [
      { inventoryLevelId: 1, warehouseLocationId: 11, productVariantId: 101,
        variantQty: "25", reservedQty: "0", pickedQty: "0", packedQty: "0" },
      { inventoryLevelId: 2, warehouseLocationId: 12, productVariantId: 102,
        variantQty: "2", reservedQty: "0", pickedQty: "0", packedQty: "0" },
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
      validationState: "valid",
      validationErrors: [],
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
    ],
    claimProjectionSource: "inventory_levels.reserved_qty",
  };
  return sealSupplySnapshot(content);
}
