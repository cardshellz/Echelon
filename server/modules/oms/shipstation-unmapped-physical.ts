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
  voidDate?: string | null;
  isReturnLabel?: boolean | null;
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

export function buildShipStationUnmappedPhysicalSummary(
  evidence: ShipStationUnmappedPhysicalEvidence,
): string {
  const orderNumber = nullableExternalRef(evidence.orderNumber);
  const trackingNumber = nullableExternalRef(evidence.trackingNumber);
  return (
    `ShipStation reported another package${orderNumber ? ` for order ${orderNumber}` : ""}` +
    `${trackingNumber ? ` with tracking ${trackingNumber}` : ""}. ` +
    "Echelon did not change fulfillment or inventory because it could not " +
    "determine whether the package was an intentional replacement or a duplicate."
  );
}

export async function recordShipStationUnmappedPhysicalException(
  db: QueryExecutor,
  input: RecordShipStationUnmappedPhysicalInput,
): Promise<void> {
  if (input.shipment.isReturnLabel === true) {
    return;
  }
  const shipmentRef = positiveReference(input.shipment.shipmentId);
  const orderRef = nullableExternalRef(input.shipment.orderId);
  const idempotencyKey = buildShipStationUnmappedPhysicalIdempotencyKey(
    input.shipment,
  );
  const summary = buildShipStationUnmappedPhysicalSummary(input.shipment);
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
    voidDate: input.shipment.voidDate ?? null,
    isReturnLabel: false,
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
      summary = EXCLUDED.summary,
      details = wms.reconciliation_exceptions.details || EXCLUDED.details
  `);
}

export async function resolveShipStationUnmappedPhysicalExceptionForVoidedLabel(
  db: QueryExecutor,
  input: {
    shipment: ShipStationUnmappedPhysicalEvidence;
    resolvedBy: string;
    notes?: string | null;
  },
): Promise<boolean> {
  const shipmentRef = positiveReference(input.shipment.shipmentId);
  const voidDateText = nullableExternalRef(input.shipment.voidDate);
  const resolvedBy = nullableExternalRef(input.resolvedBy);
  if (!shipmentRef || !voidDateText || !resolvedBy || resolvedBy.length > 120) {
    return false;
  }
  const voidDate = new Date(voidDateText);
  if (Number.isNaN(voidDate.getTime())) return false;

  const resolution =
    "ShipStation confirmed that the additional provider label was voided. " +
    "No WMS shipment, inventory, customer fulfillment, or channel fulfillment state changed.";
  const details = JSON.stringify({
    remediationAction: "resolve_voided_label",
    remediationNotes: nullableExternalRef(input.notes),
    providerShipmentId: Number(shipmentRef),
    providerOrderId: input.shipment.orderId ?? null,
    providerOrderKey: input.shipment.orderKey ?? null,
    providerTrackingNumber: input.shipment.trackingNumber ?? null,
    providerVoidDate: voidDate.toISOString(),
    fulfillmentMutationBlocked: true,
    inventoryMutationBlocked: true,
    channelWritebackBlocked: true,
  });
  const result: any = await db.execute(sql`
    UPDATE wms.reconciliation_exceptions
    SET classification = 'provider_voided_label',
        status = 'resolved',
        severity = 'info',
        details = details || ${details}::jsonb,
        resolved_at = NOW(),
        resolved_by = ${resolvedBy},
        resolution = ${resolution},
        updated_at = NOW()
    WHERE rule = ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}
      AND idempotency_key = ${buildShipStationUnmappedPhysicalIdempotencyKey(input.shipment)}
      AND status IN ('open', 'acknowledged')
    RETURNING id
  `);
  return Array.isArray(result?.rows) && result.rows.length > 0;
}

export async function resolveShipStationUnmappedPhysicalExceptionForReturnLabel(
  db: QueryExecutor,
  input: {
    shipment: ShipStationUnmappedPhysicalEvidence;
    resolvedBy: string;
    notes?: string | null;
  },
): Promise<boolean> {
  const shipmentRef = positiveReference(input.shipment.shipmentId);
  const resolvedBy = nullableExternalRef(input.resolvedBy);
  if (
    !shipmentRef
    || input.shipment.isReturnLabel !== true
    || !resolvedBy
    || resolvedBy.length > 120
  ) {
    return false;
  }

  const resolution =
    "ShipStation confirmed that this provider label is return transport. " +
    "No outbound WMS shipment, inventory, customer fulfillment, or channel fulfillment state changed.";
  const details = JSON.stringify({
    remediationAction: "resolve_return_label",
    remediationNotes: nullableExternalRef(input.notes),
    providerShipmentId: Number(shipmentRef),
    providerOrderId: input.shipment.orderId ?? null,
    providerOrderKey: input.shipment.orderKey ?? null,
    providerTrackingNumber: input.shipment.trackingNumber ?? null,
    isReturnLabel: true,
    fulfillmentMutationBlocked: true,
    inventoryMutationBlocked: true,
    channelWritebackBlocked: true,
  });
  const result: any = await db.execute(sql`
    UPDATE wms.reconciliation_exceptions
    SET classification = 'provider_return_label',
        status = 'resolved',
        severity = 'info',
        details = details || ${details}::jsonb,
        resolved_at = NOW(),
        resolved_by = ${resolvedBy},
        resolution = ${resolution},
        updated_at = NOW()
    WHERE rule = ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}
      AND idempotency_key = ${buildShipStationUnmappedPhysicalIdempotencyKey(input.shipment)}
      AND status IN ('open', 'acknowledged')
    RETURNING id
  `);
  return Array.isArray(result?.rows) && result.rows.length > 0;
}

export async function resolveShipStationUnmappedPhysicalExceptionForProviderEcho(
  db: QueryExecutor,
  input: {
    shipment: ShipStationUnmappedPhysicalEvidence;
    wmsOrderId: number;
    physicalShipmentId: number;
    resolvedBy: string;
    candidateShipmentId?: number | null;
    retiredCandidateShipmentId?: number | null;
    notes?: string | null;
  },
): Promise<boolean> {
  const shipmentRef = positiveReference(input.shipment.shipmentId);
  const resolvedBy = nullableExternalRef(input.resolvedBy);
  const wmsOrderId = Number(input.wmsOrderId);
  const physicalShipmentId = Number(input.physicalShipmentId);
  const candidateShipmentRef = input.candidateShipmentId == null
    ? null
    : positiveReference(input.candidateShipmentId);
  const retiredCandidateShipmentRef = input.retiredCandidateShipmentId == null
    ? null
    : positiveReference(input.retiredCandidateShipmentId);
  if (
    !shipmentRef
    || !resolvedBy
    || resolvedBy.length > 120
    || !Number.isSafeInteger(wmsOrderId)
    || wmsOrderId <= 0
    || !Number.isSafeInteger(physicalShipmentId)
    || physicalShipmentId <= 0
    || (input.candidateShipmentId != null && !candidateShipmentRef)
    || (
      input.retiredCandidateShipmentId != null
      && !retiredCandidateShipmentRef
    )
  ) {
    return false;
  }

  const resolution =
    "The ShipStation label and an existing canonical package have the same " +
    "tracking identity and exact WMS line quantities. They are two provider " +
    "records for one physical package; no inventory or fulfillment was repeated.";
  const details = JSON.stringify({
    remediationAction: "link_provider_package_echo",
    remediationNotes: nullableExternalRef(input.notes),
    providerShipmentId: Number(shipmentRef),
    providerOrderId: input.shipment.orderId ?? null,
    providerOrderKey: input.shipment.orderKey ?? null,
    providerTrackingNumber: input.shipment.trackingNumber ?? null,
    physicalShipmentId,
    candidateShipmentId: candidateShipmentRef
      ? Number(candidateShipmentRef)
      : null,
    retiredCandidateShipmentId: retiredCandidateShipmentRef
      ? Number(retiredCandidateShipmentRef)
      : null,
    fulfillmentMutationBlocked: true,
    inventoryMutationBlocked: true,
    channelWritebackBlocked: true,
  });
  const result: any = await db.execute(sql`
    UPDATE wms.reconciliation_exceptions
    SET classification = 'provider_package_echo',
        status = 'resolved',
        severity = 'info',
        details = details || ${details}::jsonb,
        resolved_at = NOW(),
        resolved_by = ${resolvedBy},
        resolution = ${resolution},
        updated_at = NOW()
    WHERE rule = ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}
      AND wms_order_id = ${wmsOrderId}
      AND external_shipment_ref = ${shipmentRef}
      AND status IN ('open', 'acknowledged')
    RETURNING id
  `);
  return Array.isArray(result?.rows) && result.rows.length > 0;
}
