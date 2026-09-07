import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
export const purchaseRfqOriginSchema = z.object({
  id, rfqId: id, rfqNumber: z.string().min(1), rfqLineId: id,
  purchaseOrderLineId: id, quoteRevisionId: id, quoteReference: z.string().min(1),
  quotedPieces: id, currency: z.string().regex(/^[A-Z]{3}$/),
  linkedAt: z.string().datetime({ offset: true }),
}).strict();
export type PurchaseRfqOrigin = z.infer<typeof purchaseRfqOriginSchema>;
