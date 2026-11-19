import type { PoolClient } from "pg";

import {
  canonicalAvailabilityClaimBuildHandoffCommandSchema,
  canonicalAvailabilityClaimOperationExecutionCommandSchema,
  type CanonicalAvailabilityClaimBuildHandoffCommand,
  type CanonicalAvailabilityClaimBuildHandoffResult,
  type CanonicalAvailabilityClaimOperationExecutionCommand,
  type CanonicalAvailabilityClaimOperationExecutionResult,
  type CanonicalAvailabilityClaimPickCommand,
} from "@shared/types/inventory-availability-claims";
import { BuildDomainError } from "../../../inventory/work-execution.api";
import { requireAssemblyOrderAuthority } from "../../../orders/assembly-order-authority.api";
import {
  isClaimPickRepackaging,
  selectClaimPickPackageConversions,
} from "../../domain/claim-pick-package-conversions";
import { readClaimPickPackagingPath } from "../claim-pick-packaging-path.reader";
import {
  assertOperationMatchesPlan,
  loadOperationExecutionResources,
  lockBuildOperation,
  lockHandedOffBuildOperation,
  lockPackageOperation,
  recordBuildHandoff,
  recordOperationExecution,
} from "./claim-operation-lineage";
import {
  loadActiveClaimById,
  loadClaimProductIds,
  loadOrder,
  lockGraphProducts,
  requireCanonicalAuthority,
  requirePickableLocation,
} from "./claim-order-and-locks";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  isRetryableTransactionError,
  loadBuildHandoffReplay,
  loadOperationExecutionReplay,
  MAX_COMMAND_REASON_LENGTH,
  MAX_GRAPH_PRODUCTS,
  MAX_SERIALIZATION_ATTEMPTS,
  openResourceQty,
  positiveBigInt,
  rollback,
  type ClaimRepositoryDependencies,
  type FulfillmentClaimLine,
  type PersistedClaim,
} from "./claim-primitives";

export async function executeHandoffBuildOperation(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimBuildHandoffCommand,
): Promise<CanonicalAvailabilityClaimBuildHandoffResult> {
  const command = canonicalAvailabilityClaimBuildHandoffCommandSchema.parse(rawCommand);
  if (command.work && !deps.workOwner) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ASSEMBLY_WORK_OWNER_UNAVAILABLE",
      "The warehouse work owner is not configured.",
    );
  }
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLOCK",
      "Canonical build-handoff clock returned an invalid time.",
    );
  }
  const claimId = positiveBigInt(command.claimId, "claim.id");

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const replay = await loadBuildHandoffReplay(client, command.idempotencyKey, requestHash);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await requireCanonicalAuthority(client);
      if (!deps.buildWriter) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_BUILD_HANDOFF_NOT_CONFIGURED",
          "The canonical build handoff port is not configured.",
        );
      }
      const preliminaryClaim = await loadActiveClaimById(client, claimId, false);
      if (!preliminaryClaim) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_NOT_FOUND",
          "The requested canonical claim is not active.",
          { claimId: claimId.toString() },
        );
      }
      const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
      if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_MODEL_EVIDENCE",
          "The active claim does not contain a bounded model-evidence graph.",
          { claimId: claimId.toString(), productCount: graphProductIds.length },
        );
      }
      await lockGraphProducts(client, graphProductIds);
      const order = await loadOrder(client, preliminaryClaim.orderId, true);
      if (["cancelled", "shipped"].includes(order.warehouseStatus)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_ORDER_NOT_EXECUTABLE",
          "A cancelled or shipped order cannot hand off a claim build.",
          { claimId: claimId.toString(), orderId: order.orderId, warehouseStatus: order.warehouseStatus },
        );
      }
      const claim = await loadActiveClaimById(client, claimId, true);
      if (!claim || claim.id !== preliminaryClaim.id || claim.orderId !== preliminaryClaim.orderId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while build-handoff locks were being acquired.",
          { claimId: claimId.toString() },
        );
      }
      const operation = await lockBuildOperation(client, claim.id, command.operationKey);
      if (command.work) await requireAssemblyOrderAuthority(client, {
        orderId: claim.orderId, orderItemId: operation.orderItemId, actorId: command.actor, action: "handoff",
      });
      const plannedOperation = assertOperationMatchesPlan(claim, operation);
      const resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
      const handoff = await deps.buildWriter.handoffOperation({
        client,
        claimId: claim.id,
        claimOperationId: operation.id,
        operationKey: operation.operationKey,
        transformationRecipeBindingId: operation.authorityId,
        warehouseId: operation.warehouseId,
        plannedBuilds: operation.plannedExecutions,
        destinationVariantId: operation.destinationVariantId,
        outputLocationId: operation.outputLocationId,
        outputQty: operation.outputQty,
        inputs: plannedOperation.inputs.map((input) => ({
          sourceVariantId: input.sourceVariantId,
          requiredQty: positiveBigInt(input.requiredQty, "plannedOperation.input.requiredQty"),
        })),
        resources,
        actor: command.actor,
        occurredAt,
      });
      const workTask = command.work ? await deps.workOwner!.handoff(client, {
        warehouseId: operation.warehouseId, claimId: claim.id.toString(), claimOperationId: operation.id.toString(),
        operationKey: operation.operationKey, orderId: claim.orderId, orderItemId: operation.orderItemId,
        buildOrderId: handoff.buildOrderId, buildSystemNumber: handoff.buildSystemNumber,
        destinationVariantId: operation.destinationVariantId, outputQty: operation.outputQty.toString(),
        outputLocationId: operation.outputLocationId,
        inputs: plannedOperation.inputs.map((input) => ({ variantId: input.sourceVariantId, quantity: input.requiredQty })),
        sourceLocationIds: resources.map((resource) => resource.warehouseLocationId), route: command.work,
        actorId: command.actor, reason: command.reason, commandKey: `handoff:${command.idempotencyKey}`,
        requestHash, occurredAt: occurredAt.toISOString(),
      }) : null;
      const result = await recordBuildHandoff(client, {
        claim,
        operation,
        command,
        requestHash,
        buildOrderId: handoff.buildOrderId,
        buildSystemNumber: handoff.buildSystemNumber,
        adoptedReservationQty: handoff.adoptedReservationQty,
        occurredAt,
        ...(workTask ? { workTaskId: workTask.id } : {}),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await rollback(client, error);
      } catch (rolledBackError) {
        if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
          lastRetryableError = rolledBackError;
          continue;
        }
        if (isRetryableTransactionError(rolledBackError)) {
          lastRetryableError = rolledBackError;
          break;
        }
        throw rolledBackError;
      }
    } finally {
      client.release();
    }
  }
  throw new InventoryAvailabilityClaimRepositoryError(
    "CLAIM_BUILD_HANDOFF_RETRY_EXHAUSTED",
    "Canonical build handoff could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}

export async function executeBuildClaimOperation(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimOperationExecutionCommand,
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  const command = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse(rawCommand);
  if (command.work && !deps.workOwner) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ASSEMBLY_WORK_OWNER_UNAVAILABLE",
      "The warehouse work owner is not configured.",
    );
  }
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLOCK",
      "Canonical build-execution clock returned an invalid time.",
    );
  }
  const claimId = positiveBigInt(command.claimId, "claim.id");

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await deps.lockCostGraph(client);
      const replay = await loadOperationExecutionReplay(
        client,
        command.idempotencyKey,
        requestHash,
        "execute_build",
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await requireCanonicalAuthority(client);
      if (!deps.buildWriter) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_BUILD_EXECUTION_NOT_CONFIGURED",
          "The canonical build execution port is not configured.",
        );
      }
      const preliminaryClaim = await loadActiveClaimById(client, claimId, false);
      if (!preliminaryClaim) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_NOT_FOUND",
          "The requested canonical claim is not active.",
          { claimId: claimId.toString() },
        );
      }
      const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
      if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_MODEL_EVIDENCE",
          "The active claim does not contain a bounded model-evidence graph.",
          { claimId: claimId.toString(), productCount: graphProductIds.length },
        );
      }
      await lockGraphProducts(client, graphProductIds);
      const order = await loadOrder(client, preliminaryClaim.orderId, true);
      if (["cancelled", "shipped"].includes(order.warehouseStatus)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_ORDER_NOT_EXECUTABLE",
          "A cancelled or shipped order cannot execute a claim build.",
          { claimId: claimId.toString(), orderId: order.orderId, warehouseStatus: order.warehouseStatus },
        );
      }
      const claim = await loadActiveClaimById(client, claimId, true);
      if (!claim || claim.id !== preliminaryClaim.id || claim.orderId !== preliminaryClaim.orderId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while build-execution locks were being acquired.",
          { claimId: claimId.toString() },
        );
      }
      const locked = await lockHandedOffBuildOperation(client, claim.id, command.operationKey);
      if (command.work) await requireAssemblyOrderAuthority(client, {
        orderId: claim.orderId, orderItemId: locked.operation.orderItemId, actorId: command.actor, action: "complete",
      });
      const plannedOperation = assertOperationMatchesPlan(claim, locked.operation);
      const resources = await loadOperationExecutionResources(
        client,
        claim.id,
        locked.operation,
        plannedOperation,
      );
      const execution = await deps.buildWriter.executeOperation({
        client,
        claimId: claim.id,
        claimOperationId: locked.operation.id,
        operationKey: locked.operation.operationKey,
        buildOrderId: locked.handoff.buildOrderId,
        warehouseId: locked.operation.warehouseId,
        plannedBuilds: locked.operation.plannedExecutions,
        destinationVariantId: locked.operation.destinationVariantId,
        outputLocationId: locked.operation.outputLocationId,
        outputQty: locked.operation.outputQty,
        committedOutputQty: locked.operation.committedOutputQty,
        inputs: plannedOperation.inputs.map((entry) => ({
          sourceVariantId: entry.sourceVariantId,
          requiredQty: positiveBigInt(entry.requiredQty, "plannedOperation.input.requiredQty"),
        })),
        resources,
        orderId: claim.orderId,
        orderItemId: locked.operation.orderItemId,
        actor: command.actor,
        reason: command.reason,
        occurredAt,
      });
      // Validate the worker fence and commit task evidence AFTER all owning
      // inventory/cost locks. Any rejection rolls the entire posting back.
      await deps.workOwner?.recordCompletion(client, {
        claimOperationId: locked.operation.id.toString(), producedQty: locked.operation.outputQty.toString(),
        fence: command.work, actorId: command.actor, reason: command.reason,
        commandKey: `complete:${command.idempotencyKey}`, requestHash, occurredAt: occurredAt.toISOString(),
      });
      const result = await recordOperationExecution(client, {
        claim,
        operation: locked.operation,
        resources,
        command,
        requestHash,
        outputInventoryLevelId: execution.outputInventoryLevelId,
        committedLotAllocations: execution.committedLotAllocations,
        totalInputCostMills: execution.totalInputCostMills,
        occurredAt,
        commandType: "execute_build",
        eventType: "claim_build_executed",
        buildHandoffId: locked.handoff.id,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await rollback(client, error);
      } catch (rolledBackError) {
        if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
          lastRetryableError = rolledBackError;
          continue;
        }
        if (isRetryableTransactionError(rolledBackError)) {
          lastRetryableError = rolledBackError;
          break;
        }
        throw rolledBackError;
      }
    } finally {
      client.release();
    }
  }
  throw new InventoryAvailabilityClaimRepositoryError(
    "CLAIM_BUILD_EXECUTION_RETRY_EXHAUSTED",
    "Canonical build execution could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}

/**
 * Auto-assembly at pick. Runs on the pick's client, after the pick took the
 * cost-graph, product, order and claim locks, so the build and the pick commit
 * or roll back together.
 *
 * The canonical build writer genuinely requires a build order with adopted lot
 * reservations (inventory.build_orders / build_component_reservations) and an
 * availability_claim_build_handoffs row: executeOperation authorizes the build
 * through that row, and consumption/cost evidence is recorded against the
 * build order's components. Rather than weakening those integrity fences, the
 * hand-off is created inline here as a SYSTEM record (the pick command's
 * actor, no work task, no station, no assignment) and executed immediately in
 * the same transaction, so it is never visible as open work.
 *
 * Idempotency: both receipts derive from the pick idempotency key + operation
 * key (`pick-build-handoff:` / `pick-build:`). A replayed pick returns its
 * stored receipt before reaching here; a new pick finds the operation
 * `completed` and never selects it; and the build writer's deterministic
 * build-order/run keys (`claim-build:{claim}:{operation}`) make a second
 * physical build structurally impossible.
 */
async function executeLockedPickBuildOperation(
  deps: ClaimRepositoryDependencies,
  client: PoolClient,
  claim: PersistedClaim,
  operationKey: string,
  pickOperationIdentity: string,
  pick: CanonicalAvailabilityClaimPickCommand,
  occurredAt: Date,
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  if (!deps.buildWriter) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_EXECUTION_NOT_CONFIGURED",
      "The canonical build execution port is not configured.",
    );
  }
  const audit = {
    claimId: claim.id.toString(),
    operationKey,
    actor: pick.actor,
    reason: `Auto-assembly at pick: ${pick.reason}`.slice(0, MAX_COMMAND_REASON_LENGTH),
  };
  const handoffCommand = canonicalAvailabilityClaimBuildHandoffCommandSchema.parse({
    ...audit, idempotencyKey: `pick-build-handoff:${pickOperationIdentity}`,
  });
  const executionCommand = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse({
    ...audit, idempotencyKey: `pick-build:${pickOperationIdentity}`,
  });
  try {
    const operation = await lockBuildOperation(client, claim.id, operationKey);
    const plannedOperation = assertOperationMatchesPlan(claim, operation);
    const resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
    const inputs = plannedOperation.inputs.map((input) => ({
      sourceVariantId: input.sourceVariantId,
      requiredQty: positiveBigInt(input.requiredQty, "plannedOperation.input.requiredQty"),
    }));
    const handoff = await deps.buildWriter.handoffOperation({
      client,
      claimId: claim.id,
      claimOperationId: operation.id,
      operationKey: operation.operationKey,
      transformationRecipeBindingId: operation.authorityId,
      warehouseId: operation.warehouseId,
      plannedBuilds: operation.plannedExecutions,
      destinationVariantId: operation.destinationVariantId,
      outputLocationId: operation.outputLocationId,
      outputQty: operation.outputQty,
      inputs,
      resources,
      actor: audit.actor,
      occurredAt,
    });
    await recordBuildHandoff(client, {
      claim,
      operation,
      command: handoffCommand,
      requestHash: hash(handoffCommand),
      buildOrderId: handoff.buildOrderId,
      buildSystemNumber: handoff.buildSystemNumber,
      adoptedReservationQty: handoff.adoptedReservationQty,
      occurredAt,
    });
    const locked = await lockHandedOffBuildOperation(client, claim.id, operationKey);
    if (locked.handoff.buildOrderId !== handoff.buildOrderId) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_BUILD_HANDOFF_MISMATCH",
        "The inline build hand-off does not match the build order it created.",
        { claimId: audit.claimId, operationKey, buildOrderId: handoff.buildOrderId },
      );
    }
    // The hand-off only adopts reservations into build tables; it does not
    // touch claim resources, so the exact resources loaded above still apply.
    const execution = await deps.buildWriter.executeOperation({
      client,
      claimId: claim.id,
      claimOperationId: locked.operation.id,
      operationKey: locked.operation.operationKey,
      buildOrderId: locked.handoff.buildOrderId,
      warehouseId: locked.operation.warehouseId,
      plannedBuilds: locked.operation.plannedExecutions,
      destinationVariantId: locked.operation.destinationVariantId,
      outputLocationId: locked.operation.outputLocationId,
      outputQty: locked.operation.outputQty,
      committedOutputQty: locked.operation.committedOutputQty,
      inputs,
      resources,
      orderId: claim.orderId,
      orderItemId: locked.operation.orderItemId,
      actor: audit.actor,
      reason: audit.reason,
      occurredAt,
    });
    return await recordOperationExecution(client, {
      claim,
      operation: locked.operation,
      resources,
      command: executionCommand,
      requestHash: hash(executionCommand),
      outputInventoryLevelId: execution.outputInventoryLevelId,
      committedLotAllocations: execution.committedLotAllocations,
      totalInputCostMills: execution.totalInputCostMills,
      occurredAt,
      commandType: "execute_build",
      eventType: "claim_build_executed",
      buildHandoffId: locked.handoff.id,
    });
  } catch (error) {
    // Build-owner rejections (component lot/level shortfall, recipe or cost
    // drift) are permanent for this pick: retrying cannot change them. Give
    // the picker one clear structured code; the caller's rollback discards
    // every posting this pick made, including earlier builds in the graph.
    if (error instanceof BuildDomainError) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_AUTO_ASSEMBLY_FAILED",
        `Automatic assembly could not run, so nothing was picked: ${error.message}`,
        { claimId: audit.claimId, operationKey, buildErrorCode: error.code, buildErrorContext: error.context },
        { cause: error },
      );
    }
    throw error;
  }
}

async function executeLockedPackageOperation(
  deps: ClaimRepositoryDependencies,
  client: PoolClient,
  claim: PersistedClaim,
  command: CanonicalAvailabilityClaimOperationExecutionCommand,
  occurredAt: Date,
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  const operation = await lockPackageOperation(client, claim.id, command.operationKey);
  const plannedOperation = assertOperationMatchesPlan(claim, operation);
  const resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
  const execution = await deps.inventoryWriter.executePackageOperation({
    client, claimId: claim.id, claimOperationId: operation.id,
    operationKey: operation.operationKey, operationType: operation.operationType, resources,
    destinationVariantId: operation.destinationVariantId, outputLocationId: operation.outputLocationId,
    outputQty: operation.outputQty, committedOutputQty: operation.committedOutputQty,
    orderId: claim.orderId, orderItemId: operation.orderItemId,
    actor: command.actor, reason: command.reason, occurredAt,
  });
  return recordOperationExecution(client, {
    claim, operation, resources, command, requestHash: hash(command),
    outputInventoryLevelId: execution.outputInventoryLevelId,
    committedLotAllocations: execution.committedLotAllocations,
    totalInputCostMills: execution.totalInputCostMills, occurredAt,
    commandType: "execute", eventType: "claim_operation_executed",
  });
}

/**
 * Called only after order/correction/claim locks and custody validation.
 * Conversion receipts, component builds, exact lots, surplus, pick and WMS
 * progress share the caller's transaction. No partial conversion or build can
 * survive a rejected pick: a component shortfall or any failed fence rolls the
 * whole pick back with zero postings.
 */
export async function materializePickPackageConversions(
  deps: ClaimRepositoryDependencies,
  client: PoolClient,
  claim: PersistedClaim,
  line: FulfillmentClaimLine,
  command: CanonicalAvailabilityClaimPickCommand,
  quantity: bigint,
  warehouseId: number,
  occurredAt: Date,
): Promise<boolean> {
  const readyQty = line.resources.filter((resource) => resource.warehouseId === warehouseId)
    .reduce((total, resource) => total + openResourceQty(resource), BigInt(0));
  if (readyQty >= quantity || !claim.plan.operations.some((operation) =>
    operation.lineKey === `order-item:${line.orderItemId}`)) return false;
  const stateRows = await client.query<{ operation_key: string; status: string }>(
    `SELECT operation_key, status FROM inventory.availability_claim_operations
     WHERE claim_id = $1 AND claim_line_id = $2 ORDER BY operation_key FOR UPDATE`,
    [claim.id.toString(), line.id.toString()],
  );
  const operations = selectClaimPickPackageConversions({
    operations: claim.plan.operations,
    states: new Map(stateRows.rows.map((row) => [row.operation_key, row.status])),
    orderItemId: line.orderItemId,
    targetVariantId: line.targetVariantId,
    warehouseId,
    locationId: command.warehouseLocationId,
    readyQty,
    pickQty: quantity,
  });
  // Owner decisions: an assembled SKU assembles at pick (2026-10-18, #64366),
  // and a promised order's pack breakdown happens at pick (2026-10-21,
  // #64353). Replenishment mode (queue/hybrid/inline) governs routine bin
  // refills only; applied here it made a reserved order unpickable with no
  // task for anyone to do. Recipe authority / same-product proof is kept.
  for (const operation of operations) {
    const pickOperationIdentity = hash({ pick: command.idempotencyKey, operation: operation.operationKey });
    if (operation.operationType === "component_build") {
      await requirePickableLocation(client, operation.outputLocationId!, warehouseId);
      await executeLockedPickBuildOperation(
        deps,
        client,
        claim,
        operation.operationKey,
        pickOperationIdentity,
        command,
        occurredAt,
      );
      continue;
    }
    if (operation.operationType !== "break_pack"
      && !isClaimPickRepackaging(operation, await readClaimPickPackagingPath(client, operation.authorityId))) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_OPERATION_REQUIRES_WORK",
        "This transformation requires explicit warehouse work; it is not same-product package conversion.",
        { claimId: claim.id.toString(), operationKey: operation.operationKey },
      );
    }
    await requirePickableLocation(client, operation.outputLocationId!, warehouseId);
    const executionCommand = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse({
      claimId: claim.id.toString(),
      operationKey: operation.operationKey,
      // Preserve existing case-break receipt identities across deployment.
      idempotencyKey: `${operation.operationType === "break_pack" ? "pick-case-break" : "pick-package-conversion"}:${pickOperationIdentity}`,
      actor: command.actor,
      reason: command.reason,
    });
    await executeLockedPackageOperation(deps, client, claim, executionCommand, occurredAt);
  }
  return operations.length > 0;
}

export async function executePackageClaimOperation(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimOperationExecutionCommand,
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  const command = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse(rawCommand);
  if (command.work) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ASSEMBLY_WORK_NOT_PACKAGE_EXECUTION",
      "Assembly work fences cannot execute package conversions.",
    );
  }
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLOCK",
      "Canonical operation clock returned an invalid time.",
    );
  }
  const claimId = positiveBigInt(command.claimId, "claim.id");

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await deps.lockCostGraph(client);
      const replay = await loadOperationExecutionReplay(
        client,
        command.idempotencyKey,
        requestHash,
        "execute",
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await requireCanonicalAuthority(client);
      const preliminaryClaim = await loadActiveClaimById(client, claimId, false);
      if (!preliminaryClaim) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_NOT_FOUND",
          "The requested canonical claim is not active.",
          { claimId: claimId.toString() },
        );
      }
      const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
      if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_MODEL_EVIDENCE",
          "The active claim does not contain a bounded model-evidence graph.",
          { claimId: claimId.toString(), productCount: graphProductIds.length },
        );
      }
      await lockGraphProducts(client, graphProductIds);
      const order = await loadOrder(client, preliminaryClaim.orderId, true);
      if (["cancelled", "shipped"].includes(order.warehouseStatus)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_ORDER_NOT_EXECUTABLE",
          "A cancelled or shipped order cannot execute a claim transformation.",
          { claimId: claimId.toString(), orderId: order.orderId, warehouseStatus: order.warehouseStatus },
        );
      }
      const claim = await loadActiveClaimById(client, claimId, true);
      if (!claim || claim.id !== preliminaryClaim.id || claim.orderId !== preliminaryClaim.orderId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while operation locks were being acquired.",
          { claimId: claimId.toString() },
        );
      }
      const result = await executeLockedPackageOperation(deps, client, claim, command, occurredAt);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await rollback(client, error);
      } catch (rolledBackError) {
        if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
          lastRetryableError = rolledBackError;
          continue;
        }
        if (isRetryableTransactionError(rolledBackError)) {
          lastRetryableError = rolledBackError;
          break;
        }
        throw rolledBackError;
      }
    } finally {
      client.release();
    }
  }
  throw new InventoryAvailabilityClaimRepositoryError(
    "CLAIM_TRANSACTION_RETRY_EXHAUSTED",
    "Canonical operation execution could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}
