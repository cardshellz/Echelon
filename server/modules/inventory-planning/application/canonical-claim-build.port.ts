import type {
  CanonicalClaimInventoryExecutionResource,
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
}
