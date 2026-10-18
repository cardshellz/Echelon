import { z } from "zod";
import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import { receiptCostRecoverySchema } from "@shared/procurement/receipt-cost-recovery";
import { receiptCostAttemptStateSchema, receiptCostRequestHistorySchema, receiptCostRequestResultSchema, type ReceiptCostRequestHistory } from "@shared/procurement/receipt-cost-queue";

const id = z.number().int().positive().safe();
const date = z.string().datetime({ offset: true });
export const receiptCostQueueReadSchema = z.object({
  requests: z.array(z.object({
    id, receiptId: id, receiptStatus: z.string(), purchaseOrderLineId: id, requestedBy: z.string(), requestedAt: date,
    automaticRecovery: receiptCostRecoverySchema.nullable().optional(),
  })),
  attempts: z.array(z.object({
    id, requestId: id, state: receiptCostAttemptStateSchema, summary: z.unknown(), applications: z.unknown(), recordedBy: z.string(), recordedAt: date,
  })),
});
export type ReceiptCostQueueRead = z.infer<typeof receiptCostQueueReadSchema>;

export function projectReceiptCostQueue(input: ReceiptCostQueueRead, applicationScopes: ReadonlyMap<number, { purchaseOrderLineId: number; status: string }> = new Map(), current?: PurchaseCostStatus): ReceiptCostRequestHistory {
  const data = receiptCostQueueReadSchema.parse(input);
  const byRequest = new Map<number, ReceiptCostQueueRead["attempts"]>();
  for (const attempt of data.attempts) {
    const entries = byRequest.get(attempt.requestId) ?? [];
    entries.push(attempt); byRequest.set(attempt.requestId, entries);
  }
  return receiptCostRequestHistorySchema.parse(data.requests.map((request) => {
    const attempts = (byRequest.get(request.id) ?? []).sort((left, right) => right.id - left.id).map((attempt, index) => {
      const summary = receiptCostRequestResultSchema.safeParse(attempt.summary);
      const validSummary = summary.success && summary.data.requestId === request.id && summary.data.purchaseOrderLineId === request.purchaseOrderLineId
        && summary.data.state === attempt.state && summary.data.attemptRecorded;
      const applications = z.array(z.object({ applicationId: id })).safeParse(attempt.applications ?? []);
      const validApplications = applications.success && (attempt.state !== "applied" || applications.data.length > 0)
        && applications.data.every((application) => {
          const scope = applicationScopes.get(application.applicationId);
          return scope?.purchaseOrderLineId === request.purchaseOrderLineId && (attempt.state !== "applied" || scope.status === "applied");
        });
      const issues = [...(summary.success ? summary.data.issues : [])];
      if (!validSummary) issues.push({ code: "RECEIPT_COST_ATTEMPT_INVALID", message: "The immutable cost attempt does not reconcile to this receipt request." });
      if (!validApplications) issues.push({ code: "RECEIPT_COST_APPLICATION_LINK_INVALID", message: "The cost attempt has missing or invalid application references." });
      return { id: attempt.id, state: attempt.state, latestRecordedAttempt: index === 0, recordedBy: attempt.recordedBy, recordedAt: attempt.recordedAt,
        evidenceState: validSummary && validApplications ? "verified_record" : "review_required", issues,
        applicationIds: applications.success ? applications.data.map((application) => application.applicationId) : [] };
    });
    const latest = attempts[0];
    const recordedState = latest ? latest.evidenceState === "verified_record" ? latest.state : "review_required" : "pending";
    const currentCosts = current?.lines.find(line => line.purchaseOrderLineId === request.purchaseOrderLineId);
    if (current && !currentCosts) {
      throw new Error(`Current supplier cost status is missing for receipt request ${request.id}, PO line ${request.purchaseOrderLineId}.`);
    }
    // Immutable attempt state stays in history. Later supplier applications can
    // complete this receipt, but a freight approval never completes its goods.
    const state = currentCosts ? currentCosts.components.some(component => component.status === "review_required") ? "review_required"
      : currentCosts.components.every(component => component.status === "applied") ? "applied" : "pending"
      : recordedState;
    return { ...request, state, recordedState, currentCosts, attempts };
  }));
}
