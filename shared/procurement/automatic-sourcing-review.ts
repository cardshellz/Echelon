import { z } from "zod";

const quantity = z.number().int().nonnegative().safe();
const id = z.number().int().positive().max(2_147_483_647);
export const pendingSourcingReviewSchema = z.object({
  recommendationId: z.string().min(1),
  reason: z.literal("pending_sourcing_reservation"),
  reservedPieces: quantity,
  suggestedPieces: quantity,
  uncoveredPieces: quantity,
  message: z.string().min(1),
  reservations: z.array(z.object({ productId: id, pieces: quantity.positive(), purchaseOrderId: id.nullable(), rfqId: id.nullable() }).strict().refine((source) => (source.purchaseOrderId === null) !== (source.rfqId === null), "Each reservation must identify exactly one owner")).min(1),
}).passthrough().superRefine((review, context) => {
  const total = review.reservations.reduce((sum, source) => sum + BigInt(source.pieces), BigInt(0));
  if (total !== BigInt(review.reservedPieces) || review.uncoveredPieces !== Math.max(review.suggestedPieces - review.reservedPieces, 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Reservation totals and uncovered demand must match their owner evidence" });
});
export type PendingSourcingReview = z.infer<typeof pendingSourcingReviewSchema>;
