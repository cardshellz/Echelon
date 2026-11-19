import { z } from "zod";

const integer = z.number().int().safe();
const id = integer.positive();

/** Read-only explanations. These are deliberately outside persisted financial
 * contracts: improving a task's wording must not invalidate a posted source. */
export const supplierCostReviewFactsSchema = z.object({
  quantityBasis: z.enum(["ordered", "received"]),
  expectedPieces: integer.nonnegative(),
  invoicedPieces: integer,
  creditedPieces: integer.nonnegative(),
  quantityMatches: z.boolean(),
  missingAmountLineIds: z.array(id),
  invoiceAmountCents: integer.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
}).strict();
export type SupplierCostReviewFacts = z.infer<typeof supplierCostReviewFactsSchema>;

export const costPostingReceiptSchema = z.object({
  applicationId: id,
  actorName: z.string().min(1),
  recordedAt: z.string().datetime({ offset: true }),
  amountMills: integer,
}).strict();
