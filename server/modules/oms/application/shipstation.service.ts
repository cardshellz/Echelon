/**
 * ShipStation Integration Service
 *
 * Pushes OMS orders to ShipStation for fulfillment and receives
 * SHIP_NOTIFY webhooks for automatic tracking updates.
 *
 * Key design points:
 * - Idempotent pushes via `orderKey` (echelon-oms-{oms_order_id})
 * - ShipStation API requires HTTP/1.1 (node fetch defaults to this)
 * - Carrier code mapping for eBay fulfillment push
 */

import { createShipStationLabelReconciliationClient } from "../infrastructure/shipstation-label-reconciliation.client";
import {
  createShipStationApiRequester,
  type ShipStationApiRequester,
} from "./shipstation-api-request";
import {
  getDefaultSessionAdvisoryLockRunner,
  type SessionAdvisoryLockRunner,
} from "../../../infrastructure/session-advisory-lock";
import {
  WMS_ORDER_SHIPMENT_LOCK_NAMESPACE,
  WMS_SHIPMENT_PUSH_LOCK_NAMESPACE,
} from "../../wms/shipment-execution-and-projection.api";
import {
  SS_PUSH_INVALID_SHIPMENT,
  ShipStationPushError,
  buildShipStationUrl,
  redactSensitiveUrl,
  type ShipStationInventoryRecorder,
  type ShipStationRuntimeContext,
  type ShipStationServiceDependencies,
  type ShipStationShipment,
} from "../shipstation/shipstation-contracts";
import { createShipStationNotifyPackageResolution } from "../shipstation/shipstation-notify-package-resolution";
import { createShipStationNotifyV2Execution } from "../shipstation/shipstation-notify-v2-execution";
import { createShipStationNotifyWebhookDispatch } from "../shipstation/shipstation-notify-webhook-dispatch";
import { createShipStationOrderControls } from "../shipstation/shipstation-order-controls";
import { createShipStationPushHandlers } from "../shipstation/shipstation-push-shipment";
import { createShipStationShipmentOrderResolution } from "../shipstation/shipstation-shipment-order-resolution";

export {
  normalizeCountryToIso2,
  ShipStationRateLimitError,
  ShipStationRequestTimeoutError,
  ShipStationTransientError,
  SS_RATE_LIMITED,
  SS_REQUEST_TIMEOUT,
  ShipStationPushError,
  SS_PUSH_INVALID_SHIPMENT,
  parseEchelonOrderKey,
  resolveShipStationIds,
  validateShipmentForPush,
  parsePositiveWmsShipmentItemsFromShipStation,
  mapShipStationCarrier,
  redactSensitiveUrl,
  type ManualShipmentContentsAuthorityLine,
  type ManualShipmentContentsAuthority,
  type ManualShipmentNotificationInput,
  type WmsShipmentRow,
  type WmsOrderRow,
  type WmsShipmentItemRow,
  type ShipStationRouting,
  type ShipStationShipmentItem,
  type ShipStationShipment,
  type ShipStationInventoryRecorder,
  type ShipStationServiceDependencies,
} from "../shipstation/shipstation-contracts";

export function createShipStationService(
  db: any,
  inventoryCore?: ShipStationInventoryRecorder,
  dependencies: ShipStationServiceDependencies = {},
) {
  const baseUrl = "https://ssapi.shipstation.com";
  const sessionLock: SessionAdvisoryLockRunner =
    dependencies.sessionLock ?? getDefaultSessionAdvisoryLockRunner();

  /**
   * Serializes engine push/amend work for ONE shipment across every caller
   * (webhooks, wms-sync, retry worker, reconcilers, manual routes). The
   * critical section spans read → ShipStation write → linkage write-back, so it
   * must be a session lock held on a pinned connection; see
   * server/infrastructure/session-advisory-lock.ts for why the pooled
   * pg_advisory_lock idiom serialized nothing.
   */
  function withShipmentPushLock<T>(shipmentId: number, fn: () => Promise<T>): Promise<T> {
    return sessionLock(
      {
        namespace: WMS_SHIPMENT_PUSH_LOCK_NAMESPACE,
        key: shipmentId,
        label: "shipstation.shipment_push",
      },
      fn,
    );
  }

  /** Serializes shipment-row creation for ONE WMS order (shared key space with create-shipment.ts). */
  function withOrderShipmentLock<T>(wmsOrderId: number, fn: () => Promise<T>): Promise<T> {
    return sessionLock(
      {
        namespace: WMS_ORDER_SHIPMENT_LOCK_NAMESPACE,
        key: wmsOrderId,
        label: "shipstation.order_shipment",
      },
      fn,
    );
  }
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;

  function getAuthHeader(): string {
    if (!apiKey || !apiSecret) {
      throw new Error("SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET must be set");
    }
    return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  }

  function isConfigured(): boolean {
    return !!(apiKey && apiSecret);
  }

  // Replay policy, timeouts, and transient error classification live in
  // shipstation-api-request.ts. Mutations are NOT replayed after a 429 unless
  // the call site opts in with { replaySafe: true } (idempotent upsert by id).
  const apiRequest: ShipStationApiRequester = createShipStationApiRequester({
    buildUrl: (path) => buildShipStationUrl(baseUrl, path),
    getAuthHeader,
    sleep: dependencies.sleep,
  });

  // -------------------------------------------------------------------------
  // REMOVED: pushOrder (legacy OMS-level push to ShipStation)
  //
  // pushOrder created a ShipStation order keyed `echelon-oms-<omsOrderId>`,
  // a DIFFERENT key scheme than the canonical WMS push
  // (`echelon-wms-shp-<shipmentId>`). Because ShipStation dedups on orderKey,
  // having both paths meant the same order could be created TWICE in
  // ShipStation (one per key scheme). It had no remaining live callers — the
  // manual route now delegates to pushShipment — so it is deleted to
  // guarantee exactly ONE path to ShipStation. SHIP_NOTIFY still parses
  // legacy `echelon-oms-<id>` keys for pre-cutover orders (see
  // parseEchelonOrderKey), but Echelon no longer EMITS them.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Get shipments for a ShipStation order
  // -------------------------------------------------------------------------

  async function getShipments(
    orderId: number,
    opts?: { orderNumber?: string },
  ): Promise<ShipStationShipment[]> {
    // includeShipmentItems=true is required to populate `shipmentItems` on
    // each shipment; without it SS returns empty/undefined item arrays.
    //
    // SS API gotcha: when an order is split inside ShipStation (manually
    // via the UI's split button OR via automation rules), each child
    // shipment gets its own internal SS order id. The /shipments?orderId
    // filter then misses the children because they no longer match the
    // parent's id. The orderNumber field (e.g. "#56826") is what stays
    // stable across all the splits.
    //
    // Strategy: fetch by orderId and, when we also know the orderNumber,
    // fetch by orderNumber too. Split children can exist while the parent
    // query still returns one shipment, so fallback-only misses real child
    // shipments.
    if (!opts?.orderNumber) {
      const byOrderId = await apiRequest<{ shipments: ShipStationShipment[] }>(
        "GET",
        `/shipments?orderId=${orderId}&includeShipmentItems=true`,
      );
      return byOrderId.shipments || [];
    }

    const [byOrderId, byOrderNumber] = await Promise.all([
      apiRequest<{ shipments: ShipStationShipment[] }>(
        "GET",
        `/shipments?orderId=${orderId}&includeShipmentItems=true`,
      ),
      apiRequest<{ shipments: ShipStationShipment[] }>(
        "GET",
        `/shipments?orderNumber=${encodeURIComponent(opts.orderNumber)}&includeShipmentItems=true`,
      ),
    ]);
    const idResults = byOrderId.shipments || [];
    const merged = new Map<number, ShipStationShipment>();
    for (const shipment of idResults) {
      if (Number.isInteger(shipment.shipmentId)) {
        merged.set(shipment.shipmentId, shipment);
      }
    }
    for (const shipment of byOrderNumber.shipments || []) {
      if (Number.isInteger(shipment.shipmentId)) {
        merged.set(shipment.shipmentId, shipment);
      }
    }
    return Array.from(merged.values());
  }

  async function getShipmentById(
    shipmentId: number,
  ): Promise<ShipStationShipment | null> {
    if (!Number.isSafeInteger(shipmentId) || shipmentId <= 0) {
      throw new Error("ShipStation shipment id must be a positive integer");
    }
    const result = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      `/shipments?shipmentId=${shipmentId}&includeShipmentItems=true`,
    );
    return (result.shipments ?? []).find(
      (shipment) => shipment.shipmentId === shipmentId,
    ) ?? null;
  }

  // -------------------------------------------------------------------------
  // Get order by orderKey
  // -------------------------------------------------------------------------

  const MAX_ORDER_KEY_LOOKUP_PAGES = 10;

  async function getOrderByKey(
    orderKey: string,
    orderNumber: string,
  ): Promise<any> {
    const exactMatches: any[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const endpoint =
        page === 1
          ? `/orders?orderNumber=${encodeURIComponent(orderNumber)}`
          : `/orders?orderNumber=${encodeURIComponent(orderNumber)}&page=${page}`;
      const result = await apiRequest<{
        orders?: any[];
        page?: number;
        pages?: number;
      }>("GET", endpoint);

      if (!result || !Array.isArray(result.orders)) {
        throw new ShipStationPushError(
          `ShipStation order lookup for ${orderNumber} returned a malformed orders response on page ${page}`,
          {
            code: SS_PUSH_INVALID_SHIPMENT,
            field: "provider.orders",
            value: result,
          },
        );
      }

      if (page === 1 && result.pages !== undefined && result.pages !== null) {
        const parsedPages = Number(result.pages);
        if (!Number.isInteger(parsedPages) || parsedPages < 0) {
          throw new ShipStationPushError(
            `ShipStation order lookup for ${orderNumber} returned an invalid page count (${String(result.pages)})`,
            {
              code: SS_PUSH_INVALID_SHIPMENT,
              field: "provider.pages",
              value: result.pages,
            },
          );
        }
        if (parsedPages > MAX_ORDER_KEY_LOOKUP_PAGES) {
          throw new ShipStationPushError(
            `ShipStation order lookup for ${orderNumber} spans ${parsedPages} pages (exceeds safe lookup bound ${MAX_ORDER_KEY_LOOKUP_PAGES})`,
            {
              code: SS_PUSH_INVALID_SHIPMENT,
              field: "provider.pages",
              value: parsedPages,
            },
          );
        }
        totalPages = Math.max(1, parsedPages);
      }

      for (const order of result.orders) {
        if (String(order?.orderKey ?? "") === orderKey) {
          exactMatches.push(order);
        }
      }

      page += 1;
    }

    if (exactMatches.length > 1) {
      throw new ShipStationPushError(
        `ShipStation returned ${exactMatches.length} orders for exact key ${orderKey}`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          field: "provider.orderKey",
          value: orderKey,
        },
      );
    }
    return exactMatches[0] ?? null;
  }
  // -------------------------------------------------------------------------
  // Get order by orderNumber
  // -------------------------------------------------------------------------

  async function getOrderByNumber(orderNumber: string): Promise<any> {
    if (!isConfigured()) return null;
    try {
      const result = await apiRequest<{ orders: any[] }>(
        "GET",
        `/orders?orderNumber=${encodeURIComponent(orderNumber)}`,
      );
      return result.orders?.[0] || null;
    } catch (err: any) {
      console.warn(`[ShipStation] getOrderByNumber ${orderNumber} failed:`, err.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Register SHIP_NOTIFY webhook with ShipStation (idempotent)
  // -------------------------------------------------------------------------

  async function registerWebhook(targetUrl: string): Promise<void> {
    if (!isConfigured()) {
      console.log("[ShipStation] Not configured — skipping webhook registration");
      return;
    }

    try {
      // List existing webhooks
      const existing = await apiRequest<{ webhooks: Array<{ WebHookID: number; Target: string; Event: string; IsActive: boolean }> }>(
        "GET",
        "/webhooks",
      );

      // Check if already registered
      const alreadyRegistered = existing.webhooks?.some(
        (wh) => wh.Target === targetUrl && wh.Event === "SHIP_NOTIFY" && wh.IsActive,
      );

      if (alreadyRegistered) {
        console.log("[ShipStation] SHIP_NOTIFY webhook already registered");
        return;
      }

      // Subscribe
      // Not replay-safe: a replayed subscribe can register a duplicate
      // webhook. A 429 here surfaces as a transient error and registration
      // (idempotent by target + event) is retried at the next boot.
      await apiRequest("POST", "/webhooks/subscribe", {
        target_url: targetUrl,
        event: "SHIP_NOTIFY",
        store_id: null,
        friendly_name: "Echelon OMS Tracking",
      });

      console.log(`[ShipStation] Registered SHIP_NOTIFY webhook -> ${redactSensitiveUrl(targetUrl)}`);
    } catch (err: any) {
      console.error(`[ShipStation] Failed to register webhook: ${err.message}`);
    }
  }

  /**
   * Helper: fetch a ShipStation order by ID.
   * Used to hydrate the existing order shape so createorder upsert
   * only changes what we want and doesn't blank other fields.
   */
  async function getOrderById(shipstationOrderId: number): Promise<any | null> {
    if (!isConfigured()) return null;
    try {
      return await apiRequest<any>("GET", `/orders/${shipstationOrderId}`);
    } catch (err: any) {
      console.warn(`[ShipStation] getOrderById ${shipstationOrderId} failed:`, err.message);
      return null;
    }
  }

  const runtimeContext: ShipStationRuntimeContext = {
    db,
    baseUrl,
    inventoryCore,
    dependencies,
    apiRequest,
    isConfigured,
    withShipmentPushLock,
    withOrderShipmentLock,
    getShipmentById,
    getOrderById,
    getOrderByKey,
  };

  const notifyResolution = createShipStationNotifyPackageResolution(runtimeContext);
  const notifyV2 = createShipStationNotifyV2Execution(runtimeContext, notifyResolution);
  const notifyDispatch = createShipStationNotifyWebhookDispatch(
    runtimeContext,
    notifyResolution,
    notifyV2,
  );
  const orderControls = createShipStationOrderControls(runtimeContext);
  const pushHandlers = createShipStationPushHandlers(
    runtimeContext,
    notifyV2.getOmsFinalOrderBlockerForShipmentPush,
    orderControls.cancelOrder,
  );
  const shipmentOrderResolution = createShipStationShipmentOrderResolution(runtimeContext);

  /**
   * Cancel the ShipStation order for a shipment, finding it by Echelon's
   * order key when its id was never saved. "not_found" here means proven
   * absent from ShipStation, not "we had no id".
   */
  async function cancelOrderForShipment(shipmentId: number) {
    const resolution = await shipmentOrderResolution.resolveOrderForShipment(shipmentId);
    if (resolution.state === "not_in_shipstation") {
      return { alreadyInState: false, state: "not_found" as const };
    }
    return orderControls.cancelOrder(resolution.shipstationOrderId);
  }

  return {
    pushShipment: pushHandlers.pushShipment,
    upsertShipmentFromPayload: pushHandlers.upsertShipmentFromPayload,
    appendShipmentItems: pushHandlers.appendShipmentItems,
    setShipmentItemQuantity: pushHandlers.setShipmentItemQuantity,
    getShipments,
    getShipmentById,
    getOrderById,
    getOrderByKey,
    getOrderByNumber,
    processManualShipmentNotification: notifyDispatch.processManualShipmentNotification,
    processShipNotify: notifyDispatch.processShipNotify,
    processProviderLabelSnapshots: notifyDispatch.processProviderLabelSnapshots,
    labelReconciliationSource: createShipStationLabelReconciliationClient(apiRequest, isConfigured),
    observeProviderLabels: notifyDispatch.observeProviderLabels,
    confirmDispatch: notifyDispatch.confirmDispatch,
    registerWebhook,
    isConfigured,
    putOrderOnHold: orderControls.putOrderOnHold,
    releaseOrderFromHold: orderControls.releaseOrderFromHold,
    markAsShipped: orderControls.markAsShipped,
    cancelOrder: orderControls.cancelOrder,
    resolveOrderForShipment: shipmentOrderResolution.resolveOrderForShipment,
    cancelOrderForShipment,
    updateSortRank: orderControls.updateSortRank,
    updateSortRankSingle: orderControls.updateShipStationCustomField1,
    syncWmsOrderShipStationHoldState: orderControls.syncWmsOrderShipStationHoldState,
    synchronizeOrderEditShipment: orderControls.synchronizeOrderEditShipment,
    syncWmsOrderShipStationShipToAddress: orderControls.syncWmsOrderShipStationShipToAddress,
  };
}

export type ShipStationService = ReturnType<typeof createShipStationService>;
