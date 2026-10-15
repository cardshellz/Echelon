import type {
  OrderEditOperation,
  OrderEditOrder,
  OrderEditQuoteInput,
} from "@shared/order-edits/order-edit.contract";
import type { OrderEditPreview } from "@shared/order-edits/order-edit-preview";
import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";
import { canonicalJson } from "@shared/utils/canonical-json";
import { orderEditCanCommit } from "./order-edits";

export function orderEditMatchesInput(
  operation: OrderEditOperation,
  input: Omit<OrderEditQuoteInput, "requestKey">,
): boolean {
  return (
    operation.expectedRevision === input.expectedRevision &&
    operation.requestedPlan !== undefined &&
    canonicalJson({
      ...operation.requestedPlan,
      discountCodes: operation.requestedPlan.discountCodes ?? [],
    }) ===
      canonicalJson({
        changes: input.changes,
        additions: input.additions,
        discountCodes: input.discountCodes ?? [],
      })
  );
}

function displayedFinancials(
  financials: OrderEditFinancials,
  lines: OrderEditOperation["lines"],
) {
  const grouped = new Map<
    string,
    { quantity: bigint; gross: bigint; net: bigint; product: bigint }
  >();
  for (const line of lines.filter((item) => item.quantity > 0)) {
    const amounts = financials.lines.find((item) => item.id === line.id);
    // Without catalog identity, two distinct lines must never be treated as the same item.
    if (!line.variantId || !amounts) return null;
    const group = grouped.get(line.variantId) ?? {
      quantity: BigInt(0),
      gross: BigInt(0),
      net: BigInt(0),
      product: BigInt(0),
    };
    grouped.set(line.variantId, {
      quantity: group.quantity + BigInt(line.quantity),
      gross: group.gross + BigInt(amounts.grossCents),
      net: group.net + BigInt(amounts.netCents),
      product:
        group.product + BigInt(amounts.productNetCents ?? amounts.netCents),
    });
  }
  const {
    lines: _lines,
    itemDiscounts,
    orderDiscounts,
    ...totals
  } = financials;
  const discounts = (values: OrderEditFinancials["itemDiscounts"]) =>
    (values ?? [])
      .map(({ key: _key, ...value }) => canonicalJson(value))
      .sort();
  return canonicalJson({
    ...totals,
    itemDiscountLabels: [...totals.itemDiscountLabels].sort(),
    shippingDiscountLabels: [...totals.shippingDiscountLabels].sort(),
    taxLines: (totals.taxLines ?? [])
      .map((value) => canonicalJson(value))
      .sort(),
    itemDiscounts: discounts(itemDiscounts),
    orderDiscounts: discounts(orderDiscounts),
    lines: [...grouped]
      .map(([variantId, value]) => [
        variantId,
        ...Object.values(value).map((amount) => amount.toString()),
      ])
      .sort(),
  });
}

/** A click approves only the displayed cart and money. A different verified quote requires a new click. */
export function canConfirmOrderEditPreview(
  order: OrderEditOrder,
  preview: OrderEditPreview,
  operation: OrderEditOperation,
  now: number,
): boolean {
  if (
    !orderEditCanCommit(operation, now) ||
    operation.quoteAvailable !== true ||
    !operation.shippingRepricing ||
    operation.shippingRepricing.title !== preview.shippingRepricing.title ||
    operation.shippingRepricing.code !== preview.shippingRepricing.code ||
    preview.input.connectionId !== order.connectionId ||
    preview.input.omsOrderId !== order.omsOrderId ||
    preview.input.expectedRevision !== order.revision ||
    !operation.financials?.quoted ||
    !order.settlement ||
    operation.orderNumber !== order.orderNumber ||
    operation.currency !== order.currency ||
    !orderEditMatchesInput(operation, preview.input) ||
    operation.settlement?.netPaidCents !== order.settlement.netPaidCents ||
    operation.previousTotalCents !== order.totalCents ||
    operation.updatedTotalCents !== preview.financials.totalCents ||
    operation.balanceDueCents !==
      Math.max(
        0,
        preview.financials.totalCents - order.settlement.netPaidCents,
      ) ||
    operation.refundDueCents !==
      Math.max(0, order.settlement.netPaidCents - preview.financials.totalCents)
  )
    return false;
  const approved = displayedFinancials(preview.financials, preview.lines);
  return (
    approved !== null &&
    approved ===
      displayedFinancials(operation.financials.quoted, operation.lines)
  );
}
