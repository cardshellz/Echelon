import {
  salesFinancialsSchema,
  type SalesFinancials,
} from "../../../shared/sales-financials";
import type { ShopifyDiscountEvidence } from "../../../shared/shopify-discount-evidence";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function cents(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,2})?$/.test(value)
  )
    return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return amount <= BigInt(2147483647) ? Number(amount) : null;
}
/** Null money sets explicitly mean no duties/fees. Absent fields, foreign money,
 * removed shipping lines, and unbalanced components cannot establish a snapshot.
 * Uses original_* and total_* fields throughout, never current_* after refunds.
 * Provider semantics: https://shopify.dev/docs/api/admin-rest/latest/resources/order */
export function extractShopifySalesFinancials(
  payload: unknown,
  evidence: ShopifyDiscountEvidence | undefined,
  expectedOrderId: string,
  currency: string,
): SalesFinancials | undefined {
  const envelope = record(payload),
    raw = record(envelope?.order) ?? envelope;
  if (
    !raw ||
    !evidence ||
    evidence.currency !== currency ||
    evidence.grossMerchandiseCents === null ||
    evidence.merchandiseDiscountCents === null ||
    evidence.shippingDiscountCents === null
  )
    return undefined;
  const id =
    typeof raw.id === "string"
      ? raw.id
      : typeof raw.id === "number" && Number.isSafeInteger(raw.id)
        ? String(raw.id)
        : null;
  if (id !== expectedOrderId.replace(/^gid:\/\/shopify\/Order\//, ""))
    return undefined;
  if (
    raw.currency !== currency ||
    typeof raw.taxes_included !== "boolean" ||
    typeof raw.updated_at !== "string" ||
    !Number.isFinite(Date.parse(raw.updated_at))
  )
    return undefined;
  const moneySet = (field: string): number | null => {
    if (!(field in raw)) return null;
    if (raw[field] === null) return 0;
    const money = record(record(raw[field])?.shop_money);
    return money?.currency_code === currency ? cents(money.amount) : null;
  };
  const subtotal = cents(raw.subtotal_price),
    total = cents(raw.total_price),
    tax = cents(raw.total_tax);
  const duties = moneySet("original_total_duties_set"),
    fees = moneySet("original_total_additional_fees_set"),
    tips = cents(raw.total_tip_received);
  if (
    [subtotal, total, tax, duties, fees, tips].some(
      (value) => value === null,
    ) ||
    !Array.isArray(raw.shipping_lines) ||
    raw.shipping_lines.length > 10000
  )
    return undefined;
  let shipping = BigInt(0),
    netShipping = BigInt(0);
  for (const value of raw.shipping_lines) {
    const line = record(value);
    // Removed lines require an adjustment ledger, not an inferred subtraction.
    if (!line || line.is_removed === true) return undefined;
    const price = cents(line.price),
      discounted = cents(line.discounted_price);
    if (price === null || discounted === null) return undefined;
    shipping += BigInt(price);
    netShipping += BigInt(discounted);
  }
  if (shipping > BigInt(2147483647) || netShipping > BigInt(2147483647))
    return undefined;
  const parsed = salesFinancialsSchema.safeParse({
    version: 1,
    basis: "shopify_order_before_refunds",
    sourceOrderId: id,
    sourceUpdatedAt: new Date(raw.updated_at).toISOString(),
    currency,
    grossMerchandiseCents: evidence.grossMerchandiseCents,
    merchandiseDiscountCents: evidence.merchandiseDiscountCents,
    netMerchandiseCents: subtotal,
    grossShippingCents: Number(shipping),
    shippingDiscountCents: evidence.shippingDiscountCents,
    netShippingCents: Number(netShipping),
    taxAddedCents: raw.taxes_included ? 0 : tax,
    taxIncludedCents: raw.taxes_included ? tax : 0,
    dutiesCents: duties,
    feesCents: fees,
    tipsCents: tips,
    orderTotalCents: total,
  });
  return parsed.success ? parsed.data : undefined;
}

/** Export the same provider lines used to establish the financial snapshot.
 * This does not rewrite operational OMS lines or inventory reservations. */
export function extractReconciledShopifyLines(
  payload: unknown,
  financials: SalesFinancials,
) {
  const envelope = record(payload),
    raw = record(envelope?.order) ?? envelope;
  if (!raw || !Array.isArray(raw.line_items))
    throw new Error("ARCHON_FINANCIAL_LINES_INVALID");
  let gross = BigInt(0),
    discount = BigInt(0);
  const lines = raw.line_items.map((value) => {
    const line = record(value),
      price = cents(line?.price),
      quantity = line?.quantity;
    if (
      !line ||
      price === null ||
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !Array.isArray(line.discount_allocations)
    )
      throw new Error("ARCHON_FINANCIAL_LINES_INVALID");
    const allocated = line.discount_allocations.reduce(
      (sum: bigint, value: unknown) => {
        const amount = cents(record(value)?.amount);
        if (amount === null) throw new Error("ARCHON_FINANCIAL_LINES_INVALID");
        return sum + BigInt(amount);
      },
      BigInt(0),
    );
    gross += BigInt(price) * BigInt(quantity);
    discount += allocated;
    const product = line.product_id;
    return {
      sku: typeof line.sku === "string" ? line.sku : null,
      title: typeof line.title === "string" ? line.title : null,
      quantity,
      price_cents: price,
      discount_cents: Number(allocated),
      product_id:
        typeof product === "string"
          ? product
          : typeof product === "number" && Number.isSafeInteger(product)
            ? String(product)
            : null,
      fulfillment_status:
        typeof line.fulfillment_status === "string"
          ? line.fulfillment_status
          : null,
    };
  });
  if (
    gross !== BigInt(financials.grossMerchandiseCents) ||
    discount !== BigInt(financials.merchandiseDiscountCents)
  )
    throw new Error("ARCHON_FINANCIAL_LINES_INVALID");
  return lines;
}
