import type { OmsLineAuthorizationStatus } from "./oms-line-authority";

export type ShopifyRefundRestockPolicy =
  | "no_restock"
  | "return"
  | "restock"
  | "cancel"
  | "unknown";

export interface ShopifyRefundLineAdjustment {
  externalLineItemId: string;
  quantity: number;
  restockPolicy: ShopifyRefundRestockPolicy;
  raw: Record<string, unknown>;
}

export class RefundsCreateBadPayloadError extends Error {
  readonly code = "REFUNDS_CREATE_BAD_PAYLOAD";

  constructor(message: string) {
    super(message);
    this.name = "RefundsCreateBadPayloadError";
  }
}

function requirePositiveInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new RefundsCreateBadPayloadError(`${field} must be a positive integer`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative integer (got ${String(value)})`);
  }
  return normalized;
}

export function normalizeRefundRestockPolicy(line: Record<string, unknown>): ShopifyRefundRestockPolicy {
  const restockType = typeof line.restock_type === "string"
    ? line.restock_type.trim().toLowerCase()
    : null;

  if (restockType === "return") return "return";
  if (restockType === "restock") return "restock";
  if (restockType === "cancel") return "cancel";
  if (restockType === "no_restock") return "no_restock";
  if (line.restock === true) return "restock";
  if (line.restock === false) return "no_restock";
  return "unknown";
}

/**
 * Parse Shopify's line-level refund facts without silently dropping malformed
 * rows. A money-only refund legitimately has no refund_line_items; a malformed
 * line-level refund must fail so it cannot leave warehouse authority unchanged.
 */
export function extractRefundLineAdjustments(refundLineItems: unknown): ShopifyRefundLineAdjustment[] {
  if (refundLineItems === null || refundLineItems === undefined) return [];
  if (!Array.isArray(refundLineItems)) {
    throw new RefundsCreateBadPayloadError("refund_line_items must be an array");
  }

  const seen = new Set<string>();
  return refundLineItems.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RefundsCreateBadPayloadError(`refund_line_items[${index}] must be an object`);
    }

    const line = candidate as Record<string, unknown>;
    const nestedLine = line.line_item && typeof line.line_item === "object"
      ? line.line_item as Record<string, unknown>
      : null;
    const rawExternalId = line.line_item_id ?? nestedLine?.id;
    if (rawExternalId === null || rawExternalId === undefined || String(rawExternalId).trim() === "") {
      throw new RefundsCreateBadPayloadError(
        `refund_line_items[${index}] is missing line_item_id`,
      );
    }

    const externalLineItemId = String(rawExternalId);
    if (seen.has(externalLineItemId)) {
      throw new RefundsCreateBadPayloadError(
        `refund_line_items contains duplicate line_item_id ${externalLineItemId}`,
      );
    }
    seen.add(externalLineItemId);

    return {
      externalLineItemId,
      quantity: requirePositiveInteger(line.quantity, `refund_line_items[${index}].quantity`),
      restockPolicy: normalizeRefundRestockPolicy(line),
      raw: line,
    };
  });
}

export interface RefundAuthorityInput {
  paidQuantity: number;
  previousAuthorityFulfillableQuantity: number;
  cancelledQuantity: number;
  /** Refund quantities carrying Shopify restock_type=cancel overlap cancellation authority. */
  refundCancelQuantity: number;
  /** Refund quantities with every other policy are additional non-fulfillable units. */
  refundOtherQuantity: number;
}

export interface RefundAuthorityState {
  authorityFulfillableQuantity: number;
  refundedQuantity: number;
  authorizationStatus: OmsLineAuthorizationStatus;
  overDispositionQuantity: number;
}

/**
 * Derive the latest commercial authority from cumulative line dispositions.
 * Shopify's `cancel` restock policy describes refunded units that were also
 * cancelled, so those quantities overlap rather than being subtracted twice.
 */
export function deriveRefundAuthority(input: RefundAuthorityInput): RefundAuthorityState {
  const paidQuantity = requireNonNegativeInteger(input.paidQuantity, "paidQuantity");
  const previousAuthority = requireNonNegativeInteger(
    input.previousAuthorityFulfillableQuantity,
    "previousAuthorityFulfillableQuantity",
  );
  const cancelledQuantity = requireNonNegativeInteger(input.cancelledQuantity, "cancelledQuantity");
  const refundCancelQuantity = requireNonNegativeInteger(
    input.refundCancelQuantity,
    "refundCancelQuantity",
  );
  const refundOtherQuantity = requireNonNegativeInteger(
    input.refundOtherQuantity,
    "refundOtherQuantity",
  );

  const refundedQuantity = refundCancelQuantity + refundOtherQuantity;
  const rawDispositionQuantity = Math.max(cancelledQuantity, refundCancelQuantity) + refundOtherQuantity;
  const overDispositionQuantity = Math.max(rawDispositionQuantity - paidQuantity, 0);
  const quantityAfterDisposition = Math.max(paidQuantity - rawDispositionQuantity, 0);
  const authorityFulfillableQuantity = Math.min(previousAuthority, quantityAfterDisposition);

  let authorizationStatus: OmsLineAuthorizationStatus;
  if (overDispositionQuantity > 0) {
    authorizationStatus = "review";
  } else if (refundedQuantity > 0) {
    authorizationStatus = authorityFulfillableQuantity === 0 ? "refunded" : "partially_refunded";
  } else if (cancelledQuantity > 0) {
    authorizationStatus = authorityFulfillableQuantity === 0 ? "cancelled" : "partially_cancelled";
  } else {
    authorizationStatus = paidQuantity > 0 ? "authorized" : "seen";
  }

  return {
    authorityFulfillableQuantity,
    refundedQuantity,
    authorizationStatus,
    overDispositionQuantity,
  };
}

export interface ActiveShipmentItemAllocationInput {
  shipmentItemId: number;
  shipmentId: number;
  orderItemId: number;
  currentQuantity: number;
  remainingDemand: number;
}

export interface ActiveShipmentItemAllocation extends ActiveShipmentItemAllocationInput {
  nextQuantity: number;
  changed: boolean;
}

/**
 * Allocate each WMS line's remaining demand across active shipment rows once
 * in stable shipment/item order. This prevents a partial refund from applying
 * the full remaining quantity independently to every split shipment.
 */
export function allocateActiveShipmentItems(
  input: ActiveShipmentItemAllocationInput[],
): ActiveShipmentItemAllocation[] {
  const remainingByOrderItem = new Map<number, number>();
  const sorted = [...input].sort(
    (left, right) =>
      left.orderItemId - right.orderItemId ||
      left.shipmentId - right.shipmentId ||
      left.shipmentItemId - right.shipmentItemId,
  );

  return sorted.map((row) => {
    const currentQuantity = requireNonNegativeInteger(row.currentQuantity, "currentQuantity");
    const demand = requireNonNegativeInteger(row.remainingDemand, "remainingDemand");
    const remaining = remainingByOrderItem.has(row.orderItemId)
      ? remainingByOrderItem.get(row.orderItemId)!
      : demand;
    const nextQuantity = Math.min(currentQuantity, remaining);
    remainingByOrderItem.set(row.orderItemId, Math.max(remaining - nextQuantity, 0));

    return {
      ...row,
      currentQuantity,
      remainingDemand: demand,
      nextQuantity,
      changed: nextQuantity !== currentQuantity,
    };
  });
}
