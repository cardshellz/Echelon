/**
 * ShipStation adapter — implements ShippingEngine (C9) over the
 * existing shipstation.service.ts factory.
 *
 * Phase 1 strategy: thin delegation layer. The existing service keeps
 * its internal DB queries, validation, and API calls — this adapter
 * translates between the canonical ShippingEngine interface and the
 * service's bespoke signatures. As C3/C5/C8 land they'll pass
 * pre-assembled canonical payloads; the adapter will stop loading from
 * DB and become a pure API translator.
 *
 * Engine name: "shipstation"
 * EngineRef mapping:
 *   engine = "shipstation"
 *   engineOrderRef = String(shipstation_order_id)
 *   engineShipmentRef = orderKey (e.g. "echelon-wms-shp-123")
 */

import { createHash } from "node:crypto";
import type { ShippingEngine } from "../engine";
import { normalizeShipStationV1Date } from "@shared/utils/shipstation-date";
import type {
  EnginePushResult,
  EngineCancelResult,
  EngineMarkShippedResult,
  EngineOrderState,
  EngineRef,
  EngineShipmentItemAppendResult,
  ShipmentItemAppendPayload,
  ShipmentItemQuantityPayload,
  ShipmentPushPayload,
  CanonicalShipmentEvent,
  EngineRefResolutionMetrics,
  OrderEditShipmentSyncInput,
} from "../types";
import {
  mapShipStationShipmentToCanonicalEvent,
  normalizeShipStationWebhookPayload,
} from "./shipstation/shipstation-webhook-normalizer";

export {
  mapShipStationShipmentToCanonicalEvent,
  normalizeShipStationWebhookPayload,
} from "./shipstation/shipstation-webhook-normalizer";

const ENGINE_NAME = "shipstation";
const UNSUPPORTED_MULTI_ACCOUNT_ENV_KEYS = [
  "SHIPSTATION_SECONDARY_API_KEY",
  "SHIPSTATION_SECONDARY_API_SECRET",
  "SHIPSTATION_API_KEYS",
  "SHIPSTATION_ACCOUNTS",
] as const;

export class ShipStationAccountConfigurationError extends Error {
  constructor(
    readonly code:
      | "SHIPSTATION_PARTIAL_CREDENTIALS"
      | "SHIPSTATION_MULTI_ACCOUNT_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "ShipStationAccountConfigurationError";
  }
}

export type SingleShipStationRuntimeAccount =
  | {
      configured: false;
      accountFingerprint: null;
    }
  | {
      configured: true;
      apiKey: string;
      apiSecret: string;
      accountFingerprint: string;
    };

/**
 * Enforces the FW-05 single-account ShipStation v1 runtime invariant.
 * Multi-account credentials or half-configured key/secret pairs fail closed
 * until first-class account-scoped EngineRef routing is explicitly ratified.
 */
export function resolveSingleShipStationRuntimeAccount(
  env: NodeJS.ProcessEnv = process.env,
): SingleShipStationRuntimeAccount {
  for (const forbiddenKey of UNSUPPORTED_MULTI_ACCOUNT_ENV_KEYS) {
    const raw = env[forbiddenKey];
    if (typeof raw === "string" && raw.trim().length > 0) {
      throw new ShipStationAccountConfigurationError(
        "SHIPSTATION_MULTI_ACCOUNT_UNSUPPORTED",
        `Unsupported multi-account ShipStation configuration (${forbiddenKey}): Echelon ShipStation v1 runtime supports a single account per deployment.`,
      );
    }
  }

  const apiKey = (env.SHIPSTATION_API_KEY ?? "").trim();
  const apiSecret = (env.SHIPSTATION_API_SECRET ?? "").trim();
  if (apiKey.length === 0 && apiSecret.length === 0) {
    return { configured: false, accountFingerprint: null };
  }
  if (apiKey.length === 0 || apiSecret.length === 0) {
    throw new ShipStationAccountConfigurationError(
      "SHIPSTATION_PARTIAL_CREDENTIALS",
      "Both SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET must be set together.",
    );
  }

  const accountFingerprint = `ss-v1:${createHash("sha256")
    .update(apiKey)
    .digest("hex")
    .slice(0, 12)}`;
  return {
    configured: true,
    apiKey,
    apiSecret,
    accountFingerprint,
  };
}

export function toEngineRef(
  shipstationOrderId: number,
  orderKey?: string | null,
): EngineRef {
  return {
    engine: ENGINE_NAME,
    engineOrderRef: String(shipstationOrderId),
    engineShipmentRef: orderKey ?? undefined,
  };
}

export function fromEngineRef(ref: EngineRef): number {
  if (ref.engine !== ENGINE_NAME) {
    throw new Error(`ShipStation adapter received ref for engine '${ref.engine}'`);
  }
  const id = Number(ref.engineOrderRef);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid ShipStation order ref: '${ref.engineOrderRef}'`);
  }
  return id;
}

const engineRefMetrics = {
  canonicalHits: 0,
  legacyFallbackHits: 0,
  unresolvedHits: 0,
  lastLegacyFallbackAt: null as string | null,
};

export function getEngineRefResolutionMetrics(): EngineRefResolutionMetrics {
  return { ...engineRefMetrics };
}

export function resetEngineRefResolutionMetricsForTest(): void {
  engineRefMetrics.canonicalHits = 0;
  engineRefMetrics.legacyFallbackHits = 0;
  engineRefMetrics.unresolvedHits = 0;
  engineRefMetrics.lastLegacyFallbackAt = null;
}

/**
 * Build an EngineRef from a DB row that may have the new engine columns
 * or only the legacy shipstation_order_id. Returns null if no ref found.
 * Records resolution source telemetry for the D4 30-day legacy column soak gate (`P3.3`).
 */
export function engineRefFromRow(row: {
  shipping_engine?: string | null;
  engine_order_ref?: string | null;
  engine_shipment_ref?: string | null;
  shipstation_order_id?: number | null;
  shipstation_order_key?: string | null;
}): EngineRef | null {
  if (row.shipping_engine && row.engine_order_ref) {
    engineRefMetrics.canonicalHits += 1;
    return {
      engine: row.shipping_engine,
      engineOrderRef: row.engine_order_ref,
      engineShipmentRef: row.engine_shipment_ref ?? undefined,
    };
  }
  if (row.shipstation_order_id != null && row.shipstation_order_id > 0) {
    engineRefMetrics.legacyFallbackHits += 1;
    engineRefMetrics.lastLegacyFallbackAt = new Date().toISOString();
    return toEngineRef(row.shipstation_order_id, row.shipstation_order_key);
  }
  engineRefMetrics.unresolvedHits += 1;
  return null;
}

export type ShipStationServiceHandle = {
  isConfigured(): boolean;
  pushShipment(
    shipmentId: number,
    opts?: { overrideReview?: boolean },
  ): Promise<{ shipstationOrderId: number; orderKey: string }>;
  upsertShipmentFromPayload?(
    payload: ShipmentPushPayload,
  ): Promise<{
    shipstationOrderId: number;
    orderKey: string;
    alreadyExisted?: boolean;
  }>;
  appendShipmentItems(
    shipmentId: number,
    shipmentItemIds: readonly number[],
  ): Promise<EngineShipmentItemAppendResult>;
  setShipmentItemQuantity(
    shipmentId: number,
    shipmentItemId: number,
  ): Promise<EngineShipmentItemAppendResult>;
  cancelOrder(shipstationOrderId: number): Promise<EngineCancelResult>;
  putOrderOnHold(shipstationOrderId: number): Promise<void>;
  releaseOrderFromHold(shipstationOrderId: number): Promise<void>;
  markAsShipped(
    shipstationOrderId: number,
    opts?: {
      shipDate?: Date | string;
      trackingNumber?: string | null;
      carrierCode?: string | null;
      notifyCustomer?: boolean;
    },
  ): Promise<{ alreadyInState: boolean }>;
  updateSortRank(wmsOrderId: number): Promise<{ touched: number }>;
  updateSortRankSingle(shipstationOrderId: number, sortRank: string): Promise<void>;
  getOrderById(shipstationOrderId: number): Promise<any | null>;
  getShipments(orderId: number, opts?: { orderNumber?: string }): Promise<any[]>;
  observeProviderLabels(shipments: any[]): Promise<void>;
  processShipNotify(resourceUrl: string): Promise<number>;
  registerWebhook(targetUrl: string): Promise<void>;
  synchronizeOrderEditShipment?(
    input: OrderEditShipmentSyncInput,
  ): Promise<void | { retiredShipmentIds: number[] }>;
  syncWmsOrderShipStationShipToAddress?(
    wmsOrderId: number,
  ): Promise<{ updated: number; skipped: number }>;
  resolveOrderForShipment?(shipmentId: number): Promise<
    | { state: "linked"; shipstationOrderId: number; orderKey: string }
    | { state: "not_in_shipstation"; orderKey: string }
  >;
  cancelOrderForShipment?(shipmentId: number): Promise<EngineCancelResult>;
};

/**
 * Create a ShippingEngine adapter backed by the existing ShipStation service.
 *
 * Phase 1: delegates to the service factory. Later phases will
 * inline the API calls and remove the service dependency.
 */
export function createShipStationEngine(
  ss: ShipStationServiceHandle,
): ShippingEngine {
  return {
    engineName: ENGINE_NAME,

    isConfigured(): boolean {
      return ss.isConfigured();
    },

    async upsertShipment(payload: ShipmentPushPayload): Promise<EnginePushResult> {
      const hasHydratedPayload =
        Array.isArray(payload.items) &&
        payload.items.length > 0 &&
        typeof payload.orderNumber === "string" &&
        payload.orderNumber.trim().length > 0;
      if (hasHydratedPayload && typeof ss.upsertShipmentFromPayload === "function") {
        const result = await ss.upsertShipmentFromPayload(payload);
        return {
          engineRef: toEngineRef(result.shipstationOrderId, result.orderKey),
          alreadyExisted: result.alreadyExisted ?? !!payload.existingEngineRef,
        };
      }
      const result = await ss.pushShipment(
        payload.shipmentId,
        payload.overrideReview ? { overrideReview: true } : undefined,
      );
      return {
        engineRef: toEngineRef(result.shipstationOrderId, result.orderKey),
        alreadyExisted: !!payload.existingEngineRef,
      };
    },

    async resolveShipmentRef(shipmentId: number): Promise<EngineRef | null> {
      if (!ss.resolveOrderForShipment) {
        throw new Error("ShipStation service does not expose resolveOrderForShipment");
      }
      const resolution = await ss.resolveOrderForShipment(shipmentId);
      return resolution.state === "linked"
        ? toEngineRef(resolution.shipstationOrderId, resolution.orderKey)
        : null;
    },


    async appendShipmentItems(
      payload: ShipmentItemAppendPayload,
    ): Promise<EngineShipmentItemAppendResult> {
      return ss.appendShipmentItems(
        payload.shipmentId,
        payload.shipmentItemIds,
      );
    },

    async setShipmentItemQuantity(
      payload: ShipmentItemQuantityPayload,
    ): Promise<EngineShipmentItemAppendResult> {
      return ss.setShipmentItemQuantity(payload.shipmentId, payload.shipmentItemId);
    },

    async cancel(engineRef: EngineRef): Promise<EngineCancelResult> {
      const ssOrderId = fromEngineRef(engineRef);
      return ss.cancelOrder(ssOrderId);
    },

    async hold(engineRef: EngineRef): Promise<void> {
      const ssOrderId = fromEngineRef(engineRef);
      await ss.putOrderOnHold(ssOrderId);
    },

    async releaseHold(engineRef: EngineRef): Promise<void> {
      const ssOrderId = fromEngineRef(engineRef);
      await ss.releaseOrderFromHold(ssOrderId);
    },

    async markShipped(
      engineRef: EngineRef,
      opts: {
        shipDate: Date | string;
        trackingNumber?: string | null;
        carrierCode?: string | null;
        notifyCustomer?: boolean;
      },
    ): Promise<EngineMarkShippedResult> {
      const ssOrderId = fromEngineRef(engineRef);
      return ss.markAsShipped(ssOrderId, opts);
    },

    async updatePriority(engineRef: EngineRef, sortRank: string): Promise<void> {
      const ssOrderId = fromEngineRef(engineRef);
      const ssOrder = await ss.getOrderById(ssOrderId);
      if (!ssOrder) return;
      await ss.updateSortRankSingle(ssOrderId, sortRank);
    },

    async getState(engineRef: EngineRef): Promise<EngineOrderState | null> {
      const ssOrderId = fromEngineRef(engineRef);
      const ssOrder = await ss.getOrderById(ssOrderId);
      if (!ssOrder) return null;
      const holdUntil = normalizeShipStationV1Date(ssOrder.holdUntilDate, "holdUntilDate");
      const shipDate = normalizeShipStationV1Date(ssOrder.shipDate, "shipDate");

      return {
        engineRef,
        status: ssOrder.orderStatus ?? "unknown",
        holdUntil: holdUntil.kind === "timestamp" ? new Date(holdUntil.iso) : null,
        holdUntilDate: holdUntil.kind === "date" ? holdUntil.date : null,
        trackingNumber: ssOrder.trackingNumber ?? null,
        carrier: ssOrder.carrierCode ?? null,
        shipDate: shipDate.kind === "timestamp" ? new Date(shipDate.iso) : null,
        shipCalendarDate: shipDate.kind === "date" ? shipDate.date : null,
      };
    },

    async getShipments(
      engineRef: EngineRef,
      opts?: { orderNumber?: string },
    ): Promise<CanonicalShipmentEvent[]> {
      const ssOrderId = fromEngineRef(engineRef);
      const orderNumber = opts?.orderNumber?.trim();
      const ssShipments = await ss.getShipments(
        ssOrderId,
        orderNumber ? { orderNumber } : undefined,
      );
      await ss.observeProviderLabels(ssShipments);

      // The shipping owner retains observed package dimensions in its immutable
      // label ledger here, before projecting dispatch events. Size is evidence
      // about this exact package, not authorization to ship units.

      return ssShipments
        .map((s: any) => mapShipStationShipmentToCanonicalEvent(s))
        .filter((e): e is CanonicalShipmentEvent => e !== null);
    },

    async applyInboundShipmentAuthority({ engineRef, orderNumber }): Promise<number> {
      fromEngineRef(engineRef);
      const normalizedOrderNumber = orderNumber.trim();
      if (!normalizedOrderNumber) {
        throw new Error("ShipStation inbound shipment authority requires an order number");
      }
      // Refresh provider-label evidence only. A label is not dispatch proof;
      // authenticated carrier possession owns shipment-state transitions.
      return ss.processShipNotify(
        `/shipments?orderNumber=${encodeURIComponent(normalizedOrderNumber)}`,
      );
    },

    async processWebhook(resourceUrl: string): Promise<number> {
      return ss.processShipNotify(resourceUrl);
    },

    async normalizeWebhook(rawPayload: unknown): Promise<CanonicalShipmentEvent[]> {
      return normalizeShipStationWebhookPayload(rawPayload);
    },

    async registerWebhook(targetUrl: string): Promise<void> {
      await ss.registerWebhook(targetUrl);
    },

    async sweepQueue(): Promise<void> {
      const account = resolveSingleShipStationRuntimeAccount();
      if (!account.configured) return;
      const { sweepShipStationQueue } = await import(
        "../../oms/shipstation-execution.api"
      );
      await sweepShipStationQueue(account.apiKey, account.apiSecret, {
        cancelOrderForShipment: ss.cancelOrderForShipment
          ? (shipmentId: number) => ss.cancelOrderForShipment!(shipmentId)
          : undefined,
      });
    },

    async synchronizeOrderEditShipment(
      input: OrderEditShipmentSyncInput,
    ): Promise<void | { retiredShipmentIds: number[] }> {
      if (!ss.synchronizeOrderEditShipment) {
        throw new Error("ShipStation service does not expose synchronizeOrderEditShipment");
      }
      return ss.synchronizeOrderEditShipment(input);
    },

    async syncOrderShipToAddress(
      wmsOrderId: number,
    ): Promise<{ updated: number; skipped: number }> {
      if (!ss.syncWmsOrderShipStationShipToAddress) {
        return { updated: 0, skipped: 0 };
      }
      return ss.syncWmsOrderShipStationShipToAddress(wmsOrderId);
    },
  };
}
