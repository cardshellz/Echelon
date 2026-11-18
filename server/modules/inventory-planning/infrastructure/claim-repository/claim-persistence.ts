import type { PoolClient } from "pg";

import {
  canonicalAvailabilityClaimResultSchema,
  type CanonicalAvailabilityClaimCommand,
  type CanonicalAvailabilityClaimReleaseCommand,
  type CanonicalAvailabilityClaimReplacementCommand,
  type CanonicalAvailabilityClaimReplacementResult,
  type CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";
import type { ClaimPlanDto, ClaimPlanRequestDto } from "@shared/types/inventory-availability-planner";
import type { AssemblyWorkOwner } from "../../../warehouse/cutover-work.api";
import type { CanonicalClaimBuildMutationPort } from "../../application/canonical-claim-build.port";
import type {
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimInventoryReleaseResource,
} from "../../application/canonical-claim-inventory.port";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  positiveBigInt,
  positiveInteger,
  rows,
  type ClaimAuditCommand,
  type ClaimLifecycleDisposition,
  type LockedOrder,
  type OrderLine,
  type PersistedClaim,
  type RuntimeAuthority,
} from "./claim-primitives";

export async function persistNoopCommand(
  client: PoolClient,
  command: CanonicalAvailabilityClaimCommand | CanonicalAvailabilityClaimReleaseCommand,
  commandType: "claim" | "release" | "cancel",
  requestHash: string,
  occurredAt: Date,
): Promise<CanonicalAvailabilityClaimResult> {
  const result = canonicalAvailabilityClaimResultSchema.parse({
    outcome: "no_claim_required",
    orderId: command.orderId,
    idempotentReplay: false,
  });
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES (NULL, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      command.orderId,
      commandType,
      command.idempotencyKey,
      requestHash,
      hash(result),
      JSON.stringify(command),
      JSON.stringify(result),
      command.actor,
      command.reason,
      occurredAt,
    ],
  );
  return result;
}

export async function insertClaimHeader(
  client: PoolClient,
  input: {
    order: LockedOrder;
    revision: number;
    authority: RuntimeAuthority;
    request: ClaimPlanRequestDto;
    plan: ClaimPlanDto;
    command: ClaimAuditCommand;
    supersedesClaimId?: bigint;
    occurredAt: Date;
  },
): Promise<bigint> {
  const inserted = rows(await client.query(
    `INSERT INTO inventory.availability_claims (
       claim_key, order_id, revision, supersedes_claim_id,
       status, plan_status, scope_kind, scope_warehouse_id,
       activation_run_id, runtime_authority_revision, request_hash, plan_hash,
       snapshot_fingerprint, request_payload, plan_payload, model_evidence,
       requested_by, reason, reserved_at
     ) VALUES (
       $1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12,
       $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18
     )
     RETURNING id`,
    [
      input.request.requestKey,
      input.order.orderId,
      input.revision,
      input.supersedesClaimId?.toString() ?? null,
      input.plan.status,
      input.request.scope.kind,
      input.request.scope.kind === "warehouse" ? input.request.scope.warehouseId : null,
      input.authority.activationRunId.toString(),
      input.authority.revision.toString(),
      hash(input.request),
      hash(input.plan),
      input.plan.snapshotFingerprint,
      JSON.stringify(input.request),
      JSON.stringify(input.plan),
      JSON.stringify(input.plan.modelEvidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  ))[0];
  return positiveBigInt(inserted?.id, "claim.id");
}

export async function insertClaimLines(
  client: PoolClient,
  claimId: bigint,
  order: LockedOrder,
  plan: ClaimPlanDto,
): Promise<Map<string, { claimLineId: bigint; orderItemId: number }>> {
  const orderLineByKey = new Map<string, OrderLine>(
    order.lines.map((line) => [`order-item:${line.orderItemId}`, line]),
  );
  const lineIds = new Map<string, { claimLineId: bigint; orderItemId: number }>();
  for (const line of plan.lines) {
    const orderLine = orderLineByKey.get(line.lineKey);
    if (!orderLine) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PLAN_LINE_MISMATCH",
        "The planner returned a line that does not belong to the locked order.",
        { claimId: claimId.toString(), lineKey: line.lineKey },
      );
    }
    const inserted = rows(await client.query(
      `INSERT INTO inventory.availability_claim_lines (
         claim_id, line_key, order_item_id, target_variant_id,
         requested_qty, planned_qty, shortfall_qty
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        claimId.toString(),
        line.lineKey,
        orderLine.orderItemId,
        line.targetVariantId,
        line.requestedQty,
        line.plannedQty,
        line.shortfallQty,
      ],
    ))[0];
    lineIds.set(line.lineKey, {
      claimLineId: positiveBigInt(inserted?.id, "claimLine.id"),
      orderItemId: orderLine.orderItemId,
    });
  }
  return lineIds;
}

export async function insertClaimOperations(
  client: PoolClient,
  claimId: bigint,
  lineIds: ReadonlyMap<string, { claimLineId: bigint }>,
  plan: ClaimPlanDto,
): Promise<void> {
  for (const operation of plan.operations) {
    const line = lineIds.get(operation.lineKey);
    if (!line) throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_OPERATION_LINE_MISMATCH",
      "A planner operation does not reference a persisted claim line.",
      { operationKey: operation.operationKey, lineKey: operation.lineKey },
    );
    if (operation.inputs.length === 0) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OPERATION_INPUTS_MISSING",
        "A live canonical operation must identify every required source input.",
        { operationKey: operation.operationKey },
      );
    }
    const inserted = rows(await client.query(
      `INSERT INTO inventory.availability_claim_operations (
         claim_id, claim_line_id, operation_key, parent_operation_key, warehouse_id,
         operation_type, authority_id, destination_variant_id, planned_executions,
         output_qty, committed_output_qty, output_location_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        claimId.toString(),
        line.claimLineId.toString(),
        operation.operationKey,
        operation.parentOperationKey,
        operation.warehouseId,
        operation.operationType,
        operation.authorityId,
        operation.destinationVariantId,
        operation.plannedExecutions,
        operation.outputQty,
        operation.committedOutputQty,
        operation.outputLocationId,
      ],
    ))[0];
    const operationId = positiveBigInt(inserted?.id, "claimOperation.id");
    for (const [inputOrdinal, input] of operation.inputs.entries()) {
      await client.query(
        `INSERT INTO inventory.availability_claim_operation_inputs (
           claim_operation_id, claim_id, source_variant_id, required_qty, input_ordinal
         ) VALUES ($1, $2, $3, $4, $5)`,
        [operationId.toString(), claimId.toString(), input.sourceVariantId, input.requiredQty, inputOrdinal],
      );
    }
  }
}

async function reserveClaimResource(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  input: {
    claimId: bigint;
    claimLineId: bigint;
    orderId: number;
    orderItemId: number;
    resource: ClaimPlanDto["resourceClaims"][number];
    actor: string;
    occurredAt: Date;
  },
): Promise<void> {
  const claimedQty = positiveInteger(input.resource.claimedQty, "claimResource.claimedQty");
  const insertedResource = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, warehouse_id,
       warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.claimId.toString(),
      input.claimLineId.toString(),
      input.resource.consumerOperationKey,
      input.resource.warehouseId,
      input.resource.warehouseLocationId,
      input.resource.inventoryLevelId,
      input.resource.sourceVariantId,
      claimedQty,
    ],
  ))[0];
  const claimResourceId = positiveBigInt(insertedResource?.id, "claimResource.id");
  const lotAllocations = await inventoryWriter.reserveResource({
    client,
    commandKey: `canonical:reserve-resource:${claimResourceId}`,
    claimId: input.claimId,
    claimResourceId,
    inventoryLevelId: input.resource.inventoryLevelId,
    warehouseLocationId: input.resource.warehouseLocationId,
    sourceVariantId: input.resource.sourceVariantId,
    claimedQty,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    consumerOperationKey: input.resource.consumerOperationKey,
    actor: input.actor,
    occurredAt: input.occurredAt,
  });
  for (const allocation of lotAllocations) {
    await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.claimId.toString(),
        claimResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
      ],
    );
  }
}

export async function reserveClaimResources(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  claimId: bigint,
  order: LockedOrder,
  lineIds: ReadonlyMap<string, { claimLineId: bigint; orderItemId: number }>,
  plan: ClaimPlanDto,
  actor: string,
  occurredAt: Date,
): Promise<void> {
  const orderedResources = [...plan.resourceClaims].sort((left, right) =>
    left.warehouseId - right.warehouseId
    || left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || String(left.consumerOperationKey ?? "").localeCompare(String(right.consumerOperationKey ?? ""))
    || left.lineKey.localeCompare(right.lineKey));
  for (const resource of orderedResources) {
    const line = lineIds.get(resource.lineKey);
    if (!line) throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_RESOURCE_LINE_MISMATCH",
      "A planner resource does not reference a persisted claim line.",
      { lineKey: resource.lineKey, inventoryLevelId: resource.inventoryLevelId },
    );
    await reserveClaimResource(client, inventoryWriter, {
      claimId,
      claimLineId: line.claimLineId,
      orderId: order.orderId,
      orderItemId: line.orderItemId,
      resource,
      actor,
      occurredAt,
    });
  }
}

export async function persistCommandAndEvent(
  client: PoolClient,
  input: {
    claimId: bigint;
    command: CanonicalAvailabilityClaimCommand;
    requestHash: string;
    result: CanonicalAvailabilityClaimResult;
    occurredAt: Date;
    eventType: "claim_reserved" | "claim_replayed";
  },
): Promise<void> {
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, 'claim', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.claimId.toString(),
      input.command.orderId,
      input.command.idempotencyKey,
      input.requestHash,
      hash(input.result),
      JSON.stringify(input.command),
      JSON.stringify(input.result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const evidence = {
    schemaVersion: "inventory_availability_claim_event_v1",
    eventType: input.eventType,
    claimId: input.claimId.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claimId.toString(),
      input.eventType,
      input.eventType === "claim_replayed" ? "active" : null,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
}

export async function releaseClaimResources(
  client: PoolClient,
  input: {
    inventoryWriter: CanonicalClaimInventoryMutationPort;
    commandKey: string;
    claim: PersistedClaim;
    orderId: number;
    actor: string;
    reason: string;
    disposition: ClaimLifecycleDisposition;
    occurredAt: Date;
  },
): Promise<{ releasedResourceQty: bigint; releasedLotQty: bigint }> {
  const resourceRows = rows(await client.query(
    `SELECT resource.id,
            resource.claim_line_id,
            resource.inventory_level_id,
            resource.warehouse_location_id,
            resource.source_variant_id,
            resource.claimed_qty,
             resource.released_qty,
             resource.consumed_qty,
             resource.picked_qty,
             line.order_item_id
     FROM inventory.availability_claim_resources AS resource
     JOIN inventory.availability_claim_lines AS line
       ON line.id = resource.claim_line_id AND line.claim_id = resource.claim_id
     WHERE resource.claim_id = $1
     ORDER BY resource.warehouse_id, resource.warehouse_location_id,
              resource.source_variant_id, resource.inventory_level_id, resource.id
     FOR UPDATE OF resource`,
    [input.claim.id.toString()],
  ));
  const lotRows = rows(await client.query(
    `SELECT allocation.id,
            allocation.claim_resource_id,
            allocation.inventory_lot_id,
             allocation.claimed_qty,
             allocation.released_qty,
             allocation.consumed_qty,
             allocation.picked_qty
     FROM inventory.availability_claim_lot_allocations AS allocation
     WHERE allocation.claim_id = $1
     ORDER BY allocation.claim_resource_id, allocation.inventory_lot_id, allocation.id
     FOR UPDATE OF allocation`,
    [input.claim.id.toString()],
  ));
  const lotsByResource = new Map<string, any[]>();
  for (const lot of lotRows) {
    const key = String(lot.claim_resource_id);
    const candidates = lotsByResource.get(key) ?? [];
    candidates.push(lot);
    lotsByResource.set(key, candidates);
  }

  let releasedResourceQty = BigInt(0);
  let releasedLotQty = BigInt(0);
  const pendingReleases: Array<{
    inventory: CanonicalClaimInventoryReleaseResource;
    claimLotAllocations: Array<{ allocationId: bigint; releaseQty: bigint }>;
  }> = [];
  for (const resource of resourceRows) {
    const claimed = positiveBigInt(resource.claimed_qty, "claimResource.claimedQty");
    const released = BigInt(String(resource.released_qty));
    const consumed = BigInt(String(resource.consumed_qty));
    const picked = BigInt(String(resource.picked_qty ?? 0));
    const open = claimed - released - consumed - picked;
    if (open < BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLAIM_RESOURCE_BALANCE",
        "A canonical claim resource has released, consumed, or picked more than it claimed.",
        {
          claimResourceId: String(resource.id),
          claimed: claimed.toString(),
          released: released.toString(),
          consumed: consumed.toString(),
          picked: picked.toString(),
        },
      );
    }

    const openLotAllocations: Array<{ allocationId: bigint; inventoryLotId: number; releaseQty: bigint }> = [];
    let attributedOpen = BigInt(0);
    for (const lot of lotsByResource.get(String(resource.id)) ?? []) {
      const lotClaimed = positiveBigInt(lot.claimed_qty, "claimLot.claimedQty");
      const lotReleased = BigInt(String(lot.released_qty));
      const lotConsumed = BigInt(String(lot.consumed_qty));
      const lotPicked = BigInt(String(lot.picked_qty ?? 0));
      const lotOpen = lotClaimed - lotReleased - lotConsumed - lotPicked;
      if (lotOpen < BigInt(0)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_LOT_BALANCE",
          "A canonical claim lot allocation has released, consumed, or picked more than it claimed.",
          { claimLotAllocationId: String(lot.id) },
        );
      }
      if (lotOpen === BigInt(0)) continue;
      openLotAllocations.push({
        allocationId: positiveBigInt(lot.id, "claimLot.id"),
        inventoryLotId: positiveInteger(lot.inventory_lot_id, "claimLot.inventoryLotId"),
        releaseQty: lotOpen,
      });
      attributedOpen += lotOpen;
    }
    if (attributedOpen !== open) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RELEASE_LINEAGE_MISMATCH",
        "The exact open lot allocation does not reconcile to its claim resource.",
        {
          claimResourceId: String(resource.id),
          resourceOpenQty: open.toString(),
          lotOpenQty: attributedOpen.toString(),
        },
      );
    }
    if (open === BigInt(0)) continue;
    const claimResourceId = positiveBigInt(resource.id, "claimResource.id");
    pendingReleases.push({
      inventory: {
        claimResourceId,
        inventoryLevelId: positiveInteger(resource.inventory_level_id, "claimResource.inventoryLevelId"),
        warehouseLocationId: positiveInteger(resource.warehouse_location_id, "claimResource.warehouseLocationId"),
        sourceVariantId: positiveInteger(resource.source_variant_id, "claimResource.sourceVariantId"),
        releaseQty: open,
        lotAllocations: openLotAllocations.map(({ inventoryLotId, releaseQty }) => ({ inventoryLotId, releaseQty })),
        orderItemId: positiveInteger(resource.order_item_id, "claimLine.orderItemId"),
      },
      claimLotAllocations: openLotAllocations.map(({ allocationId, releaseQty }) => ({ allocationId, releaseQty })),
    });
  }

  await input.inventoryWriter.releaseResources({
    client,
    commandKey: input.commandKey,
    claimId: input.claim.id,
    resources: pendingReleases.map((release) => release.inventory),
    orderId: input.orderId,
    actor: input.actor,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of pendingReleases) {
    for (const allocation of release.claimLotAllocations) {
      const updatedAllocation = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updatedAllocation.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_LOT_RELEASE_STATE_CHANGED",
          "A locked claim lot allocation changed before its release was recorded.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
      releasedLotQty += allocation.releaseQty;
    }
    const updatedResource = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updatedResource.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RESOURCE_RELEASE_STATE_CHANGED",
        "A locked claim resource changed before its release was recorded.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
    releasedResourceQty += release.inventory.releaseQty;
  }

  await client.query(
    `UPDATE inventory.availability_claim_lines
     SET released_target_qty = planned_qty - consumed_target_qty - picked_target_qty, updated_at = $2
     WHERE claim_id = $1`,
    [input.claim.id.toString(), input.occurredAt],
  );
  await client.query(
    `UPDATE inventory.availability_claim_operations
     SET released_executions = planned_executions - executed_executions,
         status = CASE WHEN executed_executions = planned_executions THEN status ELSE 'released' END,
         updated_at = $2
     WHERE claim_id = $1`,
    [input.claim.id.toString(), input.occurredAt],
  );
  const status = input.disposition === "cancel"
    ? "cancelled"
    : input.disposition === "supersede"
      ? "superseded"
      : "released";
  const timestampColumn = input.disposition === "cancel"
    ? "cancelled_at"
    : input.disposition === "supersede"
      ? "superseded_at"
      : "released_at";
  const updatedClaim = await client.query(
    `UPDATE inventory.availability_claims
     SET status = $1, ${timestampColumn} = $2, updated_at = $2
     WHERE id = $3 AND status = 'active'`,
    [status, input.occurredAt, input.claim.id.toString()],
  );
  if (updatedClaim.rowCount !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ACTIVE_CLAIM_STATE_CHANGED",
      "The locked canonical claim changed before its terminal state was recorded.",
      { claimId: input.claim.id.toString(), status },
    );
  }
  return { releasedResourceQty, releasedLotQty };
}

export async function persistReleaseCommandAndEvent(
  client: PoolClient,
  input: {
    claim: PersistedClaim;
    command: CanonicalAvailabilityClaimReleaseCommand;
    requestHash: string;
    result: CanonicalAvailabilityClaimResult;
    occurredAt: Date;
  },
): Promise<void> {
  const commandType = input.command.disposition === "cancel" ? "cancel" : "release";
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      input.claim.id.toString(),
      input.command.orderId,
      commandType,
      input.command.idempotencyKey,
      input.requestHash,
      hash(input.result),
      JSON.stringify(input.command),
      JSON.stringify(input.result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const toStatus = input.command.disposition === "cancel" ? "cancelled" : "released";
  const evidence = {
    schemaVersion: "inventory_availability_claim_event_v1",
    eventType: `claim_${toStatus}`,
    claimId: input.claim.id.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, 'active', $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claim.id.toString(),
      `claim_${toStatus}`,
      toStatus,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
}

export async function persistReplacementCommandAndEvents(
  client: PoolClient,
  input: {
    supersededClaim: PersistedClaim;
    replacementClaimId: bigint;
    command: CanonicalAvailabilityClaimReplacementCommand;
    requestHash: string;
    result: CanonicalAvailabilityClaimReplacementResult;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, 'replace', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.replacementClaimId.toString(),
      input.command.orderId,
      input.command.idempotencyKey,
      input.requestHash,
      hash(input.result),
      JSON.stringify(input.command),
      JSON.stringify(input.result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const supersededEvidence = {
    schemaVersion: "inventory_availability_claim_replacement_event_v1",
    eventType: "claim_superseded",
    supersededClaimId: input.supersededClaim.id.toString(),
    replacementClaimId: input.replacementClaimId.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_superseded', 'active', 'superseded', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.supersededClaim.id.toString(),
      JSON.stringify(supersededEvidence),
      hash(supersededEvidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const replacementEvidence = {
    schemaVersion: "inventory_availability_claim_replacement_event_v1",
    eventType: "claim_reserved",
    supersededClaimId: input.supersededClaim.id.toString(),
    replacementClaimId: input.replacementClaimId.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_reserved', NULL, 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.replacementClaimId.toString(),
      JSON.stringify(replacementEvidence),
      hash(replacementEvidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
}

export async function cancelOpenBuildHandoffs(
  client: PoolClient,
  buildWriter: CanonicalClaimBuildMutationPort | undefined,
  claim: PersistedClaim,
  command: ClaimAuditCommand & { disposition: ClaimLifecycleDisposition; idempotencyKey: string },
  occurredAt: Date,
  workOwner?: AssemblyWorkOwner,
): Promise<void> {
  // Every caller already owns the claim fence. Work-only start commands take
  // that same fence before any task lock, so started physical work cannot race
  // inventory release, replacement or cycle-count displacement.
  await workOwner?.cancelUnstarted(client, {
    claimId: claim.id.toString(),
    actorId: command.actor,
    reason: command.reason,
    commandKey: `claim-lifecycle:${command.idempotencyKey}`,
    requestHash: hash(command),
    occurredAt: occurredAt.toISOString(),
  });
  const openHandoffs = rows(await client.query(
    `SELECT handoff.id, handoff.claim_operation_id, handoff.build_order_id,
            handoff.adopted_reservation_qty, handoff.status,
            operation.operation_key, operation.status AS operation_status,
            operation.executed_executions, operation.released_executions
     FROM inventory.availability_claim_build_handoffs AS handoff
     JOIN inventory.availability_claim_operations AS operation
       ON operation.id = handoff.claim_operation_id AND operation.claim_id = handoff.claim_id
     WHERE handoff.claim_id = $1 AND handoff.status = 'handed_off'
     ORDER BY handoff.id
     FOR UPDATE OF handoff, operation`,
    [claim.id.toString()],
  ));
  if (openHandoffs.length === 0) return;
  if (!buildWriter) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_CANCELLATION_NOT_CONFIGURED",
      "The claim owns active build handoffs, but its cancellation port is not configured.",
      {
        claimId: claim.id.toString(),
        buildOrderIds: openHandoffs.map((row) => positiveInteger(row.build_order_id, "buildHandoff.buildOrderId")),
      },
    );
  }
  for (const handoff of openHandoffs) {
    if (String(handoff.operation_status) !== "executing"
      || BigInt(String(handoff.executed_executions)) !== BigInt(0)
      || BigInt(String(handoff.released_executions)) !== BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_BUILD_CANCELLATION_STATE_DRIFT",
        "An open build handoff is not in an unexecuted canonical operation state.",
        {
          claimId: claim.id.toString(),
          claimOperationId: String(handoff.claim_operation_id),
          operationStatus: handoff.operation_status,
        },
      );
    }
    const cancellation = await buildWriter.cancelOperation({
      client,
      claimId: claim.id,
      claimOperationId: positiveBigInt(handoff.claim_operation_id, "claimOperation.id"),
      buildOrderId: positiveInteger(handoff.build_order_id, "buildHandoff.buildOrderId"),
      expectedReservationQty: positiveBigInt(
        handoff.adopted_reservation_qty,
        "buildHandoff.adoptedReservationQty",
      ),
      actor: command.actor,
      reason: command.reason,
      occurredAt,
    });
    const updatedHandoff = await client.query(
      `UPDATE inventory.availability_claim_build_handoffs
       SET status = 'cancelled', cancelled_at = $3, updated_at = $3
       WHERE id = $1 AND claim_id = $2 AND status = 'handed_off'`,
      [String(handoff.id), claim.id.toString(), occurredAt],
    );
    if (updatedHandoff.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_BUILD_HANDOFF_STATE_CHANGED",
        "The build handoff changed while claim cancellation was being recorded.",
        { claimId: claim.id.toString(), buildOrderId: cancellation.buildOrderId },
      );
    }
    const evidence = {
      schemaVersion: "inventory_availability_claim_build_cancellation_event_v1",
      eventType: "claim_build_cancelled",
      claimId: claim.id.toString(),
      claimOperationId: String(handoff.claim_operation_id),
      operationKey: String(handoff.operation_key),
      buildOrderId: cancellation.buildOrderId,
      buildSystemNumber: cancellation.buildSystemNumber,
      releasedReservationQty: cancellation.releasedReservationQty.toString(),
      disposition: command.disposition,
    };
    await client.query(
      `INSERT INTO inventory.availability_claim_events (
         claim_id, event_type, from_status, to_status, evidence_payload,
         evidence_hash, actor, reason, occurred_at
       ) VALUES ($1, 'claim_build_cancelled', 'executing', 'released', $2::jsonb, $3, $4, $5, $6)`,
      [
        claim.id.toString(),
        JSON.stringify(evidence),
        hash(evidence),
        command.actor,
        command.reason,
        occurredAt,
      ],
    );
  }
}
