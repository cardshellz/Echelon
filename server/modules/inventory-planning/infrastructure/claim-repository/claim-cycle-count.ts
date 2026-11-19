import type { PoolClient } from "pg";

import {
  canonicalAvailabilityClaimReplacementCommandSchema,
  canonicalAvailabilityCycleCountReconciliationCommandSchema,
  canonicalAvailabilityCycleCountReconciliationResultSchema,
  type CanonicalAvailabilityCycleCountReconciliationCommand,
  type CanonicalAvailabilityCycleCountReconciliationResult,
} from "@shared/types/inventory-availability-claims";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  createVerifiedCycleCountPlanningSnapshot,
  planCanonicalClaim,
} from "../../domain/inventory-availability-planner";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "../inventory-availability-shadow.repository";
import {
  buildPlanRequest,
  discoverActiveGraphProducts,
  loadActiveClaimById,
  loadClaimProductIds,
  loadOrder,
  lockGraphProducts,
  lockPlanningPolicyHeads,
  lockSnapshotResources,
  nextClaimRevision,
  requireCanonicalAuthority,
} from "./claim-order-and-locks";
import {
  cancelOpenBuildHandoffs,
  insertClaimHeader,
  insertClaimLines,
  insertClaimOperations,
  persistReplacementCommandAndEvents,
  releaseClaimResources,
  reserveClaimResources,
} from "./claim-persistence";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  isRetryableTransactionError,
  MAX_CYCLE_COUNT_DISPLACED_CLAIMS,
  MAX_SERIALIZATION_ATTEMPTS,
  nonnegativeInteger,
  positiveBigInt,
  positiveInteger,
  replacementResult,
  rollback,
  rows,
  uniqueSorted,
  type ClaimRepositoryDependencies,
  type LockedOrder,
  type PersistedClaim,
} from "./claim-primitives";

type CycleCountItemEvidence = {
  id: number;
  cycleCountId: number;
  warehouseLocationId: number;
  productVariantId: number;
  countedQty: number;
  status: string;
  adjustmentTransactionId: number | null;
};

export type CycleCountOpenClaimAtLevel = {
  claimId: bigint;
  orderId: number;
  openQty: bigint;
};

async function loadCycleCountItemEvidence(
  client: PoolClient,
  command: CanonicalAvailabilityCycleCountReconciliationCommand,
): Promise<CycleCountItemEvidence> {
  const cycleCount = rows(await client.query(
    `SELECT id, status
     FROM inventory.cycle_counts
     WHERE id = $1
     FOR UPDATE`,
    [command.cycleCountId],
  ))[0];
  if (!cycleCount) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_NOT_FOUND",
      "The parent cycle count requested for canonical reconciliation does not exist.",
      { cycleCountId: command.cycleCountId },
    );
  }
  const row = rows(await client.query(
    `SELECT id, cycle_count_id, warehouse_location_id, product_variant_id,
            counted_qty, status, adjustment_transaction_id
     FROM inventory.cycle_count_items
     WHERE id = $1
     FOR UPDATE`,
    [command.cycleCountItemId],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_ITEM_NOT_FOUND",
      "The cycle-count item requested for canonical reconciliation does not exist.",
      { cycleCountItemId: command.cycleCountItemId },
    );
  }
  if (row.product_variant_id == null || row.counted_qty == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_ITEM_INCOMPLETE",
      "A cycle-count item must identify a variant and counted quantity before reconciliation.",
      { cycleCountItemId: command.cycleCountItemId },
    );
  }
  const item: CycleCountItemEvidence = {
    id: positiveInteger(row.id, "cycleCountItem.id"),
    cycleCountId: positiveInteger(row.cycle_count_id, "cycleCountItem.cycleCountId"),
    warehouseLocationId: positiveInteger(row.warehouse_location_id, "cycleCountItem.warehouseLocationId"),
    productVariantId: positiveInteger(row.product_variant_id, "cycleCountItem.productVariantId"),
    countedQty: nonnegativeInteger(row.counted_qty, "cycleCountItem.countedQty"),
    status: String(row.status),
    adjustmentTransactionId: row.adjustment_transaction_id == null
      ? null
      : positiveInteger(row.adjustment_transaction_id, "cycleCountItem.adjustmentTransactionId"),
  };
  if (item.cycleCountId !== command.cycleCountId
    || item.warehouseLocationId !== command.warehouseLocationId
    || item.productVariantId !== command.productVariantId
    || item.countedQty !== command.countedQty) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_COMMAND_EVIDENCE_CHANGED",
      "The locked cycle-count item no longer matches the submitted reconciliation command.",
      { command, item },
    );
  }
  if (item.status !== "approved" && String(cycleCount.status) !== "in_progress") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_NOT_IN_PROGRESS",
      "A cycle-count item may mutate inventory only while its parent count is in progress.",
      { cycleCountId: command.cycleCountId, cycleCountStatus: String(cycleCount.status), cycleCountItemId: item.id },
    );
  }
  return item;
}

export function selectCycleCountDisplacedClaims(
  claims: readonly CycleCountOpenClaimAtLevel[],
  reservedQty: number,
  countedQty: number,
): CycleCountOpenClaimAtLevel[] {
  const totalClaimed = claims.reduce((sum, claim) => sum + claim.openQty, BigInt(0));
  if (totalClaimed !== BigInt(reservedQty)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_CLAIM_OWNERSHIP_MISMATCH",
      "The inventory reserved counter does not equal exact open canonical claim ownership.",
      { reservedQty, exactClaimQty: totalClaimed.toString() },
    );
  }
  const excess = BigInt(Math.max(0, reservedQty - countedQty));
  if (excess === BigInt(0)) return [];
  const newestFirst = [...claims].sort((left, right) => left.claimId > right.claimId ? -1 : left.claimId < right.claimId ? 1 : 0);
  const selected: CycleCountOpenClaimAtLevel[] = [];
  let releasedAtLevel = BigInt(0);
  for (const claim of newestFirst) {
    if (releasedAtLevel >= excess) break;
    selected.push(claim);
    if (selected.length > MAX_CYCLE_COUNT_DISPLACED_CLAIMS) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CYCLE_COUNT_DISPLACEMENT_TOO_LARGE",
        "The counted shortage affects more claims than one bounded reconciliation may replace.",
        { limit: MAX_CYCLE_COUNT_DISPLACED_CLAIMS },
      );
    }
    releasedAtLevel += claim.openQty;
  }
  if (releasedAtLevel < excess) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_CLAIM_SHORTFALL",
      "Exact canonical claims cannot release enough ownership to apply the counted shortage.",
      { excess: excess.toString(), releasableQty: releasedAtLevel.toString() },
    );
  }
  return selected.sort((left, right) => left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0);
}

async function loadOpenClaimsAtLevel(
  client: PoolClient,
  inventoryLevelId: number,
  lock: boolean,
): Promise<CycleCountOpenClaimAtLevel[]> {
  const claimRows = rows(await client.query(
    `SELECT claim.id AS claim_id, claim.order_id, resource.id AS claim_resource_id,
            resource.claimed_qty - resource.released_qty
              - resource.consumed_qty - resource.picked_qty AS open_qty
     FROM inventory.availability_claims AS claim
     JOIN inventory.availability_claim_resources AS resource
       ON resource.claim_id = claim.id
     WHERE claim.status = 'active'
       AND resource.inventory_level_id = $1
       AND resource.claimed_qty - resource.released_qty
         - resource.consumed_qty - resource.picked_qty > 0
     ORDER BY claim.id, resource.id
     ${lock ? "FOR UPDATE OF claim, resource" : ""}`,
    [inventoryLevelId],
  ));
  const claims = new Map<string, CycleCountOpenClaimAtLevel>();
  for (const row of claimRows) {
    const claimId = positiveBigInt(row.claim_id, "claim.id");
    const key = claimId.toString();
    const orderId = positiveInteger(row.order_id, "claim.orderId");
    const openQty = positiveBigInt(row.open_qty, "claimResource.openQty");
    const existing = claims.get(key);
    if (existing && existing.orderId !== orderId) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CYCLE_COUNT_CLAIM_ORDER_MISMATCH",
        "One canonical claim resolved to multiple order owners.",
        { claimId: key, firstOrderId: existing.orderId, nextOrderId: orderId },
      );
    }
    claims.set(key, { claimId, orderId, openQty: (existing?.openQty ?? BigInt(0)) + openQty });
  }
  return [...claims.values()].sort((left, right) => left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0);
}

function openClaimEvidence(claims: readonly CycleCountOpenClaimAtLevel[]): string {
  return canonicalJson(claims.map((claim) => ({
    claimId: claim.claimId.toString(),
    orderId: claim.orderId,
    openQty: claim.openQty.toString(),
  })));
}

async function loadCycleCountReplayResult(
  client: PoolClient,
  command: CanonicalAvailabilityCycleCountReconciliationCommand,
  item: CycleCountItemEvidence,
): Promise<CanonicalAvailabilityCycleCountReconciliationResult> {
  if (item.adjustmentTransactionId == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_REPLAY_EVIDENCE_MISSING",
      "An approved cycle-count item has no durable adjustment or no-op transaction evidence.",
      { cycleCountItemId: command.cycleCountItemId },
    );
  }
  const transactions = rows(await client.query(
    `SELECT id, product_variant_id, from_location_id, to_location_id, transaction_type,
            variant_qty_before, variant_qty_after, variant_qty_delta,
            inventory_lot_id, unit_cost_mills, total_cost_mills,
            cycle_count_id, reference_type, reference_id
     FROM inventory.inventory_transactions
     WHERE id = $1
        OR (cycle_count_id = $2 AND reference_type = 'cycle_count_item' AND reference_id = $3)
     ORDER BY id
     FOR SHARE`,
    [item.adjustmentTransactionId, command.cycleCountId, String(command.cycleCountItemId)],
  ));
  const pointerIndex = transactions.findIndex((transaction) =>
    positiveInteger(transaction.id, "inventoryTransaction.id") === item.adjustmentTransactionId);
  const pointer = pointerIndex < 0 ? null : transactions[pointerIndex];
  const exactItemLineage = pointer?.reference_type === "cycle_count_item"
    && String(pointer.reference_id) === String(command.cycleCountItemId);
  const historicalCountLineage = pointer?.reference_type === "cycle_count"
    && String(pointer.reference_id) === String(command.cycleCountId);
  if (!pointer || pointerIndex !== 0 || (!exactItemLineage && !historicalCountLineage)
    || (historicalCountLineage && transactions.length !== 1)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_ADJUSTMENT_LINEAGE_MISMATCH",
      "The approved cycle-count item does not reference a complete adjustment transaction sequence.",
      { cycleCountItemId: command.cycleCountItemId, adjustmentTransactionId: item.adjustmentTransactionId },
    );
  }
  let quantityBefore: number | null = null;
  let quantityAfter: number | null = null;
  let quantityDelta = 0;
  for (const transaction of transactions) {
    const rowDelta = Number(transaction.variant_qty_delta);
    const rowBefore = nonnegativeInteger(transaction.variant_qty_before, "inventoryTransaction.quantityBefore");
    const rowAfter = nonnegativeInteger(transaction.variant_qty_after, "inventoryTransaction.quantityAfter");
    const fromLocationId = transaction.from_location_id == null
      ? null : positiveInteger(transaction.from_location_id, "inventoryTransaction.fromLocationId");
    const toLocationId = transaction.to_location_id == null
      ? null : positiveInteger(transaction.to_location_id, "inventoryTransaction.toLocationId");
    const expectedFromLocationId = rowDelta < 0
      ? command.warehouseLocationId : rowDelta === 0 ? command.warehouseLocationId : null;
    const expectedToLocationId = rowDelta > 0
      ? command.warehouseLocationId : rowDelta === 0 ? command.warehouseLocationId : null;
    if (transaction.transaction_type !== "adjustment"
      || positiveInteger(transaction.product_variant_id, "inventoryTransaction.productVariantId") !== command.productVariantId
      || positiveInteger(transaction.cycle_count_id, "inventoryTransaction.cycleCountId") !== command.cycleCountId
      || (exactItemLineage && (transaction.reference_type !== "cycle_count_item"
        || String(transaction.reference_id) !== String(command.cycleCountItemId)))
      || !Number.isSafeInteger(rowDelta)
      || rowBefore + rowDelta !== rowAfter
      || (quantityAfter != null && rowBefore !== quantityAfter)
      || fromLocationId !== expectedFromLocationId
      || toLocationId !== expectedToLocationId) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CYCLE_COUNT_ADJUSTMENT_LINEAGE_MISMATCH",
        "The cycle-count adjustment sequence does not reconcile to one location and quantity chain.",
        { cycleCountItemId: command.cycleCountItemId, inventoryTransactionId: String(transaction.id) },
      );
    }
    quantityBefore ??= rowBefore;
    quantityAfter = rowAfter;
    quantityDelta += rowDelta;
    if (!Number.isSafeInteger(quantityDelta)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CYCLE_COUNT_ADJUSTMENT_LINEAGE_MISMATCH",
        "The cycle-count adjustment sequence exceeds the supported quantity range.",
        { cycleCountItemId: command.cycleCountItemId },
      );
    }
  }
  if (quantityBefore == null || quantityAfter !== command.countedQty
    || quantityBefore + quantityDelta !== quantityAfter) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CYCLE_COUNT_ADJUSTMENT_LINEAGE_MISMATCH",
      "The cycle-count adjustment sequence does not end at the approved physical count.",
      { cycleCountItemId: command.cycleCountItemId, quantityBefore, quantityAfter, quantityDelta },
    );
  }
  const replacementPrefix = `cycle-count:${command.cycleCountId}:${command.cycleCountItemId}:claim:`;
  const displacedRows = rows(await client.query(
    `SELECT DISTINCT order_id
     FROM inventory.availability_claim_commands
     WHERE command_type = 'replace'
       AND left(idempotency_key, length($1)) = $1
     ORDER BY order_id`,
    [replacementPrefix],
  ));
  const displacedOrderIds = displacedRows.map((row) => positiveInteger(row.order_id, "claimCommand.orderId"));
  return canonicalAvailabilityCycleCountReconciliationResultSchema.parse({
    outcome: "cycle_count_reconciled",
    cycleCountId: command.cycleCountId,
    cycleCountItemId: command.cycleCountItemId,
    productVariantId: command.productVariantId,
    warehouseLocationId: command.warehouseLocationId,
    quantityBefore,
    quantityAfter,
    quantityDelta,
    adjustmentTransactionId: item.adjustmentTransactionId,
    displacedOrderIds,
    idempotentReplay: true,
  });
}

export async function executeReconcileCycleCount(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityCycleCountReconciliationCommand,
): Promise<CanonicalAvailabilityCycleCountReconciliationResult> {
  const command = canonicalAvailabilityCycleCountReconciliationCommandSchema.parse(rawCommand);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLOCK",
      "Canonical cycle-count reconciliation clock returned an invalid time.",
    );
  }

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const authority = await requireCanonicalAuthority(client);
      const item = await loadCycleCountItemEvidence(client, command);
      if (item.status === "approved") {
        const replay = await loadCycleCountReplayResult(client, command, item);
        await client.query("COMMIT");
        return replay;
      }
      if (!["counted", "variance", "investigate"].includes(item.status)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_ITEM_NOT_APPROVABLE",
          "The cycle-count item is not in an approvable state.",
          { cycleCountItemId: item.id, status: item.status },
        );
      }

      await deps.inventoryWriter.assertCountableCustody({
        client, productVariantId: command.productVariantId, warehouseLocationId: command.warehouseLocationId,
      });
      let levelRow = rows(await client.query(
        `SELECT id, variant_qty, reserved_qty
         FROM inventory.inventory_levels
         WHERE product_variant_id = $1 AND warehouse_location_id = $2`,
        [command.productVariantId, command.warehouseLocationId],
      ))[0];
      if (!levelRow && command.countedQty > 0) {
        const inventoryLevelId = await deps.inventoryWriter.ensureInventoryLevel({
          client,
          productVariantId: command.productVariantId,
          warehouseLocationId: command.warehouseLocationId,
          occurredAt,
        });
        levelRow = { id: inventoryLevelId, variant_qty: 0, reserved_qty: 0 };
      }
      const quantityBefore = levelRow == null
        ? 0
        : nonnegativeInteger(levelRow.variant_qty, "inventoryLevel.variantQty");
      const approveAndCommit = async (
        adjustmentTransactionId: number | null,
        displacedOrderIds: readonly number[],
      ): Promise<CanonicalAvailabilityCycleCountReconciliationResult> => {
        await deps.inventoryWriter.approveCycleCountItem({
          client,
          cycleCountItemId: item.id,
          expectedStatus: item.status,
          actor: command.actor,
          reasonCode: command.reasonCode,
          adjustmentTransactionId,
          occurredAt,
        });
        const result = canonicalAvailabilityCycleCountReconciliationResultSchema.parse({
          outcome: "cycle_count_reconciled",
          cycleCountId: command.cycleCountId,
          cycleCountItemId: command.cycleCountItemId,
          productVariantId: command.productVariantId,
          warehouseLocationId: command.warehouseLocationId,
          quantityBefore,
          quantityAfter: command.countedQty,
          quantityDelta: command.countedQty - quantityBefore,
          adjustmentTransactionId,
          displacedOrderIds: uniqueSorted(displacedOrderIds),
          idempotentReplay: false,
        });
        await client.query("COMMIT");
        return result;
      };
      if (levelRow == null) {
        const noOp = await deps.inventoryWriter.recordCycleCountNoop({
          client,
          productVariantId: command.productVariantId,
          warehouseLocationId: command.warehouseLocationId,
          countedQty: command.countedQty,
          cycleCountId: command.cycleCountId,
          cycleCountItemId: command.cycleCountItemId,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        });
        return approveAndCommit(noOp.adjustmentTransactionId, []);
      }

      const inventoryLevelId = positiveInteger(levelRow.id, "inventoryLevel.id");
      const preliminaryReservedQty = nonnegativeInteger(levelRow.reserved_qty, "inventoryLevel.reservedQty");
      const preliminaryOpenClaims = await loadOpenClaimsAtLevel(client, inventoryLevelId, false);
      const preliminaryDisplaced = selectCycleCountDisplacedClaims(
        preliminaryOpenClaims,
        preliminaryReservedQty,
        command.countedQty,
      );
      if (preliminaryDisplaced.length === 0) {
        const lockedLevel = rows(await client.query(
          `SELECT id, variant_qty, reserved_qty
           FROM inventory.inventory_levels
           WHERE id = $1
           FOR UPDATE`,
          [inventoryLevelId],
        ))[0];
        if (!lockedLevel
          || nonnegativeInteger(lockedLevel.variant_qty, "inventoryLevel.variantQty") !== quantityBefore
          || nonnegativeInteger(lockedLevel.reserved_qty, "inventoryLevel.reservedQty") !== preliminaryReservedQty) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_LEVEL_CHANGED",
            "The counted inventory level changed before reconciliation locks were acquired.",
            { inventoryLevelId, quantityBefore, preliminaryReservedQty },
          );
        }
        const lockedOpenClaims = await loadOpenClaimsAtLevel(client, inventoryLevelId, false);
        if (openClaimEvidence(preliminaryOpenClaims) !== openClaimEvidence(lockedOpenClaims)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_CLAIM_SET_CHANGED",
            "Canonical claim ownership changed while the counted inventory level was locked.",
            { inventoryLevelId },
          );
        }
        const lockedDisplaced = selectCycleCountDisplacedClaims(
          lockedOpenClaims,
          preliminaryReservedQty,
          command.countedQty,
        );
        if (lockedDisplaced.length !== 0) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_CLAIM_SET_CHANGED",
            "The cycle-count displacement set changed while the inventory level was locked.",
            { inventoryLevelId },
          );
        }
        const adjustment = quantityBefore === command.countedQty
          ? await deps.inventoryWriter.recordCycleCountNoop({
            client,
            productVariantId: command.productVariantId,
            warehouseLocationId: command.warehouseLocationId,
            countedQty: command.countedQty,
            cycleCountId: command.cycleCountId,
            cycleCountItemId: command.cycleCountItemId,
            actor: command.actor,
            reason: command.reason,
            occurredAt,
          })
          : await deps.inventoryWriter.applyCycleCountAdjustment({
            client,
            inventoryLevelId,
            productVariantId: command.productVariantId,
            warehouseLocationId: command.warehouseLocationId,
            quantityBefore,
            countedQty: command.countedQty,
            cycleCountId: command.cycleCountId,
            cycleCountItemId: command.cycleCountItemId,
            actor: command.actor,
            reason: command.reason,
            occurredAt,
          });
        return approveAndCommit(adjustment.adjustmentTransactionId, []);
      }
      const preliminaryClaims: PersistedClaim[] = [];
      const preliminaryOrders = new Map<number, LockedOrder>();
      for (const owner of preliminaryDisplaced) {
        const claim = await loadActiveClaimById(client, owner.claimId, false);
        if (!claim || claim.orderId !== owner.orderId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_CLAIM_SET_CHANGED",
            "A claim selected for cycle-count displacement changed before locks were acquired.",
            { claimId: owner.claimId.toString(), orderId: owner.orderId },
          );
        }
        preliminaryClaims.push(claim);
        preliminaryOrders.set(owner.orderId, await loadOrder(client, owner.orderId, false));
      }

      const countedVariant = rows(await client.query(
        `SELECT id, product_id
         FROM catalog.product_variants
         WHERE id = $1 AND is_active = true
         FOR SHARE`,
        [command.productVariantId],
      ))[0];
      if (!countedVariant) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_VARIANT_MISSING",
          "The counted product variant is missing or inactive.",
          { productVariantId: command.productVariantId },
        );
      }
      const graphRoots = [positiveInteger(countedVariant.product_id, "productVariant.productId")];
      for (const claim of preliminaryClaims) graphRoots.push(...await loadClaimProductIds(client, claim));
      for (const order of preliminaryOrders.values()) {
        graphRoots.push(...order.lines.map((line) => line.rootProductId));
      }
      const graphProducts = await discoverActiveGraphProducts(client, uniqueSorted(graphRoots));
      await lockGraphProducts(client, graphProducts);

      const targetVariantIds = uniqueSorted([
        command.productVariantId,
        ...preliminaryClaims.flatMap((claim) => claim.plan.lines.map((line) => line.targetVariantId)),
        ...[...preliminaryOrders.values()].flatMap((order) => order.lines.map((line) => line.targetVariantId)),
      ]);
      const preliminarySnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(client, targetVariantIds);
      await lockPlanningPolicyHeads(client, preliminarySnapshot);
      const lockedOrders = new Map<number, LockedOrder>();
      for (const orderId of uniqueSorted(preliminaryDisplaced.map((claim) => claim.orderId))) {
        const order = await loadOrder(client, orderId, true);
        if (["cancelled", "shipped"].includes(order.warehouseStatus) || order.lines.length === 0) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_ORDER_NOT_CLAIMABLE",
            "A displaced order became terminal or lost its remaining claimable demand.",
            { orderId, warehouseStatus: order.warehouseStatus },
          );
        }
        const preliminaryOrder = preliminaryOrders.get(orderId);
        if (!preliminaryOrder || canonicalJson(preliminaryOrder) !== canonicalJson(order)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_ORDER_DEMAND_CHANGED",
            "A displaced order changed while cycle-count locks were being acquired.",
            { orderId },
          );
        }
        lockedOrders.set(orderId, order);
      }

      // Claim mutations lock order -> claim -> inventory resources. Follow
      // that same order for every owner we may displace, then acquire the
      // complete level/lot set in the repository's canonical sorted order.
      // Non-displaced claim rows are intentionally read without row locks
      // after the inventory level is locked: every canonical ownership
      // mutation must first acquire that level, so the aggregate lock is the
      // serialization boundary without introducing claim -> level inversion.
      const lockedClaims: PersistedClaim[] = [];
      for (const owner of preliminaryDisplaced) {
        const claim = await loadActiveClaimById(client, owner.claimId, true);
        if (!claim || claim.orderId !== owner.orderId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CYCLE_COUNT_CLAIM_SET_CHANGED",
            "A displaced canonical claim changed before inventory resources were locked.",
            { claimId: owner.claimId.toString(), orderId: owner.orderId },
          );
        }
        lockedClaims.push(claim);
      }
      const lockedTargetVariantIds = uniqueSorted([
        command.productVariantId,
        ...lockedClaims.flatMap((claim) => claim.plan.lines.map((line) => line.targetVariantId)),
        ...[...lockedOrders.values()].flatMap((order) => order.lines.map((line) => line.targetVariantId)),
      ]);
      if (canonicalJson(targetVariantIds) !== canonicalJson(lockedTargetVariantIds)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_ORDER_DEMAND_CHANGED",
          "A displaced order or claim changed target variants while cycle-count locks were being acquired.",
          { targetVariantIds, lockedTargetVariantIds },
        );
      }
      const lockedGraphRoots = [positiveInteger(countedVariant.product_id, "productVariant.productId")];
      for (const claim of lockedClaims) lockedGraphRoots.push(...await loadClaimProductIds(client, claim));
      for (const order of lockedOrders.values()) {
        lockedGraphRoots.push(...order.lines.map((line) => line.rootProductId));
      }
      const lockedGraphProducts = await discoverActiveGraphProducts(client, uniqueSorted(lockedGraphRoots));
      if (canonicalJson(graphProducts) !== canonicalJson(lockedGraphProducts)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_TRANSFORMATION_GRAPH_CHANGED",
          "The active transformation graph changed while cycle-count locks were being acquired.",
          { graphProducts, lockedGraphProducts },
        );
      }
      await lockSnapshotResources(client, preliminarySnapshot);

      const lockedLevel = rows(await client.query(
        `SELECT id, variant_qty, reserved_qty
         FROM inventory.inventory_levels
         WHERE id = $1
         FOR UPDATE`,
        [inventoryLevelId],
      ))[0];
      if (!lockedLevel
        || nonnegativeInteger(lockedLevel.variant_qty, "inventoryLevel.variantQty") !== quantityBefore) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_LEVEL_CHANGED",
          "The counted inventory level changed while reconciliation locks were being acquired.",
          { inventoryLevelId, quantityBefore },
        );
      }
      const lockedReservedQty = nonnegativeInteger(lockedLevel.reserved_qty, "inventoryLevel.reservedQty");
      const lockedOpenClaims = await loadOpenClaimsAtLevel(client, inventoryLevelId, false);
      if (openClaimEvidence(preliminaryOpenClaims) !== openClaimEvidence(lockedOpenClaims)
        || preliminaryReservedQty !== lockedReservedQty) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_CLAIM_SET_CHANGED",
          "Canonical claim ownership changed while cycle-count locks were being acquired.",
          { inventoryLevelId },
        );
      }
      const displacedOwners = selectCycleCountDisplacedClaims(
        lockedOpenClaims,
        lockedReservedQty,
        command.countedQty,
      );
      if (openClaimEvidence(preliminaryDisplaced) !== openClaimEvidence(displacedOwners)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CYCLE_COUNT_CLAIM_SET_CHANGED",
          "The deterministic cycle-count displacement set changed while locks were being acquired.",
          { inventoryLevelId },
        );
      }

      const releasedByClaim = new Map<string, { releasedResourceQty: bigint; releasedLotQty: bigint }>();
      for (const claim of lockedClaims) {
        const lifecycleCommand = canonicalAvailabilityClaimReplacementCommandSchema.parse({
          orderId: claim.orderId,
          expectedClaimId: claim.id.toString(),
          idempotencyKey: `cycle-count:${command.cycleCountId}:${command.cycleCountItemId}:claim:${claim.id}`,
          actor: command.actor,
          reason: command.reason,
        });
        await cancelOpenBuildHandoffs(
          client,
          deps.buildWriter,
          claim,
          { ...lifecycleCommand, disposition: "supersede" as const },
          occurredAt,
          deps.workOwner,
        );
        releasedByClaim.set(claim.id.toString(), await releaseClaimResources(client, {
          inventoryWriter: deps.inventoryWriter,
          commandKey: `canonical:count-release:${command.cycleCountId}:${command.cycleCountItemId}:${claim.id}`,
          claim,
          orderId: claim.orderId,
          actor: command.actor,
          reason: command.reason,
          disposition: "supersede",
          occurredAt,
        }));
      }

      const adjustment = quantityBefore === command.countedQty
        ? await deps.inventoryWriter.recordCycleCountNoop({
          client,
          productVariantId: command.productVariantId,
          warehouseLocationId: command.warehouseLocationId,
          countedQty: command.countedQty,
          cycleCountId: command.cycleCountId,
          cycleCountItemId: command.cycleCountItemId,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        })
        : await deps.inventoryWriter.applyCycleCountAdjustment({
          client,
          inventoryLevelId,
          productVariantId: command.productVariantId,
          warehouseLocationId: command.warehouseLocationId,
          quantityBefore,
          countedQty: command.countedQty,
          cycleCountId: command.cycleCountId,
          cycleCountItemId: command.cycleCountItemId,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        });

      for (const claim of lockedClaims) {
        const order = lockedOrders.get(claim.orderId)!;
        const revision = await nextClaimRevision(client, claim.orderId);
        const request = buildPlanRequest(order, revision);
        const frozenSnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
          client,
          order.lines.map((line) => line.targetVariantId),
        );
        // The persisted location remains frozen for every warehouse operation.
        // Only this post-count replacement plan may use the quantity physically
        // verified by the same locked cycle-count transaction.
        const snapshot = createVerifiedCycleCountPlanningSnapshot(
          frozenSnapshot,
          command.warehouseLocationId,
        );
        const plan = planCanonicalClaim(snapshot, request);
        if (plan.status === "blocked") {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CANONICAL_CYCLE_COUNT_REPLAN_BLOCKED",
            "The canonical planner blocked an order displaced by the counted shortage.",
            { orderId: claim.orderId, supersededClaimId: claim.id.toString(), blockers: plan.blockers },
          );
        }
        const replacementCommand = canonicalAvailabilityClaimReplacementCommandSchema.parse({
          orderId: claim.orderId,
          expectedClaimId: claim.id.toString(),
          idempotencyKey: `cycle-count:${command.cycleCountId}:${command.cycleCountItemId}:claim:${claim.id}`,
          actor: command.actor,
          reason: command.reason,
        });
        const replacementClaimId = await insertClaimHeader(client, {
          order,
          revision,
          authority,
          request,
          plan,
          command: replacementCommand,
          supersedesClaimId: claim.id,
          occurredAt,
        });
        const lineIds = await insertClaimLines(client, replacementClaimId, order, plan);
        await insertClaimOperations(client, replacementClaimId, lineIds, plan);
        await reserveClaimResources(
          client,
          deps.inventoryWriter,
          replacementClaimId,
          order,
          lineIds,
          plan,
          command.actor,
          occurredAt,
        );
        const replacementClaim: PersistedClaim = {
          id: replacementClaimId,
          claimKey: request.requestKey,
          orderId: claim.orderId,
          revision,
          runtimeAuthorityRevision: authority.revision,
          planHash: hash(plan),
          plan,
        };
        const released = releasedByClaim.get(claim.id.toString())!;
        const replacement = replacementResult(claim, replacementClaim, released, false);
        await persistReplacementCommandAndEvents(client, {
          supersededClaim: claim,
          replacementClaimId,
          command: replacementCommand,
          requestHash: hash(replacementCommand),
          result: replacement,
          occurredAt,
        });
      }

      return approveAndCommit(
        adjustment.adjustmentTransactionId,
        displacedOwners.map((owner) => owner.orderId),
      );
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
    "CYCLE_COUNT_RECONCILIATION_RETRY_EXHAUSTED",
    "Canonical cycle-count reconciliation could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS, cycleCountItemId: command.cycleCountItemId },
    { cause: lastRetryableError },
  );
}
