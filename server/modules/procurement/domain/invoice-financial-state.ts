import { z } from "zod";

const money = z.number().int().nonnegative().safe();
const inputSchema = z.object({ status: z.enum(["received", "approved", "partially_paid", "paid", "disputed", "voided"]), invoiceAmountCents: money, paidAmountCents: money, creditedAmountCents: money.default(0) }).strict();

/** The same exact balance/status projection is used by AP writes and previews.
 * It changes neither payment evidence nor a disputed/voided document's status. */
export function deriveInvoiceFinancialState(input: { status: string; invoiceAmountCents: number; paidAmountCents: number; creditedAmountCents?: number }) {
  const { status, invoiceAmountCents, paidAmountCents, creditedAmountCents } = inputSchema.parse(input);
  const difference = BigInt(invoiceAmountCents) - BigInt(paidAmountCents) - BigInt(creditedAmountCents);
  let afterStatus = status;
  if (status !== "voided" && status !== "disputed") {
    if (difference <= BigInt(0)) afterStatus = "paid";
    else if (paidAmountCents > 0 || creditedAmountCents > 0) afterStatus = "partially_paid";
    else if (status === "paid" || status === "partially_paid") afterStatus = "approved";
  }
  return { balanceCents: difference > BigInt(0) ? Number(difference) : 0, status: afterStatus };
}
