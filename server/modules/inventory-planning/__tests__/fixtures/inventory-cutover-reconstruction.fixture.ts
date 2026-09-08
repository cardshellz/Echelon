import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { sealClaimSupplySnapshot } from "../../domain/inventory-availability-planner";
import { cutoverPreflightFacts } from "./inventory-cutover-preflight.fixture";

export function reconstructionEvidence(): CutoverReconstructionEvidence {
  const facts = cutoverPreflightFacts();
  return { schemaVersion: "inventory_cutover_reconstruction_v1", orders: facts.demand.orders,
    items: [{ ...facts.demand.items[0], omsOrderLineId: "11", quantity: 6, pickedQuantity: 2 }],
    variants: facts.variants, sourceItems: [], physicalItems: [], buildDemands: [], buildReservations: [], canonicalResources: [],
    canonicalClaimCount: "0", canonicalClaimHash: "a".repeat(64), acceptedOmsDemand: [], shipmentReviewEvidence: [],
    levels: [{ id: 10, warehouseLocationId: 100, warehouseId: 1, productVariantId: 101,
      variantQty: "20", reservedQty: "3", pickedQty: "2", packedQty: "0" }],
    lots: [{ id: 4, warehouseLocationId: 100, productVariantId: 101, onHandQty: "20", reservedQty: "3", pickedQty: "2",
      status: "active", unitCostMills: "9007199254740995", poUnitCostMills: "9007199254740995", packagingUnitCostMills: "0", landedUnitCostMills: "0" }],
    journals: [{ orderId: 1, orderItemId: 11, productVariantId: 101, warehouseLocationId: 100,
      reservedQty: "3", pickedQty: "2", shippedQty: "0", unknownCount: "0", journalCount: "2", journalHash: "b".repeat(64) }],
    costs: [{ id: 9, orderId: 1, orderItemId: 11, inventoryLotId: 4, productVariantId: 101, quantity: "2",
      unitCostMills: "9007199254740995", totalCostMills: "18014398509481990", occurredAt: "2026-09-06T12:00:00.000Z" }],
  };
}
export function reconstructionSupply(evidence = reconstructionEvidence()) {
  return sealClaimSupplySnapshot({ schemaVersion: "inventory_availability_claim_snapshot_v1", capturedAt: "2026-09-07T12:00:00.000Z",
    rootProducts: [{ productId: 20, legacyInventoryStrategy: "physical_only" }],
    variants: [{ id: 101, productId: 20, sku: "P5", name: "Pack", unitsPerVariant: 5, isActive: true, salesEligibility: "sellable" }],
    warehouses: [{ id: 1, code: "MAIN", isActive: true, hubWarehouseId: null }],
    locations: [{ id: 100, warehouseId: 1, code: "PICK", locationType: "pick", isPickable: true, isActive: true, isFrozen: false, promisePolicy: null }],
    inventoryPositions: evidence.levels.map(({ id, warehouseId: _warehouse, ...level }) => ({ inventoryLevelId: id, ...level })),
    safetyPolicies: [{ policyId: 1,version: 1,lifecycleSelection: "active_head",scopeKey: "business",scopeType: "business",
      productVariantId: null,warehouseId: null,policyMode: "off",fixedUnits: null,daysOfCoverMilliDays: null,
      untrustedDemandFallbackUnits: null,demandMethodVersion: null,definitionHash: "d".repeat(64) }],
    demandEvidence: [], transformationModels: [{ modelId: 1, productId: 20, version: 1,
      lifecycleSelection: "active_head", lifecycleStatus: "sealed", buildToPromiseEnabled: false, definitionHash: "c".repeat(64),
      validationState: "valid", validationErrors: [], paths: [], recipeBindings: [] }],
    legacyRecipes: [], outputLocations: [], claimProjectionSource: "inventory_levels.reserved_qty" });
}
