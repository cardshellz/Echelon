import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";

type DisplayLine = OrderEditOperation["lines"][number];
export type OrderEditDisplayGroup = {
  key: string;
  sourceLineIds: string[];
  title: string;
  variantTitle: string | null;
  quantity: number;
  totalCents: number;
  added: boolean;
};

function individualLine(line: DisplayLine, index: number): OrderEditDisplayGroup {
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
