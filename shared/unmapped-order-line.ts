/**
 * "UNKNOWN" is the WMS sentinel for an order line whose channel SKU did not map
 * to the catalog (for example a one-off graded card listed without a SKU).
 * Echelon tracks no stock for such a line, so it cannot be reserved or deducted.
 *
 * 2026-10-02: one such line made the whole-order claim fail
 * (ORDER_ITEM_VARIANT_MISSING), so the order's other, normal lines could never
 * be reserved or picked ("The order has no active canonical availability claim
 * to pick"). A line is unmapped only when it carries no catalog identity at all;
 * a real SKU that fails to resolve still fails closed, because skipping it could
 * ship tracked stock without deducting it.
 */
export const UNMAPPED_ORDER_LINE_SKU = "UNKNOWN";

export function isUnmappedOrderLine(line: {
  sku: string | null | undefined;
  catalogProductId: number | null | undefined;
  productId: number | null | undefined;
}): boolean {
  if (line.catalogProductId != null || line.productId != null) return false;
  const sku = (line.sku ?? "").trim();
  return sku === "" || sku.toUpperCase() === UNMAPPED_ORDER_LINE_SKU;
}
