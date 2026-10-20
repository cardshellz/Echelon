import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierReturnCreditReviewInputSchema, supplierReturnCreditReviewSchema, supplierReturnCreditReviewCommandResultSchema } from "@shared/procurement/supplier-return-credit";
import { FinancialCommandRequestError } from "./financial-command";
export const supplierReturnReviewIntentSchema = z.object({ command: z.literal("review_credit_difference"), entitlementId: z.number().int().positive().safe(), payload: supplierReturnCreditReviewInputSchema, reviewed: supplierReturnCreditReviewSchema }).strict().superRefine((value, context) => {
  if (value.entitlementId !== value.reviewed.entitlementId || value.payload.expectedVersion !== value.reviewed.version) context.addIssue({ code: "custom", message: "The credit difference request must match its reviewed source." });
});
export type SupplierReturnReviewIntent = z.infer<typeof supplierReturnReviewIntentSchema>;
export function verifySupplierReturnCreditReviewResult(raw: unknown, intent: SupplierReturnReviewIntent, actorId: string, key: string) {
  const parsed = supplierReturnCreditReviewCommandResultSchema.safeParse(raw);
  const invalid = (): never => { throw new FinancialCommandRequestError("The credit difference review may have completed, but its response could not be verified. Recover the saved request.", { status: 200, code: "SUPPLIER_RETURN_REVIEW_RESPONSE_INVALID", ambiguous: true, retryable: false }); };
  if (!parsed.success) return invalid();
  const result = parsed.data, review = result.review, latest = review.latestReview;
  if (result.actorId !== actorId || result.idempotencyKey !== key || result.entitlementId !== intent.entitlementId
    || canonicalJson(result.request) !== canonicalJson(intent.payload) || review.returnId !== intent.reviewed.returnId
    || review.returnLineId !== intent.reviewed.returnLineId || review.quantity !== intent.reviewed.quantity
    || !review.reviewCurrent || review.version === intent.payload.expectedVersion || !latest
    || latest.recordedBy !== actorId || latest.expectedVersion !== intent.payload.expectedVersion
    || latest.reason !== intent.payload.reason || latest.evidenceReference !== intent.payload.evidenceReference
    || latest.disposition !== intent.payload.disposition || canonicalJson(latest.assignments) !== canonicalJson(intent.payload.assignments)
    || intent.reviewed.reviewHistory.some(row => row.id === latest.id)
    || review.reviewHistory.filter(row => row.id === latest.id && canonicalJson(row) === canonicalJson(latest)).length !== 1
    || new Set(review.reviewHistory.map(row => row.id)).size !== review.reviewHistory.length
    || review.reviewHistory.length !== intent.reviewed.reviewHistory.length + 1
    || intent.reviewed.reviewHistory.some(previous => !review.reviewHistory.some(row => row.id === previous.id && canonicalJson(row) === canonicalJson(previous)))
    || canonicalJson(review.currentCosts) !== canonicalJson(intent.reviewed.currentCosts)
    || canonicalJson(review.creditLinks) !== canonicalJson(intent.reviewed.creditLinks)) return invalid();
  return result;
}
