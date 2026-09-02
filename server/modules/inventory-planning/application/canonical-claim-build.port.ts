import type {
  CanonicalClaimInventoryExecutionResource,
  CanonicalClaimProducedLotAllocation,
  CanonicalClaimTransactionClient,
} from "./canonical-claim-inventory.port";

export type CanonicalClaimBuildInput = {
  sourceVariantId: number;
  requiredQty: bigint;
};

export type CanonicalClaimBuildHandoffResult = {
  buildOrderId: number;
  buildSystemNumber: string;
  adoptedReservationQty: bigint;
};

export type CanonicalClaimBuildExecutionResult = {
  buildOrderId: number;
  buildRunId: number;
  buildSystemNumber: string;
  outputInventoryLevelId: number;
  committedLotAllocations: readonly CanonicalClaimProducedLotAllocation[];
  totalInputCostMills: bigint;
};

export type CanonicalClaimBuildCancellationResult = {
  buildOrderId: number;
  buildSystemNumber: string;
  releasedReservationQty: bigint;
};

export interface CanonicalClaimBuildMutationPort {
  handoffOperation(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimOperationId: bigint;
    operationKey: string;
    transformationRecipeBindingId: number;
    warehouseId: number;
    plannedBuilds: bigint;
    destinationVariantId: number;
    outputLocationId: number;
    outputQty: bigint;
    inputs: readonly CanonicalClaimBuildInput[];
    resources: readonly CanonicalClaimInventoryExecutionResource[];
    actor: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimBuildHandoffResult>;

  executeOperation(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimOperationId: bigint;
    operationKey: string;
    buildOrderId: number;
    warehouseId: number;
    plannedBuilds: bigint;
    destinationVariantId: number;
    outputLocationId: number;
    outputQty: bigint;
    committedOutputQty: bigint;
    inputs: readonly CanonicalClaimBuildInput[];
    resources: readonly CanonicalClaimInventoryExecutionResource[];
    orderId: number;
    orderItemId: number;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimBuildExecutionResult>;

  cancelOperation(input: {
    client: CanonicalClaimTransactionClient;
    claimId: bigint;
    claimOperationId: bigint;
    buildOrderId: number;
    expectedReservationQty: bigint;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CanonicalClaimBuildCancellationResult>;
}
