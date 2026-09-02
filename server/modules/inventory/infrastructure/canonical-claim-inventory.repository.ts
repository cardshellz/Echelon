import type {
  CanonicalClaimInventoryExecutionResource,
  CanonicalClaimInventoryReleaseResource,
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimLotAllocation,
  CanonicalClaimProducedLotAllocation,
  CanonicalClaimTransactionClient,
} from "../../inventory-planning/application/canonical-claim-inventory.port";
import { allocateBuildCostLayers } from "../domain/build.domain";
import { buildMillsToRoundedCents, normalizeBuildLotCosts } from "./build.repository";

type CanonicalTransformationExecutionInput =
  | Parameters<CanonicalClaimInventoryMutationPort["executePackageOperation"]>[0]
  | Parameters<CanonicalClaimInventoryMutationPort["executeBuildOperation"]>[0];

function rows(result: { rows: any[] }): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

function positivePostgresInteger(value: bigint, field: string): number {
  if (value <= BigInt(0) || value > BigInt(2_147_483_647)) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_QUANTITY",
      `${field} must fit a positive PostgreSQL integer`,
      { field, value: value.toString() },
    );
  }
  return Number(value);
}

function positiveBigInt(value: bigint, field: string): bigint {
  if (value <= BigInt(0) || value > BigInt("9223372036854775807")) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_IDENTITY",
      `${field} must fit a positive PostgreSQL bigint`,
      { field, value: value.toString() },
    );
  }
  return value;
}

function postgresBigInt(value: bigint, field: string): bigint {
  if (value < BigInt(0) || value > BigInt("9223372036854775807")) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_COST",
      `${field} must fit a nonnegative PostgreSQL bigint`,
      { field, value: value.toString() },
    );
  }
  return value;
}

function nonblank(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_IDENTITY",
      `${field} must contain between 1 and ${maximum} characters`,
      { field },
    );
  }
  return normalized;
}

function validateAuditInput(input: {
  claimId: bigint;
  orderId: number;
  actor: string;
  occurredAt: Date;
  reason?: string;
}): void {
  positiveBigInt(input.claimId, "claim.id");
  positiveInteger(input.orderId, "order.id");
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_TIMESTAMP",
      "Canonical inventory mutation time must be a valid Date.",
    );
  }
  if (input.actor.trim() === "" || (input.reason != null && input.reason.trim() === "")) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_AUDIT_ACTOR",
      "Canonical inventory mutations require a nonblank actor and, for release, a nonblank reason.",
    );
  }
}

export class CanonicalClaimInventoryMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CanonicalClaimInventoryMutationError";
  }
}

async function lockLevel(
  client: CanonicalClaimTransactionClient,
  inventoryLevelId: number,
): Promise<any> {
  return rows(await client.query(
    `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty
     FROM inventory.inventory_levels
     WHERE id = $1
     FOR UPDATE`,
    [inventoryLevelId],
  ))[0];
}

export class PostgresCanonicalClaimInventoryRepository implements CanonicalClaimInventoryMutationPort {
  async reserveResource(
    input: Parameters<CanonicalClaimInventoryMutationPort["reserveResource"]>[0],
  ): Promise<readonly CanonicalClaimLotAllocation[]> {
    validateAuditInput(input);
    positiveBigInt(input.claimResourceId, "claimResource.id");
    positiveInteger(input.inventoryLevelId, "inventoryLevel.id");
    positiveInteger(input.warehouseLocationId, "warehouseLocation.id");
    positiveInteger(input.sourceVariantId, "sourceVariant.id");
    positiveInteger(input.orderItemId, "orderItem.id");
    const claimedQty = positiveInteger(input.claimedQty, "claimResource.claimedQty");
    const level = await lockLevel(input.client, input.inventoryLevelId);
    if (!level
      || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== input.warehouseLocationId
      || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== input.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RESOURCE_CHANGED",
        "A planned inventory resource no longer matches its locked level identity.",
        {
          inventoryLevelId: input.inventoryLevelId,
          warehouseLocationId: input.warehouseLocationId,
          sourceVariantId: input.sourceVariantId,
        },
      );
    }
    const variantQty = nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty");
    const reservedQty = nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty");
    if (variantQty - reservedQty < claimedQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RESOURCE_CONFLICT",
        "A locked inventory resource no longer has enough unreserved physical stock.",
        { inventoryLevelId: input.inventoryLevelId, claimedQty, variantQty, reservedQty },
      );
    }

    const lotRows = rows(await input.client.query(
      `SELECT id, qty_on_hand, qty_reserved,
              unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
              landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
              po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
              total_unit_cost_mills
       FROM inventory.inventory_lots
       WHERE product_variant_id = $1
         AND warehouse_location_id = $2
         AND status = 'active'
       ORDER BY received_at, id
       FOR UPDATE`,
      [input.sourceVariantId, input.warehouseLocationId],
    ));
    let remaining = claimedQty;
    const allocations: CanonicalClaimLotAllocation[] = [];
    for (const lot of lotRows) {
      if (remaining === 0) break;
      const lotOnHand = nonnegativeInteger(lot.qty_on_hand, "inventoryLot.qtyOnHand");
      const lotReserved = nonnegativeInteger(lot.qty_reserved, "inventoryLot.qtyReserved");
      const take = Math.min(Math.max(0, lotOnHand - lotReserved), remaining);
      if (take === 0) continue;
      const inventoryLotId = positiveInteger(lot.id, "inventoryLot.id");
      let normalizedCosts: ReturnType<typeof normalizeBuildLotCosts>;
      try {
        normalizedCosts = normalizeBuildLotCosts(lot);
      } catch (cause) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A FIFO lot has invalid cost evidence and cannot be owned by a canonical claim.",
          { inventoryLotId, cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      allocations.push({
        inventoryLotId,
        qty: take,
        unitCostMills: normalizedCosts.totalMills,
        poUnitCostMills: normalizedCosts.poMills,
        packagingUnitCostMills: normalizedCosts.packagingMills,
        landedUnitCostMills: normalizedCosts.landedMills,
      });
      remaining -= take;
    }
    if (remaining !== 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_SHORTFALL",
        "Canonical claiming requires exact FIFO lot ownership for every reserved source unit.",
        {
          inventoryLevelId: input.inventoryLevelId,
          requestedQty: claimedQty,
          attributedQty: claimedQty - remaining,
        },
      );
    }
    for (const allocation of allocations) {
      const updated = await input.client.query(
        `UPDATE inventory.inventory_lots
         SET qty_reserved = qty_reserved + $1
         WHERE id = $2 AND qty_reserved + $1 <= qty_on_hand`,
        [allocation.qty, allocation.inventoryLotId],
      );
      if (updated.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_CONFLICT",
          "A locked FIFO lot changed while the canonical claim was being persisted.",
          { inventoryLotId: allocation.inventoryLotId, take: allocation.qty },
        );
      }
    }

    const updatedLevel = await input.client.query(
      `UPDATE inventory.inventory_levels
       SET reserved_qty = reserved_qty + $1, updated_at = $3
       WHERE id = $2 AND reserved_qty + $1 <= variant_qty`,
      [claimedQty, input.inventoryLevelId, input.occurredAt],
    );
    if (updatedLevel.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LEVEL_CONFLICT",
        "A locked inventory level changed while the canonical claim was being persisted.",
        { inventoryLevelId: input.inventoryLevelId, claimedQty },
      );
    }
    await input.client.query(
      `INSERT INTO inventory.inventory_transactions (
         product_variant_id, to_location_id, transaction_type,
         variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
         source_state, target_state, order_id, order_item_id,
         reference_type, reference_id, user_id, notes, created_at
       ) VALUES ($1, $2, 'reserve', 0, $3, $3, $4, 'on_hand', 'committed',
                 $5, $6, 'availability_claim', $7, $8, $9, $10)`,
      [
        input.sourceVariantId,
        input.warehouseLocationId,
        variantQty,
        claimedQty,
        input.orderId,
        input.orderItemId,
        `claim:${input.claimId}:resource:${input.claimResourceId}`,
        input.actor,
        input.consumerOperationKey == null
          ? "Canonical direct finished allocation"
          : `Canonical source allocation for operation ${input.consumerOperationKey}`,
        input.occurredAt,
      ],
    );
    return allocations;
  }

  async executePackageOperation(
    input: Parameters<CanonicalClaimInventoryMutationPort["executePackageOperation"]>[0],
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executePackageOperation"]>>> {
    return this.executeTransformationOperation(input);
  }

  async executeBuildOperation(
    input: Parameters<CanonicalClaimInventoryMutationPort["executeBuildOperation"]>[0],
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executeBuildOperation"]>>> {
    return this.executeTransformationOperation(input);
  }

  private async executeTransformationOperation(
    input: CanonicalTransformationExecutionInput,
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executePackageOperation"]>>> {
    validateAuditInput(input);
    positiveBigInt(input.claimOperationId, "claimOperation.id");
    const operationKey = nonblank(input.operationKey, "operation.key", 300);
    const outputLocationId = positiveInteger(input.outputLocationId, "operation.outputLocationId");
    const destinationVariantId = positiveInteger(input.destinationVariantId, "operation.destinationVariantId");
    const outputQty = positivePostgresInteger(input.outputQty, "operation.outputQty");
    const committedOutputQty = positivePostgresInteger(
      input.committedOutputQty,
      "operation.committedOutputQty",
    );
    if (committedOutputQty > outputQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OPERATION_OUTPUT_OVERCOMMITTED",
        "Committed claim output cannot exceed physical transformation output.",
        { outputQty, committedOutputQty },
      );
    }
    if (input.resources.length === 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OPERATION_INPUTS_MISSING",
        "A transformation requires exact claim-owned source resources.",
      );
    }
    if (input.resources.some((resource) => resource.sourceVariantId === destinationVariantId)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OPERATION_SELF_TRANSFORMATION",
        "A transformation cannot consume and produce the same variant.",
        { destinationVariantId },
      );
    }

    const build = "build" in input ? input.build : null;
    const buildComponentsByVariant = new Map<number, number>();
    if (build) {
      positiveInteger(build.buildOrderId, "buildOrder.id");
      positiveInteger(build.buildRunId, "buildRun.id");
      positiveInteger(build.buildRunNumber, "buildRun.runNumber");
      nonblank(build.buildSystemNumber, "buildOrder.systemNumber", 40);
      for (const component of build.components) {
        const sourceVariantId = positiveInteger(component.sourceVariantId, "buildComponent.sourceVariantId");
        const buildOrderComponentId = positiveInteger(
          component.buildOrderComponentId,
          "buildComponent.id",
        );
        if (buildComponentsByVariant.has(sourceVariantId)) {
          throw new CanonicalClaimInventoryMutationError(
            "DUPLICATE_CLAIM_BUILD_COMPONENT",
            "A claim build may contain only one immutable component snapshot per source variant.",
            { sourceVariantId },
          );
        }
        buildComponentsByVariant.set(sourceVariantId, buildOrderComponentId);
      }
    }

    const resources = [...input.resources].sort(compareExecutionResources);
    const seenResourceIds = new Set<string>();
    const seenLotAllocationIds = new Set<string>();
    const seenInventoryLotIds = new Set<number>();
    for (const resource of resources) {
      const resourceKey = positiveBigInt(resource.claimResourceId, "claimResource.id").toString();
      if (seenResourceIds.has(resourceKey)) {
        throw new CanonicalClaimInventoryMutationError(
          "DUPLICATE_CLAIM_EXECUTION_RESOURCE",
          "A claim resource may be consumed only once in an operation execution.",
          { claimResourceId: resourceKey },
        );
      }
      seenResourceIds.add(resourceKey);
      positiveInteger(resource.inventoryLevelId, "inventoryLevel.id");
      positiveInteger(resource.warehouseLocationId, "warehouseLocation.id");
      positiveInteger(resource.sourceVariantId, "sourceVariant.id");
      positivePostgresInteger(resource.consumeQty, "claimResource.consumeQty");
      let lotTotal = BigInt(0);
      for (const allocation of resource.lotAllocations) {
        const allocationKey = positiveBigInt(
          allocation.claimLotAllocationId,
          "claimLotAllocation.id",
        ).toString();
        const inventoryLotId = positiveInteger(allocation.inventoryLotId, "inventoryLot.id");
        if (seenLotAllocationIds.has(allocationKey) || seenInventoryLotIds.has(inventoryLotId)) {
          throw new CanonicalClaimInventoryMutationError(
            "DUPLICATE_CLAIM_EXECUTION_LOT",
            "An exact claim lot allocation and physical FIFO lot may be consumed only once per operation.",
            { claimLotAllocationId: allocationKey, inventoryLotId },
          );
        }
        seenLotAllocationIds.add(allocationKey);
        seenInventoryLotIds.add(inventoryLotId);
        positivePostgresInteger(allocation.consumeQty, "claimLotAllocation.consumeQty");
        const total = postgresBigInt(allocation.unitCostMills, "claimLotAllocation.unitCostMills");
        const po = postgresBigInt(allocation.poUnitCostMills, "claimLotAllocation.poUnitCostMills");
        const packaging = postgresBigInt(
          allocation.packagingUnitCostMills,
          "claimLotAllocation.packagingUnitCostMills",
        );
        const landed = postgresBigInt(
          allocation.landedUnitCostMills,
          "claimLotAllocation.landedUnitCostMills",
        );
        if (po + packaging + landed !== total) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_LOT_COST_LINEAGE_MISMATCH",
            "Claim-owned lot cost components do not reconcile to their authoritative total.",
            { claimLotAllocationId: allocationKey, inventoryLotId },
          );
        }
        lotTotal += allocation.consumeQty;
      }
      if (lotTotal !== resource.consumeQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_EXECUTION_LINEAGE_MISMATCH",
          "Exact open lot allocations do not reconcile to their claim resource.",
          {
            claimResourceId: resourceKey,
            resourceQty: resource.consumeQty.toString(),
            lotQty: lotTotal.toString(),
          },
        );
      }
    }

    await input.client.query(
      `INSERT INTO inventory.inventory_levels (
         product_variant_id, warehouse_location_id, variant_qty, reserved_qty,
         picked_qty, packed_qty, backorder_qty, updated_at
       ) VALUES ($1, $2, 0, 0, 0, 0, 0, $3)
       ON CONFLICT (product_variant_id, warehouse_location_id) DO NOTHING`,
      [destinationVariantId, outputLocationId, input.occurredAt],
    );

    const inputLevelIds = [...new Set(resources.map((resource) => resource.inventoryLevelId))];
    const levelRows = rows(await input.client.query(
      `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty
       FROM inventory.inventory_levels
       WHERE id = ANY($1::integer[])
          OR (product_variant_id = $2 AND warehouse_location_id = $3)
       ORDER BY warehouse_location_id, product_variant_id, id
       FOR UPDATE`,
      [inputLevelIds, destinationVariantId, outputLocationId],
    ));
    const levelsById = new Map(
      levelRows.map((level) => [positiveInteger(level.id, "inventoryLevel.id"), level] as const),
    );
    const outputLevel = levelRows.find((level) =>
      positiveInteger(level.product_variant_id, "inventoryLevel.variantId") === destinationVariantId
      && positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") === outputLocationId);
    if (!outputLevel) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OUTPUT_LEVEL_MISSING",
        "The transformation output inventory level could not be created and locked.",
        { destinationVariantId, outputLocationId },
      );
    }

    const consumeByLevel = new Map<number, number>();
    for (const resource of resources) {
      const level = levelsById.get(resource.inventoryLevelId);
      if (!level
        || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
        || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_RESOURCE_CHANGED",
          "A claim-owned transformation resource no longer matches its inventory level.",
          { claimResourceId: resource.claimResourceId.toString(), inventoryLevelId: resource.inventoryLevelId },
        );
      }
      const consumeQty = positivePostgresInteger(resource.consumeQty, "claimResource.consumeQty");
      consumeByLevel.set(
        resource.inventoryLevelId,
        (consumeByLevel.get(resource.inventoryLevelId) ?? 0) + consumeQty,
      );
    }
    for (const [levelId, consumeQty] of consumeByLevel) {
      const level = levelsById.get(levelId)!;
      if (nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty") < consumeQty
        || nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty") < consumeQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_EXECUTION_CONFLICT",
          "A claim-owned source level no longer contains its exact physical and reserved quantities.",
          { levelId, consumeQty },
        );
      }
    }

    const allocationEntries = resources.flatMap((resource) => resource.lotAllocations.map((allocation) => ({
      resource,
      allocation,
    }))).sort((left, right) =>
      left.resource.warehouseLocationId - right.resource.warehouseLocationId
      || left.resource.sourceVariantId - right.resource.sourceVariantId
      || left.allocation.inventoryLotId - right.allocation.inventoryLotId);
    const inventoryLotIds = allocationEntries.map(({ allocation }) => allocation.inventoryLotId);
    const lotRows = rows(await input.client.query(
      `SELECT id, product_variant_id, warehouse_location_id, qty_on_hand, qty_reserved,
              qty_picked, status, received_at, unit_cost_cents, po_unit_cost_cents,
              packaging_cost_cents, landed_cost_cents, total_unit_cost_cents,
              unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
              landed_cost_mills, total_unit_cost_mills
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [inventoryLotIds],
    ));
    const lotsById = new Map(
      lotRows.map((lot) => [positiveInteger(lot.id, "inventoryLot.id"), lot] as const),
    );
    if (lotsById.size !== inventoryLotIds.length) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_EXECUTION_LOT_MISSING",
        "One or more exact claim-owned FIFO lots no longer exist.",
        { requestedLotIds: inventoryLotIds, lockedLotIds: [...lotsById.keys()] },
      );
    }

    const totalCosts = { poMills: BigInt(0), packagingMills: BigInt(0), landedMills: BigInt(0) };
    for (const { resource, allocation } of allocationEntries) {
      const lot = lotsById.get(allocation.inventoryLotId)!;
      const consumeQty = positivePostgresInteger(allocation.consumeQty, "claimLotAllocation.consumeQty");
      if (positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId
        || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_EXECUTION_LOT_IDENTITY_CHANGED",
          "An exact claim-owned FIFO lot no longer matches its resource identity.",
          { inventoryLotId: allocation.inventoryLotId, claimResourceId: resource.claimResourceId.toString() },
        );
      }
      if (String(lot.status) !== "active") {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_EXECUTION_LOT_INACTIVE",
          "An exact claim-owned FIFO lot is no longer active.",
          { inventoryLotId: allocation.inventoryLotId, status: lot.status },
        );
      }
      if (nonnegativeInteger(lot.qty_on_hand, "inventoryLot.qtyOnHand") < consumeQty
        || nonnegativeInteger(lot.qty_reserved, "inventoryLot.qtyReserved") < consumeQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_EXECUTION_CONFLICT",
          "An exact claim-owned FIFO lot no longer contains its physical and reserved quantities.",
          { inventoryLotId: allocation.inventoryLotId, consumeQty },
        );
      }
      let liveCosts: ReturnType<typeof normalizeBuildLotCosts>;
      try {
        liveCosts = normalizeBuildLotCosts(lot);
      } catch (cause) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A claim-owned source lot has invalid current cost evidence.",
          { inventoryLotId: allocation.inventoryLotId, cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      if (liveCosts.totalMills !== allocation.unitCostMills
        || liveCosts.poMills !== allocation.poUnitCostMills
        || liveCosts.packagingMills !== allocation.packagingUnitCostMills
        || liveCosts.landedMills !== allocation.landedUnitCostMills) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_COST_CHANGED",
          "A claim-owned source lot was re-costed after the claim and must be replanned before execution.",
          { inventoryLotId: allocation.inventoryLotId },
        );
      }
      const multiplier = BigInt(consumeQty);
      totalCosts.poMills += allocation.poUnitCostMills * multiplier;
      totalCosts.packagingMills += allocation.packagingUnitCostMills * multiplier;
      totalCosts.landedMills += allocation.landedUnitCostMills * multiplier;
    }

    const runningLevels = new Map<number, { variantQty: number; reservedQty: number }>(
      [...levelsById].map(([id, level]) => [id, {
        variantQty: nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty"),
        reservedQty: nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty"),
      }]),
    );
    const referenceId = `claim:${input.claimId}:operation:${input.claimOperationId}`;
    for (const { resource, allocation } of allocationEntries) {
      const consumeQty = positivePostgresInteger(allocation.consumeQty, "claimLotAllocation.consumeQty");
      const updatedLot = await input.client.query(
        `UPDATE inventory.inventory_lots
         SET qty_on_hand = qty_on_hand - $1,
             qty_reserved = qty_reserved - $1,
             qty_consumed = COALESCE(qty_consumed, 0) + $1,
             status = CASE
               WHEN qty_on_hand - $1 = 0 AND qty_reserved - $1 = 0 AND qty_picked = 0
               THEN 'depleted' ELSE status END
         WHERE id = $2 AND qty_on_hand >= $1 AND qty_reserved >= $1`,
        [consumeQty, allocation.inventoryLotId],
      );
      if (updatedLot.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_EXECUTION_CONFLICT",
          "An exact claim-owned FIFO lot changed while transformation consumption was posting.",
          { inventoryLotId: allocation.inventoryLotId, consumeQty },
        );
      }
      const running = runningLevels.get(resource.inventoryLevelId)!;
      const variantBefore = running.variantQty;
      running.variantQty -= consumeQty;
      running.reservedQty -= consumeQty;
      const transactionValues = [
        resource.sourceVariantId,
        resource.warehouseLocationId,
        -consumeQty,
        variantBefore,
        running.variantQty,
        buildMillsToRoundedCents(allocation.unitCostMills).toString(),
        allocation.inventoryLotId,
        input.orderId,
        input.orderItemId,
        referenceId,
        input.actor,
        input.reason,
        input.occurredAt,
      ];
      if (build) {
        const componentId = buildComponentsByVariant.get(resource.sourceVariantId);
        if (!componentId) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_BUILD_COMPONENT_MISSING",
            "A claim-owned build source has no matching immutable build component.",
            { sourceVariantId: resource.sourceVariantId },
          );
        }
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, from_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id,
             build_order_id, build_order_component_id, build_run_id,
             user_id, notes, created_at
           ) VALUES ($1, $2, 'assemble', $3, $4, $5, $3, 'committed', 'consumed',
                     $6, $7, $8, $9, 'availability_claim_operation', $10,
                     $14, $15, $16, $11, $12, $13)`,
          [...transactionValues, build.buildOrderId, componentId, build.buildRunId],
        );
      } else {
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, from_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'transform', $3, $4, $5, $3, 'committed', 'consumed',
                     $6, $7, $8, $9, 'availability_claim_operation', $10, $11, $12, $13)`,
          transactionValues,
        );
      }
    }
    for (const [levelId, consumeQty] of [...consumeByLevel].sort(([left], [right]) => left - right)) {
      const updatedLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET variant_qty = variant_qty - $1,
             reserved_qty = reserved_qty - $1,
             updated_at = $3
         WHERE id = $2 AND variant_qty >= $1 AND reserved_qty >= $1`,
        [consumeQty, levelId, input.occurredAt],
      );
      if (updatedLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_EXECUTION_CONFLICT",
          "A claim-owned source level changed while transformation consumption was posting.",
          { levelId, consumeQty },
        );
      }
    }

    const updatedOutputLevel = await input.client.query(
      `UPDATE inventory.inventory_levels
       SET variant_qty = variant_qty + $1,
           reserved_qty = reserved_qty + $2,
           updated_at = $4
       WHERE id = $3
         AND variant_qty <= 2147483647 - $1
         AND reserved_qty <= 2147483647 - $2`,
      [outputQty, committedOutputQty, outputLevel.id, input.occurredAt],
    );
    if (updatedOutputLevel.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OUTPUT_LEVEL_OVERFLOW",
        "The transformation output would overflow its inventory level.",
        { outputInventoryLevelId: outputLevel.id, outputQty, committedOutputQty },
      );
    }

    const outputLayers = allocateBuildCostLayers(totalCosts, outputQty);
    const outputSegments: Array<(typeof outputLayers)[number] & { reservedQty: number }> = [];
    let remainingCommitted = committedOutputQty;
    for (const layer of outputLayers) {
      const reservedQty = Math.min(layer.qty, remainingCommitted);
      if (reservedQty > 0) outputSegments.push({ ...layer, qty: reservedQty, reservedQty });
      if (reservedQty < layer.qty) {
        outputSegments.push({ ...layer, qty: layer.qty - reservedQty, reservedQty: 0 });
      }
      remainingCommitted -= reservedQty;
    }
    if (remainingCommitted !== 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OUTPUT_ALLOCATION_MISMATCH",
        "Produced cost layers could not satisfy the committed output quantity.",
        { committedOutputQty, remainingCommitted },
      );
    }

    const committedLotAllocations: CanonicalClaimProducedLotAllocation[] = [];
    let outputVariantBefore = nonnegativeInteger(outputLevel.variant_qty, "outputInventoryLevel.variantQty");
    for (const [index, segment] of outputSegments.entries()) {
      const lotNumber = build
        ? `${build.buildSystemNumber}-R${build.buildRunNumber}-${String(index + 1).padStart(2, "0")}`
        : `CLM-${input.claimId}-${input.claimOperationId}-${String(index + 1).padStart(2, "0")}`;
      if (lotNumber.length > 50) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OUTPUT_LOT_IDENTITY_OVERFLOW",
          "The deterministic claim output lot number exceeds its database limit.",
          { lotNumber },
        );
      }
      postgresBigInt(segment.totalMills, "outputLot.totalUnitCostMills");
      postgresBigInt(segment.poMills, "outputLot.poUnitCostMills");
      postgresBigInt(segment.packagingMills, "outputLot.packagingUnitCostMills");
      postgresBigInt(segment.landedMills, "outputLot.landedUnitCostMills");
      const totalCostCents = buildMillsToRoundedCents(segment.totalMills).toString();
      const lotValues = [
        lotNumber,
        destinationVariantId,
        outputLocationId,
        totalCostCents,
        buildMillsToRoundedCents(segment.poMills).toString(),
        buildMillsToRoundedCents(segment.packagingMills).toString(),
        buildMillsToRoundedCents(segment.landedMills).toString(),
        segment.totalMills.toString(),
        segment.poMills.toString(),
        segment.packagingMills.toString(),
        segment.landedMills.toString(),
        segment.qty,
        segment.reservedQty,
        input.occurredAt,
        build
          ? `Output from canonical claim build ${build.buildSystemNumber}`
          : `Output from canonical operation ${operationKey}`,
      ];
      const insertedLot = rows(await input.client.query(
        build
          ? `INSERT INTO inventory.inventory_lots (
               lot_number, product_variant_id, warehouse_location_id, build_order_id, build_run_id,
               unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
               landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
               po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
               total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
               qty_picked, qty_consumed, received_at, status, cost_provisional,
               cost_source, notes, created_at
             ) VALUES ($1, $2, $3, $16, $17, $4, $5, $6, $7, $4, $8, $9, $10, $11, $8,
                       $12, $12, $13, 0, 0, $14, 'active', 0, 'build', $15, $14)
             RETURNING id`
          : `INSERT INTO inventory.inventory_lots (
               lot_number, product_variant_id, warehouse_location_id,
               unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
               landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
               po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
               total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
               qty_picked, qty_consumed, received_at, status, cost_provisional,
               cost_source, notes, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $8, $9, $10, $11, $8,
                       $12, $12, $13, 0, 0, $14, 'active', 0, 'transformation', $15, $14)
             RETURNING id`,
        build ? [...lotValues, build.buildOrderId, build.buildRunId] : lotValues,
      ))[0];
      const outputLotId = positiveInteger(insertedLot?.id, "outputInventoryLot.id");
      const outputTransactionValues = [
        destinationVariantId,
        outputLocationId,
        segment.qty,
        outputVariantBefore,
        outputVariantBefore + segment.qty,
        segment.reservedQty,
        segment.reservedQty > 0 ? "committed" : "on_hand",
        totalCostCents,
        outputLotId,
        input.orderId,
        input.orderItemId,
        referenceId,
        input.actor,
        input.reason,
        input.occurredAt,
      ];
      if (build) {
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, to_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id,
             build_order_id, build_run_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'assemble', $3, $4, $5, $6, 'built', $7,
                     $8, $9, $10, $11, 'availability_claim_operation', $12,
                     $16, $17, $13, $14, $15)`,
          [...outputTransactionValues, build.buildOrderId, build.buildRunId],
        );
      } else {
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, to_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'transform', $3, $4, $5, $6, 'transformed', $7,
                     $8, $9, $10, $11, 'availability_claim_operation', $12, $13, $14, $15)`,
          outputTransactionValues,
        );
      }
      outputVariantBefore += segment.qty;
      if (segment.reservedQty > 0) {
        committedLotAllocations.push({
          inventoryLotId: outputLotId,
          qty: segment.reservedQty,
          unitCostMills: segment.totalMills,
          poUnitCostMills: segment.poMills,
          packagingUnitCostMills: segment.packagingMills,
          landedUnitCostMills: segment.landedMills,
        });
      }
    }

    const totalInputCostMills = totalCosts.poMills + totalCosts.packagingMills + totalCosts.landedMills;
    return {
      outputInventoryLevelId: positiveInteger(outputLevel.id, "outputInventoryLevel.id"),
      committedLotAllocations,
      totalInputCostMills,
    };
  }

  async releaseResources(
    input: Parameters<CanonicalClaimInventoryMutationPort["releaseResources"]>[0],
  ): Promise<void> {
    validateAuditInput(input);
    if (input.resources.length === 0) return;
    for (const resource of input.resources) {
      positiveBigInt(resource.claimResourceId, "claimResource.id");
      positiveInteger(resource.inventoryLevelId, "inventoryLevel.id");
      positiveInteger(resource.warehouseLocationId, "warehouseLocation.id");
      positiveInteger(resource.sourceVariantId, "sourceVariant.id");
      positiveInteger(resource.orderItemId, "orderItem.id");
      for (const allocation of resource.lotAllocations) {
        positiveInteger(allocation.inventoryLotId, "inventoryLot.id");
      }
    }
    const orderedResources = [...input.resources].sort(compareReleaseResources);
    assertUniqueReleaseResources(orderedResources);

    const levelIds = [...new Set(orderedResources.map((resource) => resource.inventoryLevelId))];
    const levelRows = rows(await input.client.query(
      `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty
       FROM inventory.inventory_levels
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, id
       FOR UPDATE`,
      [levelIds],
    ));
    const levelsById = new Map(levelRows.map((level) => [positiveInteger(level.id, "inventoryLevel.id"), level] as const));
    if (levelsById.size !== levelIds.length) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LEVEL_RELEASE_MISSING",
        "One or more exact claim-owned inventory levels no longer exist.",
        { requestedLevelIds: levelIds, lockedLevelIds: [...levelsById.keys()] },
      );
    }

    const lotIds = [...new Set(
      orderedResources.flatMap((resource) => resource.lotAllocations.map((allocation) => allocation.inventoryLotId)),
    )];
    const lotRows = lotIds.length === 0 ? [] : rows(await input.client.query(
      `SELECT id, warehouse_location_id, product_variant_id, qty_reserved
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [lotIds],
    ));
    const lotsById = new Map(lotRows.map((lot) => [positiveInteger(lot.id, "inventoryLot.id"), lot] as const));
    if (lotsById.size !== lotIds.length) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_RELEASE_MISSING",
        "One or more exact claim-owned FIFO lots no longer exist.",
        { requestedLotIds: lotIds, lockedLotIds: [...lotsById.keys()] },
      );
    }

    const releaseByLevel = new Map<number, bigint>();
    const releaseByLot = new Map<number, bigint>();
    for (const resource of orderedResources) {
      validateReleaseResource(resource, levelsById, lotsById);
      releaseByLevel.set(
        resource.inventoryLevelId,
        (releaseByLevel.get(resource.inventoryLevelId) ?? BigInt(0)) + resource.releaseQty,
      );
      for (const allocation of resource.lotAllocations) {
        releaseByLot.set(
          allocation.inventoryLotId,
          (releaseByLot.get(allocation.inventoryLotId) ?? BigInt(0)) + allocation.releaseQty,
        );
      }
    }
    assertLockedBalances(releaseByLevel, levelsById, "inventoryLevel");
    assertLockedBalances(releaseByLot, lotsById, "inventoryLot");

    for (const resource of orderedResources) {
      for (const allocation of resource.lotAllocations) {
        const releaseQty = positivePostgresInteger(allocation.releaseQty, "claimLot.releaseQty");
        const updatedLot = await input.client.query(
          `UPDATE inventory.inventory_lots
           SET qty_reserved = qty_reserved - $1
           WHERE id = $2 AND qty_reserved >= $1`,
          [releaseQty, allocation.inventoryLotId],
        );
        if (updatedLot.rowCount !== 1) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_LOT_RELEASE_CONFLICT",
            "An exact claim-owned FIFO lot changed while its release was being posted.",
            { inventoryLotId: allocation.inventoryLotId, releaseQty },
          );
        }
      }
      const releaseQty = positivePostgresInteger(resource.releaseQty, "claimResource.releaseQty");
      const updatedLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET reserved_qty = reserved_qty - $1, updated_at = $3
         WHERE id = $2 AND reserved_qty >= $1`,
        [releaseQty, resource.inventoryLevelId, input.occurredAt],
      );
      if (updatedLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_RELEASE_CONFLICT",
          "A claim-owned inventory level changed while its release was being posted.",
          { inventoryLevelId: resource.inventoryLevelId, releaseQty },
        );
      }
      const level = levelsById.get(resource.inventoryLevelId)!;
      const variantQty = nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty");
      await input.client.query(
        `INSERT INTO inventory.inventory_transactions (
           product_variant_id, from_location_id, transaction_type,
           variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
           source_state, target_state, order_id, order_item_id,
           reference_type, reference_id, user_id, notes, created_at
         ) VALUES ($1, $2, 'unreserve', 0, $3, $3, $4, 'committed', 'on_hand',
                   $5, $6, 'availability_claim_release', $7, $8, $9, $10)`,
        [
          resource.sourceVariantId,
          resource.warehouseLocationId,
          variantQty,
          -releaseQty,
          input.orderId,
          resource.orderItemId,
          `claim:${input.claimId}:resource:${resource.claimResourceId}`,
          input.actor,
          input.reason,
          input.occurredAt,
        ],
      );
    }
  }
}

function compareExecutionResources(
  left: CanonicalClaimInventoryExecutionResource,
  right: CanonicalClaimInventoryExecutionResource,
): number {
  return left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || (left.claimResourceId < right.claimResourceId ? -1 : left.claimResourceId > right.claimResourceId ? 1 : 0);
}

function compareReleaseResources(
  left: CanonicalClaimInventoryReleaseResource,
  right: CanonicalClaimInventoryReleaseResource,
): number {
  return left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || (left.claimResourceId < right.claimResourceId ? -1 : left.claimResourceId > right.claimResourceId ? 1 : 0);
}

function assertUniqueReleaseResources(resources: readonly CanonicalClaimInventoryReleaseResource[]): void {
  const claimResourceIds = new Set<string>();
  for (const resource of resources) {
    const key = resource.claimResourceId.toString();
    if (claimResourceIds.has(key)) {
      throw new CanonicalClaimInventoryMutationError(
        "DUPLICATE_CLAIM_RESOURCE_RELEASE",
        "A canonical claim resource may appear only once in a release batch.",
        { claimResourceId: key },
      );
    }
    claimResourceIds.add(key);
  }
}

function validateReleaseResource(
  resource: CanonicalClaimInventoryReleaseResource,
  levelsById: ReadonlyMap<number, any>,
  lotsById: ReadonlyMap<number, any>,
): void {
  positivePostgresInteger(resource.releaseQty, "claimResource.releaseQty");
  const level = levelsById.get(resource.inventoryLevelId);
  if (!level
    || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
    || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_RESOURCE_CHANGED",
      "A claim-owned inventory resource no longer matches its level identity.",
      { claimResourceId: resource.claimResourceId.toString(), inventoryLevelId: resource.inventoryLevelId },
    );
  }
  const seenLotIds = new Set<number>();
  let lotReleaseTotal = BigInt(0);
  for (const allocation of resource.lotAllocations) {
    positivePostgresInteger(allocation.releaseQty, "claimLot.releaseQty");
    if (seenLotIds.has(allocation.inventoryLotId)) {
      throw new CanonicalClaimInventoryMutationError(
        "DUPLICATE_CLAIM_LOT_RELEASE",
        "A FIFO lot may appear only once for a claim resource release.",
        { claimResourceId: resource.claimResourceId.toString(), inventoryLotId: allocation.inventoryLotId },
      );
    }
    seenLotIds.add(allocation.inventoryLotId);
    const lot = lotsById.get(allocation.inventoryLotId);
    if (!lot
      || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId
      || positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_RELEASE_IDENTITY_CHANGED",
        "An exact claim-owned FIFO lot no longer matches its resource identity.",
        { claimResourceId: resource.claimResourceId.toString(), inventoryLotId: allocation.inventoryLotId },
      );
    }
    lotReleaseTotal += allocation.releaseQty;
  }
  if (lotReleaseTotal !== resource.releaseQty) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_RELEASE_LINEAGE_MISMATCH",
      "The exact open lot allocation does not reconcile to its claim resource.",
      {
        claimResourceId: resource.claimResourceId.toString(),
        resourceOpenQty: resource.releaseQty.toString(),
        lotOpenQty: lotReleaseTotal.toString(),
      },
    );
  }
}

function assertLockedBalances(
  releases: ReadonlyMap<number, bigint>,
  rowsById: ReadonlyMap<number, any>,
  entity: "inventoryLevel" | "inventoryLot",
): void {
  for (const [id, releaseQty] of releases) {
    const row = rowsById.get(id);
    const reservedQty = BigInt(nonnegativeInteger(
      entity === "inventoryLevel" ? row?.reserved_qty : row?.qty_reserved,
      `${entity}.reservedQty`,
    ));
    if (reservedQty < releaseQty) {
      throw new CanonicalClaimInventoryMutationError(
        entity === "inventoryLevel" ? "CLAIM_LEVEL_RELEASE_CONFLICT" : "CLAIM_LOT_RELEASE_CONFLICT",
        `A claim-owned ${entity === "inventoryLevel" ? "inventory level" : "FIFO lot"} does not contain the aggregate reserved quantity being released.`,
        { id, releaseQty: releaseQty.toString(), reservedQty: reservedQty.toString() },
      );
    }
  }
}
