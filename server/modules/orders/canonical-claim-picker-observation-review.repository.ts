import type {
  CanonicalClaimPickerObservationReviewPort,
} from "../inventory-planning/application/canonical-claim-picker-observation-review.port";

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new CanonicalClaimPickerObservationReviewError(
      "INVALID_PICKER_OBSERVATION_REVIEW_IDENTITY",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return value;
}

function nonblank(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum) {
    throw new CanonicalClaimPickerObservationReviewError(
      "INVALID_PICKER_OBSERVATION_REVIEW_EVIDENCE",
      `${field} must contain between 1 and ${maximum} characters.`,
      { field },
    );
  }
  return normalized;
}

export class CanonicalClaimPickerObservationReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CanonicalClaimPickerObservationReviewError";
  }
}

export class PostgresCanonicalClaimPickerObservationReviewRepository
  implements CanonicalClaimPickerObservationReviewPort {
  async recordReview(
    input: Parameters<CanonicalClaimPickerObservationReviewPort["recordReview"]>[0],
  ): Promise<number> {
    const orderId = positiveInteger(input.orderId, "order.id");
    const orderItemId = positiveInteger(input.orderItemId, "orderItem.id");
    const targetVariantId = positiveInteger(input.targetVariantId, "productVariant.id");
    const requestedQty = positiveInteger(input.requestedQty, "review.requestedQty");
    const selectedLocationId = positiveInteger(input.selectedLocationId, "warehouseLocation.id");
    const reviewReason = nonblank(input.reviewReason, "review.reason", 10_000);
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
      throw new CanonicalClaimPickerObservationReviewError(
        "INVALID_PICKER_OBSERVATION_REVIEW_TIME",
        "Picker-observation review time must be a valid Date.",
      );
    }
    let metadataJson: string;
    try {
      metadataJson = JSON.stringify(input.metadata);
    } catch (cause) {
      throw new CanonicalClaimPickerObservationReviewError(
        "INVALID_PICKER_OBSERVATION_REVIEW_METADATA",
        "Picker-observation review metadata must be JSON serializable.",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    const result = await input.client.query(
      `INSERT INTO wms.allocation_exceptions (
         order_id, order_item_id, order_number, sku, product_variant_id,
         exception_type, status, requested_qty, selected_location_id,
         selected_location_code, resolution, auto_fixed_setup, review_reason, metadata,
         created_at, updated_at
       )
       SELECT item.order_id, item.id, order_row.order_number, item.sku, $1,
              'inventory_auto_resolved', 'needs_review', $2, $3,
              location.code, $4, false, $5, $6::jsonb, $7, $7
       FROM wms.order_items AS item
       JOIN wms.orders AS order_row ON order_row.id = item.order_id
       JOIN warehouse.warehouse_locations AS location ON location.id = $3
       WHERE item.id = $8 AND item.order_id = $9
       RETURNING id`,
      [
        targetVariantId,
        requestedQty,
        selectedLocationId,
        input.resolution,
        reviewReason,
        metadataJson,
        input.occurredAt,
        orderItemId,
        orderId,
      ],
    );
    const row = Array.isArray(result.rows) ? result.rows[0] : undefined;
    if (!row?.id) {
      throw new CanonicalClaimPickerObservationReviewError(
        "PICKER_OBSERVATION_REVIEW_TARGET_MISSING",
        "The picker-observation review could not resolve its order item and location.",
        { orderId, orderItemId, selectedLocationId },
      );
    }
    return positiveInteger(Number(row.id), "allocationException.id");
  }
}
