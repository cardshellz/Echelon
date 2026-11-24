/**
 * Canonical Channel Order `ingestAndRoute()` Use-Case (`P3.1`)
 *
 * Owns the single post-ingest choreography across all sales channels:
 *   1. Validate `ValidatedChannelOrder` at the boundary (`channelIntakeOrderSchema`)
 *      and convert to OMS `OrderData`.
 *   2. Upsert/deduplicate into OMS via `omsService.ingestOrder(channelId, externalOrderId, orderData)`.
 *   3. Run optional `afterIngested` guard/observation hook (may short-circuit routing).
 *   4. Ensure WMS materialization via `wmsSyncService.syncOmsOrderToWms(omsOrder.id)`
 *      (enqueuing `oms_wms_sync` retry on genuine errors while treating `null`
 *      already-fulfilled skips as a harmless no-op).
 *   5. When `!omsOrder.warehouseId`: reserve inventory + assign warehouse via
 *      `omsService.reserveInventory(omsOrder.id)` and `omsService.assignWarehouse(omsOrder.id)`.
 *   6. Run the second idempotent `syncOmsOrderToWms` pass so newly assigned
 *      warehouse state is guaranteed to reach WMS (or persist a retry row).
 *   7. Run optional `afterRouted` side-effect hooks (e.g. member tier, FO IDs,
 *      Mission Control event, bridge notification).
 */

import {
  parseValidatedChannelOrder,
  type ValidatedChannelOrder,
  type ValidatedChannelOrderInput,
} from "../../channels/channel-adapter.interface.api";
import type {
  LineItemData,
  OmsService,
  OrderData,
} from "./oms.service";
import { enqueueOmsWmsSyncRetry } from "./webhook-retry.worker";
import { enrichContext } from "../../../platform/observability";
import { logger } from "../../../platform/observability/logger";

export interface WmsOrderSyncPort {
  syncOmsOrderToWms(omsOrderId: number): Promise<number | null | undefined>;
}

export interface EnsureWmsSyncInput {
  db: any;
  wmsSyncService: WmsOrderSyncPort | null | undefined;
  omsOrderId: number;
  label: string;
  logPrefix: string;
  /** When true, missing `wmsSyncService` also enqueues an `oms_wms_sync` retry before throwing. */
  enqueueRetryWhenServiceMissing?: boolean;
}

/**
 * Shared WMS sync + durable retry guarantee (`P3.1`).
 *
 * Genuine errors enqueue an `oms_wms_sync` retry row; an intentional `null`
 * return (already fulfilled out-of-band) logs and returns as a harmless no-op
 * instead of dead-lettering.
 */
export async function ensureChannelOrderQueuedForWmsSync(
  input: EnsureWmsSyncInput,
): Promise<number | null> {
  const { db, wmsSyncService, omsOrderId, label, logPrefix } = input;
  if (!wmsSyncService) {
    const err = new Error(
      `${logPrefix} wmsSyncService must be initialized to sync OMS order ${omsOrderId}`,
    );
    if (input.enqueueRetryWhenServiceMissing) {
      await enqueueOmsWmsSyncRetry(db, omsOrderId, err);
    }
    throw err;
  }

  try {
    const wmsOrderId = await wmsSyncService.syncOmsOrderToWms(omsOrderId);
    if (!wmsOrderId) {
      // `null` = sync intentionally skipped (order already final/fulfilled out-of-band) —
      // a no-op, not a failure. Do NOT re-queue it.
      logger.info("oms.channel_order_ingest_and_route", { message: `${logPrefix} WMS sync skipped for ${label} (omsOrder ${omsOrderId}) — already fulfilled out-of-band; no-op` });
      return null;
    }
    logger.info("oms.channel_order_ingest_and_route", { message: `${logPrefix} Synced ${label} to WMS (wms=${wmsOrderId})` });
    return wmsOrderId;
  } catch (error: any) {
    const err =
      error instanceof Error ? error : new Error(error?.message ?? String(error));
    logger.error("oms.channel_order_ingest_and_route", { message: `${logPrefix} WMS sync failed for ${label}: ${err.message}` });
    await enqueueOmsWmsSyncRetry(db, omsOrderId, err);
    return null;
  }
}

/**
 * Convert a boundary-validated `ValidatedChannelOrder` into OMS `OrderData`.
 */
export function validatedChannelOrderToOrderData(
  order: ValidatedChannelOrder,
): OrderData {
  const shipping = order.shippingAddress;
  const lineItems: LineItemData[] = order.lineItems.map((item) => ({
    externalLineItemId: item.externalLineItemId,
    externalProductId: item.externalProductId ?? null,
    externalVariantId: item.externalVariantId ?? null,
    sku: item.sku,
    title: item.title,
    name: item.name ?? item.title,
    variantTitle: item.variantTitle ?? null,
    quantity: item.quantity,
    ...(item.currentQuantity !== undefined
      ? { currentQuantity: item.currentQuantity }
      : {}),
    ...(item.fulfillableQuantity !== undefined
      ? { fulfillableQuantity: item.fulfillableQuantity }
      : {}),
    paidPriceCents: item.paidPriceCents,
    ...(item.retailPriceCents !== undefined
      ? { retailPriceCents: item.retailPriceCents }
      : {}),
    totalCents: item.totalCents,
    taxCents: item.taxCents,
    discountCents: item.discountCents,
    ...(item.requiresShipping !== undefined
      ? { requiresShipping: item.requiresShipping }
      : {}),
    ...(item.fulfillmentProvider
      ? { fulfillmentProvider: item.fulfillmentProvider }
      : {}),
  }));

  const data: OrderData = {
    externalOrderNumber: order.externalOrderNumber ?? order.externalOrderId,
    status: order.status,
    financialStatus: order.financialStatus ?? undefined,
    fulfillmentStatus: order.fulfillmentStatus ?? undefined,
    customerName: order.customerName ?? undefined,
    customerEmail: order.customerEmail ?? undefined,
    customerPhone: order.customerPhone ?? shipping?.phone ?? undefined,
    externalCustomerId: order.externalCustomerId,
    shipToName: shipping?.name ?? undefined,
    shipToCompany: shipping?.company ?? null,
    shipToAddress1: shipping?.address1 ?? undefined,
    shipToAddress2: shipping?.address2 ?? undefined,
    shipToCity: shipping?.city ?? undefined,
    shipToState: shipping?.province ?? undefined,
    shipToZip: shipping?.zip ?? undefined,
    shipToCountry: shipping?.country ?? null,
    shippingMethod: order.shippingMethod ?? null,
    shippingMethodCode: order.shippingMethodCode ?? null,
    shippingServiceLevel: order.shippingServiceLevel,
    channelShipByDate: order.channelShipByDate ?? null,
    subtotalCents: order.subtotalCents,
    ...(order.grossSubtotalCents !== undefined
      ? { grossSubtotalCents: order.grossSubtotalCents }
      : {}),
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    currency: order.currency,
    rawPayload: order.rawPayload,
    notes: order.notes ?? undefined,
    tags: order.tags ?? undefined,
    riskLevel: order.riskLevel ?? null,
    riskScore: order.riskScore ?? null,
    riskRecommendation: order.riskRecommendation ?? null,
    riskFacts: order.riskFacts ?? null,
    orderedAt: order.orderDate,
    channelUpdatedAt: order.channelUpdatedAt ?? null,
    lineItems,
    sourceTopic: order.sourceTopic,
    sourceEventId: order.sourceEventId ?? null,
    sourceInboxId: order.sourceInboxId ?? null,
  };

  return data;
}

export interface IngestAndRouteContext {
  omsOrder: Awaited<ReturnType<OmsService["ingestOrder"]>>;
  isNew: boolean;
  validatedOrder: ValidatedChannelOrder;
  orderData: OrderData;
}

export interface IngestAndRouteInput {
  db: any;
  omsService: {
    ingestOrder: OmsService["ingestOrder"];
    reserveInventory(orderId: number): Promise<unknown>;
    assignWarehouse(orderId: number, warehouseId?: number): Promise<unknown>;
  };
  wmsSyncService: WmsOrderSyncPort | null | undefined;
  order: ValidatedChannelOrderInput;
  logPrefix?: string;
  label?: string;
  nowMs?: number;
  /**
   * When true (e.g. Shopify `orders/paid`), always runs pre/post WMS sync even
   * when `omsOrder` is >5s old and already has `warehouseId` set.
   * When false (default — e.g. polling loops), runs routing + WMS sync when
   * `isNew || !omsOrder.warehouseId`.
   */
  alwaysSyncExistingAssigned?: boolean;
  enqueueRetryWhenSyncServiceMissing?: boolean;
  onIngestError?: (error: unknown) => Promise<void>;
  afterIngested?: (
    ctx: IngestAndRouteContext,
  ) => Promise<{ skipRouting?: boolean } | void>;
  afterRouted?: (ctx: IngestAndRouteContext & { routed: boolean }) => Promise<void>;
}

export interface IngestAndRouteResult {
  omsOrder: Awaited<ReturnType<OmsService["ingestOrder"]>>;
  omsOrderId: number;
  isNew: boolean;
  routed: boolean;
  skippedByGuard: boolean;
}

export async function ingestAndRoute(
  input: IngestAndRouteInput,
): Promise<IngestAndRouteResult> {
  let validatedOrder: ValidatedChannelOrder;
  let orderData: OrderData;
  let omsOrder: Awaited<ReturnType<OmsService["ingestOrder"]>>;
  let isNew: boolean;
  let ctx: IngestAndRouteContext;
  try {
    const providerKey = input.order.source || "unknown";
    validatedOrder = parseValidatedChannelOrder(providerKey, input.order);
    if (validatedOrder.sourceEventId) {
      enrichContext({ channelEventId: validatedOrder.sourceEventId });
    }
    orderData = validatedChannelOrderToOrderData(validatedOrder);
    omsOrder = await input.omsService.ingestOrder(
      validatedOrder.channelId,
      validatedOrder.externalOrderId,
      orderData,
    );
    enrichContext({ omsOrderId: omsOrder.id });

    const nowMs = input.nowMs ?? Date.now();
    isNew = Boolean(
      omsOrder.createdAt &&
        nowMs - new Date(omsOrder.createdAt).getTime() < 5_000,
    );

    ctx = {
      omsOrder,
      isNew,
      validatedOrder,
      orderData,
    };

    if (input.afterIngested) {
      const guardResult = await input.afterIngested(ctx);
      if (guardResult?.skipRouting) {
        return {
          omsOrder,
          omsOrderId: omsOrder.id,
          isNew,
          routed: false,
          skippedByGuard: true,
        };
      }
    }
  } catch (error) {
    if (input.onIngestError) {
      await input.onIngestError(error);
    }
    throw error;
  }

  const logPrefix = input.logPrefix ?? `[OMS Intake:${validatedOrder.source}]`;
  const label =
    input.label ??
    validatedOrder.externalOrderNumber ??
    validatedOrder.externalOrderId;

  const shouldRoute =
    input.alwaysSyncExistingAssigned === true ||
    isNew ||
    !omsOrder.warehouseId;

  if (!isNew && shouldRoute) {
    logger.info("oms.channel_order_ingest_and_route", { message: `${logPrefix} Order ${label} already exists in OMS (id=${omsOrder.id}), ensuring routing` });
  }

  if (shouldRoute) {
    await ensureChannelOrderQueuedForWmsSync({
      db: input.db,
      wmsSyncService: input.wmsSyncService,
      omsOrderId: omsOrder.id,
      label,
      logPrefix,
      enqueueRetryWhenServiceMissing: input.enqueueRetryWhenSyncServiceMissing,
    });

    if (!omsOrder.warehouseId) {
      try {
        await input.omsService.reserveInventory(omsOrder.id);
        await input.omsService.assignWarehouse(omsOrder.id);
      } catch (err: any) {
        logger.error("oms.channel_order_ingest_and_route", { message: `${logPrefix} Post-ingest processing failed for ${label}: ${err?.message ?? err}` });
      }
    } else {
      logger.info("oms.channel_order_ingest_and_route", { message: `${logPrefix} Order ${label} already has warehouse_id=${omsOrder.warehouseId}` });
    }

    await ensureChannelOrderQueuedForWmsSync({
      db: input.db,
      wmsSyncService: input.wmsSyncService,
      omsOrderId: omsOrder.id,
      label,
      logPrefix,
      enqueueRetryWhenServiceMissing: input.enqueueRetryWhenSyncServiceMissing,
    });
  }

  if (input.afterRouted) {
    await input.afterRouted({ ...ctx, routed: shouldRoute });
  }

  return {
    omsOrder,
    omsOrderId: omsOrder.id,
    isNew,
    routed: shouldRoute,
    skippedByGuard: false,
  };
}
