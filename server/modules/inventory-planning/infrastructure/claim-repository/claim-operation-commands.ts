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
  positiveInteger,
  rollback,
  rows,
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

async function rebindPackageOperationInputSourceIfRequested(
  deps: ClaimRepositoryDependencies,
  client: PoolClient,
  claim: PersistedClaim,
  operation: Awaited<ReturnType<typeof lockPackageOperation>>,
  resources: Awaited<ReturnType<typeof loadOperationExecutionResources>>,
  preferredLocationId: number | undefined,
  commandKey: string,
  actor: string,
  reason: string,
  occurredAt: Date,
): Promise<boolean> {
  if (
    preferredLocationId == null ||
    resources.length !== 1 ||
    resources[0].warehouseLocationId === preferredLocationId
  ) {
    return false;
  }
  const source = resources[0];
  const targetRow = rows(await client.query(
    `SELECT level.id AS inventory_level_id, level.variant_qty, level.reserved_qty
     FROM warehouse.warehouse_locations AS location
     JOIN inventory.inventory_levels AS level
       ON level.warehouse_location_id = location.id
      AND level.product_variant_id = $2
     WHERE location.id = $1
       AND location.warehouse_id = $3
       AND location.is_active = 1
       AND location.cycle_count_freeze_id IS NULL
     FOR UPDATE OF level`,
    [preferredLocationId, source.sourceVariantId, operation.warehouseId],
  ))[0];
  if (!targetRow || targetRow.inventory_level_id == null) return false;
  const freeQty = BigInt(Number(targetRow.variant_qty)) - BigInt(Number(targetRow.reserved_qty));
  if (freeQty < source.consumeQty) return false;

  const targetLevelId = positiveInteger(targetRow.inventory_level_id, "targetInventoryLevel.id");
  await deps.inventoryWriter.releaseResources({
    client,
    commandKey: `${commandKey}:source-rebind-release`,
    claimId: claim.id,
    resources: [{
      claimResourceId: source.claimResourceId,
      inventoryLevelId: source.inventoryLevelId,
      warehouseLocationId: source.warehouseLocationId,
      sourceVariantId: source.sourceVariantId,
      releaseQty: source.consumeQty,
      lotAllocations: source.lotAllocations.map((lot) => ({
        inventoryLotId: lot.inventoryLotId,
        releaseQty: lot.consumeQty,
      })),
      orderItemId: operation.orderItemId,
    }],
    orderId: claim.orderId,
    actor,
    reason,
    occurredAt,
  });

  for (const lot of source.lotAllocations) {
    await client.query(
      `UPDATE inventory.availability_claim_lot_allocations
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2`,
      [lot.consumeQty.toString(), lot.claimLotAllocationId.toString(), occurredAt],
    );
  }
  await client.query(
    `UPDATE inventory.availability_claim_resources
     SET released_qty = released_qty + $1, updated_at = $3
     WHERE id = $2`,
    [source.consumeQty.toString(), source.claimResourceId.toString(), occurredAt],
  );

  const newResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8)
     ON CONFLICT (
       claim_line_id, warehouse_id, warehouse_location_id, inventory_level_id,
       source_variant_id, COALESCE(consumer_operation_key, ''), COALESCE(producer_operation_key, '')
     ) DO UPDATE
       SET claimed_qty = inventory.availability_claim_resources.claimed_qty + EXCLUDED.claimed_qty,
           updated_at = $9
     RETURNING id`,
    [
      claim.id.toString(),
      operation.claimLineId.toString(),
      operation.operationKey,
      operation.warehouseId,
      preferredLocationId,
      targetLevelId,
      source.sourceVariantId,
      source.consumeQty.toString(),
      occurredAt,
    ],
  ))[0];
  const newClaimResourceId = positiveBigInt(newResourceRow?.id, "newClaimResource.id");

  const reservedLots = await deps.inventoryWriter.reserveResource({
    client,
    commandKey: `${commandKey}:source-rebind-reserve`,
    claimId: claim.id,
    claimResourceId: newClaimResourceId,
    inventoryLevelId: targetLevelId,
    warehouseLocationId: preferredLocationId,
    sourceVariantId: source.sourceVariantId,
    claimedQty: Number(source.consumeQty),
    orderId: claim.orderId,
    orderItemId: operation.orderItemId,
    consumerOperationKey: operation.operationKey,
    actor,
    occurredAt,
  });

  for (const allocation of reservedLots) {
    await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_resource_id, inventory_lot_id) DO UPDATE
         SET claimed_qty = inventory.availability_claim_lot_allocations.claimed_qty + EXCLUDED.claimed_qty,
             updated_at = $9`,
      [
        claim.id.toString(),
        newClaimResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
        occurredAt,
      ],
    );
  }
  return true;
}

async function executeLockedPackageOperation(
  deps: ClaimRepositoryDependencies,
  client: PoolClient,
  claim: PersistedClaim,
  command: CanonicalAvailabilityClaimOperationExecutionCommand,
  occurredAt: Date,
  preferredSourceLocationId?: number,
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  const operation = await lockPackageOperation(client, claim.id, command.operationKey);
  const plannedOperation = assertOperationMatchesPlan(claim, operation);
  let resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
  if (await rebindPackageOperationInputSourceIfRequested(
    deps,
    client,
    claim,
    operation,
    resources,
    preferredSourceLocationId,
    command.idempotencyKey,
    command.actor,
    command.reason,
    occurredAt,
  )) {
    resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
  }
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
  // Owner decision (2026-10-18, #64366): an assembled SKU assembles at pick.
  // A graph that contains a component build has no stocked intermediate to
  // queue replenishment against, so its package conversions run inline too.
  // Their recipe authority / same-product proof below is never skipped.
  const assemblesAtPick = operations.some((operation) => operation.operationType === "component_build");
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
    if (!assemblesAtPick && !await deps.isPackageConversionInline(client, {
      destinationVariantId: operation.destinationVariantId,
      warehouseId: operation.warehouseId,
      outputQty: BigInt(operation.outputQty),
      method: operation.operationType === "break_pack" ? "case_break" : "package_conversion",
    })) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_REPLENISHMENT_REQUIRED",
        "This package conversion is configured for queued warehouse work, not inline picking.",
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
    await executeLockedPackageOperation(
      deps,
      client,
      claim,
      executionCommand,
      occurredAt,
      command.preferredConversionSourceLocationId,
    );
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
      const result = await executeLockedPackageOperation(
        deps,
        client,
        claim,
        command,
        occurredAt,
        command.preferredSourceLocationId,
      );
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
