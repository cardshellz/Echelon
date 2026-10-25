import type { Pool } from "pg";
import type { OrderEditCodeHistory } from "../application/order-edit-code-history";
import type {
  OrderEditSnapshot,
  OrderEditQuote,
} from "../application/order-edit-provider";
import { OrderEditProviderError } from "../application/order-edit-provider";
import { orderEditQuoteSchema } from "../application/order-edit-provider.schema";
import { withOrderEditCodePricing } from "../application/order-edit-code-presentation";
import {
  preservesAutomaticOrderEditLine,
  preservesNativeOrderEditLine,
} from "../application/order-edit-evidence";

export class PostgresOrderEditCodeHistory implements OrderEditCodeHistory {
  constructor(private readonly pool: Pool) {}
  async enrich(
    snapshot: OrderEditSnapshot,
    descriptions: Map<string, string[]>,
  ): Promise<OrderEditSnapshot> {
    const active = new Set(
      [...descriptions.values()]
        .flat()
        .filter((label) => /^Order discounts \([a-f0-9]{24}\)$/.test(label)),
    );
    if (!active.size) return snapshot;
    const rows = await this.pool.query(
      `SELECT op.document->'quote' AS quote FROM oms.order_edit_operations op
      JOIN oms.oms_orders o ON o.id=op.oms_order_id WHERE op.connection_id=$1 AND o.channel_id=$2
      AND o.external_order_id=ANY($3::text[]) AND op.document->>'commitStartedAt' IS NOT NULL
      AND op.document#>'{quote,codePricing}' IS NOT NULL ORDER BY op.created_at DESC,op.id DESC LIMIT 100`,
      [
        snapshot.connectionId,
        snapshot.channelId,
        [
          snapshot.orderId,
          snapshot.orderId.replace("gid://shopify/Order/", ""),
        ],
      ],
    );
    for (const row of rows.rows) {
      const parsed = orderEditQuoteSchema.safeParse(row.quote);
      if (
        !parsed.success ||
        !parsed.data.codePricing ||
        !active.has(parsed.data.codePricing.description)
      )
        continue;
      const quote = parsed.data;
      const pricing = quote.codePricing!;
      const mapped = mapOrderEditCodeLines(snapshot, quote, descriptions);
      if (mapped)
        return withOrderEditCodePricing(snapshot, {
          ...pricing,
          newCodes: [],
          lines: mapped,
        });
    }
    throw new OrderEditProviderError(
      "ORDER_EDIT_CODE_HISTORY_UNPROVEN",
      "The order's applied code prices could not be matched to its saved pricing record. Please contact us for help.",
    );
  }
}

/** Native IDs for added lines change after commit. Match exact values, never manufacture IDs. */
export function mapOrderEditCodeLines(
  snapshot: OrderEditSnapshot,
  quote: OrderEditQuote,
  descriptions: Map<string, string[]>,
) {
  if (
    !quote.codePricing ||
    quote.orderId !== snapshot.orderId ||
    quote.baseline.customerId !== snapshot.customerId ||
    snapshot.totalCents !== quote.totalCents ||
    snapshot.subtotalCents !== quote.financials?.itemsNetCents
  )
    return null;
  const used = new Set<string>();
  const lines = [];
  for (const evidence of quote.codePricing.lines) {
    const expected = quote.lines.find(
      (line) => line.calculatedLineId === evidence.id,
    );
    if (!expected) return null;
    const carriesVerifiedDiscount = (
      line: OrderEditSnapshot["lines"][number],
    ): boolean => {
      if (evidence.nativeDiscountCents) {
        const nativeCents = snapshot.nativeDiscountAllocations
          ?.filter((allocation) => allocation.lineId === line.id)
          .reduce(
            (sum, allocation) => sum + BigInt(allocation.amountCents),
            BigInt(0),
          );
        return Boolean(
          expected.originalLineId &&
            nativeCents === BigInt(evidence.nativeDiscountCents) &&
            preservesNativeOrderEditLine(
              snapshot,
              quote.baseline,
              expected.originalLineId,
              evidence.quantity,
            ) &&
            (!evidence.preserveAutomaticDiscount ||
              preservesAutomaticOrderEditLine(
                snapshot,
                quote.baseline,
                expected.originalLineId,
                evidence.quantity,
              )),
        );
      }
      if (
        BigInt(evidence.netCents) ===
        BigInt(evidence.retailCents) * BigInt(evidence.quantity)
      )
        return true;
      if (evidence.preserveAutomaticDiscount)
        return Boolean(
          expected.originalLineId &&
            preservesAutomaticOrderEditLine(
              snapshot,
              quote.baseline,
              expected.originalLineId,
              evidence.quantity,
            ),
        );
      return (
        descriptions.get(line.id)?.includes(quote.codePricing!.description) ??
        false
      );
    };
    const matches = snapshot.lines.filter(
      (line) =>
        !used.has(line.id) &&
        line.quantity > 0 &&
        (expected.originalLineId
          ? line.id === expected.originalLineId
          : !quote.baseline.lines.some(
              (original) => original.id === line.id,
            )) &&
        line.variantId === evidence.variantId &&
        line.quantity === evidence.quantity &&
        line.originalUnitPriceCents === evidence.retailCents &&
        snapshot.financials?.lines.find((financial) => financial.id === line.id)
          ?.netCents === evidence.netCents &&
        carriesVerifiedDiscount(line),
    );
    if (!matches.length) return null;
    const matched = matches.sort((a, b) => a.id.localeCompare(b.id))[0];
    used.add(matched.id);
    const { replacesAutomaticDiscount: _replacement, ...price } = evidence;
    lines.push({ ...price, id: matched.id });
  }
  return snapshot.lines.filter((line) => line.quantity > 0).length === used.size
    ? lines
    : null;
}
