export type CanonicalClaimTransactionClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type CanonicalClaimLotAllocation = {
  inventoryLotId: number;
  qty: number;
  unitCostMills: bigint;
};

export type CanonicalClaimInventoryReleaseResource = {
  claimResourceId: bigint;
  inventoryLevelId: number;
  warehouseLocationId: number;
  sourceVariantId: number;
  releaseQty: bigint;
  lotAllocations: readonly {
    inventoryLotId: number;
    releaseQty: bigint;
  }[];
  orderItemId: number;
};

export interface CanonicalClaimInventoryMutationPort {
  reserveResource(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimResourceId: bigint;
    inventoryLevelId: number;
    warehouseLocationId: number;
    sourceVariantId: number;
    claimedQty: number;
    orderId: number;
    orderItemId: number;
    consumerOperationKey: string | null;
    actor: string;
    occurredAt: Date;
  }): Promise<readonly CanonicalClaimLotAllocation[]>;

  releaseResources(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    resources: readonly CanonicalClaimInventoryReleaseResource[];
    orderId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<void>;
}
