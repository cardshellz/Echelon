import type { SupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";

/** Observed B200/C2000 shape, plus unrelated stock to catch network-scope leaks. */
export function hubReserveSupply(): SupplySnapshotContentDto {
  const hash = "a".repeat(64);
  return {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: "2026-10-02T12:00:00.000Z",
    productId: 10,
    legacyInventoryStrategy: "physical_fungible",
    variants: [
      { id: 173, productId: 10, sku: "SHLZ-SEMI-OVR-B200", name: "Box of 200", unitsPerVariant: 200, isActive: true },
      { id: 174, productId: 10, sku: "SHLZ-SEMI-OVR-C2000", name: "Case of 2000", unitsPerVariant: 2000, isActive: true },
    ],
    warehouses: [
      { id: 1, code: "LEON", isActive: true, hubWarehouseId: null },
      { id: 2, code: "RTE-19", isActive: true, hubWarehouseId: 1 },
      { id: 3, code: "UNRELATED", isActive: true, hubWarehouseId: null },
    ],
    locations: [
      { id: 11, warehouseId: 1, code: "D-17", locationType: "pick", isPickable: true, isActive: true, isFrozen: false, promisePolicy: null },
      { id: 12, warehouseId: 1, code: "FLOOR-03", locationType: "pick", isPickable: true, isActive: true, isFrozen: false, promisePolicy: null },
      { id: 21, warehouseId: 2, code: "FLOOR-01", locationType: "reserve", isPickable: false, isActive: true, isFrozen: false, promisePolicy: null },
      { id: 31, warehouseId: 3, code: "OTHER", locationType: "reserve", isPickable: false, isActive: true, isFrozen: false, promisePolicy: null },
    ],
    inventoryPositions: [
      { inventoryLevelId: 1, warehouseLocationId: 11, productVariantId: 173, variantQty: "9", reservedQty: "4", pickedQty: "0", packedQty: "0" },
      { inventoryLevelId: 2, warehouseLocationId: 12, productVariantId: 174, variantQty: "49", reservedQty: "1", pickedQty: "0", packedQty: "0" },
      { inventoryLevelId: 3, warehouseLocationId: 21, productVariantId: 174, variantQty: "150", reservedQty: "0", pickedQty: "0", packedQty: "0" },
      { inventoryLevelId: 4, warehouseLocationId: 31, productVariantId: 174, variantQty: "7", reservedQty: "0", pickedQty: "0", packedQty: "0" },
    ],
    safetyPolicies: [{ policyId: 1, version: 1, lifecycleSelection: "active_head", scopeKey: "business", scopeType: "business",
      productVariantId: null, warehouseId: null, policyMode: "off", fixedUnits: null, daysOfCoverMilliDays: null,
      untrustedDemandFallbackUnits: null, demandMethodVersion: null, definitionHash: hash }],
    demandEvidence: [],
    transformationModels: [{ modelId: 501, productId: 10, version: 1, lifecycleSelection: "active_head", lifecycleStatus: "sealed",
      buildToPromiseEnabled: false, definitionHash: hash, validationState: "valid", validationErrors: [], recipeBindings: [],
      paths: [{ pathId: 1, sourceVariantId: 174, destinationVariantId: 173, inputQty: "1", outputQty: "10",
        sourceUnitsPerVariant: 2000, destinationUnitsPerVariant: 200, operationType: "break_pack", authorityState: "allowed",
        validationState: "valid", validationErrors: [], transformationRecipeBindingId: null }] }],
    legacyRecipes: [],
    outputLocations: [
      { productVariantId: 173, warehouseId: 1, warehouseLocationId: 11 },
      { productVariantId: 174, warehouseId: 1, warehouseLocationId: 12 },
    ],
    claimProjectionSource: "inventory_levels.reserved_qty",
  };
}
