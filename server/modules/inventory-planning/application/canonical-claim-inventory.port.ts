export type CanonicalClaimTransactionClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type CanonicalClaimLotAllocation = {
  inventoryLotId: number;
  qty: number;
  unitCostMills: bigint;
  poUnitCostMills: bigint;
  packagingUnitCostMills: bigint;
  landedUnitCostMills: bigint;
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

export type CanonicalClaimInventoryExecutionResource = {
  claimResourceId: bigint;
  inventoryLevelId: number;
  warehouseLocationId: number;
  sourceVariantId: number;
  consumeQty: bigint;
  lotAllocations: readonly {
    claimLotAllocationId: bigint;
    inventoryLotId: number;
    consumeQty: bigint;
    unitCostMills: bigint;
    poUnitCostMills: bigint;
    packagingUnitCostMills: bigint;
    landedUnitCostMills: bigint;
  }[];
};

export type CanonicalClaimProducedLotAllocation = {
  inventoryLotId: number;
  qty: number;
  unitCostMills: bigint;
  poUnitCostMills: bigint;
  packagingUnitCostMills: bigint;
  landedUnitCostMills: bigint;
};

export type CanonicalClaimPackageExecutionResult = {
  outputInventoryLevelId: number;
  committedLotAllocations: readonly CanonicalClaimProducedLotAllocation[];
  totalInputCostMills: bigint;
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

  executePackageOperation(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimOperationId: bigint;
    operationKey: string;
    operationType: "break_pack" | "assemble_pack" | "directed_conversion";
    resources: readonly CanonicalClaimInventoryExecutionResource[];
    destinationVariantId: number;
    outputLocationId: number;
    outputQty: bigint;
    committedOutputQty: bigint;
    orderId: number;
    orderItemId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimPackageExecutionResult>;
}
