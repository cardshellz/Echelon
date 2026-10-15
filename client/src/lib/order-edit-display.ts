import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";
import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";

export function orderEditTaxDisplay(
  financials: Pick<OrderEditFinancials, "taxLines" | "taxesIncluded">,
): {
  label: string;
  details: string[];
} {
  const lines = financials.taxLines ?? [];
  const singleRate = lines.length === 1 ? lines[0].ratePercentage : null;
  const qualifiers = [
    ...(singleRate === null ? [] : [`${singleRate}%`]),
    ...(financials.taxesIncluded ? ["included"] : []),
  ];
  return {
    label: qualifiers.length ? `Tax (${qualifiers.join(", ")})` : "Tax",
    // Jurisdictions may tax different bases. Never add their rates or derive a rate from dollars.
    details: lines.length > 1
      ? lines.map(line => line.ratePercentage === null
        ? line.title
        : `${line.title} ${line.ratePercentage}%`)
      : [],
  };
}

/** Use the verified price after product/member savings, before order coupons.
 * Older responses retain their exact net total; never infer allocations from a code label. */
export function orderEditItemSubtotal(
  financials: OrderEditFinancials | null | undefined,
  id: string,
  fallbackCents: number,
): number {
  return (
    financials?.lines.find((line) => line.id === id)?.productNetCents ??
    fallbackCents
  );
}

type DisplayLine = OrderEditOperation["lines"][number];

/** Display only an exact net unit amount. Uneven allocations keep their line
 * total rather than inventing a rounded price that cannot reconcile. */
export function exactOrderEditUnitPrice(
  totalCents: number,
  quantity: number,
): number | null {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  )
    return null;
  const total = BigInt(totalCents);
  const count = BigInt(quantity);
  return total % count === BigInt(0) ? Number(total / count) : null;
}
export type OrderEditDisplayGroup = {
  key: string;
  sourceLineIds: string[];
  title: string;
  variantTitle: string | null;
  quantity: number;
  totalCents: number;
  added: boolean;
};

function individualLine(
  line: DisplayLine,
  index: number,
): OrderEditDisplayGroup {
  return {
    key: `line:${index}:${line.id}`,
    sourceLineIds: [line.id],
    title: line.title,
    variantTitle: line.variantTitle,
    quantity: line.quantity,
    totalCents: line.totalCents,
    added: line.added === true,
  };
}

// Shopify can split one variant into lines with different discount allocations.
// Group only their display, summing the verified net amounts without repricing
// or changing the source IDs used by financial commands.
export function groupOrderEditDisplayLines(
  lines: readonly DisplayLine[],
): OrderEditDisplayGroup[] {
  const groups = new Map<string, OrderEditDisplayGroup>();
  for (const [index, line] of lines.entries()) {
    // Titles and SKUs are not reliable identity. Older responses without a
    // variant ID must stay separate, even when their labels happen to match.
    const key = line.variantId
      ? `variant:${line.variantId}`
      : `line:${index}:${line.id}`;
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, { ...individualLine(line, index), key });
      continue;
    }
    const quantity = previous.quantity + line.quantity;
    const totalCents = previous.totalCents + line.totalCents;
    // Keep the original exact amounts visible if aggregation cannot be
    // represented safely. Never round or clamp a financial display.
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(totalCents))
      return lines.map(individualLine);
    groups.set(key, {
      ...previous,
      sourceLineIds: [...previous.sourceLineIds, line.id],
      quantity,
      totalCents,
      added: previous.added && line.added === true,
    });
  }
  return [...groups.values()];
}
