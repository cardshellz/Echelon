import { sql } from "drizzle-orm";

export const EBAY_TRACKING_CONFLICT_CODE = "ebay_tracking_conflict";
export const EBAY_TRACKING_CONFLICT_RULE =
  "ebay_tracking_changed_after_fulfillment";

interface QueryExecutor {
  execute: (query: unknown) => Promise<unknown>;
}

export interface EbayTrackingConflictInput {
  omsOrderId: number;
  wmsOrderId: number;
  wmsShipmentId: number;
  externalOrderId: string;
  priorEventId: number;
  priorFulfillmentId: string | null;
  priorTrackingNumber: string;
  currentTrackingNumber: string;
}

export class EbayTrackingConflictError extends Error {
  public readonly context: {
    code: typeof EBAY_TRACKING_CONFLICT_CODE;
    omsOrderId: number;
    wmsOrderId: number;
    shipmentId: number;
    externalOrderId: string;
    priorEventId: number;
    priorFulfillmentId: string | null;
    priorTrackingNumber: string;
    currentTrackingNumber: string;
  };

  constructor(input: EbayTrackingConflictInput) {
    super(
      `eBay tracking conflict for shipment ${input.wmsShipmentId}: ` +
        `fulfillment ${input.priorFulfillmentId ?? "unknown"} already used tracking ` +
        `${input.priorTrackingNumber}; current shipment tracking is ${input.currentTrackingNumber}`,
    );
    this.name = "EbayTrackingConflictError";
    this.context = {
      code: EBAY_TRACKING_CONFLICT_CODE,
      omsOrderId: input.omsOrderId,
      wmsOrderId: input.wmsOrderId,
      shipmentId: input.wmsShipmentId,
      externalOrderId: input.externalOrderId,
      priorEventId: input.priorEventId,
      priorFulfillmentId: input.priorFulfillmentId,
      priorTrackingNumber: input.priorTrackingNumber,
      currentTrackingNumber: input.currentTrackingNumber,
    };
  }
}

export function isEbayTrackingConflictError(
  error: unknown,
): error is EbayTrackingConflictError {
  return (
    error instanceof EbayTrackingConflictError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { context?: { code?: unknown } }).context?.code ===
        EBAY_TRACKING_CONFLICT_CODE)
  );
}

function cleanExternalRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function buildEbayTrackingConflictIdempotencyKey(
  input: EbayTrackingConflictInput,
): string {
  return [
    "channel_writeback",
    EBAY_TRACKING_CONFLICT_RULE,
    `shipment:${input.wmsShipmentId}`,
    `prior:${input.priorTrackingNumber}`,
    `current:${input.currentTrackingNumber}`,
  ]
    .join(":")
    .slice(0, 500);
}

export async function recordEbayTrackingConflict(
  db: QueryExecutor,
  input: EbayTrackingConflictInput,
): Promise<void> {
  const idempotencyKey = buildEbayTrackingConflictIdempotencyKey(input);
  const summary =
    `eBay order ${input.externalOrderId} already has tracking ` +
    `${input.priorTrackingNumber} for WMS shipment ${input.wmsShipmentId}, but ` +
    `Echelon now has ${input.currentTrackingNumber}. Classify the later package ` +
    "as a replacement or duplicate before changing channel fulfillment.";
  const details = {
    fulfillmentMutationBlocked: true,
    inventoryMutationBlocked: true,
    channelWritebackBlocked: true,
    omsOrderId: input.omsOrderId,
    wmsOrderId: input.wmsOrderId,
    wmsShipmentId: input.wmsShipmentId,
    externalOrderId: input.externalOrderId,
    priorEventId: input.priorEventId,
    priorFulfillmentId: input.priorFulfillmentId,
    priorTrackingNumber: input.priorTrackingNumber,
    currentTrackingNumber: input.currentTrackingNumber,
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
      idempotency_key,
      summary,
      details
    )
    SELECT
      'channel_writeback',
      'manual_review',
      ${EBAY_TRACKING_CONFLICT_RULE},
      'open',
      'review',
      ${input.wmsOrderId},
      ${input.wmsShipmentId},
      'ebay',
      ${cleanExternalRef(input.externalOrderId)},
      ${cleanExternalRef(input.priorFulfillmentId)},
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
      summary = EXCLUDED.summary,
      details = wms.reconciliation_exceptions.details || EXCLUDED.details
  `);
}
