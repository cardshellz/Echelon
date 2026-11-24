import type { PoolClient } from "pg";

import type {
  CanonicalAvailabilityClaimPickCommand,
  CanonicalAvailabilityClaimPickResult,
  CanonicalAvailabilityClaimUnpickCommand,
} from "@shared/types/inventory-availability-claims";
import { commitCanonicalPickingReceipt } from "../../../wms/picking-execution.api";
import type {
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimInventoryPickResource,
  CanonicalClaimInventoryReleaseResource,
} from "../../application/canonical-claim-inventory.port";
import type {
  CanonicalClaimPickerObservationReviewMetadata,
  CanonicalClaimPickerObservationReviewPort,
} from "../../application/canonical-claim-picker-observation-review.port";
import {
  remoteConversionScope,
  selectRemoteConversionsToReplace,
  type RemoteConversionCandidate,
  type RemoteConversionPick,
  type RemoteConversionScope,
} from "../../domain/claim-remote-conversion-replacement";
import { requirePickableLocation } from "./claim-order-and-locks";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  nonnegativeBigInt,
  openLotQty,
  openResourceQty,
  positiveBigInt,
  positiveInteger,
  rows,
  type FulfillmentClaim,
  type FulfillmentClaimLine,
  type FulfillmentClaimLot,
  type FulfillmentClaimResource,
} from "./claim-primitives";

export async function loadFulfillmentClaimLine(
  client: PoolClient,
  claimId: bigint,
  orderItemId: number,
): Promise<FulfillmentClaimLine> {
  const lineRow = rows(await client.query(
    `SELECT id, order_item_id, target_variant_id, planned_qty,
            released_target_qty, consumed_target_qty, picked_target_qty
     FROM inventory.availability_claim_lines
     WHERE claim_id = $1 AND order_item_id = $2
     FOR UPDATE`,
    [claimId.toString(), orderItemId],
  ))[0];
  if (!lineRow) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_LINE_NOT_FOUND",
      "The requested order item does not belong to this canonical claim.",
      { claimId: claimId.toString(), orderItemId },
    );
  }
  const lineId = positiveBigInt(lineRow.id, "claimLine.id");
  const targetVariantId = positiveInteger(lineRow.target_variant_id, "claimLine.targetVariantId");
  const resourceRows = rows(await client.query(
    `SELECT id, inventory_level_id, warehouse_id, warehouse_location_id,
            source_variant_id, claimed_qty, released_qty, consumed_qty, picked_qty
     FROM inventory.availability_claim_resources
     WHERE claim_id = $1 AND claim_line_id = $2
       AND consumer_operation_key IS NULL
       AND source_variant_id = $3
     ORDER BY warehouse_id, warehouse_location_id, inventory_level_id, id
     FOR UPDATE`,
    [claimId.toString(), lineId.toString(), targetVariantId],
  ));
  const resourceIds = resourceRows.map((row) => positiveBigInt(row.id, "claimResource.id"));
  const lotRows = resourceIds.length === 0 ? [] : rows(await client.query(
    `SELECT id, claim_resource_id, inventory_lot_id, claimed_qty, released_qty,
            consumed_qty, picked_qty, unit_cost_mills, po_unit_cost_mills,
            packaging_unit_cost_mills, landed_unit_cost_mills
     FROM inventory.availability_claim_lot_allocations
     WHERE claim_resource_id = ANY($1::bigint[])
     ORDER BY claim_resource_id, inventory_lot_id, id
     FOR UPDATE`,
    [resourceIds.map(String)],
  ));
  const lotsByResource = new Map<string, FulfillmentClaimLot[]>();
  for (const row of lotRows) {
    if (row.po_unit_cost_mills == null
      || row.packaging_unit_cost_mills == null
      || row.landed_unit_cost_mills == null) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_COST_EVIDENCE_MISSING",
        "This claim lot predates exact cost lineage and must be replanned before fulfillment.",
        { claimLotAllocationId: String(row.id) },
      );
    }
    const lot: FulfillmentClaimLot = {
      id: positiveBigInt(row.id, "claimLot.id"),
      inventoryLotId: positiveInteger(row.inventory_lot_id, "claimLot.inventoryLotId"),
      claimedQty: positiveBigInt(row.claimed_qty, "claimLot.claimedQty"),
      releasedQty: nonnegativeBigInt(row.released_qty, "claimLot.releasedQty"),
      consumedQty: nonnegativeBigInt(row.consumed_qty, "claimLot.consumedQty"),
      pickedQty: nonnegativeBigInt(row.picked_qty, "claimLot.pickedQty"),
      unitCostMills: nonnegativeBigInt(row.unit_cost_mills, "claimLot.unitCostMills"),
      poUnitCostMills: nonnegativeBigInt(row.po_unit_cost_mills, "claimLot.poUnitCostMills"),
      packagingUnitCostMills: nonnegativeBigInt(row.packaging_unit_cost_mills, "claimLot.packagingUnitCostMills"),
      landedUnitCostMills: nonnegativeBigInt(row.landed_unit_cost_mills, "claimLot.landedUnitCostMills"),
    };
    const resourceKey = String(row.claim_resource_id);
    const existing = lotsByResource.get(resourceKey) ?? [];
    existing.push(lot);
    lotsByResource.set(resourceKey, existing);
  }
  const resources = resourceRows.map((row): FulfillmentClaimResource => {
    const resourceId = positiveBigInt(row.id, "claimResource.id");
    const resource: FulfillmentClaimResource = {
      id: resourceId,
      inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
      warehouseId: positiveInteger(row.warehouse_id, "claimResource.warehouseId"),
      warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
      sourceVariantId: positiveInteger(row.source_variant_id, "claimResource.sourceVariantId"),
      claimedQty: positiveBigInt(row.claimed_qty, "claimResource.claimedQty"),
      releasedQty: nonnegativeBigInt(row.released_qty, "claimResource.releasedQty"),
      consumedQty: nonnegativeBigInt(row.consumed_qty, "claimResource.consumedQty"),
      pickedQty: nonnegativeBigInt(row.picked_qty, "claimResource.pickedQty"),
      lots: lotsByResource.get(resourceId.toString()) ?? [],
    };
    const resourceOpen = openResourceQty(resource);
    const lotOpen = resource.lots.reduce((total, lot) => total + openLotQty(lot), BigInt(0));
    if (resourceOpen < BigInt(0) || resource.lots.some((lot) => openLotQty(lot) < BigInt(0))
      || resourceOpen !== lotOpen) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_LINEAGE_MISMATCH",
        "Open claim resource and lot balances do not reconcile before fulfillment.",
        { claimResourceId: resourceId.toString(), resourceOpen: resourceOpen.toString(), lotOpen: lotOpen.toString() },
      );
    }
    return resource;
  });
  const plannedQty = nonnegativeBigInt(lineRow.planned_qty, "claimLine.plannedQty");
  const releasedTargetQty = nonnegativeBigInt(lineRow.released_target_qty, "claimLine.releasedTargetQty");
  const consumedTargetQty = nonnegativeBigInt(lineRow.consumed_target_qty, "claimLine.consumedTargetQty");
  const pickedTargetQty = nonnegativeBigInt(lineRow.picked_target_qty, "claimLine.pickedTargetQty");
  if (releasedTargetQty + consumedTargetQty + pickedTargetQty > plannedQty) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLAIM_LINE_BALANCE",
      "The canonical claim line has released, consumed, or picked more than it planned.",
      { claimLineId: lineId.toString() },
    );
  }
  return {
    id: lineId,
    orderItemId: positiveInteger(lineRow.order_item_id, "claimLine.orderItemId"),
    targetVariantId,
    plannedQty,
    releasedTargetQty,
    consumedTargetQty,
    pickedTargetQty,
    resources,
  };
}

export function selectPickResources(
  line: FulfillmentClaimLine,
  warehouseLocationId: number,
  quantity: bigint,
): CanonicalClaimInventoryPickResource[] {
  let remaining = quantity;
  const selected: CanonicalClaimInventoryPickResource[] = [];
  for (const resource of line.resources.filter((entry) => entry.warehouseLocationId === warehouseLocationId)) {
    if (remaining === BigInt(0)) break;
    const resourceTake = openResourceQty(resource) < remaining ? openResourceQty(resource) : remaining;
    if (resourceTake <= BigInt(0)) continue;
    let lotRemaining = resourceTake;
    const lotAllocations: CanonicalClaimInventoryPickResource["lotAllocations"][number][] = [];
    for (const lot of resource.lots) {
      if (lotRemaining === BigInt(0)) break;
      const available = openLotQty(lot);
      const take = available < lotRemaining ? available : lotRemaining;
      if (take <= BigInt(0)) continue;
      lotAllocations.push({
        claimLotAllocationId: lot.id,
        inventoryLotId: lot.inventoryLotId,
        pickQty: take,
        unitCostMills: lot.unitCostMills,
        poUnitCostMills: lot.poUnitCostMills,
        packagingUnitCostMills: lot.packagingUnitCostMills,
        landedUnitCostMills: lot.landedUnitCostMills,
      });
      lotRemaining -= take;
    }
    if (lotRemaining !== BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_LINEAGE_MISMATCH",
        "The selected claim resource has insufficient exact open lot ownership.",
        { claimResourceId: resource.id.toString() },
      );
    }
    selected.push({
      claimResourceId: resource.id,
      inventoryLevelId: resource.inventoryLevelId,
      warehouseLocationId: resource.warehouseLocationId,
      sourceVariantId: resource.sourceVariantId,
      pickQty: resourceTake,
      lotAllocations,
    });
    remaining -= resourceTake;
  }
  if (remaining !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_SHORTFALL",
      "The selected location does not own enough open claim inventory for this pick.",
      { claimLineId: line.id.toString(), warehouseLocationId, requestedQty: quantity.toString(), shortfallQty: remaining.toString() },
    );
  }
  return selected;
}

function selectReconciliationReleases(
  line: FulfillmentClaimLine,
  selectedLocationId: number,
  quantity: bigint,
  sourceWarehouseId?: number,
): Array<{
  inventory: CanonicalClaimInventoryReleaseResource;
  allocations: readonly {
    allocationId: bigint;
    inventoryLotId: number;
    releaseQty: bigint;
    unitCostMills: bigint;
    poUnitCostMills: bigint;
    packagingUnitCostMills: bigint;
    landedUnitCostMills: bigint;
  }[];
}> {
  let remaining = quantity;
  const releases: Array<{
    inventory: CanonicalClaimInventoryReleaseResource;
    allocations: readonly {
      allocationId: bigint;
      inventoryLotId: number;
      releaseQty: bigint;
      unitCostMills: bigint;
      poUnitCostMills: bigint;
      packagingUnitCostMills: bigint;
      landedUnitCostMills: bigint;
    }[];
  }> = [];
  for (const resource of line.resources.filter((entry) =>
    entry.warehouseLocationId !== selectedLocationId
    && (sourceWarehouseId == null || entry.warehouseId === sourceWarehouseId))) {
    if (remaining === BigInt(0)) break;
    const take = openResourceQty(resource) < remaining ? openResourceQty(resource) : remaining;
    if (take <= BigInt(0)) continue;
    let lotRemaining = take;
    const allocations: Array<{
      allocationId: bigint;
      inventoryLotId: number;
      releaseQty: bigint;
      unitCostMills: bigint;
      poUnitCostMills: bigint;
      packagingUnitCostMills: bigint;
      landedUnitCostMills: bigint;
    }> = [];
    for (const lot of resource.lots) {
      if (lotRemaining === BigInt(0)) break;
      const available = openLotQty(lot);
      const lotTake = available < lotRemaining ? available : lotRemaining;
      if (lotTake <= BigInt(0)) continue;
      allocations.push({
        allocationId: lot.id,
        inventoryLotId: lot.inventoryLotId,
        releaseQty: lotTake,
        unitCostMills: lot.unitCostMills,
        poUnitCostMills: lot.poUnitCostMills,
        packagingUnitCostMills: lot.packagingUnitCostMills,
        landedUnitCostMills: lot.landedUnitCostMills,
      });
      lotRemaining -= lotTake;
    }
    if (lotRemaining !== BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_LINEAGE_MISMATCH",
        "The source claim resource has insufficient exact lot ownership for reconciliation.",
        { claimResourceId: resource.id.toString() },
      );
    }
    releases.push({
      inventory: {
        claimResourceId: resource.id,
        inventoryLevelId: resource.inventoryLevelId,
        warehouseLocationId: resource.warehouseLocationId,
        sourceVariantId: resource.sourceVariantId,
        releaseQty: take,
        lotAllocations: allocations.map(({ inventoryLotId, releaseQty }) => ({ inventoryLotId, releaseQty })),
        orderItemId: line.orderItemId,
      },
      allocations: allocations.map((allocation) => ({
        allocationId: allocation.allocationId,
        inventoryLotId: allocation.inventoryLotId,
        releaseQty: allocation.releaseQty,
        unitCostMills: allocation.unitCostMills,
        poUnitCostMills: allocation.poUnitCostMills,
        packagingUnitCostMills: allocation.packagingUnitCostMills,
        landedUnitCostMills: allocation.landedUnitCostMills,
      })),
    });
    remaining -= take;
  }
  if (remaining !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_RECONCILIATION_SOURCE_SHORTFALL",
      "The claim does not own enough open inventory at other locations to rebind this pick.",
      { claimLineId: line.id.toString(), requestedQty: quantity.toString(), shortfallQty: remaining.toString() },
    );
  }
  return releases;
}

type RemoteConversionRelease = {
  inventory: CanonicalClaimInventoryReleaseResource;
  allocations: readonly { allocationId: bigint; releaseQty: bigint }[];
};

type PlannedRemoteConversionReplacement = {
  operations: readonly {
    operationId: bigint;
    operationKey: string;
    warehouseId: number;
    outputLocationId: number | null;
    scope: RemoteConversionScope;
    operationType: string;
    committedOutputQty: bigint;
  }[];
  releases: readonly RemoteConversionRelease[];
  replacedTargetQty: bigint;
};

/**
 * Locks this line's conversion operations and their input resources, then asks
 * the domain rule which remote operations the pick may replace. Returns null
 * (no writes) when nothing qualifies; the caller keeps its existing behavior.
 */
async function planRemoteConversionReplacement(
  client: PoolClient,
  claim: FulfillmentClaim,
  line: FulfillmentClaimLine,
  pick: RemoteConversionPick,
  requiredQty: bigint,
): Promise<PlannedRemoteConversionReplacement | null> {
  const operationRows = rows(await client.query(
    `SELECT id, operation_key, parent_operation_key, warehouse_id, output_location_id,
            operation_type, status, destination_variant_id, planned_executions,
            executed_executions, released_executions, committed_output_qty
     FROM inventory.availability_claim_operations
     WHERE claim_id = $1 AND claim_line_id = $2
     ORDER BY operation_key, id
     FOR UPDATE`,
    [claim.id.toString(), line.id.toString()],
  ));
  if (operationRows.length === 0) return null;
  const operationKeys = operationRows.map((row) => String(row.operation_key));
  const operationIds = operationRows.map((row) => positiveBigInt(row.id, "claimOperation.id").toString());

  const parentsWithChildren = new Set(rows(await client.query(
    `SELECT DISTINCT parent_operation_key
     FROM inventory.availability_claim_operations
     WHERE claim_id = $1 AND parent_operation_key = ANY($2::varchar[])`,
    [claim.id.toString(), operationKeys],
  )).map((row) => String(row.parent_operation_key)));
  const operationIdsWithHandoff = new Set(rows(await client.query(
    `SELECT claim_operation_id
     FROM inventory.availability_claim_build_handoffs
     WHERE claim_id = $1 AND claim_operation_id = ANY($2::bigint[])`,
    [claim.id.toString(), operationIds],
  )).map((row) => String(row.claim_operation_id)));
  const producedOperationKeys = new Set(rows(await client.query(
    `SELECT DISTINCT producer_operation_key
     FROM inventory.availability_claim_resources
     WHERE claim_id = $1 AND producer_operation_key = ANY($2::varchar[])`,
    [claim.id.toString(), operationKeys],
  )).map((row) => String(row.producer_operation_key)));
  const inputRows = rows(await client.query(
    `SELECT id, consumer_operation_key, inventory_level_id, warehouse_location_id,
            source_variant_id, claimed_qty, released_qty, consumed_qty, picked_qty
     FROM inventory.availability_claim_resources
     WHERE claim_id = $1 AND claim_line_id = $2
       AND consumer_operation_key = ANY($3::varchar[])
     ORDER BY warehouse_id, warehouse_location_id, inventory_level_id, id
     FOR UPDATE`,
    [claim.id.toString(), line.id.toString(), operationKeys],
  ));
  const inputsByOperationKey = new Map<string, any[]>();
  for (const row of inputRows) {
    const key = String(row.consumer_operation_key);
    inputsByOperationKey.set(key, [...(inputsByOperationKey.get(key) ?? []), row]);
  }

  const candidates: RemoteConversionCandidate[] = operationRows.map((row) => {
    const operationKey = String(row.operation_key);
    return {
      operationKey,
      parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
      warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
      outputLocationId: row.output_location_id == null
        ? null
        : positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
      operationType: String(row.operation_type),
      status: String(row.status),
      destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
      plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
      executedExecutions: nonnegativeBigInt(row.executed_executions, "claimOperation.executedExecutions"),
      releasedExecutions: nonnegativeBigInt(row.released_executions, "claimOperation.releasedExecutions"),
      committedOutputQty: row.committed_output_qty == null
        ? null
        : positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
      hasChildOperation: parentsWithChildren.has(operationKey),
      hasBuildHandoff: operationIdsWithHandoff.has(String(row.id)),
      hasProducedResource: producedOperationKeys.has(operationKey),
      inputResources: (inputsByOperationKey.get(operationKey) ?? []).map((input) => ({
        claimedQty: positiveBigInt(input.claimed_qty, "claimResource.claimedQty"),
        releasedQty: nonnegativeBigInt(input.released_qty, "claimResource.releasedQty"),
        consumedQty: nonnegativeBigInt(input.consumed_qty, "claimResource.consumedQty"),
        pickedQty: nonnegativeBigInt(input.picked_qty, "claimResource.pickedQty"),
      })),
    };
  });
  const selection = selectRemoteConversionsToReplace({
    candidates,
    pick,
    targetVariantId: line.targetVariantId,
    requiredQty,
  });
  if (!selection) return null;

  const selectedKeys = new Set(selection.operationKeys);
  const selectedInputs = inputRows.filter((row) => selectedKeys.has(String(row.consumer_operation_key)));
  const lotRows = rows(await client.query(
    `SELECT id, claim_resource_id, inventory_lot_id, claimed_qty, released_qty, consumed_qty, picked_qty
     FROM inventory.availability_claim_lot_allocations
     WHERE claim_id = $1 AND claim_resource_id = ANY($2::bigint[])
     ORDER BY claim_resource_id, inventory_lot_id, id
     FOR UPDATE`,
    [claim.id.toString(), selectedInputs.map((row) => String(row.id))],
  ));
  const releases: RemoteConversionRelease[] = selectedInputs.map((row) => {
    const claimResourceId = positiveBigInt(row.id, "claimResource.id");
    // Eligibility guarantees nothing was released, consumed or picked: the whole claim is open.
    const releaseQty = positiveBigInt(row.claimed_qty, "claimResource.claimedQty");
    const lots = lotRows.filter((lot) => String(lot.claim_resource_id) === claimResourceId.toString());
    const allocations = lots.map((lot) => ({
      allocationId: positiveBigInt(lot.id, "claimLot.id"),
      inventoryLotId: positiveInteger(lot.inventory_lot_id, "claimLot.inventoryLotId"),
      releaseQty: positiveBigInt(lot.claimed_qty, "claimLot.claimedQty")
        - nonnegativeBigInt(lot.released_qty, "claimLot.releasedQty")
        - nonnegativeBigInt(lot.consumed_qty, "claimLot.consumedQty")
        - nonnegativeBigInt(lot.picked_qty, "claimLot.pickedQty"),
    })).filter((allocation) => allocation.releaseQty > BigInt(0));
    const attributed = allocations.reduce((total, allocation) => total + allocation.releaseQty, BigInt(0));
    if (attributed !== releaseQty) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_LINEAGE_MISMATCH",
        "The source claim resource has insufficient exact lot ownership for reconciliation.",
        { claimResourceId: claimResourceId.toString() },
      );
    }
    return {
      inventory: {
        claimResourceId,
        inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
        warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
        sourceVariantId: positiveInteger(row.source_variant_id, "claimResource.sourceVariantId"),
        releaseQty,
        lotAllocations: allocations.map(({ inventoryLotId, releaseQty: qty }) => ({ inventoryLotId, releaseQty: qty })),
        orderItemId: line.orderItemId,
      },
      allocations: allocations.map(({ allocationId, releaseQty: qty }) => ({ allocationId, releaseQty: qty })),
    };
  });
  // candidates[index] was built from operationRows[index].
  const operations = operationRows.flatMap((row, index) => {
    const candidate = candidates[index];
    if (!selectedKeys.has(candidate.operationKey)) return [];
    return [{
      operationId: positiveBigInt(row.id, "claimOperation.id"),
      operationKey: candidate.operationKey,
      warehouseId: candidate.warehouseId,
      outputLocationId: candidate.outputLocationId,
      scope: remoteConversionScope(candidate, pick),
      operationType: candidate.operationType,
      committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
    }];
  });
  return { operations, releases, replacedTargetQty: selection.replacedTargetQty };
}

/**
 * Releases the selected remote conversions and reserves their committed
 * finished units at the pick bin, in the caller's SERIALIZABLE transaction.
 * The bin's free stock is checked first. When it is short, nothing is written
 * and the error says which bin to count or receive.
 */
async function replaceRemoteConversionsAtPickLocation(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  input: {
    commandKey: string;
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    pickWarehouseId: number;
    warehouseLocationId: number;
    targetInventoryLevelId: number;
    requestedQty: bigint;
    actor: string;
    reason: string;
    occurredAt: Date;
  },
  replacement: PlannedRemoteConversionReplacement,
): Promise<void> {
  // Same global level-then-lot lock order as the inventory writer's rebinds.
  const levelIds = [...new Set([
    ...replacement.releases.map((release) => release.inventory.inventoryLevelId),
    input.targetInventoryLevelId,
  ])];
  const levelRows = rows(await client.query(
    `SELECT id, variant_qty, reserved_qty
     FROM inventory.inventory_levels
     WHERE id = ANY($1::integer[])
     ORDER BY warehouse_location_id, product_variant_id, id
     FOR UPDATE`,
    [levelIds],
  ));
  const targetLevel = levelRows.find((row) => Number(row.id) === input.targetInventoryLevelId);
  const freeQty = targetLevel
    ? BigInt(Number(targetLevel.variant_qty)) - BigInt(Number(targetLevel.reserved_qty))
    : BigInt(0);
  if (freeQty < replacement.replacedTargetQty) {
    const identity = rows(await client.query(
      `SELECT location.code AS location_code, variant.sku
       FROM warehouse.warehouse_locations AS location
       CROSS JOIN catalog.product_variants AS variant
       WHERE location.id = $1 AND variant.id = $2`,
      [input.warehouseLocationId, input.line.targetVariantId],
    ))[0];
    const binCode = String(identity?.location_code ?? `location ${input.warehouseLocationId}`);
    const sku = String(identity?.sku ?? `variant ${input.line.targetVariantId}`);
    const shownFree = freeQty < BigInt(0) ? BigInt(0) : freeQty;
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_TARGET_STOCK_SHORTFALL",
      `The system shows ${shownFree} free ${sku} at ${binCode}, but recording this pick needs `
        + `${replacement.replacedTargetQty}. Count or receive ${binCode}, then retry.`,
      {
        claimLineId: input.line.id.toString(),
        warehouseLocationId: input.warehouseLocationId,
        targetVariantId: input.line.targetVariantId,
        freeQty: shownFree.toString(),
        requiredQty: replacement.replacedTargetQty.toString(),
      },
    );
  }
  const sourceLotIds = [...new Set(replacement.releases.flatMap((release) =>
    release.inventory.lotAllocations.map((allocation) => allocation.inventoryLotId)))];
  await client.query(
    `SELECT id
     FROM inventory.inventory_lots
     WHERE id = ANY($1::integer[])
        OR (product_variant_id = $2 AND warehouse_location_id = $3 AND status = 'active')
     ORDER BY warehouse_location_id, product_variant_id, received_at, id
     FOR UPDATE`,
    [sourceLotIds, input.line.targetVariantId, input.warehouseLocationId],
  );

  const targetResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7)
     ON CONFLICT (
       claim_line_id, warehouse_id, warehouse_location_id, inventory_level_id,
       source_variant_id, COALESCE(consumer_operation_key, ''), COALESCE(producer_operation_key, '')
     ) DO UPDATE
       SET claimed_qty = inventory.availability_claim_resources.claimed_qty + EXCLUDED.claimed_qty,
           updated_at = $8
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.line.id.toString(),
      input.pickWarehouseId,
      input.warehouseLocationId,
      input.targetInventoryLevelId,
      input.line.targetVariantId,
      replacement.replacedTargetQty.toString(),
      input.occurredAt,
    ],
  ))[0];
  const targetResourceId = positiveBigInt(targetResourceRow?.id, "targetClaimResource.id");

  await inventoryWriter.releaseResources({
    client,
    commandKey: `${input.commandKey}:remote-conversion-release`,
    claimId: input.claim.id,
    resources: replacement.releases.map((release) => release.inventory),
    orderId: input.claim.orderId,
    actor: input.actor,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of replacement.releases) {
    for (const allocation of release.allocations) {
      const updated = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updated.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_RECONCILIATION_STATE_CHANGED",
          "A remote conversion's source claim lot changed while it was being replaced.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
    }
    const updated = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updated.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_STATE_CHANGED",
        "A remote conversion's source claim resource changed while it was being replaced.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
  }
  for (const operation of replacement.operations) {
    const updated = await client.query(
      `UPDATE inventory.availability_claim_operations
       SET status = 'released',
           released_executions = planned_executions - executed_executions,
           updated_at = $3
       WHERE id = $1 AND claim_id = $2
         AND status IN ('pending', 'ready')
         AND executed_executions = 0 AND released_executions = 0`,
      [operation.operationId.toString(), input.claim.id.toString(), input.occurredAt],
    );
    if (updated.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_STATE_CHANGED",
        "A remote conversion changed while it was being replaced.",
        { claimOperationId: operation.operationId.toString(), operationKey: operation.operationKey },
      );
    }
  }

  const allocations = await inventoryWriter.reserveResource({
    client,
    commandKey: `${input.commandKey}:remote-conversion-reserve`,
    claimId: input.claim.id,
    claimResourceId: targetResourceId,
    inventoryLevelId: input.targetInventoryLevelId,
    warehouseLocationId: input.warehouseLocationId,
    sourceVariantId: input.line.targetVariantId,
    claimedQty: positiveInteger(Number(replacement.replacedTargetQty), "replacement.replacedTargetQty"),
    orderId: input.claim.orderId,
    orderItemId: input.line.orderItemId,
    consumerOperationKey: null,
    actor: input.actor,
    occurredAt: input.occurredAt,
  });
  for (const allocation of allocations) {
    const inserted = await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_resource_id, inventory_lot_id) DO UPDATE
         SET claimed_qty = inventory.availability_claim_lot_allocations.claimed_qty + EXCLUDED.claimed_qty,
             updated_at = $9
         WHERE inventory.availability_claim_lot_allocations.unit_cost_mills = EXCLUDED.unit_cost_mills
           AND inventory.availability_claim_lot_allocations.po_unit_cost_mills = EXCLUDED.po_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.packaging_unit_cost_mills = EXCLUDED.packaging_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.landed_unit_cost_mills = EXCLUDED.landed_unit_cost_mills
       RETURNING id`,
      [
        input.claim.id.toString(), targetResourceId.toString(), allocation.inventoryLotId, allocation.qty,
        allocation.unitCostMills.toString(), allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(), allocation.landedUnitCostMills.toString(), input.occurredAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_COST_CHANGED",
        "The target FIFO lot cost no longer matches existing claim lineage.",
        { inventoryLotId: allocation.inventoryLotId },
      );
    }
  }

  // v2 adds each released operation's scope and output bin. Every v1 event
  // (written before same-warehouse replacement existed) is other_warehouse.
  const evidence = {
    schemaVersion: "inventory_availability_claim_remote_conversion_replacement_event_v2",
    eventType: "claim_remote_conversion_replaced",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    orderItemId: input.line.orderItemId,
    pickWarehouseId: input.pickWarehouseId,
    targetWarehouseLocationId: input.warehouseLocationId,
    targetClaimResourceId: targetResourceId.toString(),
    requestedPickQty: input.requestedQty.toString(),
    replacedTargetQty: replacement.replacedTargetQty.toString(),
    releasedOperations: replacement.operations.map((operation) => ({
      operationKey: operation.operationKey,
      warehouseId: operation.warehouseId,
      scope: operation.scope,
      outputLocationId: operation.outputLocationId,
      operationType: operation.operationType,
      committedOutputQty: operation.committedOutputQty.toString(),
    })),
    releasedClaimResources: replacement.releases.map((release) => ({
      claimResourceId: release.inventory.claimResourceId.toString(),
      warehouseLocationId: release.inventory.warehouseLocationId,
      sourceVariantId: release.inventory.sourceVariantId,
      releaseQty: release.inventory.releaseQty.toString(),
    })),
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_remote_conversion_replaced', 'active', 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.claim.id.toString(), JSON.stringify(evidence), hash(evidence), input.actor,
      input.reason, input.occurredAt,
    ],
  );
}

export async function reconcilePickLocation(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  input: {
    commandKey: string;
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    orderWarehouseId: number | null;
    warehouseLocationId: number;
    quantity: bigint;
    actor: string;
    reason: string;
    occurredAt: Date;
  },
): Promise<void> {
  const targetRow = rows(await client.query(
    `SELECT level.id AS inventory_level_id, location.warehouse_id,
            location.is_active, location.is_pickable, location.cycle_count_freeze_id
     FROM warehouse.warehouse_locations AS location
     LEFT JOIN inventory.inventory_levels AS level
       ON level.warehouse_location_id = location.id
      AND level.product_variant_id = $2
     WHERE location.id = $1`,
    [input.warehouseLocationId, input.line.targetVariantId],
  ))[0];
  if (!targetRow || targetRow.inventory_level_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_INVENTORY_MISSING",
      "The selected pick location has no recorded inventory level for the claim target variant.",
      { warehouseLocationId: input.warehouseLocationId, targetVariantId: input.line.targetVariantId },
    );
  }
  const targetWarehouseId = await requirePickableLocation(
    client,
    input.warehouseLocationId,
    input.orderWarehouseId,
  );
  // A line whose only remaining supply is a conversion that cannot produce into
  // this bin (planned in another warehouse, or in this one without this bin as
  // its output) has no finished units to move here. Replace that conversion with
  // the finished units picked from this bin (see claim-remote-conversion-replacement.ts).
  // Mixed lines keep the existing rebind and its shortfall error.
  const directOpenElsewhere = input.line.resources
    .filter((resource) => resource.warehouseLocationId !== input.warehouseLocationId)
    .reduce((total, resource) => total + openResourceQty(resource), BigInt(0));
  if (directOpenElsewhere === BigInt(0)) {
    const replacement = await planRemoteConversionReplacement(
      client,
      input.claim,
      input.line,
      { warehouseId: targetWarehouseId, warehouseLocationId: input.warehouseLocationId },
      input.quantity,
    );
    if (replacement) {
      await replaceRemoteConversionsAtPickLocation(client, inventoryWriter, {
        commandKey: input.commandKey,
        claim: input.claim,
        line: input.line,
        pickWarehouseId: targetWarehouseId,
        warehouseLocationId: input.warehouseLocationId,
        targetInventoryLevelId: positiveInteger(targetRow.inventory_level_id, "inventoryLevel.id"),
        requestedQty: input.quantity,
        actor: input.actor,
        reason: input.reason,
        occurredAt: input.occurredAt,
      }, replacement);
      return;
    }
  }
  const releases = selectReconciliationReleases(input.line, input.warehouseLocationId, input.quantity);
  const targetResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7)
     ON CONFLICT (
       claim_line_id, warehouse_id, warehouse_location_id, inventory_level_id,
       source_variant_id, COALESCE(consumer_operation_key, ''), COALESCE(producer_operation_key, '')
     ) DO UPDATE
       SET claimed_qty = inventory.availability_claim_resources.claimed_qty + EXCLUDED.claimed_qty,
           updated_at = $8
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.line.id.toString(),
      targetWarehouseId,
      input.warehouseLocationId,
      positiveInteger(targetRow.inventory_level_id, "inventoryLevel.id"),
      input.line.targetVariantId,
      input.quantity.toString(),
      input.occurredAt,
    ],
  ))[0];
  const targetResourceId = positiveBigInt(targetResourceRow?.id, "targetClaimResource.id");
  const allocations = await inventoryWriter.reconcilePickResource({
    client,
    commandKey: input.commandKey,
    claimId: input.claim.id,
    releases: releases.map((release) => release.inventory),
    target: {
      claimResourceId: targetResourceId,
      inventoryLevelId: positiveInteger(targetRow.inventory_level_id, "inventoryLevel.id"),
      warehouseLocationId: input.warehouseLocationId,
      sourceVariantId: input.line.targetVariantId,
      claimedQty: Number(input.quantity),
      orderItemId: input.line.orderItemId,
    },
    orderId: input.claim.orderId,
    actor: input.actor,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of releases) {
    for (const allocation of release.allocations) {
      const updated = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updated.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_RECONCILIATION_STATE_CHANGED",
          "A source claim lot changed while pick-location reconciliation was recorded.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
    }
    const updated = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updated.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_STATE_CHANGED",
        "A source claim resource changed while pick-location reconciliation was recorded.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
  }
  for (const allocation of allocations) {
    const inserted = await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_resource_id, inventory_lot_id) DO UPDATE
         SET claimed_qty = inventory.availability_claim_lot_allocations.claimed_qty + EXCLUDED.claimed_qty,
             updated_at = $9
         WHERE inventory.availability_claim_lot_allocations.unit_cost_mills = EXCLUDED.unit_cost_mills
           AND inventory.availability_claim_lot_allocations.po_unit_cost_mills = EXCLUDED.po_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.packaging_unit_cost_mills = EXCLUDED.packaging_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.landed_unit_cost_mills = EXCLUDED.landed_unit_cost_mills
       RETURNING id`,
      [
        input.claim.id.toString(), targetResourceId.toString(), allocation.inventoryLotId, allocation.qty,
        allocation.unitCostMills.toString(), allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(), allocation.landedUnitCostMills.toString(), input.occurredAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_COST_CHANGED",
        "The target FIFO lot cost no longer matches existing claim lineage.",
        { inventoryLotId: allocation.inventoryLotId },
      );
    }
  }
  const evidence = {
    schemaVersion: "inventory_availability_claim_pick_reconciliation_event_v1",
    eventType: "claim_pick_location_reconciled",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    orderItemId: input.line.orderItemId,
    targetWarehouseLocationId: input.warehouseLocationId,
    targetClaimResourceId: targetResourceId.toString(),
    quantity: input.quantity.toString(),
    releasedClaimResourceIds: releases.map((release) => release.inventory.claimResourceId.toString()),
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_pick_location_reconciled', 'active', 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.claim.id.toString(), JSON.stringify(evidence), hash(evidence), input.actor,
      input.reason, input.occurredAt,
    ],
  );
}

export type PickerObservationCommand = Extract<
  CanonicalAvailabilityClaimPickCommand,
  { locationStrategy: "reconcile_picker_observation" }
>;

export async function reconcileObservedPickLocation(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  observationReviewWriter: CanonicalClaimPickerObservationReviewPort,
  input: {
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    orderWarehouseId: number | null;
    quantity: bigint;
    command: PickerObservationCommand;
    requestHash: string;
    occurredAt: Date;
  },
): Promise<{
  inventoryReviewId: number;
  recordedReconciledQuantity: bigint;
  observedRelocatedQuantity: bigint;
}> {
  const targetRow = rows(await client.query(
    `SELECT location.warehouse_id, location.code,
            location.is_active, location.is_pickable, location.cycle_count_freeze_id
     FROM warehouse.warehouse_locations AS location
     WHERE location.id = $1`,
    [input.command.warehouseLocationId],
  ))[0];
  if (!targetRow) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_NOT_FOUND",
      "The observed pick location does not exist.",
      {
        warehouseLocationId: input.command.warehouseLocationId,
        targetVariantId: input.line.targetVariantId,
      },
    );
  }
  const targetLocationCode = String(targetRow.code ?? "").trim();
  if (targetLocationCode === ""
    || targetLocationCode.toUpperCase() !== input.command.observation.locationCode.trim().toUpperCase()) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_OBSERVATION_LOCATION_MISMATCH",
      "The observed location code does not match the selected warehouse location.",
      {
        warehouseLocationId: input.command.warehouseLocationId,
        observedLocationCode: input.command.observation.locationCode,
        actualLocationCode: targetLocationCode || null,
      },
    );
  }
  const targetWarehouseId = await requirePickableLocation(
    client,
    input.command.warehouseLocationId,
    input.orderWarehouseId,
  );
  const targetInventoryLevelId = await inventoryWriter.ensureInventoryLevel({
    client,
    productVariantId: input.line.targetVariantId,
    warehouseLocationId: input.command.warehouseLocationId,
    occurredAt: input.occurredAt,
  });
  const releases = selectReconciliationReleases(
    input.line,
    input.command.warehouseLocationId,
    input.quantity,
    targetWarehouseId,
  );
  const targetResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7)
     ON CONFLICT (
       claim_line_id, warehouse_id, warehouse_location_id, inventory_level_id,
       source_variant_id, COALESCE(consumer_operation_key, ''), COALESCE(producer_operation_key, '')
     ) DO UPDATE
       SET claimed_qty = inventory.availability_claim_resources.claimed_qty + EXCLUDED.claimed_qty,
           updated_at = $8
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.line.id.toString(),
      targetWarehouseId,
      input.command.warehouseLocationId,
      targetInventoryLevelId,
      input.line.targetVariantId,
      input.quantity.toString(),
      input.occurredAt,
    ],
  ))[0];
  const targetResourceId = positiveBigInt(targetResourceRow?.id, "targetClaimResource.id");
  const reconciled = await inventoryWriter.reconcileObservedPickResource({
    client,
    commandKey: `canonical:observe:${input.command.idempotencyKey}`,
    claimId: input.claim.id,
    releases: releases.map((release) => release.inventory),
    sourceCostLayers: releases.flatMap((release) => release.allocations.map((allocation) => ({
      inventoryLotId: allocation.inventoryLotId,
      quantity: allocation.releaseQty,
      unitCostMills: allocation.unitCostMills,
      poUnitCostMills: allocation.poUnitCostMills,
      packagingUnitCostMills: allocation.packagingUnitCostMills,
      landedUnitCostMills: allocation.landedUnitCostMills,
    }))),
    target: {
      claimResourceId: targetResourceId,
      inventoryLevelId: targetInventoryLevelId,
      warehouseLocationId: input.command.warehouseLocationId,
      sourceVariantId: input.line.targetVariantId,
      claimedQty: Number(input.quantity),
      orderItemId: input.line.orderItemId,
    },
    observationReference: input.requestHash,
    orderId: input.claim.orderId,
    actor: input.command.actor,
    reason: input.command.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of releases) {
    for (const allocation of release.allocations) {
      const updated = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updated.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_OBSERVATION_STATE_CHANGED",
          "A source claim lot changed while picker-observation reconciliation was recorded.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
    }
    const updated = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updated.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OBSERVATION_STATE_CHANGED",
        "A source claim resource changed while picker-observation reconciliation was recorded.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
  }
  for (const allocation of reconciled.allocations) {
    const inserted = await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_resource_id, inventory_lot_id) DO UPDATE
         SET claimed_qty = inventory.availability_claim_lot_allocations.claimed_qty + EXCLUDED.claimed_qty,
             updated_at = $9
         WHERE inventory.availability_claim_lot_allocations.unit_cost_mills = EXCLUDED.unit_cost_mills
           AND inventory.availability_claim_lot_allocations.po_unit_cost_mills = EXCLUDED.po_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.packaging_unit_cost_mills = EXCLUDED.packaging_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.landed_unit_cost_mills = EXCLUDED.landed_unit_cost_mills
       RETURNING id`,
      [
        input.claim.id.toString(),
        targetResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
        input.occurredAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OBSERVATION_COST_CHANGED",
        "The reconciled FIFO lot cost no longer matches existing claim lineage.",
        { inventoryLotId: allocation.inventoryLotId },
      );
    }
  }
  const exceptionMetadata = {
    schemaVersion: "inventory_availability_claim_picker_observation_v1",
    pickerNonBlocking: true,
    shipmentBlocking: false,
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    observationKind: input.command.observation.kind,
    observedPhysicalQty: input.command.observation.observedPhysicalQty,
    systemLevelQtyBefore: reconciled.systemLevelQuantityBefore.toString(),
    systemLotQtyBefore: reconciled.systemLotQuantityBefore.toString(),
    recordedUnreservedQtyBefore: reconciled.recordedUnreservedQuantityBefore.toString(),
    recordedReconciledQty: reconciled.recordedReconciledQuantity.toString(),
    observedRelocatedQty: reconciled.observedRelocatedQuantity.toString(),
    relocatedInventoryLotIds: reconciled.relocatedInventoryLotIds,
    releasedClaimResourceIds: releases.map((release) => release.inventory.claimResourceId.toString()),
    deviceType: input.command.observation.deviceType ?? null,
    sessionId: input.command.observation.sessionId ?? null,
    actor: input.command.actor,
  } satisfies CanonicalClaimPickerObservationReviewMetadata;
  const inventoryReviewId = await observationReviewWriter.recordReview({
    client,
    orderId: input.claim.orderId,
    orderItemId: input.line.orderItemId,
    targetVariantId: input.line.targetVariantId,
    requestedQty: Number(input.command.quantity),
    selectedLocationId: input.command.warehouseLocationId,
    resolution: input.command.observation.kind === "validated_item_scan"
      ? "picker_scan_count_correction"
      : "picker_confirmed_count_correction",
    reviewReason: input.command.reason,
    metadata: exceptionMetadata,
    occurredAt: input.occurredAt,
  });
  const evidence = {
    schemaVersion: "inventory_availability_claim_picker_observation_event_v1",
    eventType: "claim_pick_observation_reconciled",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    orderItemId: input.line.orderItemId,
    targetWarehouseLocationId: input.command.warehouseLocationId,
    targetLocationCode,
    targetClaimResourceId: targetResourceId.toString(),
    quantity: input.quantity.toString(),
    inventoryReviewId,
    observation: exceptionMetadata,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_pick_observation_reconciled', 'active', 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.claim.id.toString(),
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  return {
    inventoryReviewId,
    recordedReconciledQuantity: reconciled.recordedReconciledQuantity,
    observedRelocatedQuantity: reconciled.observedRelocatedQuantity,
  };
}

export async function persistPickCommandAndEvent(
  client: PoolClient,
  input: {
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    command: CanonicalAvailabilityClaimPickCommand | CanonicalAvailabilityClaimUnpickCommand;
    commandType: "pick" | "pick_observation" | "unpick";
    movementType: "pick" | "unpick";
    requestHash: string;
    result: CanonicalAvailabilityClaimPickResult;
    movements: Awaited<ReturnType<CanonicalClaimInventoryMutationPort["pickResources"]>>["movements"];
    occurredAt: Date;
  },
): Promise<void> {
  const commandRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
     RETURNING id`,
    [
      input.claim.id.toString(), input.claim.orderId, input.commandType,
      input.command.idempotencyKey, input.requestHash, hash(input.result),
      JSON.stringify(input.command), JSON.stringify(input.result), input.command.actor,
      input.command.reason, input.occurredAt,
    ],
  ))[0];
  await commitCanonicalPickingReceipt(
    client,
    input.command.idempotencyKey,
    { canonicalRequest: input.command, canonicalResult: input.result, productVariantId: input.line.targetVariantId },
    input.occurredAt,
  );
  const commandId = positiveBigInt(commandRow?.id, "claimCommand.id");
  for (const movement of input.movements) {
    await client.query(
      `INSERT INTO inventory.availability_claim_pick_movements (
         claim_id, claim_line_id, claim_resource_id, claim_lot_allocation_id,
         inventory_lot_id, command_id, order_item_cost_id, movement_type, quantity,
         reverses_pick_movement_id, unit_cost_mills, total_cost_mills, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.claim.id.toString(), input.line.id.toString(), movement.claimResourceId.toString(),
        movement.claimLotAllocationId.toString(), movement.inventoryLotId, commandId.toString(),
        movement.orderItemCostId, input.movementType, movement.quantity.toString(),
        movement.reversesPickMovementId?.toString() ?? null, movement.unitCostMills.toString(),
        movement.totalCostMills.toString(), input.occurredAt,
      ],
    );
  }
  const evidence = {
    schemaVersion: "inventory_availability_claim_pick_event_v1",
    eventType: input.commandType === "unpick" ? "claim_line_unpicked" : "claim_line_picked",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claim.id.toString(), evidence.eventType, input.claim.status, JSON.stringify(evidence),
      hash(evidence), input.command.actor, input.command.reason, input.occurredAt,
    ],
  );
}
