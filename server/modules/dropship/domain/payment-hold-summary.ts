/**
 * What a vendor's held orders need from the wallet.
 *
 * An order lands in payment hold when the wallet cannot cover its debit. The
 * shortfall is the one number the vendor needs: the least they must add so
 * every held order can be accepted. Held orders are accepted one at a time
 * against the same balance, so it is the total the holds need less what the
 * wallet already has — never negative, because a balance that already covers
 * the holds needs nothing.
 *
 * Pure: integer cents in, integer cents out, no clock.
 */

export interface PaymentHoldAggregate {
  /** Held orders counted. */
  heldCount: number;
  /** Sum of what those orders will debit when accepted. */
  totalDebitCents: number;
  /** Spendable wallet balance right now. */
  availableBalanceCents: number;
  /** The first hold to expire, or null when nothing is held. */
  earliestExpiresAt: Date | null;
  currency: string;
}

export interface PaymentHoldSummary extends PaymentHoldAggregate {
  /** The least the vendor must add so every held order can be accepted. */
  shortfallCents: number;
}

export function summarizePaymentHolds(aggregate: PaymentHoldAggregate): PaymentHoldSummary {
  assertNonNegativeInteger(aggregate.heldCount, "heldCount");
  assertNonNegativeInteger(aggregate.totalDebitCents, "totalDebitCents");
  assertInteger(aggregate.availableBalanceCents, "availableBalanceCents");
  // A negative balance (return fees swept later) widens the gap: the holds
  // need their total plus whatever brings the wallet back to zero.
  const shortfallCents = Math.max(0, aggregate.totalDebitCents - aggregate.availableBalanceCents);
  return {
    ...aggregate,
    shortfallCents: aggregate.heldCount === 0 ? 0 : shortfallCents,
  };
}

function assertInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be a whole number of cents.`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  assertInteger(value, field);
  if (value < 0) {
    throw new RangeError(`${field} must not be negative.`);
  }
}
