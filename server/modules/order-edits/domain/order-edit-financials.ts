import {
  orderEditFinancialsSchema,
  orderEditSettlementSchema,
  type OrderEditFinancials,
  type OrderEditSettlement,
} from "@shared/order-edits/order-edit-financials";
import { canonicalJson } from "@shared/utils/canonical-json";
import { OrderEditError } from "./order-edit-error";
import type { OrderEditDiscount } from "@shared/order-edits/order-edit-discounts";

interface SettlementTransaction {
  id: string;
  kind: string;
  status: string;
  amountCents: number;
  parentId?: string | null;
  gateway?: string;
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
  itemDiscounts?: OrderEditDiscount[];
  shippingGrossCents: number;
  shippingCents: number;
  shippingDiscountLabels: string[];
  taxCents: number;
  taxLines?: OrderEditFinancials["taxLines"];
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
  return (
    fields.every((field) => current[field] === expected[field]) &&
    (!expected.itemDiscounts ||
      (current.itemDiscounts !== undefined &&
        canonicalJson(current.itemDiscounts) ===
          canonicalJson(expected.itemDiscounts)))
  );
}

/** New display evidence must not prevent an older unsubmitted edit from being cancelled. */
export function equivalentOrderEditFinancialEvidence(
  actual: OrderEditFinancials | undefined,
  expected: OrderEditFinancials | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  // Tax rates are display metadata. Exact tax cents remain part of the proof,
  // including when cancelling an edit saved before rates were requested.
  const { taxLines: _actualRates, ...actualEvidence } = actual;
  const { taxLines: _expectedRates, ...expectedEvidence } = expected;
  if (!expected.itemDiscounts) delete actualEvidence.itemDiscounts;
  return canonicalJson(actualEvidence) === canonicalJson(expectedEvidence);
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

/** One presentation owner for account rows and their management panel. A
 * settled refund must not be labelled "payment outstanding" just because the
 * provider no longer reports the cancelled order as fullyPaid. */
export function presentOrderEditFinancialStatus(snapshot: SettlementEvidence & { cancelled: boolean; fullyPaid: boolean }): string {
  const settled = presentOrderEditSettlement(snapshot);
  const pending = settled.activity.filter(entry => !["SUCCESS", "FAILURE", "ERROR"].includes(entry.status));
  if (pending.some(entry => entry.kind === "refund")) return "Refund processing";
  if (settled.outstandingCents > 0) return "Payment due";
  if (settled.refundedCents > 0) return settled.netPaidCents === 0 ? "Refunded" : "Partially refunded";
  if (snapshot.cancelled) return settled.netPaidCents > 0 ? "Refund pending" : "Cancelled";
  if (pending.length) return "Payment processing";
  return snapshot.fullyPaid ? "Paid" : "Payment pending";
}

/** Full cancellation must refund the approved remaining payment, without an
 * extra capture or a changed refund amount being hidden by a zero net balance. */
export function matchesOrderCancellationSettlement(before: SettlementEvidence, after: SettlementEvidence, refundCents: number): boolean {
  if (!Number.isSafeInteger(refundCents) || refundCents < 0) return false;
  const original = presentOrderEditSettlement(before), current = presentOrderEditSettlement(after);
  return original.netPaidCents === refundCents && current.netPaidCents === 0 && current.outstandingCents === 0
    && original.receivedCents === current.receivedCents
    && BigInt(current.refundedCents) - BigInt(original.refundedCents) === BigInt(refundCents);
}

/** Confirmed receipts and completed refunds can leave less than the order
 * total (including zero) available to return. A status or net balance alone
 * cannot prove this. Merchandise cancellation remains a separate command. */
export function isOrderCancellationPaymentSettled(
  snapshot: SettlementEvidence & {
    fullyPaid: boolean;
    capturableCents: number;
    totalCents: number;
  },
): boolean {
  const settlement = presentOrderEditSettlement(snapshot);
  if (
    !Number.isSafeInteger(snapshot.totalCents) ||
    snapshot.totalCents < 0 ||
    snapshot.capturableCents !== 0 ||
    snapshot.outstandingCents !== 0 ||
    settlement.activity.some(
      (entry) => !["SUCCESS", "FAILURE", "ERROR"].includes(entry.status),
    )
  )
    return false;
  if (snapshot.fullyPaid && snapshot.netPaidCents === snapshot.totalCents)
    return true;
  const transactions = new Map<string, SettlementTransaction>();
  for (const transaction of [
    ...snapshot.transactions,
    ...snapshot.refunds.flatMap((refund) => refund.transactions),
  ]) {
    // presentOrderEditSettlement already rejects contradictory duplicates.
    transactions.set(transaction.id, transaction);
  }
  const refundedByParent = new Map<string, bigint>();
  for (const refund of transactions.values()) {
    if (refund.kind !== "REFUND" || refund.status !== "SUCCESS") continue;
    const parent = refund.parentId
      ? transactions.get(refund.parentId)
      : undefined;
    if (
      !parent ||
      !["SALE", "CAPTURE"].includes(parent.kind) ||
      parent.status !== "SUCCESS" ||
      !refund.gateway ||
      refund.gateway !== parent.gateway
    )
      return false;
    const refunded =
      (refundedByParent.get(parent.id) ?? BigInt(0)) +
      BigInt(refund.amountCents);
    if (refunded > BigInt(parent.amountCents)) return false;
    refundedByParent.set(parent.id, refunded);
  }
  return (
    settlement.receivedCents > 0 &&
    // A completed price-reducing edit can make the current total smaller than
    // the original receipt. Require enough captured money to cover that total.
    settlement.receivedCents >= snapshot.totalCents &&
    settlement.refundedCents > 0 &&
    settlement.refundedCents <= settlement.receivedCents &&
    BigInt(settlement.receivedCents) - BigInt(settlement.refundedCents) ===
      BigInt(snapshot.netPaidCents)
  );
}
