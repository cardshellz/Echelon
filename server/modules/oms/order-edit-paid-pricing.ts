import {
  orderEditFinancialsSchema,
  type OrderEditFinancials,
} from "@shared/order-edits/order-edit-financials";
import { OrderEditError } from "../order-edits/domain/order-edit-error";

interface PaidSourceLine {
  id: string;
  variantId: string;
  quantity: number;
  originalUnitPriceCents: number;
  totalCents: number;
}
interface PaidProductPrice {
  id: string;
  variantId: string;
  quantity: number;
  /** Unit retail price; productNetCents and netCents are complete line amounts. */
  retailCents: number;
  productNetCents: number;
  netCents: number;
}
export interface OrderEditPaidPricingInput {
  lines: readonly PaidSourceLine[];
  financials?: OrderEditFinancials;
  productPrices?: readonly PaidProductPrice[];
  originalLineIds: readonly string[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}
export interface OrderEditPaidLinePrice {
  netCents: number;
  unitNetCents: number;
  discountCents: number;
  planDiscountCents: number;
  couponDiscountCents: number;
}
const invalid = (): never => {
  throw new OrderEditError(
    "ORDER_EDIT_PROJECTION_TOTALS_INVALID",
    "The verified current line prices do not add up to the order total.",
  );
};
const exact = (value: number): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) return invalid();
  return BigInt(value);
};
const cents = (value: bigint): number => {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER))
    return invalid();
  return Number(value);
};

/** OMS uses the reconciled financial nets, including native order allocations.
 * Shopify's editable line subtotal can exclude those allocations. Legacy saved
 * edits without financial evidence retain their old path only when it reconciles.
 */
export function buildOrderEditPaidPricing(input: OrderEditPaidPricingInput): {
  grossCents: number;
  discountCents: number;
  lines: ReadonlyMap<string, OrderEditPaidLinePrice>;
} {
  const subtotal = exact(input.subtotalCents);
  const shipping = exact(input.shippingCents);
  const tax = exact(input.taxCents);
  const total = exact(input.totalCents);
  const financialResult =
    input.financials === undefined
      ? null
      : orderEditFinancialsSchema.safeParse(input.financials);
  if (financialResult && !financialResult.success) return invalid();
  const financials = financialResult?.success
    ? financialResult.data
    : undefined;
  const financialLines = new Map(
    financials?.lines.map((line) => [line.id, line]),
  );
  const products = new Map(input.productPrices?.map((line) => [line.id, line]));
  const originals = new Set(input.originalLineIds);
  const lineIds = new Set(input.lines.map((line) => line.id));
  if (
    lineIds.size !== input.lines.length ||
    (input.productPrices && products.size !== input.productPrices.length) ||
    (financials && financialLines.size !== input.lines.length) ||
    [...products.keys()].some((id) => !lineIds.has(id))
  )
    return invalid();
  if (
    financials &&
    (financials.itemsNetCents !== input.subtotalCents ||
      financials.shippingCents !== input.shippingCents ||
      financials.taxCents !== input.taxCents ||
      financials.totalCents !== input.totalCents)
  )
    return invalid();
  if (
    subtotal + shipping + (financials?.taxesIncluded ? BigInt(0) : tax) !==
    total
  )
    return invalid();
  const prices = new Map<string, OrderEditPaidLinePrice>();
  let grossTotal = BigInt(0);
  let netTotal = BigInt(0);
  for (const line of input.lines) {
    if (
      !line.id ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 0 ||
      (line.quantity > 0 && !line.variantId)
    )
      return invalid();
    const quantity = BigInt(line.quantity);
    exact(line.totalCents);
    const gross = exact(line.originalUnitPriceCents) * quantity;
    const evidence = financialLines.get(line.id);
    if (financials && (!evidence || exact(evidence.grossCents) !== gross))
      return invalid();
    const net = exact(evidence?.netCents ?? line.totalCents);
    if (net > gross || (quantity === BigInt(0) && net !== BigInt(0)))
      return invalid();
    const product = products.get(line.id);
    if (input.productPrices && quantity > BigInt(0) && !product)
      return invalid();
    if (
      product &&
      (product.quantity !== line.quantity ||
        product.variantId !== line.variantId ||
        exact(product.retailCents) !== exact(line.originalUnitPriceCents) ||
        exact(product.netCents) !== net ||
        exact(product.productNetCents) < net ||
        exact(product.productNetCents) > gross)
    )
      return invalid();
    const discount = gross - net;
    // Preserve the normalizer's original-line categories. On introduced lines,
    // proved order-code savings belong to coupons, not the member-price bucket.
    const plan = originals.has(line.id)
      ? BigInt(0)
      : gross - exact(product?.productNetCents ?? cents(net));
    const coupon = discount - plan;
    // paid_price_cents is a rounded average for unit-only consumers. The exact
    // line net remains authoritative when a discount creates uneven cents.
    const unit =
      quantity === BigInt(0)
        ? BigInt(0)
        : net / quantity +
          (BigInt(2) * (net % quantity) >= quantity ? BigInt(1) : BigInt(0));
    prices.set(line.id, {
      netCents: cents(net),
      unitNetCents: cents(unit),
      discountCents: cents(discount),
      planDiscountCents: cents(plan),
      couponDiscountCents: cents(coupon),
    });
    grossTotal += gross;
    netTotal += net;
  }
  if (
    netTotal !== subtotal ||
    (financials && grossTotal !== exact(financials.itemsGrossCents))
  )
    return invalid();
  return {
    grossCents: cents(grossTotal),
    discountCents: cents(grossTotal - subtotal),
    lines: prices,
  };
}
