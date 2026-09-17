/**
 * Held orders on the vendor pages.
 *
 * An order in payment hold is waiting for the wallet to cover it. These
 * helpers turn the server's summary and list items into the few lines a
 * vendor needs: how many orders are waiting, how much to add, and how long
 * they have before the marketplace order is cancelled. Pure: the clock is a
 * parameter so every string is reproducible.
 */

import {
  formatCents,
  type DropshipOrderListItem,
  type DropshipPaymentHoldSummaryResponse,
} from "./dropship-ops-surface";

export const PAYMENT_HOLD_SUMMARY_PATH = "/api/dropship/orders/payment-hold-summary";
export const PAYMENT_HOLD_STATUS = "payment_hold";

export type DropshipPaymentHoldSummary = DropshipPaymentHoldSummaryResponse["summary"];

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** What the vendor's standing adds to the held-order copy. */
export interface PaymentHoldStandingContext {
  /** True while the vendor is paused for a funding reason: holds wait for the wallet minimum, not the order total. */
  pausedForFunding: boolean;
}

export interface PaymentHoldNotice {
  /** "2 orders are waiting on payment" */
  title: string;
  /** What they need against what the wallet has. */
  needs: string;
  /** What to do about it. */
  action: string;
  /** How long the first one has, or null when nothing is held. */
  deadline: string | null;
  /** True when adding money is what unblocks the orders. */
  needsFunds: boolean;
}

export function isWaitingOnPayment(order: Pick<DropshipOrderListItem, "status">): boolean {
  return order.status === PAYMENT_HOLD_STATUS;
}

/**
 * Time left until `target`, as a vendor reads it: "2d 3h", "3h 5m", "12m",
 * "under a minute", or "past due" once it has gone. Null without a deadline.
 */
export function formatTimeUntil(target: string | Date | null, now: Date): string | null {
  if (target === null) return null;
  const targetDate = target instanceof Date ? target : new Date(target);
  const targetMs = targetDate.getTime();
  if (Number.isNaN(targetMs)) return null;
  const remainingMs = targetMs - now.getTime();
  if (remainingMs <= 0) return "past due";
  const totalMinutes = Math.floor(remainingMs / MS_PER_MINUTE);
  if (totalMinutes < 1) return "under a minute";
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * The banner copy for a vendor's held orders, or null when nothing is held.
 * While the vendor is paused for funding, the orders wait for the wallet to
 * reach its minimum, so the shortfall against the order total is not the
 * number to show.
 */
export function describePaymentHoldSummary(
  summary: DropshipPaymentHoldSummary,
  now: Date,
  standing: PaymentHoldStandingContext = { pausedForFunding: false },
): PaymentHoldNotice | null {
  if (summary.heldCount <= 0) return null;
  const plural = summary.heldCount === 1 ? "" : "s";
  const needsFunds = standing.pausedForFunding || summary.shortfallCents > 0;
  const remaining = formatTimeUntil(summary.earliestExpiresAt, now);
  return {
    title: `${summary.heldCount} order${plural} ${summary.heldCount === 1 ? "is" : "are"} waiting on payment`,
    needs: `${summary.heldCount === 1 ? "It needs" : "They need"} ${formatCents(summary.totalDebitCents)} in total; your balance is ${formatCents(summary.availableBalanceCents)}.`,
    action: standing.pausedForFunding
      ? `Selling is paused. Fund your wallet back to its minimum and ${summary.heldCount === 1 ? "it" : "they"} will be accepted.`
      : needsFunds
        ? `Add ${formatCents(summary.shortfallCents)} to accept ${summary.heldCount === 1 ? "it" : "them"}.`
        : `Your balance covers ${summary.heldCount === 1 ? "it" : "them"} now. Accept ${summary.heldCount === 1 ? "it" : "them"} from the orders list.`,
    deadline: remaining === null
      ? null
      : remaining === "past due"
        ? `The first one is past its deadline and will be cancelled.`
        : `The first one is cancelled in ${remaining} if it is not paid.`,
    needsFunds,
  };
}

/**
 * The one-line detail under a held order's status: what it needs and how long
 * it has. Null for an order that is not held.
 */
export function describeHeldOrder(order: DropshipOrderListItem, now: Date): string | null {
  if (!isWaitingOnPayment(order)) return null;
  const amount = order.paymentHold ? `Needs ${formatCents(order.paymentHold.totalDebitCents)}` : "Waiting on payment";
  const remaining = formatTimeUntil(order.paymentHold?.expiresAt ?? order.paymentHoldExpiresAt, now);
  if (remaining === null) return amount;
  return remaining === "past due" ? `${amount} · past due` : `${amount} · cancels in ${remaining}`;
}

/**
 * The status filter a link asked for, e.g. "/orders?status=payment_hold" from
 * the dashboard. Anything the page does not offer falls back to "all" rather
 * than sending an unknown status to the server.
 */
export function ordersStatusFilterFromSearch(search: string, offered: readonly string[]): string {
  const requested = new URLSearchParams(search).get("status");
  return requested !== null && offered.includes(requested) ? requested : "all";
}
