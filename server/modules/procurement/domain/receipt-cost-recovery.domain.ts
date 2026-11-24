import { z } from "zod";
import { receiptCostRetryResultSchema } from "@shared/procurement/receipt-cost-queue";
import type { ReceiptCostRecovery } from "@shared/procurement/receipt-cost-recovery";

// Five retries span transient failures without repeatedly retrying bad evidence.
// The operator's existing explicit retry remains available after this budget.
export const RECEIPT_COST_RECOVERY_MAX_ATTEMPTS = 5;
export const RECEIPT_COST_RECOVERY_ACTOR = "system:receipt-cost-recovery";
export const RECEIPT_COST_RECOVERY_GRACE_MS = 120_000;
export const RECEIPT_COST_RECOVERY_LEASE_MS = 300_000;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

export const receiptCostRecoveryClaimSchema = z.object({
  requestId: z.number().int().positive().safe(),
  receiptId: z.number().int().positive().safe(),
  purchaseOrderLineId: z.number().int().positive().safe(),
  attemptCount: z.number().int().min(1).max(20),
  maxAttempts: z.number().int().min(1).max(20),
  leaseToken: z.string().uuid(),
}).refine((value) => value.attemptCount <= value.maxAttempts, "Recovery claim exceeds its retry budget");
export type ReceiptCostRecoveryClaim = z.infer<typeof receiptCostRecoveryClaimSchema>;
export interface ReceiptCostRecoveryOutcome {
  state: Exclude<ReceiptCostRecovery["state"], "processing">;
  errorCode: string | null;
  nextAttemptAt: Date;
}

export function receiptCostRecoveryOutcome(claimInput: ReceiptCostRecoveryClaim, raw: unknown, now: Date): ReceiptCostRecoveryOutcome {
  const claim = receiptCostRecoveryClaimSchema.parse(claimInput);
  assertRecoveryDate(now);
  const parsed = receiptCostRetryResultSchema.safeParse(raw);
  const request = parsed.success && parsed.data.requests.length === 1 ? parsed.data.requests[0] : null;
  const valid = request?.requestId === claim.requestId && request.purchaseOrderLineId === claim.purchaseOrderLineId;
  if (valid && request.attemptRecorded && (request.state === "applied" || request.state === "review_required")) {
    return { state: request.state, errorCode: request.state === "applied" ? null : "RECEIPT_COST_REVIEW_REQUIRED", nextAttemptAt: new Date(now) };
  }
  return recoveryRetryOutcome(claim, valid ? "RECEIPT_COST_RETRY_REQUIRED" : "RECEIPT_COST_RECOVERY_RESULT_INVALID", now);
}

export function recoveryRetryOutcome(claimInput: ReceiptCostRecoveryClaim, code: string, now: Date): ReceiptCostRecoveryOutcome {
  const claim = receiptCostRecoveryClaimSchema.parse(claimInput);
  assertRecoveryDate(now);
  const errorCode = z.string().min(1).max(100).parse(code);
  const delay = RETRY_DELAYS_MS[Math.min(claim.attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
  const nextAttemptAt = new Date(now.getTime() + delay);
  assertRecoveryDate(nextAttemptAt);
  return { state: claim.attemptCount >= claim.maxAttempts ? "exhausted" : "queued", errorCode, nextAttemptAt };
}

export function assertRecoveryDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Receipt-cost recovery requires a valid clock");
}
