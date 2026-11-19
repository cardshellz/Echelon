import type { PoolClient } from "pg";

import {
  canonicalAvailabilityClaimBuildHandoffResultSchema,
  canonicalAvailabilityClaimOperationExecutionResultSchema,
  type CanonicalAvailabilityClaimBuildHandoffCommand,
  type CanonicalAvailabilityClaimBuildHandoffResult,
  type CanonicalAvailabilityClaimOperationExecutionCommand,
  type CanonicalAvailabilityClaimOperationExecutionResult,
} from "@shared/types/inventory-availability-claims";
import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";
import { canonicalJson } from "@shared/utils/canonical-json";
import type {
  CanonicalClaimInventoryExecutionResource,
  CanonicalClaimInventoryMutationPort,
} from "../../application/canonical-claim-inventory.port";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  positiveBigInt,
  positiveInteger,
  rows,
  type PersistedClaim,
} from "./claim-primitives";

export type LockedClaimOperation = {
  id: bigint;
  claimLineId: bigint;
  orderItemId: number;
  operationKey: string;
  parentOperationKey: string | null;
  warehouseId: number;
  operationType: "break_pack" | "assemble_pack" | "directed_conversion" | "component_build";
  authorityId: number;
  destinationVariantId: number;
  plannedExecutions: bigint;
  outputQty: bigint;
  committedOutputQty: bigint;
  outputLocationId: number;
  status: string;
};

export type LockedClaimPackageOperation = LockedClaimOperation & {
  operationType: "break_pack" | "assemble_pack" | "directed_conversion";
};

export type LockedClaimBuildOperation = LockedClaimOperation & {
  operationType: "component_build";
};

export type LockedClaimBuildHandoff = {
  id: bigint;
  buildOrderId: number;
  adoptedReservationQty: bigint;
};

export async function lockPackageOperation(
  client: PoolClient,
  claimId: bigint,
  operationKey: string,
): Promise<LockedClaimPackageOperation> {
  const row = rows(await client.query(
    `SELECT operation.id, operation.claim_line_id, line.order_item_id,
            operation.operation_key, operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id, operation.destination_variant_id,
            operation.planned_executions, operation.output_qty,
            operation.committed_output_qty, operation.output_location_id,
            operation.status, operation.executed_executions, operation.released_executions
     FROM inventory.availability_claim_operations AS operation
     JOIN inventory.availability_claim_lines AS line
       ON line.id = operation.claim_line_id AND line.claim_id = operation.claim_id
     WHERE operation.claim_id = $1 AND operation.operation_key = $2
     FOR UPDATE OF operation`,
    [claimId.toString(), operationKey],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_FOUND",
      "The requested operation does not belong to the active canonical claim.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (row.operation_type === "component_build") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_REQUIRES_BUILD_HANDOFF",
      "Component-build operations must use the claim-to-build handoff contract.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (!["break_pack", "assemble_pack", "directed_conversion"].includes(String(row.operation_type))) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLAIM_OPERATION_TYPE",
      "The claim operation has an unsupported package-transformation type.",
      { claimId: claimId.toString(), operationKey, operationType: row.operation_type },
    );
  }
  if (row.committed_output_qty == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_EXECUTION_EVIDENCE_MISSING",
      "This operation predates the exact committed-output contract and must be replanned.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (row.output_location_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_OUTPUT_LOCATION_MISSING",
      "A package transformation cannot execute without its planned output location.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (String(row.status) !== "pending" && String(row.status) !== "ready") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_EXECUTABLE",
      "The package transformation is not in an executable state.",
      { claimId: claimId.toString(), operationKey, status: row.status },
    );
  }
  if (BigInt(String(row.executed_executions)) !== BigInt(0)
    || BigInt(String(row.released_executions)) !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PROGRESS_CONFLICT",
      "A pending package transformation already contains execution or release progress.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  return {
    id: positiveBigInt(row.id, "claimOperation.id"),
    claimLineId: positiveBigInt(row.claim_line_id, "claimOperation.claimLineId"),
    orderItemId: positiveInteger(row.order_item_id, "claimLine.orderItemId"),
    operationKey: String(row.operation_key),
    parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
    warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
    operationType: row.operation_type,
    authorityId: positiveInteger(row.authority_id, "claimOperation.authorityId"),
    destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
    plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
    outputQty: positiveBigInt(row.output_qty, "claimOperation.outputQty"),
    committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
    outputLocationId: positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
    status: String(row.status),
  } as LockedClaimPackageOperation;
}

export async function lockBuildOperation(
  client: PoolClient,
  claimId: bigint,
  operationKey: string,
): Promise<LockedClaimBuildOperation> {
  const row = rows(await client.query(
    `SELECT operation.id, operation.claim_line_id, line.order_item_id,
            operation.operation_key, operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id, operation.destination_variant_id,
            operation.planned_executions, operation.output_qty,
            operation.committed_output_qty, operation.output_location_id,
            operation.status, operation.executed_executions, operation.released_executions
     FROM inventory.availability_claim_operations AS operation
     JOIN inventory.availability_claim_lines AS line
       ON line.id = operation.claim_line_id AND line.claim_id = operation.claim_id
     WHERE operation.claim_id = $1 AND operation.operation_key = $2
     FOR UPDATE OF operation`,
    [claimId.toString(), operationKey],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_FOUND",
      "The requested operation does not belong to the active canonical claim.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (String(row.operation_type) !== "component_build") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_COMPONENT_BUILD",
      "Only component-build operations may use the claim-to-build handoff contract.",
      { claimId: claimId.toString(), operationKey, operationType: row.operation_type },
    );
  }
  if (row.committed_output_qty == null || row.output_location_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_EVIDENCE_MISSING",
      "The component build lacks exact committed-output or output-location evidence and must be replanned.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (!["pending", "ready"].includes(String(row.status))
    || BigInt(String(row.executed_executions)) !== BigInt(0)
    || BigInt(String(row.released_executions)) !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_OPERATION_NOT_HANDOFF_READY",
      "The component build is not in a clean handoff-ready state.",
      { claimId: claimId.toString(), operationKey, status: row.status },
    );
  }
  return {
    id: positiveBigInt(row.id, "claimOperation.id"),
    claimLineId: positiveBigInt(row.claim_line_id, "claimOperation.claimLineId"),
    orderItemId: positiveInteger(row.order_item_id, "claimLine.orderItemId"),
    operationKey: String(row.operation_key),
    parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
    warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
    operationType: "component_build",
    authorityId: positiveInteger(row.authority_id, "claimOperation.authorityId"),
    destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
    plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
    outputQty: positiveBigInt(row.output_qty, "claimOperation.outputQty"),
    committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
    outputLocationId: positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
    status: String(row.status),
  };
}

export async function lockHandedOffBuildOperation(
  client: PoolClient,
  claimId: bigint,
  operationKey: string,
): Promise<{ operation: LockedClaimBuildOperation; handoff: LockedClaimBuildHandoff }> {
  const row = rows(await client.query(
    `SELECT operation.id, operation.claim_line_id, line.order_item_id,
            operation.operation_key, operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id, operation.destination_variant_id,
            operation.planned_executions, operation.output_qty,
            operation.committed_output_qty, operation.output_location_id,
            operation.status, operation.executed_executions, operation.released_executions,
            handoff.id AS handoff_id, handoff.build_order_id,
            handoff.adopted_reservation_qty, handoff.status AS handoff_status
     FROM inventory.availability_claim_operations AS operation
     JOIN inventory.availability_claim_lines AS line
       ON line.id = operation.claim_line_id AND line.claim_id = operation.claim_id
     JOIN inventory.availability_claim_build_handoffs AS handoff
       ON handoff.claim_id = operation.claim_id AND handoff.claim_operation_id = operation.id
     WHERE operation.claim_id = $1 AND operation.operation_key = $2
     FOR UPDATE OF operation, handoff`,
    [claimId.toString(), operationKey],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_NOT_FOUND",
      "The requested component build has no active claim handoff.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (String(row.operation_type) !== "component_build"
    || String(row.status) !== "executing"
    || String(row.handoff_status) !== "handed_off"
    || BigInt(String(row.executed_executions)) !== BigInt(0)
    || BigInt(String(row.released_executions)) !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_OPERATION_NOT_EXECUTABLE",
      "The claim build is not in an exact handed-off execution state.",
      {
        claimId: claimId.toString(),
        operationKey,
        operationStatus: row.status,
        handoffStatus: row.handoff_status,
      },
    );
  }
  if (row.committed_output_qty == null || row.output_location_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_EXECUTION_EVIDENCE_MISSING",
      "The handed-off build lacks exact committed-output or output-location evidence and must be replanned.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  return {
    operation: {
      id: positiveBigInt(row.id, "claimOperation.id"),
      claimLineId: positiveBigInt(row.claim_line_id, "claimOperation.claimLineId"),
      orderItemId: positiveInteger(row.order_item_id, "claimLine.orderItemId"),
      operationKey: String(row.operation_key),
      parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
      warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
      operationType: "component_build",
      authorityId: positiveInteger(row.authority_id, "claimOperation.authorityId"),
      destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
      plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
      outputQty: positiveBigInt(row.output_qty, "claimOperation.outputQty"),
      committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
      outputLocationId: positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
      status: "executing",
    },
    handoff: {
      id: positiveBigInt(row.handoff_id, "claimBuildHandoff.id"),
      buildOrderId: positiveInteger(row.build_order_id, "claimBuildHandoff.buildOrderId"),
      adoptedReservationQty: positiveBigInt(
        row.adopted_reservation_qty,
        "claimBuildHandoff.adoptedReservationQty",
      ),
    },
  };
}

export function assertOperationMatchesPlan(
  claim: PersistedClaim,
  operation: LockedClaimOperation,
): ClaimPlanDto["operations"][number] {
  const planned = claim.plan.operations.find((candidate) => candidate.operationKey === operation.operationKey);
  if (!planned) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PLAN_EVIDENCE_MISSING",
      "The relational operation is absent from the claim's hashed planner payload.",
      { claimId: claim.id.toString(), operationKey: operation.operationKey },
    );
  }
  const persistedEvidence = {
    lineKey: `order-item:${operation.orderItemId}`,
    warehouseId: operation.warehouseId,
    operationKey: operation.operationKey,
    parentOperationKey: operation.parentOperationKey,
    operationType: operation.operationType,
    authorityId: operation.authorityId,
    destinationVariantId: operation.destinationVariantId,
    plannedExecutions: operation.plannedExecutions.toString(),
    outputQty: operation.outputQty.toString(),
    committedOutputQty: operation.committedOutputQty.toString(),
    outputLocationId: operation.outputLocationId,
  };
  const plannedEvidence = {
    lineKey: planned.lineKey,
    warehouseId: planned.warehouseId,
    operationKey: planned.operationKey,
    parentOperationKey: planned.parentOperationKey,
    operationType: planned.operationType,
    authorityId: planned.authorityId,
    destinationVariantId: planned.destinationVariantId,
    plannedExecutions: planned.plannedExecutions,
    outputQty: planned.outputQty,
    committedOutputQty: planned.committedOutputQty,
    outputLocationId: planned.outputLocationId,
  };
  if (canonicalJson(persistedEvidence) !== canonicalJson(plannedEvidence)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PLAN_EVIDENCE_MISMATCH",
      "The relational operation differs from the claim's hashed planner payload.",
      { claimId: claim.id.toString(), operationKey: operation.operationKey, persistedEvidence, plannedEvidence },
    );
  }
  return planned;
}

export async function loadOperationExecutionResources(
  client: PoolClient,
  claimId: bigint,
  operation: LockedClaimOperation,
  plannedOperation: ClaimPlanDto["operations"][number],
): Promise<CanonicalClaimInventoryExecutionResource[]> {
  const prerequisiteRows = rows(await client.query(
    `SELECT operation_key, status
     FROM inventory.availability_claim_operations
     WHERE claim_id = $1 AND parent_operation_key = $2
     ORDER BY operation_key
     FOR SHARE`,
    [claimId.toString(), operation.operationKey],
  ));
  const incompletePrerequisites = prerequisiteRows
    .filter((row) => String(row.status) !== "completed")
    .map((row) => ({ operationKey: String(row.operation_key), status: String(row.status) }));
  if (incompletePrerequisites.length > 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PREREQUISITE_INCOMPLETE",
      "Every child operation must complete before its parent can consume the produced output.",
      { claimId: claimId.toString(), operationKey: operation.operationKey, incompletePrerequisites },
    );
  }

  const inputRows = rows(await client.query(
    `SELECT source_variant_id, required_qty
     FROM inventory.availability_claim_operation_inputs
     WHERE claim_operation_id = $1 AND claim_id = $2
     ORDER BY input_ordinal, source_variant_id
     FOR SHARE`,
    [operation.id.toString(), claimId.toString()],
  ));
  if (inputRows.length === 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_INPUTS_MISSING",
      "The package transformation has no persisted input contract.",
      { claimId: claimId.toString(), operationKey: operation.operationKey },
    );
  }
  const expectedByVariant = new Map<number, bigint>();
  for (const row of inputRows) {
    expectedByVariant.set(
      positiveInteger(row.source_variant_id, "claimOperationInput.sourceVariantId"),
      positiveBigInt(row.required_qty, "claimOperationInput.requiredQty"),
    );
  }
  const plannedInputs = [...plannedOperation.inputs]
    .sort((left, right) => left.sourceVariantId - right.sourceVariantId)
    .map((input) => [input.sourceVariantId, input.requiredQty]);
  const persistedInputs = [...expectedByVariant]
    .sort(([left], [right]) => left - right)
    .map(([variantId, quantity]) => [variantId, quantity.toString()]);
  if (canonicalJson(persistedInputs) !== canonicalJson(plannedInputs)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_INPUT_PLAN_MISMATCH",
      "The relational operation inputs differ from the claim's hashed planner payload.",
      { operationKey: operation.operationKey, plannedInputs, persistedInputs },
    );
  }

  const resourceRows = rows(await client.query(
    `SELECT id, claim_line_id, warehouse_id, warehouse_location_id,
            inventory_level_id, source_variant_id, claimed_qty, released_qty, consumed_qty, picked_qty
     FROM inventory.availability_claim_resources
     WHERE claim_id = $1 AND consumer_operation_key = $2
     ORDER BY warehouse_id, warehouse_location_id, source_variant_id, inventory_level_id, id
     FOR UPDATE`,
    [claimId.toString(), operation.operationKey],
  ));
  if (resourceRows.length === 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_RESOURCES_MISSING",
      "The package transformation has no claim-owned source resources.",
      { claimId: claimId.toString(), operationKey: operation.operationKey },
    );
  }
  const resourceIds = resourceRows.map((row) => positiveBigInt(row.id, "claimResource.id").toString());
  const allocationRows = rows(await client.query(
    `SELECT id, claim_resource_id, inventory_lot_id, claimed_qty, released_qty, consumed_qty, picked_qty,
            unit_cost_mills, po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
     FROM inventory.availability_claim_lot_allocations
     WHERE claim_id = $1 AND claim_resource_id = ANY($2::bigint[])
     ORDER BY claim_resource_id, inventory_lot_id, id
     FOR UPDATE`,
    [claimId.toString(), resourceIds],
  ));
  const allocationsByResource = new Map<string, any[]>();
  for (const allocation of allocationRows) {
    const key = String(allocation.claim_resource_id);
    const candidates = allocationsByResource.get(key) ?? [];
    candidates.push(allocation);
    allocationsByResource.set(key, candidates);
  }

  const actualByVariant = new Map<number, bigint>();
  const executionResources: CanonicalClaimInventoryExecutionResource[] = [];
  for (const row of resourceRows) {
    const claimResourceId = positiveBigInt(row.id, "claimResource.id");
    if (positiveBigInt(row.claim_line_id, "claimResource.claimLineId") !== operation.claimLineId
      || positiveInteger(row.warehouse_id, "claimResource.warehouseId") !== operation.warehouseId) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OPERATION_RESOURCE_SCOPE_MISMATCH",
        "A claim-owned source resource is outside the operation line or warehouse.",
        { claimId: claimId.toString(), operationKey: operation.operationKey, claimResourceId: claimResourceId.toString() },
      );
    }
    const claimed = positiveBigInt(row.claimed_qty, "claimResource.claimedQty");
    const released = BigInt(String(row.released_qty));
    const consumed = BigInt(String(row.consumed_qty));
    const picked = BigInt(String(row.picked_qty ?? 0));
    const open = claimed - released - consumed - picked;
    if (open <= BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OPERATION_RESOURCE_NOT_OPEN",
        "Every source resource must remain open until its operation executes.",
        { claimResourceId: claimResourceId.toString(), openQty: open.toString() },
      );
    }
    const sourceVariantId = positiveInteger(row.source_variant_id, "claimResource.sourceVariantId");
    const lotAllocations: CanonicalClaimInventoryExecutionResource["lotAllocations"][number][] = [];
    let lotOpenTotal = BigInt(0);
    for (const allocation of allocationsByResource.get(claimResourceId.toString()) ?? []) {
      if (allocation.po_unit_cost_mills == null
        || allocation.packaging_unit_cost_mills == null
        || allocation.landed_unit_cost_mills == null) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_OPERATION_COST_EVIDENCE_MISSING",
          "This claim lot predates the exact cost-breakdown contract and must be replanned.",
          { claimLotAllocationId: String(allocation.id) },
        );
      }
      const lotOpen = positiveBigInt(allocation.claimed_qty, "claimLot.claimedQty")
        - BigInt(String(allocation.released_qty))
        - BigInt(String(allocation.consumed_qty))
        - BigInt(String(allocation.picked_qty ?? 0));
      if (lotOpen <= BigInt(0)) continue;
      lotAllocations.push({
        claimLotAllocationId: positiveBigInt(allocation.id, "claimLot.id"),
        inventoryLotId: positiveInteger(allocation.inventory_lot_id, "claimLot.inventoryLotId"),
        consumeQty: lotOpen,
        unitCostMills: BigInt(String(allocation.unit_cost_mills)),
        poUnitCostMills: BigInt(String(allocation.po_unit_cost_mills)),
        packagingUnitCostMills: BigInt(String(allocation.packaging_unit_cost_mills)),
        landedUnitCostMills: BigInt(String(allocation.landed_unit_cost_mills)),
      });
      lotOpenTotal += lotOpen;
    }
    if (lotOpenTotal !== open) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_EXECUTION_LINEAGE_MISMATCH",
        "Exact open lot allocations do not reconcile to their claim resource.",
        { claimResourceId: claimResourceId.toString(), resourceQty: open.toString(), lotQty: lotOpenTotal.toString() },
      );
    }
    actualByVariant.set(sourceVariantId, (actualByVariant.get(sourceVariantId) ?? BigInt(0)) + open);
    executionResources.push({
      claimResourceId,
      inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
      warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
      sourceVariantId,
      consumeQty: open,
      lotAllocations,
    });
  }
  const expected = [...expectedByVariant]
    .sort(([left], [right]) => left - right)
    .map(([variantId, quantity]) => [variantId, quantity.toString()]);
  const actual = [...actualByVariant]
    .sort(([left], [right]) => left - right)
    .map(([variantId, quantity]) => [variantId, quantity.toString()]);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_INPUT_MISMATCH",
      "Claim-owned source resources do not equal the operation input contract.",
      { operationKey: operation.operationKey, expected, actual },
    );
  }
  return executionResources;
}

export async function recordOperationExecution(
  client: PoolClient,
  input: {
    claim: PersistedClaim;
    operation: LockedClaimOperation;
    resources: readonly CanonicalClaimInventoryExecutionResource[];
    command: CanonicalAvailabilityClaimOperationExecutionCommand;
    requestHash: string;
    outputInventoryLevelId: number;
    committedLotAllocations: Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executePackageOperation"]>>["committedLotAllocations"];
    totalInputCostMills: bigint;
    occurredAt: Date;
    commandType: "execute" | "execute_build";
    eventType: "claim_operation_executed" | "claim_build_executed";
    buildHandoffId?: bigint;
  },
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  for (const resource of input.resources) {
    for (const allocation of resource.lotAllocations) {
      const updatedAllocation = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET consumed_qty = consumed_qty + $1, updated_at = $3
         WHERE id = $2 AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
        [allocation.consumeQty.toString(), allocation.claimLotAllocationId.toString(), input.occurredAt],
      );
      if (updatedAllocation.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_LOT_EXECUTION_STATE_CHANGED",
          "A locked claim lot allocation changed before its consumption was recorded.",
          { claimLotAllocationId: allocation.claimLotAllocationId.toString() },
        );
      }
    }
    const updatedResource = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET consumed_qty = consumed_qty + $1, updated_at = $3
       WHERE id = $2 AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
      [resource.consumeQty.toString(), resource.claimResourceId.toString(), input.occurredAt],
    );
    if (updatedResource.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RESOURCE_EXECUTION_STATE_CHANGED",
        "A locked claim resource changed before its consumption was recorded.",
        { claimResourceId: resource.claimResourceId.toString() },
      );
    }
  }

  const outputResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.operation.claimLineId.toString(),
      input.operation.parentOperationKey,
      input.operation.operationKey,
      input.operation.warehouseId,
      input.operation.outputLocationId,
      input.outputInventoryLevelId,
      input.operation.destinationVariantId,
      input.operation.committedOutputQty.toString(),
    ],
  ))[0];
  const outputResourceId = positiveBigInt(outputResourceRow?.id, "outputClaimResource.id");
  for (const allocation of input.committedLotAllocations) {
    await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.claim.id.toString(),
        outputResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
      ],
    );
  }
  const committedLotQty = input.committedLotAllocations.reduce(
    (total, allocation) => total + BigInt(allocation.qty),
    BigInt(0),
  );
  if (committedLotQty !== input.operation.committedOutputQty) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OUTPUT_LINEAGE_MISMATCH",
      "Produced claim-owned lots do not reconcile to committed operation output.",
      {
        operationKey: input.operation.operationKey,
        committedQty: input.operation.committedOutputQty.toString(),
        lotQty: committedLotQty.toString(),
      },
    );
  }
  const updatedOperation = await client.query(
    `UPDATE inventory.availability_claim_operations
     SET status = 'completed', executed_executions = planned_executions, updated_at = $3
     WHERE id = $1 AND claim_id = $2
       AND status = $4
       AND executed_executions = 0 AND released_executions = 0`,
    [input.operation.id.toString(), input.claim.id.toString(), input.occurredAt, input.operation.status],
  );
  if (updatedOperation.rowCount !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_STATE_CHANGED",
      "The locked claim operation changed before completion was recorded.",
      { operationKey: input.operation.operationKey },
    );
  }
  if (input.buildHandoffId != null) {
    const updatedHandoff = await client.query(
      `UPDATE inventory.availability_claim_build_handoffs
       SET status = 'completed', completed_at = $3, updated_at = $3
       WHERE id = $1 AND claim_id = $2 AND status = 'handed_off'`,
      [input.buildHandoffId.toString(), input.claim.id.toString(), input.occurredAt],
    );
    if (updatedHandoff.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_BUILD_HANDOFF_STATE_CHANGED",
        "The claim build handoff changed before completion was recorded.",
        { operationKey: input.operation.operationKey, buildHandoffId: input.buildHandoffId.toString() },
      );
    }
  }

  const result = canonicalAvailabilityClaimOperationExecutionResultSchema.parse({
    outcome: "executed",
    claimId: input.claim.id.toString(),
    claimOperationId: input.operation.id.toString(),
    operationKey: input.operation.operationKey,
    outputResourceId: outputResourceId.toString(),
    producedQty: input.operation.outputQty.toString(),
    committedQty: input.operation.committedOutputQty.toString(),
    surplusQty: (input.operation.outputQty - input.operation.committedOutputQty).toString(),
    totalInputCostMills: input.totalInputCostMills.toString(),
    idempotentReplay: false,
  });
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      input.claim.id.toString(),
      input.claim.orderId,
      input.commandType,
      input.command.idempotencyKey,
      input.requestHash,
      hash(result),
      JSON.stringify(input.command),
      JSON.stringify(result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const evidence = {
    schemaVersion: "inventory_availability_claim_operation_event_v1",
    eventType: input.eventType,
    claimId: input.claim.id.toString(),
    operationKey: input.operation.operationKey,
    result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, 'completed', $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claim.id.toString(),
      input.eventType,
      input.operation.status,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  return result;
}

export async function recordBuildHandoff(
  client: PoolClient,
  input: {
    claim: PersistedClaim;
    operation: LockedClaimBuildOperation;
    command: CanonicalAvailabilityClaimBuildHandoffCommand;
    requestHash: string;
    buildOrderId: number;
    buildSystemNumber: string;
    adoptedReservationQty: bigint;
    occurredAt: Date;
    workTaskId?: string;
  },
): Promise<CanonicalAvailabilityClaimBuildHandoffResult> {
  await client.query(
    `INSERT INTO inventory.availability_claim_build_handoffs (
       claim_id, claim_operation_id, build_order_id, status,
       adopted_reservation_qty, created_by, created_at
     ) VALUES ($1, $2, $3, 'handed_off', $4, $5, $6)`,
    [
      input.claim.id.toString(),
      input.operation.id.toString(),
      input.buildOrderId,
      input.adoptedReservationQty.toString(),
      input.command.actor,
      input.occurredAt,
    ],
  );
  const operationUpdate = await client.query(
    `UPDATE inventory.availability_claim_operations
     SET status = 'executing', updated_at = $3
     WHERE id = $1 AND claim_id = $2 AND status IN ('pending', 'ready')
     RETURNING id`,
    [input.operation.id.toString(), input.claim.id.toString(), input.occurredAt],
  );
  if (operationUpdate.rowCount !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_STATE_CONFLICT",
      "The component-build operation changed before ownership could be handed off.",
      { claimId: input.claim.id.toString(), operationKey: input.operation.operationKey },
    );
  }
  const result = canonicalAvailabilityClaimBuildHandoffResultSchema.parse({
    outcome: "build_handed_off",
    claimId: input.claim.id.toString(),
    claimOperationId: input.operation.id.toString(),
    operationKey: input.operation.operationKey,
    buildOrderId: input.buildOrderId,
    buildSystemNumber: input.buildSystemNumber,
    adoptedReservationQty: input.adoptedReservationQty.toString(),
    idempotentReplay: false,
    ...(input.workTaskId ? { workTaskId: input.workTaskId } : {}),
  });
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key,
       request_hash, result_hash, request_payload, result_payload,
       actor, reason, occurred_at
     ) VALUES ($1, $2, 'handoff_build', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.claim.id.toString(),
      input.claim.orderId,
      input.command.idempotencyKey,
      input.requestHash,
      hash(result),
      JSON.stringify(input.command),
      JSON.stringify(result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const evidence = {
    eventType: "claim_build_handed_off",
    claimId: input.claim.id.toString(),
    claimOperationId: input.operation.id.toString(),
    operationKey: input.operation.operationKey,
    buildOrderId: input.buildOrderId,
    buildSystemNumber: input.buildSystemNumber,
    adoptedReservationQty: input.adoptedReservationQty.toString(),
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_build_handed_off', $2, 'executing', $3::jsonb, $4, $5, $6, $7)`,
    [
      input.claim.id.toString(),
      input.operation.status,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  return result;
}
