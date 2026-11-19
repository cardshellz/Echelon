import {
  canonicalAvailabilityClaimCommandSchema,
  canonicalAvailabilityClaimReleaseCommandSchema,
  canonicalAvailabilityClaimReplacementCommandSchema,
  canonicalAvailabilityClaimResultSchema,
  type CanonicalAvailabilityClaimCommand,
  type CanonicalAvailabilityClaimReleaseCommand,
  type CanonicalAvailabilityClaimReplacementCommand,
  type CanonicalAvailabilityClaimReplacementResult,
  type CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  rejectSupplyRefreshBeforePlanning,
  rejectSupplyRefreshPlan,
  type ClaimLineBalance,
} from "../../domain/claim-supply-refresh";
import { planCanonicalClaim } from "../../domain/inventory-availability-planner";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "../inventory-availability-shadow.repository";
import {
  buildPlanRequest,
  discoverActiveGraphProducts,
  loadActiveClaim,
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
  persistCommandAndEvent,
  persistNoopCommand,
  persistReleaseCommandAndEvent,
  persistReplacementCommandAndEvents,
  releaseClaimResources,
  reserveClaimResources,
} from "./claim-persistence";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  isRetryableTransactionError,
  loadCommandReplay,
  loadReplacementReplay,
  MAX_GRAPH_PRODUCTS,
  MAX_SERIALIZATION_ATTEMPTS,
  positiveBigInt,
  replacementResult,
  resultFromClaim,
  rollback,
  uniqueSorted,
  type ClaimRepositoryDependencies,
  type PersistedClaim,
} from "./claim-primitives";

export async function executeClaimOrder(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimCommand,
): Promise<CanonicalAvailabilityClaimResult> {
  const command = canonicalAvailabilityClaimCommandSchema.parse(rawCommand);
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical claim clock returned an invalid time.");
  }

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const replay = await loadCommandReplay(client, command.idempotencyKey, requestHash);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }

      const authority = await requireCanonicalAuthority(client);
      const preliminaryOrder = await loadOrder(client, command.orderId, false);
      if (!orderClaimable(preliminaryOrder, command.recordConfirmedShipment === true)) {
        const result = await persistNoopCommand(client, command, "claim", requestHash, occurredAt);
        await client.query("COMMIT");
        return result;
      }

      const initialGraphProducts = await discoverActiveGraphProducts(
        client,
        preliminaryOrder.lines.map((line) => line.rootProductId),
      );
      await lockGraphProducts(client, initialGraphProducts);
      const preliminarySnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
        client,
        preliminaryOrder.lines.map((line) => line.targetVariantId),
      );
      await lockPlanningPolicyHeads(client, preliminarySnapshot);
      const lockedOrder = await loadOrder(client, command.orderId, true);
      if (!orderClaimable(lockedOrder, command.recordConfirmedShipment === true)) {
        const result = await persistNoopCommand(client, command, "claim", requestHash, occurredAt);
        await client.query("COMMIT");
        return result;
      }
      const lockedGraphProducts = await discoverActiveGraphProducts(
        client,
        lockedOrder.lines.map((line) => line.rootProductId),
      );
      if (canonicalJson(initialGraphProducts) !== canonicalJson(lockedGraphProducts)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "TRANSFORMATION_GRAPH_CHANGED",
          "The active transformation graph changed while canonical claim locks were being acquired.",
          { initialGraphProducts, lockedGraphProducts },
        );
      }

      const activeClaim = await loadActiveClaim(client, command.orderId);
      if (activeClaim) {
        if (!await orderDemandMatchesClaim(client, lockedOrder, activeClaim)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_REPLACEMENT_REQUIRED",
            "The locked order demand differs from its active canonical claim and must be replaced atomically.",
            { orderId: command.orderId, claimId: activeClaim.id.toString() },
          );
        }
        const result = resultFromClaim(command.orderId, activeClaim, false);
        await persistCommandAndEvent(client, {
          claimId: activeClaim.id,
          command,
          requestHash,
          result,
          occurredAt,
          eventType: "claim_replayed",
        });
        await client.query("COMMIT");
        return result;
      }

      await lockSnapshotResources(client, preliminarySnapshot);
      const snapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
        client,
        lockedOrder.lines.map((line) => line.targetVariantId),
      );
      const revision = await nextClaimRevision(client, command.orderId);
      const request = buildPlanRequest(lockedOrder, revision);
      const plan = planCanonicalClaim(snapshot, request);
      if (plan.status === "blocked") {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CANONICAL_CLAIM_BLOCKED",
          "The active canonical planner blocked the whole-order claim.",
          { orderId: command.orderId, blockers: plan.blockers },
        );
      }

      const claimId = await insertClaimHeader(client, {
        order: lockedOrder,
        revision,
        authority,
        request,
        plan,
        command,
        occurredAt,
      });
      const lineIds = await insertClaimLines(client, claimId, lockedOrder, plan);
      await insertClaimOperations(client, claimId, lineIds, plan);
      await reserveClaimResources(
        client,
        deps.inventoryWriter,
        claimId,
        lockedOrder,
        lineIds,
        plan,
        command.actor,
        occurredAt,
      );
      const result = resultFromClaim(command.orderId, {
        id: claimId,
        claimKey: request.requestKey,
        orderId: command.orderId,
        revision,
        runtimeAuthorityRevision: authority.revision,
        planHash: hash(plan),
        plan,
      }, false);
      await persistCommandAndEvent(client, {
        claimId,
        command,
        requestHash,
        result,
        occurredAt,
        eventType: "claim_reserved",
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
    "CLAIM_TRANSACTION_RETRY_EXHAUSTED",
    "Canonical claim transaction could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}

export async function executeReplaceOrderClaim(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimReplacementCommand,
): Promise<CanonicalAvailabilityClaimReplacementResult> {
  const command = canonicalAvailabilityClaimReplacementCommandSchema.parse(rawCommand);
  const expectedClaimId = positiveBigInt(command.expectedClaimId, "replacement.expectedClaimId");
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLOCK",
      "Canonical claim replacement clock returned an invalid time.",
    );
  }

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const replay = await loadReplacementReplay(client, command.idempotencyKey, requestHash);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }

      const authority = await requireCanonicalAuthority(client);
      const preliminaryClaim = await loadActiveClaim(client, command.orderId, false);
      if (!preliminaryClaim) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_NOT_FOUND",
          "The order does not have an active canonical claim to replace.",
          { orderId: command.orderId, expectedClaimId: command.expectedClaimId },
        );
      }
      if (preliminaryClaim.id !== expectedClaimId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The order's active canonical claim does not match the expected replacement predecessor.",
          {
            orderId: command.orderId,
            expectedClaimId: command.expectedClaimId,
            activeClaimId: preliminaryClaim.id.toString(),
          },
        );
      }

      const preliminaryOrder = await loadOrder(client, command.orderId, false);
      if (!orderClaimable(preliminaryOrder, command.refreshSupply === true)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "REPLACEMENT_ORDER_NOT_CLAIMABLE",
          "A terminal order or an order without remaining claimable demand must use canonical release or cancellation.",
          { orderId: command.orderId, warehouseStatus: preliminaryOrder.warehouseStatus },
        );
      }
      const preliminaryClaimProducts = await loadClaimProductIds(client, preliminaryClaim);
      const preliminaryOrderProducts = await discoverActiveGraphProducts(
        client,
        preliminaryOrder.lines.map((line) => line.rootProductId),
      );
      const preliminaryGraphProducts = uniqueSorted([
        ...preliminaryClaimProducts,
        ...preliminaryOrderProducts,
      ]);
      if (preliminaryGraphProducts.length === 0 || preliminaryGraphProducts.length > MAX_GRAPH_PRODUCTS) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_MODEL_EVIDENCE",
          "The replacement claim graph is empty or exceeds the bounded product limit.",
          { orderId: command.orderId, productCount: preliminaryGraphProducts.length },
        );
      }
      await lockGraphProducts(client, preliminaryGraphProducts);

      const preliminaryTargetVariantIds = uniqueSorted([
        ...preliminaryClaim.plan.lines.map((line) => line.targetVariantId),
        ...preliminaryOrder.lines.map((line) => line.targetVariantId),
      ]);
      const preliminarySnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
        client,
        preliminaryTargetVariantIds,
      );
      await lockPlanningPolicyHeads(client, preliminarySnapshot);

      const lockedOrder = await loadOrder(client, command.orderId, true);
      if (!orderClaimable(lockedOrder, command.refreshSupply === true)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "REPLACEMENT_ORDER_NOT_CLAIMABLE",
          "The order became terminal or lost all claimable demand while replacement locks were being acquired.",
          { orderId: command.orderId, warehouseStatus: lockedOrder.warehouseStatus },
        );
      }
      const claim = await loadActiveClaim(client, command.orderId, true);
      if (!claim || claim.id !== preliminaryClaim.id || claim.id !== expectedClaimId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while replacement locks were being acquired.",
          {
            orderId: command.orderId,
            expectedClaimId: command.expectedClaimId,
            preliminaryClaimId: preliminaryClaim.id.toString(),
            lockedClaimId: claim?.id.toString() ?? null,
          },
        );
      }
      const lockedTargetVariantIds = uniqueSorted([
        ...claim.plan.lines.map((line) => line.targetVariantId),
        ...lockedOrder.lines.map((line) => line.targetVariantId),
      ]);
      if (canonicalJson(preliminaryTargetVariantIds) !== canonicalJson(lockedTargetVariantIds)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ORDER_DEMAND_IDENTITY_CHANGED",
          "The order's target variant identities changed while replacement locks were being acquired.",
          { orderId: command.orderId, preliminaryTargetVariantIds, lockedTargetVariantIds },
        );
      }
      const demandUnchanged = await orderDemandMatchesClaim(client, lockedOrder, claim);
      let refreshBaseline: ClaimLineBalance[] | null = null;
      if (command.refreshSupply) {
        // A supply refresh never doubles as a demand change: a changed order
        // must go through ordinary demand reconciliation and its events.
        if (!demandUnchanged) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_SUPPLY_REFRESH_DEMAND_CHANGED",
            "The order demand changed; reconcile demand instead of refreshing supply.",
            { orderId: command.orderId, claimId: claim.id.toString() },
          );
        }
        refreshBaseline = await loadClaimLineBalances(client, claim);
        const rejection = rejectSupplyRefreshBeforePlanning(refreshBaseline);
        if (rejection) throw supplyRefreshError(rejection, command.orderId, claim);
      } else if (demandUnchanged) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ORDER_DEMAND_UNCHANGED",
          "The locked order demand still matches its active canonical claim.",
          { orderId: command.orderId, claimId: claim.id.toString() },
        );
      }

      const lockedClaimProducts = await loadClaimProductIds(client, claim);
      const lockedOrderProducts = await discoverActiveGraphProducts(
        client,
        lockedOrder.lines.map((line) => line.rootProductId),
      );
      const lockedGraphProducts = uniqueSorted([...lockedClaimProducts, ...lockedOrderProducts]);
      if (canonicalJson(preliminaryGraphProducts) !== canonicalJson(lockedGraphProducts)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "TRANSFORMATION_GRAPH_CHANGED",
          "The active transformation graph changed while replacement locks were being acquired.",
          { preliminaryGraphProducts, lockedGraphProducts },
        );
      }

      await lockSnapshotResources(client, preliminarySnapshot);
      const lifecycleCommand = { ...command, disposition: "supersede" as const };
      await cancelOpenBuildHandoffs(client, deps.buildWriter, claim, lifecycleCommand, occurredAt, deps.workOwner);
      const released = await releaseClaimResources(client, {
        inventoryWriter: deps.inventoryWriter,
        commandKey: `canonical:replace-release:${command.idempotencyKey}`,
        claim,
        orderId: command.orderId,
        actor: command.actor,
        reason: command.reason,
        disposition: "supersede",
        occurredAt,
      });

      const snapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
        client,
        lockedOrder.lines.map((line) => line.targetVariantId),
      );
      const revision = await nextClaimRevision(client, command.orderId);
      const request = buildPlanRequest(lockedOrder, revision);
      const plan = planCanonicalClaim(snapshot, request);
      if (plan.status === "blocked") {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CANONICAL_CLAIM_REPLACEMENT_BLOCKED",
          "The active canonical planner blocked the whole-order replacement claim.",
          { orderId: command.orderId, supersededClaimId: claim.id.toString(), blockers: plan.blockers },
        );
      }
      if (refreshBaseline) {
        // Throwing here rolls back the release above; the old claim stays intact.
        const rejection = rejectSupplyRefreshPlan(refreshBaseline, plan.lines);
        if (rejection) throw supplyRefreshError(rejection, command.orderId, claim);
      }

      const replacementClaimId = await insertClaimHeader(client, {
        order: lockedOrder,
        revision,
        authority,
        request,
        plan,
        command,
        supersedesClaimId: claim.id,
        occurredAt,
      });
      const lineIds = await insertClaimLines(client, replacementClaimId, lockedOrder, plan);
      await insertClaimOperations(client, replacementClaimId, lineIds, plan);
      await reserveClaimResources(
        client,
        deps.inventoryWriter,
        replacementClaimId,
        lockedOrder,
        lineIds,
        plan,
        command.actor,
        occurredAt,
      );
      const replacementClaim: PersistedClaim = {
        id: replacementClaimId,
        claimKey: request.requestKey,
        orderId: command.orderId,
        revision,
        runtimeAuthorityRevision: authority.revision,
        planHash: hash(plan),
        plan,
      };
      const result = replacementResult(claim, replacementClaim, released, false);
      await persistReplacementCommandAndEvents(client, {
        supersededClaim: claim,
        replacementClaimId,
        command,
        requestHash,
        result,
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
    "CLAIM_REPLACEMENT_RETRY_EXHAUSTED",
    "Canonical claim replacement could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}

export async function executeReleaseOrderClaim(
  deps: ClaimRepositoryDependencies,
  rawCommand: CanonicalAvailabilityClaimReleaseCommand,
): Promise<CanonicalAvailabilityClaimResult> {
  const command = canonicalAvailabilityClaimReleaseCommandSchema.parse(rawCommand);
  const expectedClaimId = command.expectedClaimId == null
    ? null
    : positiveBigInt(command.expectedClaimId, "release.expectedClaimId");
  const requestHash = hash(command);
  const occurredAt = deps.clock();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical claim clock returned an invalid time.");
  }

  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await deps.connectionPool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const replay = await loadCommandReplay(client, command.idempotencyKey, requestHash);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await requireCanonicalAuthority(client);

      const preliminaryClaim = await loadActiveClaim(client, command.orderId, false);
      if (!preliminaryClaim) {
        if (expectedClaimId !== null) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The order no longer has the active canonical claim expected by the release command.",
            { orderId: command.orderId, expectedClaimId: command.expectedClaimId },
          );
        }
        await loadOrder(client, command.orderId, true);
        const result = await persistNoopCommand(
          client,
          command,
          command.disposition === "cancel" ? "cancel" : "release",
          requestHash,
          occurredAt,
        );
        await client.query("COMMIT");
        return result;
      }
      if (expectedClaimId !== null && preliminaryClaim.id !== expectedClaimId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The order's active canonical claim does not match the expected release target.",
          {
            orderId: command.orderId,
            expectedClaimId: command.expectedClaimId,
            activeClaimId: preliminaryClaim.id.toString(),
          },
        );
      }
      const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
      if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_MODEL_EVIDENCE",
          "The active claim does not contain a bounded model-evidence graph.",
          { claimId: preliminaryClaim.id.toString(), productCount: graphProductIds.length },
        );
      }
      await lockGraphProducts(client, graphProductIds);
      const lockedOrder = await loadOrder(client, command.orderId, true);
      const claim = await loadActiveClaim(client, command.orderId, true);
      if (!claim
        || claim.id !== preliminaryClaim.id
        || (expectedClaimId !== null && claim.id !== expectedClaimId)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ACTIVE_CLAIM_CHANGED",
          "The active canonical claim changed while release locks were being acquired.",
          {
            orderId: command.orderId,
            expectedClaimId: command.expectedClaimId ?? null,
            preliminaryClaimId: preliminaryClaim.id.toString(),
            lockedClaimId: claim?.id.toString() ?? null,
          },
        );
      }
      if (command.requireNoClaimableDemand === true
        && lockedOrder.warehouseStatus !== command.expectedWarehouseStatus) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ORDER_WAREHOUSE_STATUS_CHANGED",
          "The guarded canonical release was rejected because the locked order status changed.",
          {
            orderId: command.orderId,
            expectedClaimId: command.expectedClaimId,
            expectedWarehouseStatus: command.expectedWarehouseStatus,
            lockedWarehouseStatus: lockedOrder.warehouseStatus,
          },
        );
      }
      if (command.requireNoClaimableDemand === true
        && !["cancelled", "shipped"].includes(lockedOrder.warehouseStatus)
        && lockedOrder.lines.length > 0) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ORDER_STILL_HAS_CLAIMABLE_DEMAND",
          "The guarded canonical release was rejected because the locked order still has claimable demand.",
          {
            orderId: command.orderId,
            expectedClaimId: command.expectedClaimId,
            claimableLineCount: lockedOrder.lines.length,
          },
        );
      }
      await cancelOpenBuildHandoffs(client, deps.buildWriter, claim, command, occurredAt, deps.workOwner);
      const released = await releaseClaimResources(client, {
        inventoryWriter: deps.inventoryWriter,
        commandKey: `canonical:release:${command.idempotencyKey}`,
        claim,
        orderId: command.orderId,
        actor: command.actor,
        reason: command.reason,
        disposition: command.disposition,
        occurredAt,
      });
      const result = canonicalAvailabilityClaimResultSchema.parse({
        outcome: "released",
        claimId: claim.id.toString(),
        claimKey: claim.claimKey,
        orderId: command.orderId,
        status: command.disposition === "cancel" ? "cancelled" : "released",
        releasedResourceQty: released.releasedResourceQty.toString(),
        releasedLotQty: released.releasedLotQty.toString(),
        idempotentReplay: false,
      });
      await persistReleaseCommandAndEvent(client, {
        claim,
        command,
        requestHash,
        result,
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
    "CLAIM_RELEASE_RETRY_EXHAUSTED",
    "Canonical claim release could not serialize after bounded retries.",
    { attempts: MAX_SERIALIZATION_ATTEMPTS },
    { cause: lastRetryableError },
  );
}
