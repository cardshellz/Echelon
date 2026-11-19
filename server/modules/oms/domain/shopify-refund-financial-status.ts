export interface ShopifyRefundFinancialEvidence {
  totalCents: number | string | null;
  previousRefundCents: number | string | null;
  refundCents: number;
  previousFinancialStatus: string | null;
}

function nonnegativeCents(value: number | string | null): bigint {
  if (value === null) return BigInt(0);
  if (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^\d+$/.test(value))
  ) {
    const cents = BigInt(value);
    if (cents <= BigInt(Number.MAX_SAFE_INTEGER)) return cents;
  }
  throw Object.assign(
    new Error("Refund financial evidence contains an invalid amount."),
    {
      code: "SHOPIFY_REFUND_FINANCIAL_EVIDENCE_INVALID",
    },
  );
}

/** A removed/replaced item is physical disposition, not proof of money returned. */
export function deriveShopifyRefundFinancialStatus(
  input: ShopifyRefundFinancialEvidence,
): string | null {
  const total = nonnegativeCents(input.totalCents);
  const cumulative =
    nonnegativeCents(input.previousRefundCents) +
    nonnegativeCents(input.refundCents);
  if (cumulative > BigInt(Number.MAX_SAFE_INTEGER))
    throw Object.assign(
      new Error("Cumulative refund exceeds the supported amount."),
      {
        code: "SHOPIFY_REFUND_FINANCIAL_EVIDENCE_INVALID",
      },
    );
  if (cumulative === BigInt(0)) return input.previousFinancialStatus;
  return total > BigInt(0) && cumulative >= total
    ? "refunded"
    : "partially_refunded";
}
