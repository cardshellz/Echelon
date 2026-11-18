import type { PoolClient } from "pg";

import {
  canonicalAvailabilityClaimDisplacementCommandSchema,
  canonicalAvailabilityClaimDisplacementResultSchema,
  canonicalAvailabilityClaimReplacementCommandSchema,
  type CanonicalAvailabilityClaimDisplacementCommand,
  type CanonicalAvailabilityClaimDisplacementResult,
  type CanonicalAvailabilityClaimReplacementCommand,
} from "@shared/types/inventory-availability-claims";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  displacementEvidence,
  selectDisplacementDonors,
  type DisplacementDonor,
} from "../../domain/claim-displacement";
import {
  rejectSupplyRefreshBeforePlanning,
  rejectSupplyRefreshPlan,
} from "../../domain/claim-supply-refresh";
import { planCanonicalClaim } from "../../domain/inventory-availability-planner";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "../inventory-availability-shadow.repository";
import {
  buildPlanRequest,
  discoverActiveGraphProducts,
  loadActiveClaim,
  loadActiveClaimById,
  loadClaimLineBalances,
  loadClaimProductIds,
  loadOrder,
  lockGraphProducts,
  lockPlanningPolicyHeads,
  lockSnapshotResources,
  nextClaimRevision,
  orderClaimable,
  orderDemandMatchesClaim,
  requireCanonicalAuthority,
  supplyRefreshError,
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
  loadReplacementReplay,
  MAX_GRAPH_PRODUCTS,
  MAX_SERIALIZATION_ATTEMPTS,
  nonnegativeBigInt,
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

/**
 * The pick queue's manual "Bump to Top" priority. A bumped order keeps its stock;
 * every other order's priority (shipping speed plus membership tier) only
 * decides who yields first.
 */
const BUMPED_ORDER_PRIORITY = 9999;
/** Bounds the donor search; a shortfall needing more orders than this is declined. */
const MAX_DISPLACEMENT_DONORS = 50;

/** The units the confirmed line still needs its claim to own at this moment. */
async function loadDisplacementNeed(
  client: PoolClient,
  claim: PersistedClaim,
  order: LockedOrder,
  orderItemId: number,
  quantity: bigint,
): Promise<{ targetVariantId: number; warehouseId: number; shortQty: bigint }> {
  if (order.warehouseId == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_DISPLACEMENT_SCOPE_UNSUPPORTED",
      "Displacement needs a warehouse-scoped order.",
      { orderId: order.orderId },
    );
  }
  const line = rows(await client.query(
    `SELECT target_variant_id, planned_qty, released_target_qty, consumed_target_qty, picked_target_qty
     FROM inventory.availability_claim_lines
     WHERE claim_id = $1 AND order_item_id = $2`,
    [claim.id.toString(), orderItemId],
  ))[0];
  if (!line) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_LINE_NOT_FOUND",
      "The confirmed order item is not on the order's active claim.",
      { claimId: claim.id.toString(), orderItemId },
    );
  }
  const open = nonnegativeBigInt(line.planned_qty, "claimLine.plannedQty")
    - nonnegativeBigInt(line.released_target_qty, "claimLine.releasedTargetQty")
    - nonnegativeBigInt(line.consumed_target_qty, "claimLine.consumedTargetQty")
    - nonnegativeBigInt(line.picked_target_qty, "claimLine.pickedTargetQty");
  const shortQty = quantity - open;
  if (shortQty <= BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_DISPLACEMENT_NOT_REQUIRED",
      "The confirmed line already owns enough reserved stock.",
      { claimId: claim.id.toString(), orderItemId },
    );
  }
  return {
    targetVariantId: positiveInteger(line.target_variant_id, "claimLine.targetVariantId"),
    warehouseId: order.warehouseId,
    shortQty,
  };
}

/**
 * Other orders' claims that hold open, unpicked stock of the variant in the
 * warehouse and have not started: ready, not held, not bumped, and no picked
 * or consumed custody on any line. Lowest pick priority first, then newest.
 */
async function loadDisplacementDonors(
  client: PoolClient,
  input: { targetVariantId: number; warehouseId: number; recipientOrderId: number },
): Promise<DisplacementDonor[]> {
  return rows(await client.query(
    `SELECT c.id AS claim_id, c.order_id, COALESCE(o.priority, 0) AS priority,
            SUM(r.claimed_qty - r.released_qty - r.consumed_qty - r.picked_qty) AS open_qty
     FROM inventory.availability_claim_resources r
     JOIN inventory.availability_claims c ON c.id = r.claim_id AND c.status = 'active'
     JOIN wms.orders o ON o.id = c.order_id
     WHERE r.source_variant_id = $1
       AND r.warehouse_id = $2
       AND r.consumer_operation_key IS NULL
       AND r.claimed_qty - r.released_qty - r.consumed_qty - r.picked_qty > 0
       AND c.order_id <> $3
       AND o.warehouse_status = 'ready'
       AND COALESCE(o.on_hold, 0) = 0
       AND COALESCE(o.priority, 0) < $4
       AND NOT EXISTS (
         SELECT 1 FROM inventory.availability_claim_lines l
         WHERE l.claim_id = c.id AND (l.picked_target_qty > 0 OR l.consumed_target_qty > 0))
     GROUP BY c.id, c.order_id, o.priority
     ORDER BY COALESCE(o.priority, 0) ASC, c.order_id DESC, c.id DESC
     LIMIT $5`,
    [input.targetVariantId, input.warehouseId, input.recipientOrderId,
      BUMPED_ORDER_PRIORITY, MAX_DISPLACEMENT_DONORS],
  )).map((row) => ({
    claimId: positiveBigInt(row.claim_id, "displacementDonor.claimId"),
    orderId: positiveInteger(row.order_id, "displacementDonor.orderId"),
    priority: Number(row.priority),
    openQty: positiveBigInt(row.open_qty, "displacementDonor.openQty"),
  }));
}

/** Each displaced claim's replacement needs its own key within the 120-character limit. */
function displacedClaimIdempotencyKey(recipientKey: string, donorClaimId: bigint): string {
  return `displaced:${hash({ recipientKey, donorClaimId: donorClaimId.toString() })}`;
}

/**
 * A picker confirmed units of this order already shipped, but the books
 * promised every unit of the variant in its warehouse to orders that have not
 * started picking. The shipped units came out of that shared stock, so the
 * lowest-priority (then newest) unstarted orders give up exactly the shortfall and are re-planned
 * (and may become short), and this order is re-planned to own what it shipped.
 * One serializable transaction: unless the confirmed line ends fully owned and
 * no line of this order loses stock, nothing changes.
 */
export async function executeDisplaceForConfirmedShipment(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimDisplacementCommand,
): Promise<CanonicalAvailabilityClaimDisplacementResult> {
  const command = canonicalAvailabilityClaimDisplacementCommandSchema.parse(rawCommand);
  const expectedClaimId = positiveBigInt(command.expectedClaimId, "displacement.expectedClaimId");
  const quantity = positiveBigInt(command.quantity, "displacement.quantity");
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLOCK",
      "Canonical claim displacement clock returned an invalid time.",
    );
  }
  const displacementError = (code: string, message: string, context: Record<string, unknown> = {}) =>
    new InventoryAvailabilityClaimRepositoryError(code, message, { orderId: command.orderId, ...context });

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const replay = await loadReplacementReplay(client, command.idempotencyKey, requestHash);
      if (replay) {
        await client.query("COMMIT");
        return canonicalAvailabilityClaimDisplacementResultSchema.parse({ ...replay, displacedOrderIds: [] });
      }
      const authority = await requireCanonicalAuthority(client);

      // Unlocked reads choose the lock set; everything is re-read under lock.
      const preliminaryClaim = await loadActiveClaim(client, command.orderId, false);
      if (!preliminaryClaim || preliminaryClaim.id !== expectedClaimId) {
        throw displacementError("ACTIVE_CLAIM_CHANGED",
          "The order's active canonical claim does not match the expected displacement recipient.",
          { expectedClaimId: command.expectedClaimId, activeClaimId: preliminaryClaim?.id.toString() ?? null });
      }
      const preliminaryOrder = await loadOrder(client, command.orderId, false);
      if (!orderClaimable(preliminaryOrder, true)) {
        throw displacementError("REPLACEMENT_ORDER_NOT_CLAIMABLE",
          "The order is cancelled or has nothing left to reserve.",
          { warehouseStatus: preliminaryOrder.warehouseStatus });
      }
      const preliminaryNeed = await loadDisplacementNeed(client, preliminaryClaim, preliminaryOrder,
        command.orderItemId, quantity);
      const preliminaryDonors = selectDisplacementDonors(
        await loadDisplacementDonors(client, { ...preliminaryNeed, recipientOrderId: command.orderId }),
        preliminaryNeed.shortQty,
      );
      if (preliminaryDonors === null || preliminaryDonors.length === 0) {
        throw displacementError("CLAIM_DISPLACEMENT_NO_DONORS",
          "No unstarted order holds enough of this stock to cover the confirmed shipment.",
          { targetVariantId: preliminaryNeed.targetVariantId, shortQty: preliminaryNeed.shortQty.toString() });
      }
      const preliminaryDonorClaims: PersistedClaim[] = [];
      const preliminaryDonorOrders = new Map<number, LockedOrder>();
      for (const donor of preliminaryDonors) {
        const claim = await loadActiveClaimById(client, donor.claimId, false);
        if (!claim || claim.orderId !== donor.orderId) {
          throw displacementError("CLAIM_DISPLACEMENT_SET_CHANGED",
            "A donor claim changed before displacement locks were acquired.", { claimId: donor.claimId.toString() });
        }
        preliminaryDonorClaims.push(claim);
        preliminaryDonorOrders.set(donor.orderId, await loadOrder(client, donor.orderId, false));
      }

      // Global lock order: product graph, policy heads, orders, claims, inventory.
      const graphRoots: number[] = [
        ...await loadClaimProductIds(client, preliminaryClaim),
        ...preliminaryOrder.lines.map((line) => line.rootProductId),
      ];
      for (const claim of preliminaryDonorClaims) graphRoots.push(...await loadClaimProductIds(client, claim));
      for (const order of preliminaryDonorOrders.values()) graphRoots.push(...order.lines.map((line) => line.rootProductId));
      const graphProducts = await discoverActiveGraphProducts(client, uniqueSorted(graphRoots));
      if (graphProducts.length === 0 || graphProducts.length > MAX_GRAPH_PRODUCTS) {
        throw displacementError("INVALID_CLAIM_MODEL_EVIDENCE",
          "The displacement graph is empty or exceeds the bounded product limit.", { productCount: graphProducts.length });
      }
      await lockGraphProducts(client, graphProducts);
      const targetVariantIds = uniqueSorted([
        ...preliminaryClaim.plan.lines.map((line) => line.targetVariantId),
        ...preliminaryOrder.lines.map((line) => line.targetVariantId),
        ...preliminaryDonorClaims.flatMap((claim) => claim.plan.lines.map((line) => line.targetVariantId)),
        ...[...preliminaryDonorOrders.values()].flatMap((order) => order.lines.map((line) => line.targetVariantId)),
      ]);
      const preliminarySnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(client, targetVariantIds);
      await lockPlanningPolicyHeads(client, preliminarySnapshot);

      const lockedOrders = new Map<number, LockedOrder>();
      for (const orderId of uniqueSorted([command.orderId, ...preliminaryDonors.map((donor) => donor.orderId)])) {
        lockedOrders.set(orderId, await loadOrder(client, orderId, true));
      }
      const recipientOrder = lockedOrders.get(command.orderId)!;
      if (!orderClaimable(recipientOrder, true)
        || canonicalJson(recipientOrder) !== canonicalJson(preliminaryOrder)) {
        throw displacementError("CLAIM_DISPLACEMENT_SET_CHANGED",
          "The confirmed order changed while displacement locks were being acquired.");
      }
      for (const [orderId, preliminary] of preliminaryDonorOrders) {
        const locked = lockedOrders.get(orderId)!;
        if (locked.warehouseStatus !== "ready" || locked.onHold || canonicalJson(locked) !== canonicalJson(preliminary)) {
          throw displacementError("CLAIM_DISPLACEMENT_SET_CHANGED",
            "A donor order changed while displacement locks were being acquired.", { donorOrderId: orderId });
        }
      }
      const claim = await loadActiveClaim(client, command.orderId, true);
      if (!claim || claim.id !== expectedClaimId) {
        throw displacementError("ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while displacement locks were being acquired.",
          { expectedClaimId: command.expectedClaimId, lockedClaimId: claim?.id.toString() ?? null });
      }
      const donorClaims: PersistedClaim[] = [];
      for (const donor of preliminaryDonors) {
        const donorClaim = await loadActiveClaimById(client, donor.claimId, true);
        if (!donorClaim || donorClaim.orderId !== donor.orderId) {
          throw displacementError("CLAIM_DISPLACEMENT_SET_CHANGED",
            "A donor claim changed while displacement locks were being acquired.", { claimId: donor.claimId.toString() });
        }
        donorClaims.push(donorClaim);
      }
      const lockedNeed = await loadDisplacementNeed(client, claim, recipientOrder, command.orderItemId, quantity);
      const lockedDonors = selectDisplacementDonors(
        await loadDisplacementDonors(client, { ...lockedNeed, recipientOrderId: command.orderId }),
        lockedNeed.shortQty,
      );
      if (lockedDonors === null || lockedNeed.shortQty !== preliminaryNeed.shortQty
        || displacementEvidence(lockedDonors) !== displacementEvidence(preliminaryDonors)) {
        throw displacementError("CLAIM_DISPLACEMENT_SET_CHANGED",
          "The displacement set changed while its locks were being acquired.");
      }

      // The recipient follows the same rules as a supply refresh.
      if (!await orderDemandMatchesClaim(client, recipientOrder, claim)) {
        throw displacementError("CLAIM_SUPPLY_REFRESH_DEMAND_CHANGED",
          "The order demand changed; reconcile demand instead of displacing stock.", { claimId: claim.id.toString() });
      }
      const baseline = await loadClaimLineBalances(client, claim);
      const beforeRejection = rejectSupplyRefreshBeforePlanning(baseline);
      if (beforeRejection) throw supplyRefreshError(beforeRejection, command.orderId, claim);
      await lockSnapshotResources(client, preliminarySnapshot);

      const recipientCommand = canonicalAvailabilityClaimReplacementCommandSchema.parse({
        orderId: command.orderId,
        expectedClaimId: command.expectedClaimId,
        idempotencyKey: command.idempotencyKey,
        actor: command.actor,
        reason: command.reason,
        refreshSupply: true,
      });
      const donorCommands = new Map(donorClaims.map((donorClaim) => [donorClaim.id.toString(),
        canonicalAvailabilityClaimReplacementCommandSchema.parse({
          orderId: donorClaim.orderId,
          expectedClaimId: donorClaim.id.toString(),
          idempotencyKey: displacedClaimIdempotencyKey(command.idempotencyKey, donorClaim.id),
          actor: command.actor,
          reason: `Displaced by the confirmed shipment of order ${command.orderId}: ${command.reason}`.slice(0, 1000),
        })]));
      const releasedByClaim = new Map<string, { releasedResourceQty: bigint; releasedLotQty: bigint }>();
      for (const donorClaim of donorClaims) {
        const donorCommand = donorCommands.get(donorClaim.id.toString())!;
        await cancelOpenBuildHandoffs(client, deps.buildWriter, donorClaim,
          { ...donorCommand, disposition: "supersede" as const }, occurredAt, deps.workOwner);
        releasedByClaim.set(donorClaim.id.toString(), await releaseClaimResources(client, {
          inventoryWriter: deps.inventoryWriter,
          commandKey: `canonical:displace-release:${donorCommand.idempotencyKey}`,
          claim: donorClaim,
          orderId: donorClaim.orderId,
          actor: command.actor,
          reason: donorCommand.reason,
          disposition: "supersede",
          occurredAt,
        }));
      }
      await cancelOpenBuildHandoffs(client, deps.buildWriter, claim,
        { ...recipientCommand, disposition: "supersede" as const }, occurredAt, deps.workOwner);
      const recipientReleased = await releaseClaimResources(client, {
        inventoryWriter: deps.inventoryWriter,
        commandKey: `canonical:displace-recipient:${command.idempotencyKey}`,
        claim,
        orderId: command.orderId,
        actor: command.actor,
        reason: command.reason,
        disposition: "supersede",
        occurredAt,
      });

      // The recipient is planned first: it owns units that already shipped.
      const replan = async (order: LockedOrder) => {
        const revision = await nextClaimRevision(client, order.orderId);
        const request = buildPlanRequest(order, revision);
        const snapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
          client, order.lines.map((line) => line.targetVariantId));
        return { revision, request, plan: planCanonicalClaim(snapshot, request) };
      };
      const persistReplacement = async (
        order: LockedOrder,
        superseded: PersistedClaim,
        planned: Awaited<ReturnType<typeof replan>>,
        replacementCommand: CanonicalAvailabilityClaimReplacementCommand,
        released: { releasedResourceQty: bigint; releasedLotQty: bigint },
        commandHash: string,
      ) => {
        const replacementClaimId = await insertClaimHeader(client, {
          order, revision: planned.revision, authority, request: planned.request, plan: planned.plan,
          command: replacementCommand, supersedesClaimId: superseded.id, occurredAt,
        });
        const lineIds = await insertClaimLines(client, replacementClaimId, order, planned.plan);
        await insertClaimOperations(client, replacementClaimId, lineIds, planned.plan);
        await reserveClaimResources(client, deps.inventoryWriter, replacementClaimId, order, lineIds,
          planned.plan, command.actor, occurredAt);
        const replacementClaim: PersistedClaim = {
          id: replacementClaimId,
          claimKey: planned.request.requestKey,
          orderId: order.orderId,
          revision: planned.revision,
          runtimeAuthorityRevision: authority.revision,
          planHash: hash(planned.plan),
          plan: planned.plan,
        };
        const result = replacementResult(superseded, replacementClaim, released, false);
        await persistReplacementCommandAndEvents(client, {
          supersededClaim: superseded, replacementClaimId, command: replacementCommand,
          requestHash: commandHash, result, occurredAt,
        });
        return result;
      };

      const recipientPlan = await replan(recipientOrder);
      if (recipientPlan.plan.status === "blocked") {
        throw displacementError("CANONICAL_CLAIM_REPLACEMENT_BLOCKED",
          "The planner blocked the confirmed order's replacement claim.", { blockers: recipientPlan.plan.blockers });
      }
      const planRejection = rejectSupplyRefreshPlan(baseline, recipientPlan.plan.lines);
      if (planRejection) throw supplyRefreshError(planRejection, command.orderId, claim);
      const confirmedLine = recipientPlan.plan.lines.find((line) => line.lineKey === `order-item:${command.orderItemId}`);
      if (!confirmedLine || BigInt(confirmedLine.shortfallQty) !== BigInt(0)) {
        throw displacementError("CLAIM_DISPLACEMENT_INSUFFICIENT",
          "Displacement would not fully reserve the confirmed line; nothing was changed.",
          { orderItemId: command.orderItemId, shortfallQty: confirmedLine?.shortfallQty ?? null });
      }
      const recipientResult = await persistReplacement(recipientOrder, claim, recipientPlan, recipientCommand,
        recipientReleased, requestHash);

      // Donors are re-planned from whatever remains; they may become short and
      // are re-reserved later by the short-claim refresh when stock arrives.
      for (const donorClaim of donorClaims) {
        const donorOrder = lockedOrders.get(donorClaim.orderId)!;
        const donorPlan = await replan(donorOrder);
        if (donorPlan.plan.status === "blocked") {
          throw displacementError("CLAIM_DISPLACEMENT_REPLAN_BLOCKED",
            "The planner blocked a displaced order's replacement claim.",
            { donorOrderId: donorClaim.orderId, blockers: donorPlan.plan.blockers });
        }
        const donorCommand = donorCommands.get(donorClaim.id.toString())!;
        await persistReplacement(donorOrder, donorClaim, donorPlan, donorCommand,
          releasedByClaim.get(donorClaim.id.toString())!, hash(donorCommand));
      }

      await client.query("COMMIT");
      return canonicalAvailabilityClaimDisplacementResultSchema.parse({
        ...recipientResult,
        displacedOrderIds: donorClaims.map((donorClaim) => donorClaim.orderId),
      });
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
    "CLAIM_DISPLACEMENT_RETRY_EXHAUSTED",
    "Canonical claim displacement could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS, orderId: command.orderId },
    { cause: lastRetryableError },
  );
}
