import { z } from "zod";

// IDs are PostgreSQL integer columns, including their boundary validation.
const maximumDatabaseId = 2_147_483_647;
export const poFinancialEvidenceIdSchema = z
  .number()
  .int()
  .positive()
  .max(maximumDatabaseId);
const cents = z.number().int().safe();

/** Current PO attribution evidence, separate from legacy whole-invoice caches. */
export const poFinancialEvidenceSchema = z
  .object({
    purchaseOrderId: poFinancialEvidenceIdSchema,
    currency: z.string(),
    state: z.enum(["complete", "review_required"]),
    invoicedAmountCents: cents.nullable(),
    paidAmountCents: cents.nonnegative().nullable(),
    outstandingAmountCents: cents.nonnegative().nullable(),
    invoiceCount: z.number().int().nonnegative().safe(),
    reviewReasons: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          invoiceId: poFinancialEvidenceIdSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const amounts = [
      value.invoicedAmountCents,
      value.paidAmountCents,
      value.outstandingAmountCents,
    ];
    if (amounts.some((amount) => amount !== null) && value.currency !== "USD") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "Known amounts require supported USD evidence.",
      });
    }
    if (
      value.state === "complete" &&
      (amounts.some((amount) => amount === null) ||
        value.reviewReasons.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message:
          "Complete evidence requires known amounts and no review reasons.",
      });
    }
    if (value.state === "review_required" && value.reviewReasons.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewReasons"],
        message: "Incomplete evidence requires an explicit review reason.",
      });
    }
    if (
      value.invoicedAmountCents !== null &&
      value.paidAmountCents !== null &&
      value.outstandingAmountCents !== null &&
      amounts.every((amount) => Number.isSafeInteger(amount)) &&
      BigInt(value.invoicedAmountCents) !==
        BigInt(value.paidAmountCents) + BigInt(value.outstandingAmountCents)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outstandingAmountCents"],
        message:
          "Known financial amounts must conserve the mapped invoice amount.",
      });
    }
  });

export type PoFinancialEvidence = z.infer<typeof poFinancialEvidenceSchema>;
