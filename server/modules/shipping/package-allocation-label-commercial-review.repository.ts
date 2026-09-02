import { sql } from "drizzle-orm";

export const PACKAGE_ALLOCATION_LABEL_COMMERCIAL_REVIEW_RULE =
  "package_allocation_label_commercial_fulfillment_review";

export interface PackageAllocationLabelCommercialReviewInput {
  readonly shippingProviderLabelId: number;
  readonly providerShipmentId: string;
  readonly providerOrderId: string | null;
  readonly providerOrderKey: string | null;
  readonly orderNumber: string | null;
  readonly trackingNumber: string | null;
  readonly reasonCode: string;
  readonly sourceWmsShipmentItemIds: readonly number[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PackageAllocationLabelCommercialReviewRepository {
  record(input: PackageAllocationLabelCommercialReviewInput): Promise<void>;
}

interface QueryExecutor {
  execute(query: unknown): Promise<unknown>;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function normalizedSourceIds(values: readonly number[]): readonly number[] {
  const result = [...new Set(values)].sort((left, right) => left - right);
  for (const value of result) positiveInteger(value, "sourceWmsShipmentItemId");
  return Object.freeze(result);
}

export function createPackageAllocationLabelCommercialReviewRepository(
  db: QueryExecutor,
): PackageAllocationLabelCommercialReviewRepository {
  return {
    async record(rawInput) {
      const shippingProviderLabelId = positiveInteger(
        rawInput.shippingProviderLabelId,
        "shippingProviderLabelId",
      );
      const providerShipmentId = boundedText(rawInput.providerShipmentId, 200);
      const reasonCode = boundedText(rawInput.reasonCode, 120);
      if (!providerShipmentId || !reasonCode) {
        throw new Error("providerShipmentId and reasonCode are required");
      }
      const sourceWmsShipmentItemIds = normalizedSourceIds(
        rawInput.sourceWmsShipmentItemIds,
      );
      const idempotencyKey = [
        "shipstation_label_commercial_fulfillment",
        `label:${shippingProviderLabelId}`,
      ].join(":").slice(0, 500);
      const summary = (
        `ShipStation shipment ${providerShipmentId} could not be safely marked shipped `
        + `on its sales channel (${reasonCode}).`
      );
      const details = {
        ...(rawInput.details ?? {}),
        fulfillmentMutationBlocked: true,
        inventoryMutationBlocked: true,
        channelWritebackBlocked: true,
        shippingProviderLabelId,
        providerShipmentId,
        orderNumber: boundedText(rawInput.orderNumber, 200),
        trackingNumber: boundedText(rawInput.trackingNumber, 200),
        reasonCode,
        sourceWmsShipmentItemIds,
      };

      await db.execute(sql`
        INSERT INTO wms.reconciliation_exceptions (
          source,
          classification,
          rule,
          status,
          severity,
          external_system,
          external_order_ref,
          external_shipment_ref,
          external_order_key,
          idempotency_key,
          summary,
          details
        )
        SELECT
          'shipstation_label_commercial_fulfillment',
          'manual_review',
          ${PACKAGE_ALLOCATION_LABEL_COMMERCIAL_REVIEW_RULE},
          'open',
          'review',
          'shipstation',
          ${boundedText(rawInput.providerOrderId, 200)},
          ${providerShipmentId},
          ${boundedText(rawInput.providerOrderKey, 200)},
          ${idempotencyKey},
          ${summary},
          ${JSON.stringify(details)}::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM wms.reconciliation_exceptions AS existing
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
    },
  };
}
