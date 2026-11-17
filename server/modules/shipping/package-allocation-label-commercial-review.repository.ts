import { upsertLabelCommercialReconciliationExceptionInOms } from "../oms/reconciliation-exceptions.api";

export const PACKAGE_ALLOCATION_LABEL_COMMERCIAL_REVIEW_RULE =
  "package_allocation_label_commercial_fulfillment_review";

export interface PackageAllocationLabelCommercialReviewInput {
  readonly operation?: "label_void";
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
        ...(rawInput.operation ? [rawInput.operation] : []),
      ].join(":").slice(0, 500);
      const summary = rawInput.operation === "label_void"
        ? `Voided ShipStation shipment ${providerShipmentId} could not be safely removed from Shopify fulfillment (${reasonCode}).`
        : (
        `ShipStation shipment ${providerShipmentId} could not be safely marked shipped `
        + `on its sales channel (${reasonCode}).`
      );
      const details = {
        ...(rawInput.details ?? {}),
        ...(rawInput.operation ? { operation: rawInput.operation } : {}),
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

      await upsertLabelCommercialReconciliationExceptionInOms(db, {
        rule: PACKAGE_ALLOCATION_LABEL_COMMERCIAL_REVIEW_RULE,
        externalOrderRef: boundedText(rawInput.providerOrderId, 200),
        externalShipmentRef: providerShipmentId,
        externalOrderKey: boundedText(rawInput.providerOrderKey, 200),
        idempotencyKey,
        summary,
        detailsJson: JSON.stringify(details),
      });
    },
  };
}
