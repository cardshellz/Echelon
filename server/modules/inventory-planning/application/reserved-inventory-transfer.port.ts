import type { CanonicalClaimTransactionClient } from "./canonical-claim-inventory.port";
export interface ReservedTransferAllocation {
  allocationId: string;
  resourceId: string;
  claimId: string;
  claimLineId: string;
  orderId: number;
  orderItemId: number;
  sourceLotId: number;
  quantity: number;
  unitCostMills: string;
  poUnitCostMills: string | null;
  packagingUnitCostMills: string | null;
  landedUnitCostMills: string | null;
}
export interface ReservedTransferPlan {
  productVariantId: number;
  fromLocationId: number;
  toLocationId: number;
  reservedQuantity: number;
  orderItemIds: readonly number[];
  allocations: readonly ReservedTransferAllocation[];
}
export interface TransferredInventoryLot {
  sourceLotId: number;
  destinationLotId: number;
  quantity: number;
  reservedQuantity: number;
}
export interface ReservedInventoryTransferOwner {
  /** Follows canonical graph -> order -> claim lock order, before level/lot locks. */
  lockSource(client: CanonicalClaimTransactionClient, input: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
  }): Promise<void>;
  plan(client: CanonicalClaimTransactionClient, input: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    quantity: number;
    sourceLevelId: number;
    warehouseId: number;
    onHand: number;
    reserved: number;
  }): Promise<ReservedTransferPlan>;
  relocate(client: CanonicalClaimTransactionClient, input: {
    plan: ReservedTransferPlan;
    lots: readonly TransferredInventoryLot[];
    destinationLevelId: number;
    warehouseId: number;
    commandKey: string;
    actor: string;
    occurredAt: Date;
  }): Promise<void>;
}
