import { z } from "zod";
import { costIssueSchema } from "./cost-source-contracts";

const id = z.number().int().positive().safe();
const date = z.string().datetime({ offset: true });
export const receiptCostAttemptStateSchema = z.enum(["applied", "review_required", "retry_required"]);
export const receiptCostRequestResultSchema = z.object({
  requestId: id,
  purchaseOrderLineId: id,
  state: receiptCostAttemptStateSchema,
  issues: z.array(costIssueSchema),
  attemptRecorded: z.boolean(),
});
export const receiptCostRetryResultSchema = z.object({
  state: z.enum(["applied", "review_required", "retry_required", "not_applicable"]),
  requests: z.array(receiptCostRequestResultSchema),
}).superRefine((result, context) => {
  // An unavailable queue may return a retry with no request rows. Success still
  // requires a recorded result for every returned request.
  const expectedState = result.requests.some((request) => request.state === "retry_required") ? "retry_required"
    : result.requests.some((request) => request.state === "review_required") ? "review_required"
    : result.requests.length > 0 ? "applied" : "not_applicable";
  if (result.state !== expectedState && !(result.state === "retry_required" && result.requests.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Receipt cost state conflicts with its request outcomes" });
  }
  if (result.requests.some((request) => request.state === "applied" && !request.attemptRecorded)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requests"], message: "Applied cost outcomes require a recorded attempt" });
  }
  if (new Set(result.requests.map((request) => request.requestId)).size !== result.requests.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requests"], message: "Receipt cost request IDs must be unique" });
  }
});
export const receiptCostRequestHistorySchema = z.array(z.object({
  id,
  receiptId: id,
  receiptStatus: z.string(),
  purchaseOrderLineId: id,
  requestedBy: z.string(),
  requestedAt: date,
  state: z.enum(["pending", "applied", "review_required", "retry_required"]),
  attempts: z.array(z.object({
    id,
    state: receiptCostAttemptStateSchema,
    latestRecordedAttempt: z.boolean(),
    recordedBy: z.string(),
    recordedAt: date,
    evidenceState: z.enum(["verified_record", "review_required"]),
    issues: z.array(costIssueSchema),
    applicationIds: z.array(id),
  })),
}));
export type ReceiptCostRequestHistory = z.infer<typeof receiptCostRequestHistorySchema>;
export type ReceiptCostRetryResult = z.infer<typeof receiptCostRetryResultSchema>;
