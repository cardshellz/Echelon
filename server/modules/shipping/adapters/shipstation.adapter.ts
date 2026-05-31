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

import type { ShippingEngine } from "../engine";
import type {
  EnginePushResult,
  EngineCancelResult,
  EngineMarkShippedResult,
  EngineOrderState,
  EngineRef,
  ShipmentPushPayload,
  CanonicalShipmentEvent,
} from "../types";
import { normalizeCarrier } from "../types";

const ENGINE_NAME = "shipstation";

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

/**
 * Build an EngineRef from a DB row that may have the new engine columns
 * or only the legacy shipstation_order_id. Returns null if no ref found.
 */
export function engineRefFromRow(row: {
  shipping_engine?: string | null;
  engine_order_ref?: string | null;
  engine_shipment_ref?: string | null;
  shipstation_order_id?: number | null;
  shipstation_order_key?: string | null;
}): EngineRef | null {
  if (row.shipping_engine && row.engine_order_ref) {
    return {
      engine: row.shipping_engine,
      engineOrderRef: row.engine_order_ref,
      engineShipmentRef: row.engine_shipment_ref ?? undefined,
    };
  }
  if (row.shipstation_order_id != null && row.shipstation_order_id > 0) {
    return toEngineRef(row.shipstation_order_id, row.shipstation_order_key);
  }
  return null;
}

export type ShipStationServiceHandle = {
  isConfigured(): boolean;
  pushShipment(shipmentId: number): Promise<{ shipstationOrderId: number; orderKey: string }>;
  cancelOrder(shipstationOrderId: number): Promise<{ alreadyInState: boolean }>;
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
  processShipNotify(resourceUrl: string): Promise<number>;
  registerWebhook(targetUrl: string): Promise<void>;
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
      const result = await ss.pushShipment(payload.shipmentId);
      return {
        engineRef: toEngineRef(result.shipstationOrderId, result.orderKey),
        alreadyExisted: !!payload.existingEngineRef,
      };
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

      return {
        engineRef,
        status: ssOrder.orderStatus ?? "unknown",
        holdUntil: ssOrder.holdUntilDate ? new Date(ssOrder.holdUntilDate) : null,
        trackingNumber: ssOrder.trackingNumber ?? null,
        carrier: ssOrder.carrierCode ?? null,
        shipDate: ssOrder.shipDate ? new Date(ssOrder.shipDate) : null,
      };
    },

    async getShipments(engineRef: EngineRef): Promise<CanonicalShipmentEvent[]> {
      const ssOrderId = fromEngineRef(engineRef);
      const ssShipments = await ss.getShipments(ssOrderId);

      return ssShipments.map((s: any) => {
        if (s.voidDate) {
          return {
            kind: "voided" as const,
            shipmentId: s.shipmentId,
            engineRef: toEngineRef(s.orderId, s.orderKey),
            reason: "voided in ShipStation",
          };
        }
        return {
          kind: "shipped" as const,
          shipmentId: s.shipmentId,
          engineRef: toEngineRef(s.orderId, s.orderKey),
          trackingNumber: s.trackingNumber ?? "",
          carrier: normalizeCarrier(s.carrierCode ?? "other"),
          carrierRaw: s.carrierCode ?? "other",
          shipDate: new Date(s.shipDate),
          shipmentCost: s.shipmentCost,
          items: s.shipmentItems?.map((item: any) => ({
            sku: item.sku ?? "",
            quantity: item.quantity ?? 0,
            name: item.name ?? "",
          })),
        };
      });
    },

    async normalizeWebhook(rawPayload: unknown): Promise<CanonicalShipmentEvent[]> {
      // Phase 1: the existing processShipNotify handles the full
      // webhook lifecycle (fetch resource URL, process each shipment,
      // dispatch rollup). The canonical normalizeWebhook should only
      // translate the payload — processing moves to C5. For now this
      // is a no-op; callers still use ss.processShipNotify directly.
      // This will be implemented when C5 (shipment-event applier) lands.
      return [];
    },

    async registerWebhook(targetUrl: string): Promise<void> {
      await ss.registerWebhook(targetUrl);
    },
  };
}
