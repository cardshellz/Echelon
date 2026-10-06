import {
  orderEditFinancialsSchema,
  orderEditSettlementSchema,
  type OrderEditFinancials,
  type OrderEditSettlement,
} from "@shared/order-edits/order-edit-financials";
import { canonicalJson } from "@shared/utils/canonical-json";
import { OrderEditError } from "./order-edit-error";

interface SettlementTransaction {
  id: string;
  kind: string;
  status: string;
  amountCents: number;
}
interface SettlementEvidence {
  transactions: SettlementTransaction[];
  refunds: Array<{ transactions: SettlementTransaction[] }>;
  netPaidCents: number;
  outstandingCents: number;
  paymentDates?: Record<string, string | null>;
}

function safeCents(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OrderEditError(
      "ORDER_EDIT_MONEY_INVALID",
      "The financial amount is outside the supported integer-cent range.",
    );
  }
  return Number(value);
}

export function sumOrderEditCents(values: readonly number[]): number {
  return safeCents(
    values.reduce((total, value) => {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new OrderEditError(
          "ORDER_EDIT_MONEY_INVALID",
          "A nonnegative integer-cent amount is required.",
        );
      return total + BigInt(value);
    }, BigInt(0)),
  );
}

export function buildOrderEditFinancials(input: {
  lines: Array<{ id: string; grossCents: number; netCents: number }>;
  itemsNetCents: number;
  itemDiscountLabels: string[];
  shippingGrossCents: number;
  shippingCents: number;
  shippingDiscountLabels: string[];
  taxCents: number;
  taxesIncluded: boolean;
  totalCents: number;
}): OrderEditFinancials {
  const itemsGrossCents = sumOrderEditCents(
    input.lines.map((line) => line.grossCents),
  );
  const financials = orderEditFinancialsSchema.safeParse({
    ...input,
    itemsGrossCents,
    itemsDiscountCents: itemsGrossCents - input.itemsNetCents,
    shippingDiscountCents: input.shippingGrossCents - input.shippingCents,
    itemDiscountLabels: [...new Set(input.itemDiscountLabels)],
    shippingDiscountLabels: [...new Set(input.shippingDiscountLabels)],
    lines: input.lines.map((line) => ({
      ...line,
      discountCents: line.grossCents - line.netCents,
    })),
  });
  if (!financials.success)
    throw new OrderEditError(
      "ORDER_EDIT_FINANCIAL_MISMATCH",
      "The discounts, shipping, and tax do not reconcile to the order total.",
    );
  return financials.data;
}

export function matchesOrderEditFinancials(
  current: OrderEditFinancials | undefined,
  expected: OrderEditFinancials | undefined,
): boolean {
  if (!expected) return true;
  if (!current) return false;
  const fields = [
    "itemsGrossCents",
    "itemsDiscountCents",
    "itemsNetCents",
    "shippingGrossCents",
    "shippingDiscountCents",
    "shippingCents",
    "taxCents",
    "taxesIncluded",
    "totalCents",
  ] as const;
  return fields.every((field) => current[field] === expected[field]);
}

/** Older persisted snapshots can still report settlement without fabricating discount allocations. */
export function presentOrderEditSettlement(
  snapshot: SettlementEvidence,
): OrderEditSettlement {
  const transactions = new Map<string, SettlementTransaction>();
  for (const group of [
    snapshot.transactions,
    ...snapshot.refunds.map((refund) => refund.transactions),
  ]) {
    for (const transaction of group) {
      const previous = transactions.get(transaction.id);
      if (previous && canonicalJson(previous) !== canonicalJson(transaction)) {
        throw new OrderEditError(
          "ORDER_EDIT_PAYMENT_EVIDENCE_CONFLICT",
          "The same payment transaction has contradictory evidence.",
        );
      }
      transactions.set(transaction.id, transaction);
    }
  }
  const activity = [...transactions.values()].flatMap((transaction) => {
    const kind =
      transaction.kind === "SALE" || transaction.kind === "CAPTURE"
        ? "payment"
        : transaction.kind === "REFUND"
          ? "refund"
          : transaction.kind === "AUTHORIZATION" ||
              transaction.kind === "EMV_AUTHORIZATION"
            ? "authorization"
            : transaction.kind === "VOID"
              ? "void"
              : transaction.kind === "CHANGE"
                ? "adjustment"
                : null;
    if (!kind)
      throw new OrderEditError(
        "ORDER_EDIT_PAYMENT_EVIDENCE_INVALID",
        "The payment history contains an unsupported transaction kind.",
      );
    return [
      {
        id: transaction.id,
        kind,
        status: transaction.status,
        amountCents: transaction.amountCents,
        processedAt: snapshot.paymentDates?.[transaction.id] ?? null,
      },
    ];
  });
  const result = orderEditSettlementSchema.safeParse({
    receivedCents: sumOrderEditCents(
      activity
        .filter(
          (entry) => entry.kind === "payment" && entry.status === "SUCCESS",
        )
        .map((entry) => entry.amountCents),
    ),
    refundedCents: sumOrderEditCents(
      activity
        .filter(
          (entry) => entry.kind === "refund" && entry.status === "SUCCESS",
        )
        .map((entry) => entry.amountCents),
    ),
    netPaidCents: snapshot.netPaidCents,
    outstandingCents: snapshot.outstandingCents,
    activity,
  });
  if (!result.success)
    throw new OrderEditError(
      "ORDER_EDIT_PAYMENT_EVIDENCE_INVALID",
      "The payment history contains an invalid amount, identity, status, or date.",
    );
  return result.data;
}
