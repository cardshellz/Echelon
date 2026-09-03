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

export type CanonicalClaimBuildInventoryContext = {
  buildOrderId: number;
  buildRunId: number;
  buildRunNumber: number;
  buildSystemNumber: string;
  components: readonly {
    sourceVariantId: number;
    buildOrderComponentId: number;
  }[];
};

export type CanonicalClaimInventoryPickResource = {
  claimResourceId: bigint;
  inventoryLevelId: number;
  warehouseLocationId: number;
  sourceVariantId: number;
  pickQty: bigint;
  lotAllocations: readonly {
    claimLotAllocationId: bigint;
    inventoryLotId: number;
    pickQty: bigint;
    unitCostMills: bigint;
    poUnitCostMills: bigint;
    packagingUnitCostMills: bigint;
    landedUnitCostMills: bigint;
  }[];
};

export type CanonicalClaimInventoryUnpickResource = {
  claimResourceId: bigint;
  inventoryLevelId: number;
  warehouseLocationId: number;
  sourceVariantId: number;
  unpickQty: bigint;
  lotAllocations: readonly {
    claimLotAllocationId: bigint;
    inventoryLotId: number;
    unpickQty: bigint;
    reversesPickMovementId: bigint;
    unitCostMills: bigint;
  }[];
};

export type CanonicalClaimInventoryPickMovement = {
  claimResourceId: bigint;
  claimLotAllocationId: bigint;
  inventoryLotId: number;
  quantity: bigint;
  unitCostMills: bigint;
  totalCostMills: bigint;
  orderItemCostId: number;
  reversesPickMovementId: bigint | null;
};

export type CanonicalClaimInventoryPickResult = {
  movements: readonly CanonicalClaimInventoryPickMovement[];
  totalCostMills: bigint;
};

export type CanonicalClaimInventoryObservationCostLayer = {
  inventoryLotId: number;
  quantity: bigint;
  unitCostMills: bigint;
  poUnitCostMills: bigint;
  packagingUnitCostMills: bigint;
  landedUnitCostMills: bigint;
};

export type CanonicalClaimInventoryObservedReconciliationResult = {
  allocations: readonly CanonicalClaimLotAllocation[];
  recordedReconciledQuantity: bigint;
  observedRelocatedQuantity: bigint;
  relocatedInventoryLotIds: readonly number[];
  systemLevelQuantityBefore: bigint;
  systemLotQuantityBefore: bigint;
  recordedUnreservedQuantityBefore: bigint;
};

export type CanonicalClaimCycleCountAdjustmentResult = {
  adjustmentTransactionId: number;
  consumedQty: bigint;
  consumedCostMills: bigint;
};

export interface CanonicalClaimInventoryMutationPort {
  ensureInventoryLevel(input: {
    client: CanonicalClaimTransactionClient;
    productVariantId: number;
    warehouseLocationId: number;
    occurredAt: Date;
  }): Promise<number>;

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

  reconcilePickResource(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    releases: readonly CanonicalClaimInventoryReleaseResource[];
    target: {
      claimResourceId: bigint;
      inventoryLevelId: number;
      warehouseLocationId: number;
      sourceVariantId: number;
      claimedQty: number;
      orderItemId: number;
    };
    orderId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<readonly CanonicalClaimLotAllocation[]>;

  reconcileObservedPickResource(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    releases: readonly CanonicalClaimInventoryReleaseResource[];
    sourceCostLayers: readonly CanonicalClaimInventoryObservationCostLayer[];
    target: {
      claimResourceId: bigint;
      inventoryLevelId: number;
      warehouseLocationId: number;
      sourceVariantId: number;
      claimedQty: number;
      orderItemId: number;
    };
    observationReference: string;
    orderId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimInventoryObservedReconciliationResult>;

  pickResources(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimLineId: bigint;
    resources: readonly CanonicalClaimInventoryPickResource[];
    orderId: number;
    orderItemId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimInventoryPickResult>;

  unpickResources(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimLineId: bigint;
    resources: readonly CanonicalClaimInventoryUnpickResource[];
    orderId: number;
    orderItemId: number;
    restoreReservation: boolean;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimInventoryPickResult>;

  applyCycleCountAdjustment(input: {
    client: CanonicalClaimTransactionClient;
    inventoryLevelId: number;
    productVariantId: number;
    warehouseLocationId: number;
    quantityBefore: number;
    countedQty: number;
    cycleCountId: number;
    cycleCountItemId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimCycleCountAdjustmentResult>;

  recordCycleCountNoop(input: {
    client: CanonicalClaimTransactionClient;
    productVariantId: number;
    warehouseLocationId: number;
    countedQty: number;
    cycleCountId: number;
    cycleCountItemId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<{ adjustmentTransactionId: number }>;

  approveCycleCountItem(input: {
    client: CanonicalClaimTransactionClient;
    cycleCountItemId: number;
    expectedStatus: string;
    actor: string;
    reasonCode: string;
    adjustmentTransactionId: number | null;
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

  executeBuildOperation(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimOperationId: bigint;
    operationKey: string;
    operationType: "component_build";
    resources: readonly CanonicalClaimInventoryExecutionResource[];
    destinationVariantId: number;
    outputLocationId: number;
    outputQty: bigint;
    committedOutputQty: bigint;
    orderId: number;
    orderItemId: number;
    build: CanonicalClaimBuildInventoryContext;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimPackageExecutionResult>;
}
