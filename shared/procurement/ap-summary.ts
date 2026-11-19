import { z } from "zod";

const cents = z.number().int().nonnegative().safe();
const count = z.number().int().nonnegative().safe();
const id = count.positive();
const vendorName = z.string().nullable();

/** Read DTO for getApSummary. Missing financial evidence is unavailable, never
 * an implicit zero. Nullable supplier names and legacy dates retain their
 * existing display owners; payment methods remain provider-defined strings. */
export const apSummarySchema = z.object({
  totalOutstandingCents: cents,
  disputedOutstandingCents: cents,
  disputedInvoiceCount: count,
  overdueCents: cents,
  dueSoonCents: cents,
  paidThisMonthCents: cents,
  paidAllTimeCents: cents,
  creditedAllTimeCents: cents,
  openInvoiceCount: count,
  agingBuckets: z.object({ current: cents, days1_30: cents, days31_60: cents, days61_90: cents, days90plus: cents }),
  vendorAging: z.array(z.object({
    vendorId: id, vendorName,
    current: cents, days1_30: cents, days31_60: cents, days61_90: cents, days90plus: cents, total: cents,
  })),
  recentPayments: z.array(z.object({
    id, paymentNumber: z.string(), vendorName,
    paymentDate: z.string().nullable(), paymentCalendarDate: z.string().nullable(),
    paymentDateSource: z.enum(["recorded_calendar_date", "legacy_timestamp"]),
    paymentMethod: z.string().nullable(), totalAmountCents: cents, status: z.string(),
  })),
  recentlyPaid: z.array(z.object({
    id, invoiceNumber: z.string(), vendorName,
    invoicedAmountCents: cents, paidAmountCents: cents, creditedAmountCents: cents,
  })),
});
export type ApSummary = z.infer<typeof apSummarySchema>;
