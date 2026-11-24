import { sql } from "drizzle-orm";
import { logger as platformLogger } from "../../../platform/observability/logger";
import { linkShipStationOrderIdentityOnOutboundShipmentInWms } from "../../wms/outbound-shipment-mutations.api";
import {
  ShipStationPushError,
  shipStationOrderKeyForShipment,
  shipStationOrderNumberForWmsOrder,
  type ShipStationRuntimeContext,
} from "./shipstation-contracts";

/**
 * Finding a shipment's ShipStation order by Echelon's OWN identity.
 *
 * Every ShipStation order Echelon creates is named before it is sent:
 * orderKey `echelon-wms-shp-<shipmentId>`. ShipStation's numeric order id is
 * only learned from the push response, and that response can be lost (timeout,
 * 429, restart) or arrive after the shipment was cancelled. Treating "no saved
 * id" as "not in ShipStation" is what left #65805 live in ShipStation after a
 * fraud cancel.
 *
 * So the saved id is a CACHE. This resolver returns it when present and
 * otherwise looks the order up by key, proves it is ours, and saves the id.
 * ShipStation's v1 API still needs the numeric id for hold, restore, cancel,
 * and mark-shipped, so callers keep addressing the provider by id; they just
 * never have to *have* it to act.
 */

export const SS_ORDER_IDENTITY_UNPROVEN = "SS_ORDER_IDENTITY_UNPROVEN";
export const SS_ORDER_LINK_CONFLICT = "SS_ORDER_LINK_CONFLICT";
export const SS_SHIPMENT_NOT_FOUND = "SS_SHIPMENT_NOT_FOUND";

export type ShipStationShipmentOrderResolution =
  | {
      state: "linked";
      shipstationOrderId: number;
      orderKey: string;
      /** "saved" = id already on the row; "looked_up" = found by key and saved now. */
      source: "saved" | "looked_up";
    }
  | { state: "not_in_shipstation"; orderKey: string };

export interface ShipStationProviderOrderEvidence {
  orderId?: unknown;
  orderKey?: unknown;
  orderNumber?: unknown;
  advancedOptions?: { customField2?: unknown } | null;
}

/**
 * Pure identity check. The key alone is not trusted: the order number and the
 * WMS metadata Echelon writes into customField2 must agree too, so a copied or
 * hand-edited provider row is never acted on as ours.
 */
export function proveShipStationOrderBelongsToShipment(
  expected: { shipmentId: number; wmsOrderId: number; orderNumber: string },
  evidence: ShipStationProviderOrderEvidence,
): { proven: true; providerOrderId: number } | { proven: false; reason: string } {
  const providerOrderId = Number(evidence.orderId);
  if (!Number.isSafeInteger(providerOrderId) || providerOrderId <= 0 || providerOrderId > 2147483647) {
    return { proven: false, reason: "invalid_provider_order_id" };
  }
  if (String(evidence.orderKey ?? "") !== shipStationOrderKeyForShipment(expected.shipmentId)) {
    return { proven: false, reason: "order_key_mismatch" };
  }
  if (String(evidence.orderNumber ?? "") !== expected.orderNumber) {
    return { proven: false, reason: "order_number_mismatch" };
  }
  const expectedMetadata = `wms_order_id:${expected.wmsOrderId}|shipment_id:${expected.shipmentId}`;
  if (String(evidence.advancedOptions?.customField2 ?? "") !== expectedMetadata) {
    return { proven: false, reason: "wms_metadata_mismatch" };
  }
  return { proven: true, providerOrderId };
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function createShipStationShipmentOrderResolution(
  ctx: Pick<ShipStationRuntimeContext, "db" | "withShipmentPushLock" | "getOrderByKey">,
  deps: { now?: () => Date } = {},
) {
  const { db, withShipmentPushLock, getOrderByKey } = ctx;
  const now = deps.now ?? (() => new Date());

  /**
   * Resolve the ShipStation order for one shipment.
   *
   * Runs under the same per-shipment lock as pushShipment, so it never reads
   * the row while a push is between "ShipStation created the order" and "id
   * saved": it waits for that push to finish first. Lookup failures throw
   * (transient); callers on a retry ladder retry, others log and fall back to
   * the sweeper. Never call this from inside withShipmentPushLock (the lock is
   * not re-entrant).
   */
  async function resolveOrderForShipment(
    shipmentId: number,
  ): Promise<ShipStationShipmentOrderResolution> {
    if (!Number.isSafeInteger(shipmentId) || shipmentId <= 0) {
      throw new ShipStationPushError("shipmentId must be a positive integer", {
        code: SS_SHIPMENT_NOT_FOUND,
        shipmentId,
        field: "shipmentId",
        value: shipmentId,
      });
    }
    return withShipmentPushLock(shipmentId, () => resolveLocked(shipmentId));
  }

  async function resolveLocked(shipmentId: number): Promise<ShipStationShipmentOrderResolution> {
    const result: any = await db.execute(sql`
      SELECT os.id, os.order_id, os.status, os.shipstation_order_id, os.shipstation_order_key,
             os.engine_order_ref, o.order_number, o.external_order_id, o.channel_id
      FROM wms.outbound_shipments os
      JOIN wms.orders o ON o.id = os.order_id
      WHERE os.id = ${shipmentId}
      LIMIT 1
    `);
    const row = result?.rows?.[0];
    if (!row) {
      throw new ShipStationPushError(`shipment ${shipmentId} not found`, {
        code: SS_SHIPMENT_NOT_FOUND,
        shipmentId,
        field: "shipment",
        value: null,
      });
    }

    const savedId = positiveId(row.shipstation_order_id) ?? positiveId(row.engine_order_ref);
    if (savedId !== null) {
      return {
        state: "linked",
        shipstationOrderId: savedId,
        orderKey: row.shipstation_order_key || shipStationOrderKeyForShipment(shipmentId),
        source: "saved",
      };
    }

    const orderKey = shipStationOrderKeyForShipment(shipmentId);
    const orderNumber = shipStationOrderNumberForWmsOrder(row);
    const evidence = await getOrderByKey(orderKey, orderNumber);
    if (!evidence) {
      return { state: "not_in_shipstation", orderKey };
    }

    const proof = proveShipStationOrderBelongsToShipment(
      { shipmentId, wmsOrderId: Number(row.order_id), orderNumber },
      evidence,
    );
    if (!proof.proven) {
      platformLogger.error("shipstation.shipment_order_resolution", {
        action: "resolve_by_order_key",
        outcome: "identity_unproven",
        error_code: SS_ORDER_IDENTITY_UNPROVEN,
        wms_shipment_id: shipmentId,
        wms_order_id: Number(row.order_id),
        engine_ref: positiveId(evidence.orderId),
        reason: proof.reason,
      });
      throw new ShipStationPushError(
        `ShipStation order with key ${orderKey} could not be proven to belong to shipment ${shipmentId}: ${proof.reason}`,
        { code: SS_ORDER_IDENTITY_UNPROVEN, shipmentId, field: "provider_order_identity", value: proof.reason },
      );
    }

    const link = await linkShipStationOrderIdentityOnOutboundShipmentInWms(db, {
      shipmentId,
      providerOrderId: proof.providerOrderId,
      orderKey,
      now: now(),
    });
    if (!link.linked) {
      throw new ShipStationPushError(
        `shipment ${shipmentId} is already linked to ShipStation order ${link.existingProviderOrderId}, not ${proof.providerOrderId}`,
        { code: SS_ORDER_LINK_CONFLICT, shipmentId, field: "shipstation_order_id", value: link.existingProviderOrderId },
      );
    }

    platformLogger.warn("shipstation.shipment_order_resolution", {
      action: "resolve_by_order_key",
      outcome: "linked_missing_provider_id",
      wms_shipment_id: shipmentId,
      wms_order_id: Number(row.order_id),
      engine_ref: proof.providerOrderId,
      before: { shipstation_order_id: null, status: String(row.status) },
      after: { shipstation_order_id: proof.providerOrderId, status: link.status },
    });
    return { state: "linked", shipstationOrderId: proof.providerOrderId, orderKey, source: "looked_up" };
  }

  return { resolveOrderForShipment };
}
