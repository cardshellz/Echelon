import type {
  CanonicalClaimInventoryReleaseResource,
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimLotAllocation,
  CanonicalClaimTransactionClient,
} from "../../inventory-planning/application/canonical-claim-inventory.port";

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

function nonnegativeBigInt(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < BigInt(0) || parsed > BigInt("9223372036854775807")) throw new Error("outside range");
    return parsed;
  } catch (cause) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative PostgreSQL bigint`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
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
              COALESCE(total_unit_cost_mills, unit_cost_mills, 0) AS unit_cost_mills
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
      const unitCostMills = nonnegativeBigInt(lot.unit_cost_mills ?? 0, "inventoryLot.unitCostMills");
      allocations.push({ inventoryLotId, qty: take, unitCostMills });
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
