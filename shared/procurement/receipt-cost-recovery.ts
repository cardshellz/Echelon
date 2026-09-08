import { z } from "zod";

export const receiptCostRecoveryStateSchema = z.enum(["queued", "processing", "applied", "review_required", "exhausted"]);
export const receiptCostRecoverySchema = z.object({
  state: receiptCostRecoveryStateSchema,
  attemptCount: z.number().int().min(0).max(20),
  maxAttempts: z.number().int().min(1).max(20),
  nextAttemptAt: z.string().datetime({ offset: true }),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  lastErrorCode: z.string().max(100).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine((value, context) => {
  if (value.attemptCount > value.maxAttempts) context.addIssue({ code: z.ZodIssueCode.custom, message: "Recovery attempts exceed their limit" });
  if ((value.state === "processing") !== (value.leaseExpiresAt !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Recovery lease conflicts with state" });
});
export type ReceiptCostRecovery = z.infer<typeof receiptCostRecoverySchema>;

export function describeReceiptCostRecovery(recovery: ReceiptCostRecovery, receiptState: string): string {
  const value = receiptCostRecoverySchema.parse(recovery);
  if (receiptState === "applied") return "Receipt costs completed. Automatic recovery has no further work for this request.";
  if (receiptState === "review_required") return "Automatic recovery stopped for review. Resolve the cost evidence, then retry receipt costs.";
  if (value.state === "exhausted") return `Automatic recovery stopped after ${value.attemptCount} attempts. Review the failure and retry receipt costs manually.`;
  if (value.state === "processing") return `Automatic recovery is processing attempt ${value.attemptCount} of ${value.maxAttempts}.`;
  if (value.state === "queued") return `Automatic recovery is queued after ${value.attemptCount} of ${value.maxAttempts} attempts.`;
  return "A later receipt-cost outcome requires review. Check the recorded attempts before retrying.";
}
