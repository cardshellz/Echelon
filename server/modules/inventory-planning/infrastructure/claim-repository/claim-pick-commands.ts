import {
  canonicalAvailabilityClaimPickCommandSchema,
  canonicalAvailabilityClaimPickResultSchema,
  canonicalAvailabilityClaimUnpickCommandSchema,
  type CanonicalAvailabilityClaimPickCommand,
  type CanonicalAvailabilityClaimPickResult,
  type CanonicalAvailabilityClaimUnpickCommand,
} from "@shared/types/inventory-availability-claims";
import {
  exactRecordedCostTotalsSchema,
  recordedCostTotalIsValid,
} from "@shared/utils/recorded-cost-total";
import { recordAssemblyOutputPickLocation } from "../../../wms/assembly-and-packing.api";
import { persistCanonicalWmsPickProgress } from "../../../wms/order-intake-and-items.api";
import { lockClaimPickCorrection } from "../../../wms/pick-corrections-and-holds.api";
import type { CanonicalClaimInventoryUnpickResource } from "../../application/canonical-claim-inventory.port";
import { materializePickPackageConversions } from "./claim-operation-commands";
import {
  loadClaimById,
  loadClaimProductIds,
  loadOrder,
  lockGraphProducts,
  requireCanonicalAuthority,
  requirePickableLocation,
} from "./claim-order-and-locks";
import {
  loadFulfillmentClaimLine,
  persistPickCommandAndEvent,
  reconcileObservedPickLocation,
  reconcilePickLocation,
  selectPickResources,
} from "./claim-pick-reconciliation";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  isRetryableTransactionError,
  loadPickReplay,
  MAX_GRAPH_PRODUCTS,
  MAX_SERIALIZATION_ATTEMPTS,
  nonnegativeBigInt,
  openResourceQty,
  positiveBigInt,
  positiveInteger,
  rollback,
  rows,
  uniqueSorted,
  type ClaimRepositoryDependencies,
} from "./claim-primitives";

export async function executePickClaimLine(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimPickCommand,
): Promise<CanonicalAvailabilityClaimPickResult> {
  const command = canonicalAvailabilityClaimPickCommandSchema.parse(rawCommand);
  if (command.assemblyWork && !deps.workOwner) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ASSEMBLY_WORK_OWNER_UNAVAILABLE",
      "The warehouse work owner is not configured.",
    );
  }
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical pick clock returned an invalid time.");
  }
  const claimId = positiveBigInt(command.claimId, "claim.id");
  const quantity = BigInt(positiveInteger(command.quantity, "pick.quantity"));
  const commandType = command.locationStrategy === "reconcile_picker_observation"
    ? "pick_observation" as const
    : "pick" as const;

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      // Price binding and any case break share the cost graph lock. Always
      // acquire it before product/order/level rows, including ordinary picks.
      await deps.lockCostGraph(client);
      const replay = await loadPickReplay(client, command.idempotencyKey, requestHash, commandType);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await requireCanonicalAuthority(client);
      const preliminaryClaim = await loadClaimById(client, claimId, false);
      if (!preliminaryClaim || preliminaryClaim.status !== "active") {
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
      // A correction records units the provider already shipped, so shipped or
      // held cannot stop it; its owner refuses held orders for a new scan pick.
      if (order.warehouseStatus === "cancelled"
        || ((order.onHold || order.warehouseStatus === "shipped") && !command.wmsProgress?.pickCorrectionId)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_ORDER_NOT_PICKABLE",
          "A cancelled, shipped, or held order cannot consume a canonical claim pick.",
          {
            claimId: claimId.toString(),
            orderId: order.orderId,
            warehouseStatus: order.warehouseStatus,
            onHold: order.onHold,
          },
        );
      }
      if (command.wmsProgress?.pickCorrectionId) {
        await lockClaimPickCorrection(
          client,
          command.wmsProgress.pickCorrectionId,
          command.orderItemId,
          command.wmsProgress.targetPickedQuantity,
          command.actor,
          command.wmsProgress.pickCorrectionRevision,
        );
      }
      const claim = await loadClaimById(client, claimId, true);
      if (!claim || claim.status !== "active" || claim.orderId !== preliminaryClaim.orderId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while fulfillment locks were being acquired.",
          { claimId: claimId.toString() },
        );
      }
      const pickWarehouseId = await requirePickableLocation(client, command.warehouseLocationId, order.warehouseId);
      let line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
      if (command.wmsProgress) {
        const expectedPicked = BigInt(command.wmsProgress.expectedPickedQuantity);
        const expectedFulfilled = BigInt(command.wmsProgress.expectedFulfilledQuantity ?? 0);
        // Provider-declared packed quantities can precede the missing pick.
        // Only actual claim consumption, not that declaration, removes picked custody.
        // Label printing marks a box fulfilled before the carrier scan consumes
        // its claim units, so fulfilled can run ahead of consumption. Picked
        // custody then still holds those shipped units (#63891, 2026-10-07):
        // accept it only when it is exactly picked - consumed, never more.
        const consumptionPending = line.consumedTargetQty < expectedFulfilled
          && line.pickedTargetQty === expectedPicked - line.consumedTargetQty;
        const expectedClaimPicked = expectedPicked - (command.wmsProgress.pickCorrectionId || consumptionPending
          ? line.consumedTargetQty : expectedFulfilled);
        const resourcePicked = line.resources.reduce((sum, resource) => sum + resource.pickedQty, BigInt(0));
        const lotsMatchResources = line.resources.every((resource) =>
          resource.lots.reduce((sum, lot) => sum + lot.pickedQty, BigInt(0)) === resource.pickedQty);
        if (expectedClaimPicked < BigInt(0)
          || line.pickedTargetQty !== expectedClaimPicked
          || resourcePicked !== expectedClaimPicked || !lotsMatchResources
          || quantity !== BigInt(command.wmsProgress.targetPickedQuantity) - expectedPicked) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_WMS_PICK_CUSTODY_MISMATCH",
            "WMS pick progress must add only its next delta above fulfilled custody to exact existing claim-owned picked custody.",
            {
              claimLineId: line.id.toString(),
              expectedPickedQty: expectedPicked.toString(),
              expectedFulfilledQty: expectedFulfilled.toString(),
              expectedClaimPickedQty: expectedClaimPicked.toString(),
              actualClaimPickedQty: line.pickedTargetQty.toString(),
              quantity: quantity.toString(),
            },
          );
        }
        if (line.resources.some((resource) =>
          resource.pickedQty > BigInt(0) && resource.warehouseLocationId !== command.warehouseLocationId)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_PARTIAL_LOCATION_CONFLICT",
            "Remaining completion must use the existing picked source bin; fully unpick before relocating a single-source item.",
            { claimLineId: line.id.toString(), warehouseLocationId: command.warehouseLocationId },
          );
        }
      }
      const openTarget = line.plannedQty - line.releasedTargetQty - line.consumedTargetQty - line.pickedTargetQty;
      if (openTarget < quantity) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_LINE_PICK_OVERAGE",
          "The pick exceeds the claim line's remaining planned target quantity.",
          { claimLineId: line.id.toString(), requestedQty: quantity.toString(), openQty: openTarget.toString() },
        );
      }
      if (command.wmsProgress && !command.assemblyWork
        && await materializePickPackageConversions(deps, client, claim, line, command, quantity, pickWarehouseId, occurredAt)) {
        line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
      }
      const selectedOpen = line.resources
        .filter((resource) => resource.warehouseLocationId === command.warehouseLocationId)
        .reduce((total, resource) => total + openResourceQty(resource), BigInt(0));
      let reconciledQuantity = BigInt(0);
      let observationReconciliation: Awaited<ReturnType<typeof reconcileObservedPickLocation>> | null = null;
      if (selectedOpen >= quantity && command.locationStrategy === "reconcile_picker_observation") {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_PICK_OBSERVATION_NOT_REQUIRED",
          "The selected location already owns enough open claim inventory; use a normal strict pick.",
          {
            claimLineId: line.id.toString(),
            warehouseLocationId: command.warehouseLocationId,
            requestedQty: quantity.toString(),
            selectedOpenQty: selectedOpen.toString(),
          },
        );
      }
      if (selectedOpen < quantity) {
        reconciledQuantity = quantity - selectedOpen;
        if (command.locationStrategy === "strict") {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_LOCATION_SHORTFALL",
            "The selected location does not own enough open claim inventory and strict location mode forbids reallocation.",
            {
              claimLineId: line.id.toString(),
              warehouseLocationId: command.warehouseLocationId,
              requestedQty: quantity.toString(),
              selectedOpenQty: selectedOpen.toString(),
            },
          );
        }
        if (command.locationStrategy === "reconcile_picker_observation") {
          if (!deps.observationReviewWriter) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_PICK_OBSERVATION_REVIEW_WRITER_MISSING",
              "Picker-observation reconciliation requires an atomic warehouse-review writer.",
            );
          }
          observationReconciliation = await reconcileObservedPickLocation(
            client,
            deps.inventoryWriter,
            deps.observationReviewWriter,
            {
              claim,
              line,
              orderWarehouseId: order.warehouseId,
              quantity: reconciledQuantity,
              command,
              requestHash,
              occurredAt,
            },
          );
        } else {
          await reconcilePickLocation(client, deps.inventoryWriter, {
            commandKey: `canonical:reconcile:${command.idempotencyKey}`,
            claim,
            line,
            orderWarehouseId: order.warehouseId,
            warehouseLocationId: command.warehouseLocationId,
            quantity: reconciledQuantity,
            actor: command.actor,
            reason: command.reason,
            occurredAt,
          });
        }
        line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
      }
      const pickResources = selectPickResources(line, command.warehouseLocationId, quantity);
      const picked = await deps.inventoryWriter.pickResources({
        client,
        commandKey: `canonical:pick:${command.idempotencyKey}`,
        claimId: claim.id,
        claimLineId: line.id,
        resources: pickResources,
        orderId: claim.orderId,
        orderItemId: line.orderItemId,
        actor: command.actor,
        reason: command.reason,
        occurredAt,
      });
      let assemblyLocation: { locationCode: string; zone: string | null } | null = null;
      if (command.assemblyWork) {
        const producers = await client.query<{ producer_operation_key: string | null }>(
          "SELECT producer_operation_key FROM inventory.availability_claim_resources WHERE id=ANY($1::bigint[]) ORDER BY id",
          [pickResources.map((resource) => resource.claimResourceId.toString())],
        );
        if (producers.rows.length !== pickResources.length) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_LINEAGE_MISMATCH",
            "Assembly output resource evidence changed.",
          );
        }
        assemblyLocation = await deps.workOwner!.authorizeOutputPick(client, {
          fence: command.assemblyWork,
          claimId: claim.id.toString(),
          orderId: claim.orderId,
          orderItemId: line.orderItemId,
          variantId: line.targetVariantId,
          locationId: command.warehouseLocationId,
          quantity: quantity.toString(),
          actorId: command.actor,
          producerOperationKeys: producers.rows.map((row) => row.producer_operation_key),
        });
      }
      for (const resource of pickResources) {
        for (const allocation of resource.lotAllocations) {
          const updated = await client.query(
            `UPDATE inventory.availability_claim_lot_allocations
             SET picked_qty = picked_qty + $1, updated_at = $3
             WHERE id = $2
               AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
            [allocation.pickQty.toString(), allocation.claimLotAllocationId.toString(), occurredAt],
          );
          if (updated.rowCount !== 1) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_PICK_STATE_CHANGED",
              "A claim lot allocation changed while its pick was recorded.",
              { claimLotAllocationId: allocation.claimLotAllocationId.toString() },
            );
          }
        }
        const updated = await client.query(
          `UPDATE inventory.availability_claim_resources
           SET picked_qty = picked_qty + $1, updated_at = $3
           WHERE id = $2
             AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
          [resource.pickQty.toString(), resource.claimResourceId.toString(), occurredAt],
        );
        if (updated.rowCount !== 1) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_STATE_CHANGED",
            "A claim resource changed while its pick was recorded.",
            { claimResourceId: resource.claimResourceId.toString() },
          );
        }
      }
      const updatedLine = await client.query(
        `UPDATE inventory.availability_claim_lines
         SET picked_target_qty = picked_target_qty + $1, updated_at = $3
         WHERE id = $2
           AND planned_qty - released_target_qty - consumed_target_qty - picked_target_qty >= $1`,
        [quantity.toString(), line.id.toString(), occurredAt],
      );
      if (updatedLine.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_PICK_STATE_CHANGED",
          "The claim line changed while its pick was recorded.",
          { claimLineId: line.id.toString() },
        );
      }
      await persistCanonicalWmsPickProgress(client, {
        movementType: "pick",
        movementQuantity: Number(quantity),
        orderId: claim.orderId,
        orderItemId: line.orderItemId,
        targetVariantId: line.targetVariantId,
        warehouseLocationId: command.warehouseLocationId,
        progress: command.wmsProgress,
        occurredAt,
      });
      if (assemblyLocation) {
        await recordAssemblyOutputPickLocation(client, {
          orderId: claim.orderId,
          orderItemId: line.orderItemId,
          ...assemblyLocation,
        });
      }
      const commonResult = {
        claimId: claim.id.toString(),
        claimLineId: line.id.toString(),
        orderId: claim.orderId,
        orderItemId: line.orderItemId,
        warehouseLocationIds: [command.warehouseLocationId],
        quantity: quantity.toString(),
        reconciledQuantity: reconciledQuantity.toString(),
        totalCostMills: picked.totalCostMills.toString(),
        idempotentReplay: false,
      };
      const result = canonicalAvailabilityClaimPickResultSchema.parse(
        command.locationStrategy === "reconcile_picker_observation" && observationReconciliation
          ? {
              outcome: "picked_with_observation",
              ...commonResult,
              recordedReconciledQuantity: observationReconciliation.recordedReconciledQuantity.toString(),
              observedRelocatedQuantity: observationReconciliation.observedRelocatedQuantity.toString(),
              inventoryReviewId: observationReconciliation.inventoryReviewId,
              observationKind: command.observation.kind,
            }
          : { outcome: "picked", ...commonResult },
      );
      await persistPickCommandAndEvent(client, {
        claim,
        line,
        command,
        commandType,
        movementType: "pick",
        requestHash,
        result,
        movements: picked.movements,
        occurredAt,
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
    "CLAIM_PICK_RETRY_EXHAUSTED",
    "Canonical claim pick could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}

export async function executeUnpickClaimLine(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimUnpickCommand,
): Promise<CanonicalAvailabilityClaimPickResult> {
  const command = canonicalAvailabilityClaimUnpickCommandSchema.parse(rawCommand);
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical unpick clock returned an invalid time.");
  }
  const claimId = positiveBigInt(command.claimId, "claim.id");
  const quantity = BigInt(positiveInteger(command.quantity, "unpick.quantity"));

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const replay = await loadPickReplay(client, command.idempotencyKey, requestHash, "unpick");
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await requireCanonicalAuthority(client);
      const preliminaryClaim = await loadClaimById(client, claimId, false);
      if (!preliminaryClaim) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_NOT_FOUND",
          "The requested canonical claim does not exist.",
          { claimId: claimId.toString() },
        );
      }
      const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
      if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_MODEL_EVIDENCE",
          "The claim does not contain a bounded model-evidence graph.",
          { claimId: claimId.toString(), productCount: graphProductIds.length },
        );
      }
      await lockGraphProducts(client, graphProductIds);
      const order = await loadOrder(client, preliminaryClaim.orderId, true);
      if (["packing", "packed", "shipped"].includes(order.warehouseStatus) || order.onHold) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_ORDER_NOT_UNPICKABLE",
          "A held, packing, packed, or shipped order cannot reverse a canonical pick.",
          { orderId: order.orderId, warehouseStatus: order.warehouseStatus, onHold: order.onHold },
        );
      }
      const claim = await loadClaimById(client, claimId, true);
      if (!claim || claim.orderId !== preliminaryClaim.orderId || claim.status !== preliminaryClaim.status) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_CHANGED",
          "The canonical claim changed while unpick locks were being acquired.",
          { claimId: claimId.toString() },
        );
      }
      const line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
      if (command.wmsProgress) {
        const expectedPicked = BigInt(command.wmsProgress.expectedPickedQuantity);
        const expectedFulfilled = BigInt(command.wmsProgress.expectedFulfilledQuantity ?? 0);
        const expectedClaimPicked = expectedPicked - expectedFulfilled;
        const resourcePicked = line.resources.reduce((sum, resource) => sum + resource.pickedQty, BigInt(0));
        const lotsMatchResources = line.resources.every((resource) =>
          resource.lots.reduce((sum, lot) => sum + lot.pickedQty, BigInt(0)) === resource.pickedQty);
        if (expectedClaimPicked < BigInt(0)
          || line.pickedTargetQty !== expectedClaimPicked
          || resourcePicked !== expectedClaimPicked
          || !lotsMatchResources
          || quantity !== expectedPicked - BigInt(command.wmsProgress.targetPickedQuantity)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_WMS_UNPICK_CUSTODY_MISMATCH",
            "WMS unpick progress must reverse only exact claim-owned picked custody above fulfilled custody.",
            {
              claimLineId: line.id.toString(),
              expectedPickedQty: expectedPicked.toString(),
              expectedFulfilledQty: expectedFulfilled.toString(),
              expectedClaimPickedQty: expectedClaimPicked.toString(),
              actualClaimPickedQty: line.pickedTargetQty.toString(),
              quantity: quantity.toString(),
            },
          );
        }
      }
      if (line.pickedTargetQty < quantity) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_LINE_UNPICK_OVERAGE",
          "The unpick exceeds the claim line's currently picked quantity.",
          { claimLineId: line.id.toString(), requestedQty: quantity.toString(), pickedQty: line.pickedTargetQty.toString() },
        );
      }
      const movementRows = rows(await client.query(
        `SELECT movement.id, movement.order_item_cost_id,
                movement.claim_resource_id, movement.claim_lot_allocation_id,
                movement.inventory_lot_id, movement.movement_type, movement.quantity,
                movement.reverses_pick_movement_id,
                resource.inventory_level_id, resource.warehouse_location_id,
                resource.source_variant_id,
                cost.order_id AS cost_order_id, cost.order_item_id AS cost_order_item_id,
                cost.inventory_lot_id AS cost_inventory_lot_id,
                cost.product_variant_id AS cost_product_variant_id,
                cost.qty AS cost_qty, cost.unit_cost_mills, cost.total_cost_mills,
                CASE WHEN to_jsonb(cost)->>'cost_quantity_allocation_id' IS NULL THEN NULL
                  ELSE jsonb_build_object('quantityAllocationId',to_jsonb(cost)->>'cost_quantity_allocation_id',
                  'productMills',to_jsonb(cost)->>'product_total_cost_mills','packagingMills',to_jsonb(cost)->>'packaging_total_cost_mills',
                  'landedMills',to_jsonb(cost)->>'landed_total_cost_mills') END AS exact_cost_totals,
                COALESCE((SELECT sum(dispatch.quantity)
                  FROM inventory.availability_claim_dispatch_movements AS dispatch
                  WHERE dispatch.pick_movement_id = movement.id), 0)::text AS dispatched_quantity
         FROM inventory.availability_claim_pick_movements AS movement
         JOIN inventory.availability_claim_resources AS resource
           ON resource.id = movement.claim_resource_id AND resource.claim_id = movement.claim_id
         JOIN oms.order_item_costs AS cost ON cost.id = movement.order_item_cost_id
         WHERE movement.claim_id = $1 AND movement.claim_line_id = $2
         ORDER BY movement.id
         FOR UPDATE OF movement, cost`,
        [claim.id.toString(), line.id.toString()],
      ));
      const reversedByPick = new Map<string, bigint>();
      for (const row of movementRows) {
        if (String(row.movement_type) !== "unpick") continue;
        const reverseId = positiveBigInt(row.reverses_pick_movement_id, "unpickMovement.reversesPickMovementId").toString();
        reversedByPick.set(reverseId, (reversedByPick.get(reverseId) ?? BigInt(0))
          + positiveBigInt(row.quantity, "unpickMovement.quantity"));
      }
      let remaining = quantity;
      const selectedRows: Array<{ row: any; quantity: bigint }> = [];
      for (const row of [...movementRows].reverse()) {
        if (remaining === BigInt(0)) break;
        if (String(row.movement_type) !== "pick") continue;
        const movementId = positiveBigInt(row.id, "pickMovement.id");
        const pickedQty = positiveBigInt(row.quantity, "pickMovement.quantity");
        const dispatchedQty = nonnegativeBigInt(row.dispatched_quantity, "pickMovement.dispatchedQuantity");
        const available = pickedQty - (reversedByPick.get(movementId.toString()) ?? BigInt(0)) - dispatchedQty;
        if (available < BigInt(0)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_UNPICK_LINEAGE_MISMATCH",
            "Compensating unpick and dispatch movements exceed their original pick movement.",
            { pickMovementId: movementId.toString() },
          );
        }
        const take = available < remaining ? available : remaining;
        if (take > BigInt(0)) selectedRows.push({ row, quantity: take });
        remaining -= take;
      }
      if (remaining !== BigInt(0)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_UNPICK_MOVEMENT_SHORTFALL",
          "Append-only pick movements do not contain enough unreversed quantity.",
          { claimLineId: line.id.toString(), shortfallQty: remaining.toString() },
        );
      }
      const byResource = new Map<string, CanonicalClaimInventoryUnpickResource>();
      for (const selected of selectedRows) {
        const row = selected.row;
        const movementQty = positiveBigInt(row.quantity, "pickMovement.quantity");
        const costQty = positiveBigInt(row.cost_qty, "orderItemCost.qty");
        const unitCostMills = nonnegativeBigInt(row.unit_cost_mills, "orderItemCost.unitCostMills");
        const totalCostMills = nonnegativeBigInt(row.total_cost_mills, "orderItemCost.totalCostMills");
        if (positiveInteger(row.cost_order_id, "orderItemCost.orderId") !== claim.orderId
          || positiveInteger(row.cost_order_item_id, "orderItemCost.orderItemId") !== line.orderItemId
          || positiveInteger(row.cost_inventory_lot_id, "orderItemCost.inventoryLotId")
            !== positiveInteger(row.inventory_lot_id, "pickMovement.inventoryLotId")
          || positiveInteger(row.cost_product_variant_id, "orderItemCost.productVariantId")
            !== positiveInteger(row.source_variant_id, "claimResource.sourceVariantId")
          || costQty !== movementQty
          || !recordedCostTotalIsValid({
            quantity: costQty.toString(),
            unitCostMills: unitCostMills.toString(),
            totalCostMills: totalCostMills.toString(),
            exactTotals: row.exact_cost_totals == null ? undefined : exactRecordedCostTotalsSchema.parse(row.exact_cost_totals),
          })) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_COGS_EVIDENCE_INVALID",
            "The original canonical pick COGS row does not match its immutable movement identity or cost.",
            { pickMovementId: String(row.id) },
          );
        }
        const resourceId = positiveBigInt(row.claim_resource_id, "claimResource.id");
        const key = resourceId.toString();
        const existing = byResource.get(key) ?? {
          claimResourceId: resourceId,
          inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
          warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
          sourceVariantId: positiveInteger(row.source_variant_id, "claimResource.sourceVariantId"),
          unpickQty: BigInt(0),
          lotAllocations: [],
        };
        const allocation = {
          claimLotAllocationId: positiveBigInt(row.claim_lot_allocation_id, "claimLotAllocation.id"),
          inventoryLotId: positiveInteger(row.inventory_lot_id, "inventoryLot.id"),
          unpickQty: selected.quantity,
          reversesPickMovementId: positiveBigInt(row.id, "pickMovement.id"),
          orderItemCostId: positiveInteger(row.order_item_cost_id, "orderItemCost.id"),
          unitCostMills,
        };
        byResource.set(key, {
          ...existing,
          unpickQty: existing.unpickQty + selected.quantity,
          lotAllocations: [...existing.lotAllocations, allocation],
        });
      }
      const restoreReservation = claim.status === "active";
      const unpicked = await deps.inventoryWriter.unpickResources({
        client,
        commandKey: `canonical:unpick:${command.idempotencyKey}`,
        claimId: claim.id,
        claimLineId: line.id,
        resources: [...byResource.values()],
        orderId: claim.orderId,
        orderItemId: line.orderItemId,
        restoreReservation,
        actor: command.actor,
        reason: command.reason,
        occurredAt,
      });
      for (const resource of byResource.values()) {
        for (const allocation of resource.lotAllocations) {
          const updated = await client.query(
            `UPDATE inventory.availability_claim_lot_allocations
             SET picked_qty = picked_qty - $1,
                 released_qty = released_qty + $2,
                 updated_at = $4
             WHERE id = $3 AND picked_qty >= $1`,
            [
              allocation.unpickQty.toString(),
              restoreReservation ? "0" : allocation.unpickQty.toString(),
              allocation.claimLotAllocationId.toString(),
              occurredAt,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_UNPICK_STATE_CHANGED",
              "A claim lot allocation changed while its unpick was recorded.",
              { claimLotAllocationId: allocation.claimLotAllocationId.toString() },
            );
          }
        }
        const updated = await client.query(
          `UPDATE inventory.availability_claim_resources
           SET picked_qty = picked_qty - $1,
               released_qty = released_qty + $2,
               updated_at = $4
           WHERE id = $3 AND picked_qty >= $1`,
          [
            resource.unpickQty.toString(),
            restoreReservation ? "0" : resource.unpickQty.toString(),
            resource.claimResourceId.toString(),
            occurredAt,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_UNPICK_STATE_CHANGED",
            "A claim resource changed while its unpick was recorded.",
            { claimResourceId: resource.claimResourceId.toString() },
          );
        }
      }
      const updatedLine = await client.query(
        `UPDATE inventory.availability_claim_lines
         SET picked_target_qty = picked_target_qty - $1,
             released_target_qty = released_target_qty + $2,
             updated_at = $4
         WHERE id = $3 AND picked_target_qty >= $1`,
        [quantity.toString(), restoreReservation ? "0" : quantity.toString(), line.id.toString(), occurredAt],
      );
      if (updatedLine.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_UNPICK_STATE_CHANGED",
          "The claim line changed while its unpick was recorded.",
          { claimLineId: line.id.toString() },
        );
      }
      await persistCanonicalWmsPickProgress(client, {
        movementType: "unpick",
        movementQuantity: Number(quantity),
        orderId: claim.orderId,
        orderItemId: line.orderItemId,
        targetVariantId: line.targetVariantId,
        unpickedWarehouseLocationIds: uniqueSorted(
          [...byResource.values()].map((resource) => resource.warehouseLocationId),
        ),
        progress: command.wmsProgress,
        occurredAt,
      });
      const locationIds = uniqueSorted([...byResource.values()].map((resource) => resource.warehouseLocationId));
      const result = canonicalAvailabilityClaimPickResultSchema.parse({
        outcome: "unpicked",
        claimId: claim.id.toString(),
        claimLineId: line.id.toString(),
        orderId: claim.orderId,
        orderItemId: line.orderItemId,
        warehouseLocationIds: locationIds,
        quantity: quantity.toString(),
        reservationRestored: restoreReservation,
        totalCostMills: unpicked.totalCostMills.toString(),
        idempotentReplay: false,
      });
      await persistPickCommandAndEvent(client, {
        claim,
        line,
        command,
        commandType: "unpick",
        movementType: "unpick",
        requestHash,
        result,
        movements: unpicked.movements,
        occurredAt,
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
    "CLAIM_UNPICK_RETRY_EXHAUSTED",
    "Canonical claim unpick could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}
