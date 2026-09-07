import type { CanonicalClaimDispatchCommand, CanonicalClaimDispatchEvidence } from "@shared/types/inventory-availability-dispatch";

export function inventoryDispatchFixture(): { command: CanonicalClaimDispatchCommand; evidence: CanonicalClaimDispatchEvidence } {
  return {
    command: { claimId: "10", orderId: 70, orderItemId: 71, warehouseId: 1, warehouseLocationId: 50,
      productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101, physicalShipmentId: null,
      physicalShipmentItemId: null, quantity: "3", idempotencyKey: "dispatch:90:101:1", actor: "test-worker", reason: "Dispatch exact source" },
    evidence: { coverage: "complete_final_target_line",
      source: { orderId: 70, orderItemId: 71, warehouseId: 1, warehouseLocationId: 50, productVariantId: 105,
        outboundShipmentId: 90, sourceShipmentItemId: 101, physicalShipmentId: null, physicalShipmentItemId: null,
        physicalShipmentItemQuantity: null, quantity: "3", dispatchedQuantity: "0", readiness: "authorized", orderStatus: "shipped" },
      claim: { id: "10", orderId: 70, status: "active" },
      line: { id: "20", claimId: "10", orderItemId: 71, targetVariantId: 105, plannedQty: "3",
        releasedTargetQty: "0", consumedTargetQty: "0", pickedTargetQty: "3" },
      resources: [{ id: "30", claimId: "10", claimLineId: "20", warehouseId: 1, warehouseLocationId: 50,
        inventoryLevelId: 60, sourceVariantId: 105, consumerOperationKey: null, producerOperationKey: null,
        claimedQty: "3", releasedQty: "0", consumedQty: "0", pickedQty: "3",
        lots: [{ id: "40", claimId: "10", claimResourceId: "30", inventoryLotId: 401,
          claimedQty: "3", releasedQty: "0", consumedQty: "0", pickedQty: "3" }] }],
      pickMovements: [{ id: "50", claimId: "10", claimLineId: "20", claimResourceId: "30", claimLotAllocationId: "40",
        inventoryLotId: 401, quantity: "3", reversedQuantity: "0", dispatchedQuantity: "0",
        cost: { id: 301, orderId: 70, orderItemId: 71, productVariantId: 105, inventoryLotId: 401,
          quantity: "3", unitCostMills: "100", totalCostMills: "300" } }],
    },
  };
}
