import {
  formatCents,
  formatStatus,
  type DropshipOrderAcceptResponse,
  type DropshipOrderDetail,
  type DropshipOrderListItem,
} from "@/lib/dropship-ops-surface";

/**
 * How an order was, or will be, paid from the wallet, in the vendor's words
 * (funding design phase 7). Every order debit takes rewards first and cash
 * second unless the vendor saved their rewards, so an accepted order has up
 * to two ledger rows behind it: the cash row (`order_debit`) and the rewards
 * row (`rewards_spent`). The page shows both parts and never adds them up
 * itself beyond what the two rows say.
 */

export interface OrderPaymentPart {
  label: string;
  value: string;
}

/**
 * The rows of the "Wallet debit" section: the whole amount, the part rewards
 * paid, the part cash paid, and the balances each left behind. Null when the
 * order has no wallet rows yet (not accepted, or accepted before the wallet
 * recorded anything).
 */
export function describeOrderPayment(order: Pick<DropshipOrderDetail, "walletLedgerEntry" | "walletRewardsEntry">): OrderPaymentPart[] | null {
  const cash = order.walletLedgerEntry;
  const rewards = order.walletRewardsEntry ?? null;
  if (!cash && !rewards) return null;
  const cashCents = cash ? magnitude(cash.amountCents) : 0;
  const rewardsCents = rewards ? magnitude(rewards.amountCents) : 0;
  const parts: OrderPaymentPart[] = [{ label: "Paid from your wallet", value: formatCents(cashCents + rewardsCents) }];
  if (rewards) {
    parts.push({ label: "From rewards", value: formatCents(rewardsCents) });
    parts.push({ label: "From cash", value: formatCents(cashCents) });
  }
  if (cash) {
    parts.push({ label: "Status", value: formatStatus(cash.status) });
    parts.push({ label: "Cash balance after", value: cash.availableBalanceAfterCents === null ? "Not recorded" : formatCents(cash.availableBalanceAfterCents) });
  }
  if (rewards) {
    parts.push({ label: "Rewards balance after", value: rewards.rewardsBalanceAfterCents === null ? "Not recorded" : formatCents(rewards.rewardsBalanceAfterCents) });
  }
  return parts;
}

/**
 * What a held order still needs, split the way it will be paid: rewards
 * cover their part once the hold clears, so the cash the order waits for is
 * the rest. Only the total is stated when the hold recorded no rewards
 * figure (a hold from before rewards existed, or a server not serving it).
 */
export function describeHeldOrderNeed(hold: NonNullable<DropshipOrderListItem["paymentHold"]>): OrderPaymentPart[] {
  assertCents(hold.totalDebitCents, "totalDebitCents");
  const rewardsCents = hold.rewardsCents ?? null;
  if (rewardsCents === null) return [{ label: "Amount needed", value: formatCents(hold.totalDebitCents) }];
  assertCents(rewardsCents, "rewardsCents");
  if (rewardsCents > hold.totalDebitCents) {
    throw new RangeError(`rewardsCents (${rewardsCents}) exceeds totalDebitCents (${hold.totalDebitCents})`);
  }
  if (rewardsCents === 0) return [{ label: "Amount needed", value: formatCents(hold.totalDebitCents) }];
  return [
    { label: "Amount needed", value: formatCents(hold.totalDebitCents) },
    { label: "Rewards will cover", value: formatCents(rewardsCents) },
    { label: "Cash still needed", value: formatCents(hold.totalDebitCents - rewardsCents) },
  ];
}

/** The one-line outcome after Accept: the amount, and the rewards part when there is one. */
export function describeOrderAcceptance(result: DropshipOrderAcceptResponse["result"]): string {
  const rewardsCents = result.rewardsCents ?? 0;
  assertCents(result.totalDebitCents, "totalDebitCents");
  assertCents(rewardsCents, "rewardsCents");
  const rewardsClause = rewardsCents > 0 ? ` (${formatCents(rewardsCents)} from rewards)` : "";
  if (result.outcome === "payment_hold") {
    return `Order intake ${result.intakeId} placed on payment hold for ${formatCents(result.totalDebitCents)}${rewardsClause}.`;
  }
  return `Order intake ${result.intakeId} accepted for ${formatCents(result.totalDebitCents)}${rewardsClause}.`;
}

function magnitude(amountCents: number): number {
  assertInteger(amountCents, "amountCents");
  return Math.abs(amountCents);
}

function assertCents(value: number, field: string): void {
  assertInteger(value, field);
  if (value < 0) throw new RangeError(`${field} must not be negative, got ${value}`);
}

function assertInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be an integer amount of cents, got ${value}`);
}
