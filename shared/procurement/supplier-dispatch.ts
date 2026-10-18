import { z } from "zod";

/** This is an operator attestation, never provider delivery evidence. */
export const supplierDispatchConfirmationSchema = z.object({
  confirmedSentExternally: z.literal(true),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();
export type SupplierDispatchConfirmation = z.infer<typeof supplierDispatchConfirmationSchema>;
