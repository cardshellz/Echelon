import { z } from "zod";
const cents = z.number().int().nonnegative().safe();
const invoiceSettlementSchema = z.object({
  invoicedAmountCents: z.number().int().safe(),
  status: z.string().optional(),
  paidAmountCents: cents,
  creditedAmountCents: cents,
  balanceCents: cents
});
/** Cash and supplier credits remain distinct; the projection never derives missing credit evidence.
 * A legacy cash overpayment is a review state, never permission to allocate additional funds. */
export function projectInvoiceSettlement(input: unknown): {
  creditedAmountCents: number;
  settledAmountCents: number;
  overpaidAmountCents: number;
  settlementReviewRequired: boolean;
} {
  const value = invoiceSettlementSchema.parse(input);
  if (value.invoicedAmountCents < 0) {
    // Retain a voided historical document as review evidence. It is neither
    // an active supplier credit nor an overpayment, and no write path uses this exception.
    if (value.status !== "voided" || value.paidAmountCents !== 0 || value.creditedAmountCents !== 0 || value.balanceCents !== 0) {
      throw new Error("Invoice settlement totals require review.");
    }
    return { creditedAmountCents: 0, settledAmountCents: 0, overpaidAmountCents: 0, settlementReviewRequired: true };
  }
  const settled = BigInt(value.paidAmountCents) + BigInt(value.creditedAmountCents);
  const gross = BigInt(value.invoicedAmountCents);
  const legacyCashOverpayment = value.creditedAmountCents === 0 && value.balanceCents === 0 && settled > gross;
  if (settled > BigInt(Number.MAX_SAFE_INTEGER)
    || (!legacyCashOverpayment && settled + BigInt(value.balanceCents) !== gross)) {
    throw new Error("Invoice settlement totals require review.");
  }
  return {
    creditedAmountCents: value.creditedAmountCents,
    settledAmountCents: Number(settled),
    overpaidAmountCents: legacyCashOverpayment ? Number(settled - gross) : 0,
    settlementReviewRequired: legacyCashOverpayment
  };
}
