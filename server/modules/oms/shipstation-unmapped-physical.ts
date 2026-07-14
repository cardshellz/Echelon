import { sql } from "drizzle-orm";

export const SHIPSTATION_UNMAPPED_PHYSICAL_RULE =
  "shipstation_unmapped_physical_shipment";
export const SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON =
  "shipstation_split_items_unmapped";

interface QueryExecutor {
  execute: (query: unknown) => Promise<unknown>;
}

export interface ShipStationUnmappedPhysicalEvidence {
  shipmentId?: number | null;
  orderId?: number | null;
  orderKey?: string | null;
  orderNumber?: string | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  shipDate?: string | null;
  shipmentItems?: Array<{
    orderItemId?: number | null;
    lineItemKey?: string | null;
    sku?: string | null;
    quantity?: number | null;
  }>;
}

export interface RecordShipStationUnmappedPhysicalInput {
  shipment: ShipStationUnmappedPhysicalEvidence;
  wmsOrderId: number;
  wmsShipmentId: number;
  blockedReason: string;
  currentPhysicalShipmentRef?: string | null;
  currentTrackingNumber?: string | null;
}

function nullableExternalRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function positiveReference(value: unknown): string | null {
  const normalized = nullableExternalRef(value);
  if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? normalized : null;
}

export function buildShipStationUnmappedPhysicalIdempotencyKey(
  evidence: ShipStationUnmappedPhysicalEvidence,
): string {
  const shipmentRef = positiveReference(evidence.shipmentId);
  const parts = shipmentRef
    ? ["shipstation_notify", SHIPSTATION_UNMAPPED_PHYSICAL_RULE, "shipment", shipmentRef]
    : [
        "shipstation_notify",
        SHIPSTATION_UNMAPPED_PHYSICAL_RULE,
        nullableExternalRef(evidence.orderId) ?? "no-order-id",
        nullableExternalRef(evidence.orderKey) ?? "no-order-key",
        nullableExternalRef(evidence.trackingNumber) ?? "no-tracking",
      ];
  return parts.join(":").slice(0, 500);
}

export function shipStationShipmentRefFromExternalFulfillmentId(
  value: unknown,
): string | null {
  const normalized = nullableExternalRef(value);
  if (!normalized) return null;
  const match = /^shipstation_shipment:([1-9][0-9]*)$/.exec(normalized);
  return match ? match[1] : null;
}

export async function recordShipStationUnmappedPhysicalException(
  db: QueryExecutor,
  input: RecordShipStationUnmappedPhysicalInput,
): Promise<void> {
  const shipmentRef = positiveReference(input.shipment.shipmentId);
  const orderRef = nullableExternalRef(input.shipment.orderId);
  const idempotencyKey = buildShipStationUnmappedPhysicalIdempotencyKey(
    input.shipment,
  );
  const summary =
    `ShipStation shipment ${shipmentRef ?? "unknown"} could not be authorized ` +
    `against remaining WMS lines; fulfillment mutation was blocked.`;
  const details = {
    blockedReason: input.blockedReason,
    fulfillmentMutationBlocked: true,
    inventoryMutationBlocked: true,
    channelWritebackBlocked: true,
    wmsOrderId: input.wmsOrderId,
    wmsShipmentId: input.wmsShipmentId,
    currentPhysicalShipmentRef: input.currentPhysicalShipmentRef ?? null,
    currentTrackingNumber: input.currentTrackingNumber ?? null,
    ssShipmentId: input.shipment.shipmentId ?? null,
    ssOrderId: input.shipment.orderId ?? null,
    ssOrderKey: input.shipment.orderKey ?? null,
    orderNumber: input.shipment.orderNumber ?? null,
    trackingNumber: input.shipment.trackingNumber ?? null,
    carrierCode: input.shipment.carrierCode ?? null,
    serviceCode: input.shipment.serviceCode ?? null,
    shipDate: input.shipment.shipDate ?? null,
    shipmentItems: Array.isArray(input.shipment.shipmentItems)
      ? input.shipment.shipmentItems.map((item) => ({
          orderItemId: item.orderItemId ?? null,
          lineItemKey: item.lineItemKey ?? null,
          sku: item.sku ?? null,
          quantity: item.quantity ?? null,
        }))
      : [],
  };

  await db.execute(sql`
    INSERT INTO wms.reconciliation_exceptions (
      source,
      classification,
      rule,
      status,
      severity,
      wms_order_id,
      wms_shipment_id,
      external_system,
      external_order_ref,
      external_shipment_ref,
      external_order_key,
      idempotency_key,
      summary,
      details
    )
    SELECT
      'shipstation_notify',
      'manual_review',
      ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE},
      'open',
      'review',
      ${input.wmsOrderId},
      ${input.wmsShipmentId},
      'shipstation',
      ${orderRef},
      ${shipmentRef},
      ${nullableExternalRef(input.shipment.orderKey)},
      ${idempotencyKey},
      ${summary},
      ${JSON.stringify(details)}::jsonb
    WHERE NOT EXISTS (
      SELECT 1
      FROM wms.reconciliation_exceptions existing
      WHERE existing.idempotency_key = ${idempotencyKey}
        AND existing.status IN ('resolved', 'ignored')
    )
    ON CONFLICT (idempotency_key)
      WHERE status IN ('open', 'acknowledged')
    DO UPDATE SET
      last_seen_at = NOW(),
      updated_at = NOW(),
      occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
      wms_order_id = COALESCE(wms.reconciliation_exceptions.wms_order_id, EXCLUDED.wms_order_id),
      wms_shipment_id = COALESCE(wms.reconciliation_exceptions.wms_shipment_id, EXCLUDED.wms_shipment_id),
      details = wms.reconciliation_exceptions.details || EXCLUDED.details
  `);
}
