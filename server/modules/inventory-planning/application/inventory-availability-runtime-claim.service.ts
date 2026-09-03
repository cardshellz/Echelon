import { createHash } from "node:crypto";

import type {
  CanonicalAvailabilityClaimReplacementResult,
  CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";
import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";
import { canonicalJson } from "@shared/utils/canonical-json";

import type {
  OrderReservationStatus,
  RefundDemandReleaseTarget,
  ReconcileRefundOrderDemandCommand,
  ReconcileRefundOrderDemandResult,
  ReconcileOrderDemandCommand,
  ReconcileOrderDemandResult,
  ReleaseOrderItemReservationResult,
  ReleaseOrderReservationOptions,
  ReleaseOrderReservationResult,
  ReservationResult,
  ReservationServiceContract,
  ReserveForOrderResult,
} from "../../channels/reservation.service";
import type { InventoryAvailabilityRuntimeAuthority } from "./inventory-availability-runtime-atp.service";

export type CanonicalClaimStatus = "active" | "released" | "cancelled" | "superseded" | "failed";

export interface CanonicalClaimCursor {
  claimId: string;
  revision: number;
  status: CanonicalClaimStatus;
  plan: ClaimPlanDto;
}

export interface CanonicalClaimVariantMetadata {
  productVariantId: number;
  sku: string;
  unitsPerVariant: number;
}

export interface RuntimeCanonicalClaimService {
  claimOrder(input: unknown): Promise<CanonicalAvailabilityClaimResult>;
  replaceOrderClaim(input: unknown): Promise<CanonicalAvailabilityClaimReplacementResult>;
  releaseOrderClaim(input: unknown): Promise<CanonicalAvailabilityClaimResult>;
}

export interface InventoryAvailabilityRuntimeClaimContext {
  authority: InventoryAvailabilityRuntimeAuthority;
  authorityRevision: string;
  activationRunId: string | null;
  legacy: ReservationServiceContract;
  canonical: RuntimeCanonicalClaimService;
  getLatestClaim(orderId: number): Promise<CanonicalClaimCursor | null>;
  getVariantMetadata(
    productVariantIds: readonly number[],
  ): Promise<Map<number, CanonicalClaimVariantMetadata>>;
  getOrderIdByShopifyOrderId(shopifyOrderId: string): Promise<number | null>;
}

export interface InventoryAvailabilityRuntimeClaimExecutor {
  execute<T>(
    work: (context: InventoryAvailabilityRuntimeClaimContext) => Promise<T>,
  ): Promise<T>;
}

interface CanonicalDemandReconciliationOutcome {
  result: ReconcileOrderDemandResult;
  previousPlan: ClaimPlanDto | null;
  nextPlan: ClaimPlanDto | null;
}

export class InventoryAvailabilityRuntimeClaimError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityRuntimeClaimError";
  }
}

/**
 * The single operational order-reservation boundary.
 *
 * Legacy authority delegates to the deployed reservation service. Canonical
 * authority invokes only validated whole-order claim lifecycle commands. Any
 * legacy operation that lacks an atomic canonical equivalent fails closed.
 */
export class AuthorityAwareReservationService implements ReservationServiceContract {
  constructor(private readonly executor: InventoryAvailabilityRuntimeClaimExecutor) {}

  async reserveForOrder(
    productId: number,
    variantId: number,
    orderQty: number,
    orderId: number,
    orderItemId: number,
    userId?: string,
    dbOverride?: any,
  ): Promise<ReserveForOrderResult> {
    return this.executor.execute((context) => {
      if (context.authority === "legacy") {
        return context.legacy.reserveForOrder(
          productId,
          variantId,
          orderQty,
          orderId,
          orderItemId,
          userId,
          dbOverride,
        );
      }
      throw unsupportedCanonicalMutation(
        "CANONICAL_LINE_RESERVATION_UNSUPPORTED",
        "Canonical authority accepts one atomic whole-order claim, not an item-level reservation.",
        context,
        { productId, variantId, orderId, orderItemId },
      );
    });
  }

  async reserveOrder(
    orderId: number,
    userId?: string,
    dbOverride?: any,
  ): Promise<ReservationResult> {
    const validatedOrderId = positiveInteger(orderId, "orderId");
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return context.legacy.reserveOrder(validatedOrderId, userId, dbOverride);
      }
      if (dbOverride != null) {
        throw unsupportedCanonicalMutation(
          "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
          "Canonical whole-order claims own their serializable transaction and cannot join a legacy Drizzle transaction.",
          context,
          { orderId: validatedOrderId },
        );
      }
      return claimCanonicalOrder(context, validatedOrderId, userId, "Reserve order inventory");
    });
  }

  async releaseOrderReservation(
    orderId: number,
    reason: string,
    userId?: string,
    options: ReleaseOrderReservationOptions = {},
  ): Promise<ReleaseOrderReservationResult> {
    const validatedOrderId = positiveInteger(orderId, "orderId");
    const validatedReason = nonblank(reason, "reason", 1000);
    const disposition = options.disposition ?? "release";
    if (disposition !== "release" && disposition !== "cancel") {
      throw invalidInput("disposition", disposition);
    }
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        const legacyOptions: ReleaseOrderReservationOptions = { disposition };
        if (options.dbOverride != null) legacyOptions.dbOverride = options.dbOverride;
        return context.legacy.releaseOrderReservation(
          validatedOrderId,
          validatedReason,
          userId,
          legacyOptions,
        );
      }
      if (options.dbOverride != null) {
        throw unsupportedCanonicalMutation(
          "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
          "Canonical whole-order claim release owns its serializable transaction and cannot join a legacy Drizzle transaction.",
          context,
          { orderId: validatedOrderId },
        );
      }

      const actor = canonicalActor(userId);
      const cursor = await context.getLatestClaim(validatedOrderId);
      const idempotencyKey = commandKey("release-order-claim", {
        orderId: validatedOrderId,
        claimId: cursor?.claimId ?? "none",
        disposition,
        actor,
        reason: validatedReason,
      });
      const result = await context.canonical.releaseOrderClaim({
        orderId: validatedOrderId,
        disposition,
        ...(cursor?.status === "active" ? { expectedClaimId: cursor.claimId } : {}),
        idempotencyKey,
        actor,
        reason: validatedReason,
      });
      if (result.outcome === "no_claim_required") return { released: 0, failed: [] };
      if (result.outcome !== "released") {
        throw invalidCanonicalResult("release_order_claim", result, context);
      }
      const released = cursor?.claimId === result.claimId
        ? cursor.plan.lines.filter((line) => BigInt(line.plannedQty) > BigInt(0)).length
        : 0;
      return { released, failed: [] };
    });
  }

  async releaseOrderItemReservation(params: {
    orderId: number;
    orderItemId: number;
    quantity: number;
    sourceEventId: string;
    reason: string;
    userId?: string;
    dbOverride?: any;
  }): Promise<ReleaseOrderItemReservationResult> {
    return this.executor.execute((context) => {
      if (context.authority === "legacy") {
        return context.legacy.releaseOrderItemReservation(params);
      }
      throw unsupportedCanonicalMutation(
        "CANONICAL_ITEM_RELEASE_UNSUPPORTED",
        "Canonical demand changes must replace the whole-order claim; an item-level release would orphan planner lineage.",
        context,
        { orderId: params.orderId, orderItemId: params.orderItemId, sourceEventId: params.sourceEventId },
      );
    });
  }

  async reconcileOrderDemand(
    command: ReconcileOrderDemandCommand,
  ): Promise<ReconcileOrderDemandResult> {
    const orderId = positiveInteger(command.orderId, "orderId");
    const sourceEventId = nonblank(command.sourceEventId, "sourceEventId", 500);
    const reason = nonblank(command.reason, "reason", 1000);
    if (typeof command.demandChanged !== "boolean") {
      throw invalidInput("demandChanged", command.demandChanged);
    }
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return context.legacy.reconcileOrderDemand({
          ...command,
          orderId,
          sourceEventId,
          demandChanged: command.demandChanged,
          reason,
        });
      }
      if (command.dbOverride != null) {
        throw unsupportedCanonicalMutation(
          "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
          "Canonical demand reconciliation owns its serializable transactions and cannot join a legacy Drizzle transaction.",
          context,
          { orderId, sourceEventId },
        );
      }
      try {
        const outcome = await reconcileCanonicalOrderDemand(
          context,
          orderId,
          sourceEventId,
          command.userId,
          reason,
        );
        return outcome.result;
      } catch (error) {
        throw demandReconciliationFailed(context, orderId, sourceEventId, error);
      }
    });
  }

  async reconcileRefundOrderDemand(
    command: ReconcileRefundOrderDemandCommand,
  ): Promise<ReconcileRefundOrderDemandResult> {
    const orderId = positiveInteger(command.orderId, "orderId");
    const sourceEventId = nonblank(command.sourceEventId, "sourceEventId", 500);
    const reason = nonblank(command.reason, "reason", 1000);
    const releaseTargets = validateRefundReleaseTargets(command.releaseTargets);

    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return context.legacy.reconcileRefundOrderDemand({
          ...command,
          orderId,
          sourceEventId,
          releaseTargets,
          reason,
        });
      }
      if (command.dbOverride != null) {
        throw unsupportedCanonicalMutation(
          "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
          "Canonical refund demand reconciliation owns its serializable transactions and cannot join a legacy Drizzle transaction.",
          context,
          { orderId, sourceEventId },
        );
      }
      try {
        const outcome = await reconcileCanonicalOrderDemand(
          context,
          orderId,
          sourceEventId,
          command.userId,
          reason,
        );
        return {
          releasedReservationQuantity: releasedRefundTargetQuantity(
            orderId,
            releaseTargets,
            outcome.previousPlan,
            outcome.nextPlan,
          ),
        };
      } catch (error) {
        throw demandReconciliationFailed(context, orderId, sourceEventId, error);
      }
    });
  }

  async reallocateOrphaned(
    productVariantId: number,
    warehouseLocationId: number,
    userId?: string,
    orphanedQty?: number,
    dbOverride?: any,
  ): Promise<{ released: number; reallocated: number; failed: number }> {
    return this.executor.execute((context) => {
      if (context.authority === "legacy") {
        return dbOverride == null
          ? context.legacy.reallocateOrphaned(
            productVariantId,
            warehouseLocationId,
            userId,
            orphanedQty,
          )
          : context.legacy.reallocateOrphaned(
            productVariantId,
            warehouseLocationId,
            userId,
            orphanedQty,
            dbOverride,
          );
      }
      throw unsupportedCanonicalMutation(
        "CANONICAL_ORPHAN_REALLOCATION_UNSUPPORTED",
        "Canonical claim ownership cannot be trimmed or reallocated outside a whole-order claim reconciliation.",
        context,
        { productVariantId, warehouseLocationId, orphanedQty: orphanedQty ?? null },
      );
    });
  }

  async getOrderReservationStatus(
    orderId: number,
    dbOverride?: any,
  ): Promise<OrderReservationStatus[]> {
    const validatedOrderId = positiveInteger(orderId, "orderId");
    return this.executor.execute((context) => {
      if (context.authority === "legacy") {
        return dbOverride == null
          ? context.legacy.getOrderReservationStatus(validatedOrderId)
          : context.legacy.getOrderReservationStatus(validatedOrderId, dbOverride);
      }
      throw unsupportedCanonicalMutation(
        "CANONICAL_RESERVATION_STATUS_PROJECTION_REQUIRED",
        "The legacy reservation-status DTO cannot represent canonical resource claims and operations without losing lineage.",
        context,
        { orderId: validatedOrderId },
      );
    });
  }

  async autoReserveOnSync(
    shopifyOrderId: string,
    userId?: string,
    dbOverride?: any,
  ): Promise<ReservationResult | null> {
    const validatedShopifyOrderId = nonblank(shopifyOrderId, "shopifyOrderId", 50);
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return dbOverride == null
          ? context.legacy.autoReserveOnSync(validatedShopifyOrderId, userId)
          : context.legacy.autoReserveOnSync(validatedShopifyOrderId, userId, dbOverride);
      }
      if (dbOverride != null) {
        throw unsupportedCanonicalMutation(
          "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
          "Canonical whole-order claims own their serializable transaction and cannot join a legacy Drizzle transaction.",
          context,
          { shopifyOrderId: validatedShopifyOrderId },
        );
      }
      const orderId = await context.getOrderIdByShopifyOrderId(validatedShopifyOrderId);
      if (orderId == null) return null;
      return claimCanonicalOrder(
        context,
        orderId,
        userId,
        `Reserve synced Shopify order ${validatedShopifyOrderId}`,
      );
    });
  }
}

async function claimCanonicalOrder(
  context: InventoryAvailabilityRuntimeClaimContext,
  orderId: number,
  userId: string | undefined,
  reason: string,
): Promise<ReservationResult> {
  const actor = canonicalActor(userId);
  const cursor = await context.getLatestClaim(orderId);
  const lifecycle = cursor?.status === "active"
    ? `active:${cursor.claimId}`
    : `next:${(cursor?.revision ?? 0) + 1}`;
  const idempotencyKey = commandKey("claim-order", { orderId, lifecycle, actor, reason });
  const result = await context.canonical.claimOrder({
    orderId,
    idempotencyKey,
    actor,
    reason,
  });
  if (result.outcome === "no_claim_required") return emptyReservationResult(orderId);
  if (result.outcome !== "claimed") {
    throw invalidCanonicalResult("claim_order", result, context);
  }
  return mapCanonicalPlanToReservationResult(context, orderId, result.plan);
}

async function reconcileCanonicalOrderDemand(
  context: InventoryAvailabilityRuntimeClaimContext,
  orderId: number,
  sourceEventId: string,
  userId: string | undefined,
  reason: string,
): Promise<CanonicalDemandReconciliationOutcome> {
  const actor = canonicalActor(userId);
  const cursor = await context.getLatestClaim(orderId);
  if (!cursor || cursor.status !== "active") {
    const result = await context.canonical.claimOrder({
      orderId,
      idempotencyKey: commandKey("reconcile-order-demand-claim", {
        orderId,
        sourceEventId,
        lifecycle: `next:${(cursor?.revision ?? 0) + 1}`,
      }),
      actor,
      reason,
    });
    if (result.outcome === "no_claim_required") {
      return {
        result: emptyDemandReconciliationResult(orderId),
        previousPlan: null,
        nextPlan: null,
      };
    }
    if (result.outcome !== "claimed") {
      throw invalidCanonicalResult("reconcile_order_demand_claim", result, context);
    }
    return {
      result: {
        reconciled: !result.idempotentReplay,
        release: { released: 0, failed: [] },
        reservation: await mapCanonicalPlanToReservationResult(context, orderId, result.plan),
      },
      previousPlan: null,
      nextPlan: result.plan,
    };
  }

  try {
    const replacement = await context.canonical.replaceOrderClaim({
      orderId,
      expectedClaimId: cursor.claimId,
      idempotencyKey: commandKey("reconcile-order-demand-replace", {
        orderId,
        sourceEventId,
        expectedClaimId: cursor.claimId,
      }),
      actor,
      reason,
    });
    return {
      result: {
        reconciled: !replacement.idempotentReplay,
        release: {
          released: replacement.idempotentReplay ? 0 : claimLineCount(cursor.plan),
          failed: [],
        },
        reservation: await mapCanonicalPlanToReservationResult(
          context,
          orderId,
          replacement.replacementClaim.plan,
        ),
      },
      previousPlan: cursor.plan,
      nextPlan: replacement.replacementClaim.plan,
    };
  } catch (error) {
    const code = structuredErrorCode(error);
    if (code === "ORDER_DEMAND_UNCHANGED") {
      const replay = await context.canonical.claimOrder({
        orderId,
        idempotencyKey: commandKey("reconcile-order-demand-unchanged", {
          orderId,
          sourceEventId,
          claimId: cursor.claimId,
        }),
        actor,
        reason,
      });
      if (replay.outcome !== "claimed") {
        throw invalidCanonicalResult("reconcile_order_demand_unchanged", replay, context);
      }
      return {
        result: {
          reconciled: false,
          release: { released: 0, failed: [] },
          reservation: await mapCanonicalPlanToReservationResult(context, orderId, replay.plan),
        },
        previousPlan: cursor.plan,
        nextPlan: replay.plan,
      };
    }
    if (code === "REPLACEMENT_ORDER_NOT_CLAIMABLE") {
      const expectedWarehouseStatus = structuredErrorContextString(error, "warehouseStatus");
      if (expectedWarehouseStatus === null) throw error;
      const release = await context.canonical.releaseOrderClaim({
        orderId,
        disposition: expectedWarehouseStatus === "cancelled" ? "cancel" : "release",
        expectedClaimId: cursor.claimId,
        expectedWarehouseStatus,
        requireNoClaimableDemand: true,
        idempotencyKey: commandKey("reconcile-order-demand-release", {
          orderId,
          sourceEventId,
          expectedClaimId: cursor.claimId,
        }),
        actor,
        reason,
      });
      if (release.outcome !== "released") {
        throw invalidCanonicalResult("reconcile_order_demand_release", release, context);
      }
      return {
        result: {
          reconciled: !release.idempotentReplay,
          release: {
            released: release.idempotentReplay ? 0 : claimLineCount(cursor.plan),
            failed: [],
          },
          reservation: emptyReservationResult(orderId),
        },
        previousPlan: cursor.plan,
        nextPlan: null,
      };
    }
    throw error;
  }
}

async function mapCanonicalPlanToReservationResult(
  context: InventoryAvailabilityRuntimeClaimContext,
  orderId: number,
  plan: ClaimPlanDto,
): Promise<ReservationResult> {
  const variantIds = [...new Set(plan.lines.map((line) => line.targetVariantId))];
  const metadata = await context.getVariantMetadata(variantIds);
  const componentBuildLines = new Set(
    plan.operations
      .filter((operation) => operation.operationType === "component_build")
      .map((operation) => operation.lineKey),
  );
  const result = emptyReservationResult(orderId);
  let reservedBaseUnits = BigInt(0);
  let promisedBaseUnits = BigInt(0);

  for (const line of plan.lines) {
    const variant = metadata.get(line.targetVariantId);
    if (!variant) {
      throw new InventoryAvailabilityRuntimeClaimError(
        "CANONICAL_CLAIM_VARIANT_METADATA_MISSING",
        "A canonical claim result references a product variant that cannot be resolved.",
        { orderId, productVariantId: line.targetVariantId, lineKey: line.lineKey },
      );
    }
    const plannedQty = BigInt(line.plannedQty);
    const shortfallQty = BigInt(line.shortfallQty);
    const baseUnits = plannedQty * BigInt(variant.unitsPerVariant);
    if (plannedQty > BigInt(0)) {
      if (componentBuildLines.has(line.lineKey)) {
        result.promised += 1;
        promisedBaseUnits += baseUnits;
      } else {
        result.reserved += 1;
        reservedBaseUnits += baseUnits;
      }
    }
    if (shortfallQty > BigInt(0)) {
      result.failed.push({
        sku: variant.sku,
        orderItemId: orderItemIdFromLineKey(line.lineKey),
        reason: `Canonical claim shortfall: planned ${line.plannedQty} of ${line.requestedQty} variant units (shortfall: ${line.shortfallQty})`,
      });
    }
  }

  result.totalBaseUnits = safeInteger(reservedBaseUnits, "totalBaseUnits", orderId);
  result.totalPromisedBaseUnits = safeInteger(promisedBaseUnits, "totalPromisedBaseUnits", orderId);
  return result;
}

function emptyReservationResult(orderId: number): ReservationResult {
  return {
    orderId,
    reserved: 0,
    promised: 0,
    failed: [],
    totalBaseUnits: 0,
    totalPromisedBaseUnits: 0,
  };
}

function emptyDemandReconciliationResult(orderId: number): ReconcileOrderDemandResult {
  return {
    reconciled: false,
    release: { released: 0, failed: [] },
    reservation: emptyReservationResult(orderId),
  };
}

function claimLineCount(plan: ClaimPlanDto): number {
  return plan.lines.filter((line) => BigInt(line.plannedQty) > BigInt(0)).length;
}

function validateRefundReleaseTargets(
  targets: unknown,
): RefundDemandReleaseTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw invalidInput("releaseTargets", targets);
  }
  const seenOrderItemIds = new Set<number>();
  return targets.map((target, index) => {
    if (typeof target !== "object" || target === null) {
      throw invalidInput(`releaseTargets[${index}]`, target);
    }
    const candidate = target as { orderItemId?: unknown; quantity?: unknown };
    const orderItemId = positiveInteger(
      candidate.orderItemId,
      `releaseTargets[${index}].orderItemId`,
    );
    const quantity = positiveInteger(candidate.quantity, `releaseTargets[${index}].quantity`);
    if (seenOrderItemIds.has(orderItemId)) {
      throw invalidInput(`releaseTargets[${index}].orderItemId`, candidate.orderItemId);
    }
    seenOrderItemIds.add(orderItemId);
    return { orderItemId, quantity };
  }).sort((left, right) => left.orderItemId - right.orderItemId);
}

function releasedRefundTargetQuantity(
  orderId: number,
  targets: readonly RefundDemandReleaseTarget[],
  previousPlan: ClaimPlanDto | null,
  nextPlan: ClaimPlanDto | null,
): number {
  const previousQuantities = claimLineQuantities(previousPlan);
  const nextQuantities = claimLineQuantities(nextPlan);
  let released = BigInt(0);
  for (const target of targets) {
    const lineKey = `order-item:${target.orderItemId}`;
    const previous = previousQuantities.get(lineKey) ?? BigInt(0);
    const next = nextQuantities.get(lineKey) ?? BigInt(0);
    const reduction = previous > next ? previous - next : BigInt(0);
    released += reduction < BigInt(target.quantity) ? reduction : BigInt(target.quantity);
  }
  return safeInteger(released, "releasedReservationQuantity", orderId);
}

function claimLineQuantities(plan: ClaimPlanDto | null): Map<string, bigint> {
  return new Map(
    (plan?.lines ?? []).map((line) => [line.lineKey, BigInt(line.plannedQty)] as const),
  );
}

function demandReconciliationFailed(
  context: InventoryAvailabilityRuntimeClaimContext,
  orderId: number,
  sourceEventId: string,
  error: unknown,
): InventoryAvailabilityRuntimeClaimError {
  return new InventoryAvailabilityRuntimeClaimError(
    "CANONICAL_DEMAND_RECONCILIATION_FAILED",
    "Canonical order-demand reconciliation failed and must be retried without falling back to legacy reservations.",
    {
      orderId,
      sourceEventId,
      authorityRevision: context.authorityRevision,
      activationRunId: context.activationRunId,
      causeCode: structuredErrorCode(error),
    },
    { cause: error },
  );
}

function structuredErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function structuredErrorContextString(error: unknown, field: string): string | null {
  if (typeof error !== "object" || error === null || !("context" in error)) return null;
  const context = (error as { context?: unknown }).context;
  if (typeof context !== "object" || context === null || !(field in context)) return null;
  const value = (context as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function canonicalActor(userId: string | undefined): string {
  return userId == null || String(userId).trim() === ""
    ? "system:inventory-reservation-runtime"
    : nonblank(String(userId), "userId", 100);
}

function commandKey(operation: string, evidence: Readonly<Record<string, unknown>>): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ operation, evidence }), "utf8")
    .digest("hex");
  return `inventory-runtime:${operation}:${digest}`;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw invalidInput(field, value);
  }
  return parsed;
}

function nonblank(value: unknown, field: string, maximum: number): string {
  const parsed = String(value ?? "").trim();
  if (parsed.length === 0 || parsed.length > maximum) throw invalidInput(field, value);
  return parsed;
}

function invalidInput(field: string, value: unknown): InventoryAvailabilityRuntimeClaimError {
  return new InventoryAvailabilityRuntimeClaimError(
    "INVALID_INVENTORY_RESERVATION_RUNTIME_INPUT",
    `${field} is invalid for the inventory reservation runtime boundary.`,
    { field, value },
  );
}

function orderItemIdFromLineKey(lineKey: string): number {
  const match = /^order-item:([1-9][0-9]*)$/.exec(lineKey);
  if (!match) {
    throw new InventoryAvailabilityRuntimeClaimError(
      "CANONICAL_CLAIM_LINE_KEY_INVALID",
      "A canonical claim result contains an invalid WMS order-item line key.",
      { lineKey },
    );
  }
  return positiveInteger(match[1], "orderItemId");
}

function safeInteger(value: bigint, field: string, orderId: number): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InventoryAvailabilityRuntimeClaimError(
      "CANONICAL_RESERVATION_RESULT_OUT_OF_RANGE",
      `${field} does not fit the JavaScript safe-integer range.`,
      { field, value: value.toString(), orderId },
    );
  }
  return Number(value);
}

function unsupportedCanonicalMutation(
  code: string,
  message: string,
  context: InventoryAvailabilityRuntimeClaimContext,
  details: Readonly<Record<string, unknown>>,
): InventoryAvailabilityRuntimeClaimError {
  const error = new InventoryAvailabilityRuntimeClaimError(code, message, {
    ...details,
    authority: context.authority,
    authorityRevision: context.authorityRevision,
    activationRunId: context.activationRunId,
  });
  return error;
}

function invalidCanonicalResult(
  operation: string,
  result: CanonicalAvailabilityClaimResult,
  context: InventoryAvailabilityRuntimeClaimContext,
): InventoryAvailabilityRuntimeClaimError {
  const error = new InventoryAvailabilityRuntimeClaimError(
    "CANONICAL_RESERVATION_RESULT_INVALID",
    "The canonical claim application returned an outcome that is invalid for this runtime operation.",
    {
      operation,
      outcome: result.outcome,
      authorityRevision: context.authorityRevision,
      activationRunId: context.activationRunId,
    },
  );
  return error;
}
