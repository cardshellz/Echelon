/**
 * Reservation errors raised by a bad order line (identity, mapping or policy
 * data). They fail identically on every retry, so they are permanent: holding
 * the whole order off ShipStation while retrying them stranded paid orders
 * (2026-09-17: 27 orders; 2026-10-02: an order with an unmapped graded card).
 * Infrastructure and authority errors are not in this set; they still abort and
 * retry because they leave claim state unknown.
 */
const PERMANENT_ORDER_RESERVATION_DATA_ERRORS: ReadonlySet<string> = new Set([
  "ORDER_ITEM_VARIANT_MISSING",
  "ORDER_ITEM_VARIANT_IDENTITY_CONFLICT",
  "ORDER_ITEM_INVENTORY_POLICY_CONFLICT",
  "ORDER_ITEM_NOT_CLAIMABLE",
  "ORDER_REFUND_CUSTODY_REVIEW_REQUIRED",
  "INVALID_ORDER_ITEM_FULFILLMENT_IDENTITY",
]);

/** The structured code of the error or of a cause it wraps (bounded depth). */
export function reservationErrorCode(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isPermanentOrderReservationDataError(error: unknown): boolean {
  const code = reservationErrorCode(error);
  return code !== null && PERMANENT_ORDER_RESERVATION_DATA_ERRORS.has(code);
}
