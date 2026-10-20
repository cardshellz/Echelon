import { z } from "zod";
const id = z.number().int().positive().max(2_147_483_647);
const money = z.number().int().nonnegative().safe();
export const invoiceCreditEvidenceSchema = z.object({
  allocationId: id,
  creditId: id,
  creditVendorId: id.nullable(),
  creditCurrency: z.string().nullable(),
  creditStatus: z.string().nullable(),
  creditTotalAmountCents: money.nullable(),
  creditAppliedAmountCents: money.nullable(),
  appliedAmountCents: money.positive(),
  reversalId: id.nullable(),
  evidenceValid: z.boolean()
}).strict();
export type InvoiceCreditEvidence = z.infer<typeof invoiceCreditEvidenceSchema>;
/** Credits settle payable without becoming cash. Every retained application is validated,
 * including reversed history, before current credit can be established. */
export function sumInvoiceCredits(rows: readonly unknown[], vendorId: number | null, currency: string | null): number | null {
  const parsed = z.array(invoiceCreditEvidenceSchema).safeParse(rows);
  if (!parsed.success) return null;
  const seen = new Set<number>();
  let sum = BigInt(0);
  for (const row of parsed.data) {
    if (seen.has(row.allocationId) || !row.evidenceValid || row.creditVendorId !== vendorId || row.creditCurrency !== currency || !["approved", "voided"].includes(row.creditStatus ?? "") || row.creditTotalAmountCents === null || row.creditAppliedAmountCents === null || row.creditTotalAmountCents <= 0 || row.creditAppliedAmountCents > row.creditTotalAmountCents || row.reversalId === null && row.creditStatus !== "approved") return null;
    seen.add(row.allocationId);
    if (row.reversalId === null) sum += BigInt(row.appliedAmountCents);
  }
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : null;
}
