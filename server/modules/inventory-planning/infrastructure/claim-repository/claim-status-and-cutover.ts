import type { PoolClient } from "pg";

import {
  canonicalAvailabilityReservationStatusCommandSchema,
  canonicalAvailabilityReservationStatusProjectionSchema,
  type CanonicalAvailabilityReservationStatusCommand,
  type CanonicalAvailabilityReservationStatusProjection,
} from "@shared/types/inventory-availability-claims";
import type {
  CutoverReconstructionCommit,
  CutoverReconstructionCost,
} from "@shared/types/inventory-cutover-reconstruction";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { CanonicalClaimInventoryMutationPort } from "../../application/canonical-claim-inventory.port";
import type { PlannedCutoverOrder } from "../../domain/inventory-cutover-reconstruction-planning";
import {
  loadActiveClaim,
  loadOrder,
  nextClaimRevision,
  orderDemandMatchesClaim,
  requireCanonicalAuthority,
} from "./claim-order-and-locks";
import {
  insertClaimHeader,
  insertClaimLines,
  insertClaimOperations,
} from "./claim-persistence";
import {
  databaseText,
  hash,
  InventoryAvailabilityClaimRepositoryError,
  nonnegativeBigInt,
  positiveBigInt,
  positiveInteger,
  rollback,
  rows,
  type ClaimRepositoryDependencies,
  type LockedOrder,
  type PersistedClaim,
} from "./claim-primitives";

type ReservationStatusClaim = NonNullable<CanonicalAvailabilityReservationStatusProjection["claim"]>;
type ReservationStatusLine = ReservationStatusClaim["lines"][number];
type ReservationStatusOperation = ReservationStatusLine["operations"][number];
type ReservationStatusResource = ReservationStatusLine["resources"][number];

function assertStatusLineage(
  condition: boolean,
  message: string,
  context: Readonly<Record<string, unknown>>,
): asserts condition {
  if (condition) return;
  throw new InventoryAvailabilityClaimRepositoryError(
    "CLAIM_STATUS_LINEAGE_MISMATCH",
    message,
    context,
  );
}

async function buildReservationStatusClaim(
  client: PoolClient,
  claim: PersistedClaim,
): Promise<ReservationStatusClaim> {
  assertStatusLineage(
    claim.plan.status === "satisfied" || claim.plan.status === "partial",
    "An active claim has an invalid planner status.",
    { claimId: claim.id.toString(), planStatus: claim.plan.status },
  );
  const headerRow = rows(await client.query(
    `SELECT activation_run_id, plan_status, scope_kind, scope_warehouse_id,
            snapshot_fingerprint
     FROM inventory.availability_claims
     WHERE id = $1 AND status = 'active'`,
    [claim.id.toString()],
  ))[0];
  assertStatusLineage(
    headerRow != null,
    "The active canonical claim disappeared inside the status snapshot.",
    { claimId: claim.id.toString() },
  );
  const activationRunId = positiveBigInt(headerRow.activation_run_id, "claim.activationRunId");
  const scopeKind = databaseText(headerRow.scope_kind, "claim.scopeKind", 20);
  const scopeWarehouseId = headerRow.scope_warehouse_id == null
    ? null
    : positiveInteger(headerRow.scope_warehouse_id, "claim.scopeWarehouseId");
  const persistedScope = scopeKind === "network"
    ? { kind: "network" as const }
    : scopeKind === "warehouse" && scopeWarehouseId != null
      ? { kind: "warehouse" as const, warehouseId: scopeWarehouseId }
      : null;
  assertStatusLineage(
    claim.claimKey === claim.plan.requestKey
      && String(headerRow.plan_status) === claim.plan.status
      && canonicalJson(persistedScope) === canonicalJson(claim.plan.scope)
      && String(headerRow.snapshot_fingerprint) === claim.plan.snapshotFingerprint,
    "The canonical claim header does not reconcile to its hashed planner payload.",
    { claimId: claim.id.toString() },
  );
  const lineRows = await client.query(
    `SELECT line.id, line.line_key, line.order_item_id, item.sku,
            line.target_variant_id, line.requested_qty, line.planned_qty,
            line.shortfall_qty, line.released_target_qty,
            line.consumed_target_qty, line.picked_target_qty
     FROM inventory.availability_claim_lines AS line
     JOIN wms.order_items AS item ON item.id = line.order_item_id
     WHERE line.claim_id = $1
     ORDER BY line.line_key, line.id`,
    [claim.id.toString()],
  );
  const operationRows = await client.query(
    `SELECT operation.id, operation.claim_line_id, operation.operation_key,
            operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id,
            operation.destination_variant_id, operation.planned_executions,
            operation.executed_executions, operation.released_executions,
            operation.output_qty, operation.committed_output_qty,
            operation.output_location_id, operation.status,
            handoff.id AS handoff_id, handoff.build_order_id,
            build_order.system_number AS build_system_number,
            handoff.status AS handoff_status, handoff.adopted_reservation_qty
     FROM inventory.availability_claim_operations AS operation
     LEFT JOIN inventory.availability_claim_build_handoffs AS handoff
       ON handoff.claim_id = operation.claim_id
      AND handoff.claim_operation_id = operation.id
     LEFT JOIN inventory.build_orders AS build_order ON build_order.id = handoff.build_order_id
     WHERE operation.claim_id = $1
     ORDER BY operation.operation_key, operation.id`,
    [claim.id.toString()],
  );
  const inputRows = await client.query(
    `SELECT input.claim_operation_id, input.source_variant_id,
            input.required_qty, input.input_ordinal
     FROM inventory.availability_claim_operation_inputs AS input
     WHERE input.claim_id = $1
     ORDER BY input.claim_operation_id, input.input_ordinal`,
    [claim.id.toString()],
  );
  const resourceRows = await client.query(
    `SELECT resource.id, resource.claim_line_id,
            resource.consumer_operation_key, resource.producer_operation_key,
            resource.warehouse_id, resource.warehouse_location_id,
            resource.inventory_level_id, resource.source_variant_id,
            resource.claimed_qty, resource.released_qty,
            resource.consumed_qty, resource.picked_qty
     FROM inventory.availability_claim_resources AS resource
     WHERE resource.claim_id = $1
     ORDER BY resource.claim_line_id, resource.warehouse_id,
              resource.warehouse_location_id, resource.inventory_level_id,
              resource.source_variant_id, resource.id`,
    [claim.id.toString()],
  );

  const persistedLines = rows(lineRows);
  const planLineByKey = new Map(claim.plan.lines.map((line) => [line.lineKey, line] as const));
  assertStatusLineage(
    persistedLines.length === planLineByKey.size,
    "Canonical status lines do not match the hashed planner payload.",
    { claimId: claim.id.toString(), planLineCount: planLineByKey.size, persistedLineCount: persistedLines.length },
  );

  const lineKeyById = new Map<string, string>();
  const lineBaseById = new Map<string, Omit<ReservationStatusLine, "resources" | "operations">>();
  for (const row of persistedLines) {
    const claimLineId = positiveBigInt(row.id, "claimLine.id").toString();
    const lineKey = databaseText(row.line_key, "claimLine.lineKey", 200);
    const orderItemId = positiveInteger(row.order_item_id, "claimLine.orderItemId");
    const targetVariantId = positiveInteger(row.target_variant_id, "claimLine.targetVariantId");
    const requestedQty = positiveBigInt(row.requested_qty, "claimLine.requestedQty");
    const plannedQty = nonnegativeBigInt(row.planned_qty, "claimLine.plannedQty");
    const shortfallQty = nonnegativeBigInt(row.shortfall_qty, "claimLine.shortfallQty");
    const releasedTargetQty = nonnegativeBigInt(row.released_target_qty, "claimLine.releasedTargetQty");
    const consumedTargetQty = nonnegativeBigInt(row.consumed_target_qty, "claimLine.consumedTargetQty");
    const pickedTargetQty = nonnegativeBigInt(row.picked_target_qty, "claimLine.pickedTargetQty");
    const planLine = planLineByKey.get(lineKey);
    assertStatusLineage(
      planLine != null
        && lineKey === `order-item:${orderItemId}`
        && planLine.targetVariantId === targetVariantId
        && BigInt(planLine.requestedQty) === requestedQty
        && BigInt(planLine.plannedQty) === plannedQty
        && BigInt(planLine.shortfallQty) === shortfallQty
        && requestedQty === plannedQty + shortfallQty
        && releasedTargetQty + consumedTargetQty + pickedTargetQty <= plannedQty,
      "A canonical status line does not reconcile to its hashed planner line.",
      { claimId: claim.id.toString(), claimLineId, lineKey },
    );
    assertStatusLineage(
      !lineKeyById.has(claimLineId),
      "Canonical status contains a duplicate claim-line identity.",
      { claimId: claim.id.toString(), claimLineId },
    );
    lineKeyById.set(claimLineId, lineKey);
    lineBaseById.set(claimLineId, {
      claimLineId,
      lineKey,
      orderItemId,
      sku: databaseText(row.sku, "claimLine.sku", 100),
      targetVariantId,
      requestedQty: requestedQty.toString(),
      plannedQty: plannedQty.toString(),
      shortfallQty: shortfallQty.toString(),
      releasedTargetQty: releasedTargetQty.toString(),
      consumedTargetQty: consumedTargetQty.toString(),
      pickedTargetQty: pickedTargetQty.toString(),
      openPlannedQty: (plannedQty - releasedTargetQty - consumedTargetQty - pickedTargetQty).toString(),
    });
  }

  const inputsByOperationId = new Map<string, ReservationStatusOperation["inputs"]>();
  for (const row of rows(inputRows)) {
    const operationId = positiveBigInt(row.claim_operation_id, "claimOperationInput.claimOperationId").toString();
    const input = {
      sourceVariantId: positiveInteger(row.source_variant_id, "claimOperationInput.sourceVariantId"),
      requiredQty: positiveBigInt(row.required_qty, "claimOperationInput.requiredQty").toString(),
    };
    const existing = inputsByOperationId.get(operationId) ?? [];
    existing.push(input);
    inputsByOperationId.set(operationId, existing);
  }

  const planOperationByKey = new Map(claim.plan.operations.map((operation) => [operation.operationKey, operation] as const));
  const operationsByLineId = new Map<string, ReservationStatusOperation[]>();
  const operationByKey = new Map<string, ReservationStatusOperation & { claimLineId: string }>();
  const persistedOperationIds = new Set<string>();
  for (const row of rows(operationRows)) {
    const claimOperationId = positiveBigInt(row.id, "claimOperation.id").toString();
    const claimLineId = positiveBigInt(row.claim_line_id, "claimOperation.claimLineId").toString();
    const lineKey = lineKeyById.get(claimLineId);
    const operationKey = databaseText(row.operation_key, "claimOperation.operationKey", 300);
    const planOperation = planOperationByKey.get(operationKey);
    const plannedExecutions = positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions");
    const executedExecutions = nonnegativeBigInt(row.executed_executions, "claimOperation.executedExecutions");
    const releasedExecutions = nonnegativeBigInt(row.released_executions, "claimOperation.releasedExecutions");
    const outputQty = positiveBigInt(row.output_qty, "claimOperation.outputQty");
    const committedOutputQty = positiveBigInt(
      row.committed_output_qty,
      "claimOperation.committedOutputQty",
    );
    const parentOperationKey = row.parent_operation_key == null
      ? null
      : databaseText(row.parent_operation_key, "claimOperation.parentOperationKey", 300);
    const warehouseId = positiveInteger(row.warehouse_id, "claimOperation.warehouseId");
    const authorityId = positiveInteger(row.authority_id, "claimOperation.authorityId");
    const destinationVariantId = positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId");
    const outputLocationId = row.output_location_id == null
      ? null
      : positiveInteger(row.output_location_id, "claimOperation.outputLocationId");
    const inputs = inputsByOperationId.get(claimOperationId) ?? [];
    assertStatusLineage(
      lineKey != null
        && planOperation != null
        && planOperation.lineKey === lineKey
        && planOperation.parentOperationKey === parentOperationKey
        && planOperation.warehouseId === warehouseId
        && planOperation.operationType === String(row.operation_type)
        && planOperation.authorityId === authorityId
        && planOperation.destinationVariantId === destinationVariantId
        && BigInt(planOperation.plannedExecutions) === plannedExecutions
        && BigInt(planOperation.outputQty) === outputQty
        && BigInt(planOperation.committedOutputQty) === committedOutputQty
        && planOperation.outputLocationId === outputLocationId
        && canonicalJson(planOperation.inputs) === canonicalJson(inputs)
        && executedExecutions + releasedExecutions <= plannedExecutions,
      "A canonical operation does not reconcile to its hashed planner operation.",
      { claimId: claim.id.toString(), claimOperationId, operationKey },
    );
    const hasHandoff = row.handoff_id != null;
    assertStatusLineage(
      hasHandoff === (row.build_order_id != null
        && row.build_system_number != null
        && row.handoff_status != null
        && row.adopted_reservation_qty != null),
      "A canonical build handoff is incomplete.",
      { claimId: claim.id.toString(), claimOperationId, operationKey },
    );
    const buildHandoff = hasHandoff ? {
      buildHandoffId: positiveBigInt(row.handoff_id, "buildHandoff.id").toString(),
      buildOrderId: positiveInteger(row.build_order_id, "buildHandoff.buildOrderId"),
      buildSystemNumber: databaseText(row.build_system_number, "buildHandoff.buildSystemNumber", 40),
      status: databaseText(row.handoff_status, "buildHandoff.status", 30) as "handed_off" | "completed" | "cancelled",
      adoptedReservationQty: positiveBigInt(
        row.adopted_reservation_qty,
        "buildHandoff.adoptedReservationQty",
      ).toString(),
    } : null;
    assertStatusLineage(
      buildHandoff == null || planOperation.operationType === "component_build",
      "Only a component-build operation may own a build handoff.",
      { claimId: claim.id.toString(), claimOperationId, operationKey },
    );
    const operation: ReservationStatusOperation = {
      claimOperationId,
      operationKey,
      parentOperationKey,
      warehouseId,
      operationType: databaseText(row.operation_type, "claimOperation.operationType", 30) as ReservationStatusOperation["operationType"],
      authorityId,
      inputs,
      destinationVariantId,
      plannedExecutions: plannedExecutions.toString(),
      executedExecutions: executedExecutions.toString(),
      releasedExecutions: releasedExecutions.toString(),
      remainingExecutions: (plannedExecutions - executedExecutions - releasedExecutions).toString(),
      outputQty: outputQty.toString(),
      committedOutputQty: committedOutputQty.toString(),
      outputLocationId,
      status: databaseText(row.status, "claimOperation.status", 30) as ReservationStatusOperation["status"],
      buildHandoff,
    };
    const operationCountersMatchStatus = operation.status === "completed"
      ? executedExecutions === plannedExecutions && releasedExecutions === BigInt(0)
      : operation.status === "released"
        ? executedExecutions + releasedExecutions === plannedExecutions
        : executedExecutions === BigInt(0) && releasedExecutions === BigInt(0);
    const handoffMatchesOperation = buildHandoff == null
      || (buildHandoff.status === "handed_off" && operation.status === "executing")
      || (buildHandoff.status === "completed" && operation.status === "completed")
      || (buildHandoff.status === "cancelled" && operation.status === "released");
    assertStatusLineage(
      operationCountersMatchStatus && handoffMatchesOperation,
      "Canonical operation counters or build-handoff state do not match the operation status.",
      { claimId: claim.id.toString(), claimOperationId, operationKey, status: operation.status },
    );
    assertStatusLineage(
      !operationByKey.has(operationKey) && !persistedOperationIds.has(claimOperationId),
      "Canonical status contains a duplicate operation identity.",
      { claimId: claim.id.toString(), claimOperationId, operationKey },
    );
    operationByKey.set(operationKey, { ...operation, claimLineId });
    persistedOperationIds.add(claimOperationId);
    const lineOperations = operationsByLineId.get(claimLineId) ?? [];
    lineOperations.push(operation);
    operationsByLineId.set(claimLineId, lineOperations);
  }
  assertStatusLineage(
    operationByKey.size === planOperationByKey.size,
    "Canonical status operations do not match the hashed planner payload.",
    { claimId: claim.id.toString(), planOperationCount: planOperationByKey.size, persistedOperationCount: operationByKey.size },
  );
  for (const operationId of inputsByOperationId.keys()) {
    assertStatusLineage(
      persistedOperationIds.has(operationId),
      "Canonical status contains an orphaned operation input.",
      { claimId: claim.id.toString(), claimOperationId: operationId },
    );
  }

  const resourcesByLineId = new Map<string, ReservationStatusResource[]>();
  const initialResources: Array<{
    lineKey: string;
    consumerOperationKey: string | null;
    warehouseId: number;
    warehouseLocationId: number;
    inventoryLevelId: number;
    sourceVariantId: number;
    claimedQty: string;
  }> = [];
  const outputResourcesByOperationKey = new Map<string, ReservationStatusResource[]>();
  for (const row of rows(resourceRows)) {
    const claimResourceId = positiveBigInt(row.id, "claimResource.id").toString();
    const claimLineId = positiveBigInt(row.claim_line_id, "claimResource.claimLineId").toString();
    const lineKey = lineKeyById.get(claimLineId);
    const consumerOperationKey = row.consumer_operation_key == null
      ? null
      : databaseText(row.consumer_operation_key, "claimResource.consumerOperationKey", 300);
    const producerOperationKey = row.producer_operation_key == null
      ? null
      : databaseText(row.producer_operation_key, "claimResource.producerOperationKey", 300);
    const warehouseId = positiveInteger(row.warehouse_id, "claimResource.warehouseId");
    const warehouseLocationId = positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId");
    const inventoryLevelId = positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId");
    const sourceVariantId = positiveInteger(row.source_variant_id, "claimResource.sourceVariantId");
    const claimedQty = positiveBigInt(row.claimed_qty, "claimResource.claimedQty");
    const releasedQty = nonnegativeBigInt(row.released_qty, "claimResource.releasedQty");
    const consumedQty = nonnegativeBigInt(row.consumed_qty, "claimResource.consumedQty");
    const pickedQty = nonnegativeBigInt(row.picked_qty, "claimResource.pickedQty");
    assertStatusLineage(
      lineKey != null
        && releasedQty + consumedQty + pickedQty <= claimedQty
        && (consumerOperationKey == null || operationByKey.get(consumerOperationKey)?.claimLineId === claimLineId)
        && (producerOperationKey == null || operationByKey.get(producerOperationKey)?.claimLineId === claimLineId),
      "A canonical resource has invalid claim-line or quantity lineage.",
      { claimId: claim.id.toString(), claimResourceId, claimLineId },
    );
    const resource: ReservationStatusResource = {
      claimResourceId,
      consumerOperationKey,
      producerOperationKey,
      warehouseId,
      warehouseLocationId,
      inventoryLevelId,
      sourceVariantId,
      claimedQty: claimedQty.toString(),
      releasedQty: releasedQty.toString(),
      consumedQty: consumedQty.toString(),
      pickedQty: pickedQty.toString(),
      openQty: (claimedQty - releasedQty - consumedQty - pickedQty).toString(),
    };
    if (producerOperationKey == null) {
      initialResources.push({
        lineKey,
        consumerOperationKey,
        warehouseId,
        warehouseLocationId,
        inventoryLevelId,
        sourceVariantId,
        claimedQty: claimedQty.toString(),
      });
    } else {
      const producer = operationByKey.get(producerOperationKey)!;
      assertStatusLineage(
        producer.parentOperationKey === consumerOperationKey
          && producer.warehouseId === warehouseId
          && producer.destinationVariantId === sourceVariantId
          && producer.outputLocationId === warehouseLocationId
          && producer.committedOutputQty === claimedQty.toString(),
        "A produced canonical resource does not match its producer operation.",
        { claimId: claim.id.toString(), claimResourceId, producerOperationKey },
      );
      const outputs = outputResourcesByOperationKey.get(producerOperationKey) ?? [];
      outputs.push(resource);
      outputResourcesByOperationKey.set(producerOperationKey, outputs);
    }
    const lineResources = resourcesByLineId.get(claimLineId) ?? [];
    lineResources.push(resource);
    resourcesByLineId.set(claimLineId, lineResources);
  }
  const resourceSortKey = (resource: typeof initialResources[number]) => canonicalJson(resource);
  const expectedInitialResources = claim.plan.resourceClaims.map((resource) => ({ ...resource }))
    .sort((left, right) => resourceSortKey(left).localeCompare(resourceSortKey(right)));
  initialResources.sort((left, right) => resourceSortKey(left).localeCompare(resourceSortKey(right)));
  assertStatusLineage(
    canonicalJson(initialResources) === canonicalJson(expectedInitialResources),
    "Canonical initial resources do not match the hashed planner payload.",
    { claimId: claim.id.toString(), expectedInitialResources, initialResources },
  );
  for (const operation of operationByKey.values()) {
    const outputCount = outputResourcesByOperationKey.get(operation.operationKey)?.length ?? 0;
    assertStatusLineage(
      outputCount === (BigInt(operation.executedExecutions) > BigInt(0) ? 1 : 0),
      "Canonical produced-resource evidence does not match operation execution.",
      { claimId: claim.id.toString(), operationKey: operation.operationKey, outputCount },
    );
  }

  const lines = persistedLines.map((row): ReservationStatusLine => {
    const claimLineId = positiveBigInt(row.id, "claimLine.id").toString();
    const line = lineBaseById.get(claimLineId);
    assertStatusLineage(line != null, "Canonical status line assembly failed.", { claimId: claim.id.toString(), claimLineId });
    return {
      ...line,
      resources: resourcesByLineId.get(claimLineId) ?? [],
      operations: operationsByLineId.get(claimLineId) ?? [],
    };
  });
  return {
    claimId: claim.id.toString(),
    claimKey: databaseText(claim.claimKey, "claim.claimKey", 200),
    revision: claim.revision,
    activationRunId: activationRunId.toString(),
    runtimeAuthorityRevision: claim.runtimeAuthorityRevision.toString(),
    planStatus: claim.plan.status,
    scope: claim.plan.scope,
    planHash: claim.planHash,
    snapshotFingerprint: claim.plan.snapshotFingerprint,
    lines,
  };
}

export async function executeGetReservationStatus(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityReservationStatusCommand,
): Promise<CanonicalAvailabilityReservationStatusProjection> {
  const command = canonicalAvailabilityReservationStatusCommandSchema.parse(rawCommand);
  const client = await deps.connectionPool.connect();
  let began = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    began = true;
    const authority = await requireCanonicalAuthority(client);
    const order = rows(await client.query(
      `SELECT id FROM wms.orders WHERE id = $1`,
      [command.orderId],
    ))[0];
    if (!order) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "ORDER_NOT_FOUND",
        "The order requested for canonical reservation status does not exist.",
        { orderId: command.orderId },
      );
    }
    const claim = await loadActiveClaim(client, command.orderId, false);
    const result = canonicalAvailabilityReservationStatusProjectionSchema.parse({
      schemaVersion: "inventory_availability_reservation_status_v1",
      authority: "canonical",
      authorityRevision: authority.revision.toString(),
      activationRunId: authority.activationRunId.toString(),
      orderId: command.orderId,
      claim: claim == null ? null : await buildReservationStatusClaim(client, claim),
    });
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) await rollback(client, error);
    throw error;
  } finally {
    client.release();
  }
}

/** First-cutover owner entry point; the admitted caller owns the transaction. */
export async function persistReconstructedCutoverClaim(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  batch: PlannedCutoverOrder,
  command: CutoverReconstructionCommit,
): Promise<string> {
  const occurredAt = new Date(command.occurredAt);
  const order: LockedOrder = {
    orderId: batch.order.orderId,
    warehouseId: batch.order.warehouseId,
    warehouseStatus: "cutover_adoption",
    onHold: false,
    lines: batch.order.lines.map((line) => ({
      orderItemId: line.orderItemId,
      targetVariantId: line.targetVariantId,
      rootProductId: line.productId,
      requestedQty: positiveInteger(line.requestedQty, "reconstruction.requestedQty"),
    })),
  };
  const claimId = await insertClaimHeader(client, {
    order,
    revision: await nextClaimRevision(client, order.orderId),
    authority: { activationRunId: BigInt(command.activationRunId), revision: BigInt(command.runtimeAuthorityRevision) },
    request: batch.request,
    plan: batch.plan,
    command,
    occurredAt,
  });
  const lineIds = await insertClaimLines(client, claimId, order, batch.plan);
  await insertClaimOperations(client, claimId, lineIds, batch.plan);
  const insertAdoptionCommand = async (key: string, evidence: unknown): Promise<string> => {
    const request = { ...command, orderId: order.orderId, claimId: claimId.toString(), evidence };
    const result = { claimId: claimId.toString(), disposition: "adopted_existing_custody" };
    const row = rows(await client.query(
      `INSERT INTO inventory.availability_claim_commands
        (claim_id,order_id,command_type,idempotency_key,request_hash,result_hash,request_payload,result_payload,actor,reason,occurred_at)
        VALUES ($1,$2,'cutover_adopt',$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) RETURNING id`,
      [claimId.toString(), order.orderId, key, hash(request), hash(result), JSON.stringify(request), JSON.stringify(result), command.actor, command.reason, occurredAt],
    ))[0];
    return positiveBigInt(row?.id, "cutover.commandId").toString();
  };
  await insertAdoptionCommand(`cutover:${command.activationRunId}:order:${order.orderId}`, { planHash: hash(batch.plan) });
  for (const line of batch.order.lines) {
    const claimLineId = lineIds.get(`order-item:${line.orderItemId}`)!.claimLineId;
    await client.query(
      "UPDATE inventory.availability_claim_lines SET picked_target_qty=$2 WHERE id=$1",
      [claimLineId.toString(), line.pickedQty],
    );
  }
  for (const resource of batch.plan.resourceClaims) {
    const lineId = lineIds.get(resource.lineKey)!;
    const adoptedLine = batch.order.lines.find((line) => line.orderItemId === lineId.orderItemId)!;
    const adopted = resource.consumerOperationKey === null
      ? adoptedLine.allocations.find((allocation) => allocation.inventoryLevelId === resource.inventoryLevelId)
      : undefined;
    const fresh = batch.freshPlan?.resourceClaims.find((candidate) => candidate.lineKey === resource.lineKey
      && candidate.inventoryLevelId === resource.inventoryLevelId && candidate.consumerOperationKey === resource.consumerOperationKey);
    const inserted = rows(await client.query(
      `INSERT INTO inventory.availability_claim_resources
        (claim_id,claim_line_id,consumer_operation_key,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty,picked_qty)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [claimId.toString(), lineId.claimLineId.toString(), resource.consumerOperationKey,
        resource.warehouseId, resource.warehouseLocationId, resource.inventoryLevelId, resource.sourceVariantId, resource.claimedQty, adopted?.pickedQty ?? "0"],
    ))[0];
    const resourceId = positiveBigInt(inserted?.id, "cutover.resourceId");
    const allocations = new Map<number, {
      claimedQty: bigint;
      pickedQty: bigint;
      cost: {
        unitCostMills: bigint;
        poUnitCostMills: bigint;
        packagingUnitCostMills: bigint;
        landedUnitCostMills: bigint;
      };
      originalCosts: CutoverReconstructionCost[];
    }>();
    for (const lot of adopted?.lots ?? []) {
      allocations.set(lot.inventoryLotId, {
        claimedQty: BigInt(lot.reservedQty) + BigInt(lot.pickedQty),
        pickedQty: BigInt(lot.pickedQty),
        cost: {
          unitCostMills: BigInt(lot.cost.unitCostMills),
          poUnitCostMills: BigInt(lot.cost.poUnitCostMills),
          packagingUnitCostMills: BigInt(lot.cost.packagingUnitCostMills),
          landedUnitCostMills: BigInt(lot.cost.landedUnitCostMills),
        },
        originalCosts: lot.originalCosts,
      });
    }
    if (fresh) {
      const reservedLots = await inventoryWriter.reserveResource({
        client,
        claimId,
        claimResourceId: resourceId,
        commandKey: `canonical:cutover-reserve:${resourceId}`,
        inventoryLevelId: resource.inventoryLevelId,
        warehouseLocationId: resource.warehouseLocationId,
        sourceVariantId: resource.sourceVariantId,
        claimedQty: positiveInteger(fresh.claimedQty, "cutover.freshQty"),
        orderId: order.orderId,
        orderItemId: lineId.orderItemId,
        consumerOperationKey: resource.consumerOperationKey,
        actor: command.actor,
        occurredAt,
      });
      for (const lot of reservedLots) {
        const existing = allocations.get(lot.inventoryLotId);
        if (existing) {
          if (existing.cost.unitCostMills !== lot.unitCostMills || existing.cost.poUnitCostMills !== lot.poUnitCostMills
            || existing.cost.packagingUnitCostMills !== lot.packagingUnitCostMills || existing.cost.landedUnitCostMills !== lot.landedUnitCostMills) {
            throw new InventoryAvailabilityClaimRepositoryError("CUTOVER_LOT_COST_CHANGED", "Lot cost changed during admitted adoption.");
          }
          existing.claimedQty += BigInt(lot.qty);
        } else {
          allocations.set(lot.inventoryLotId, { claimedQty: BigInt(lot.qty), pickedQty: BigInt(0), cost: lot, originalCosts: [] });
        }
      }
    }
    if ([...allocations.values()].reduce((total, lot) => total + lot.claimedQty, BigInt(0)) !== BigInt(resource.claimedQty)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CUTOVER_RESOURCE_LOTS_MISMATCH",
        "Exact lot allocations do not exhaust adopted plus fresh resource quantity.",
      );
    }
    for (const [lotId, lot] of [...allocations].sort(([a], [b]) => a - b)) {
      const insertedLot = rows(await client.query(
        `INSERT INTO inventory.availability_claim_lot_allocations
          (claim_id,claim_resource_id,inventory_lot_id,claimed_qty,picked_qty,unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [claimId.toString(), resourceId.toString(), lotId, lot.claimedQty.toString(),
          lot.pickedQty.toString(), lot.cost.unitCostMills.toString(), lot.cost.poUnitCostMills.toString(), lot.cost.packagingUnitCostMills.toString(), lot.cost.landedUnitCostMills.toString()],
      ))[0];
      const allocationId = positiveBigInt(insertedLot?.id, "cutover.lotAllocationId").toString();
      for (const cost of lot.originalCosts) {
        const commandId = await insertAdoptionCommand(`cutover:${command.activationRunId}:pick-cost:${cost.id}`, cost);
        const movement = rows(await client.query(
          `INSERT INTO inventory.availability_claim_pick_movements
            (claim_id,claim_line_id,claim_resource_id,claim_lot_allocation_id,inventory_lot_id,command_id,order_item_cost_id,
             movement_type,quantity,unit_cost_mills,total_cost_mills,occurred_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'pick',$8,$9,$10,$11) RETURNING id`,
          [claimId.toString(), lineId.claimLineId.toString(),
            resourceId.toString(), allocationId, lotId, commandId, cost.id, cost.quantity, cost.unitCostMills, cost.totalCostMills, cost.occurredAt],
        ))[0];
        await client.query(
          `INSERT INTO inventory.availability_cutover_pick_sources
            (order_item_cost_id,pick_movement_id,activation_run_id,evidence_hash,original_cost_payload)
            VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [cost.id, String(movement.id), command.activationRunId, command.expectedEvidenceHash, JSON.stringify(cost)],
        );
      }
    }
  }
  const event = { evidenceHash: command.expectedEvidenceHash, planHash: hash(batch.plan), kind: "adopt_existing_and_plan_remaining" };
  await client.query(
    `INSERT INTO inventory.availability_claim_events
      (claim_id,event_type,from_status,to_status,evidence_payload,evidence_hash,actor,reason,occurred_at)
      VALUES ($1,'cutover_adopted',NULL,'active',$2::jsonb,$3,$4,$5,$6)`,
    [claimId.toString(), JSON.stringify(event), hash(event), command.actor, command.reason, occurredAt],
  );
  const adoptedClaim = await loadActiveClaim(client, order.orderId);
  const currentDemand = await loadOrder(client, order.orderId, true);
  if (!adoptedClaim || !await orderDemandMatchesClaim(client, currentDemand, adoptedClaim)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CUTOVER_RUNTIME_DEMAND_MISMATCH",
      "Adopted relational custody must match the actual canonical runtime demand reader.",
      { orderId: order.orderId },
    );
  }
  return claimId.toString();
}
